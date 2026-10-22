import { createHash, randomBytes } from "node:crypto";
import type { VercelRequest } from "@vercel/node";
import { type Cidade, type ConfigContratos, type Escopo, type Modelo, type ResultadoSelecao, ROTULO_STATUS, STATUS, type Status, TELAS, type Tela } from "./contratoCore";

/**
 * Contratos de anúncio: a parte PURA do servidor (token do link, validações, o que o cliente pode ver). Nada aqui lê o Firestore:
 * quem lê e grava é a rota (`api/contratos.ts`). O cliente nunca fala com o Firestore: tudo passa pela rota, que confere o token,
 * a etapa e RECALCULA o preço.
 */

export const COLECAO = "contratos";
export const CONFIG_DOC = "adsConfig/contratos";
export const HISTORICO_MAX = 40;
export const TOKEN_FORMATO = /^[A-Za-z0-9_-]{43}$/;
/** O comprovante (imagem) vai em base64 dentro do JSON: o corpo da função na Vercel aceita ~4,5 MB, então a imagem decodificada fica em 3 MB. */
export const COMPROVANTE_MAX_BYTES = 3 * 1024 * 1024;
/** A URL temporária do comprovante, para o administrador, vale isto. */
export const COMPROVANTE_URL_SEGUNDOS = 300;

/** Token do link: 256 bits aleatórios (43 caracteres). Só o HASH dele é guardado: quem lê o banco não consegue montar o link. */
export const gerarToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// Alfabeto de Crockford (sem I, L, O, U): 32 símbolos, e 256 é múltiplo de 32, então não há viés ao usar o resto.
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Código curto do pedido (6 caracteres), para o cliente colocar no pagamento e você achar o contrato. */
export const gerarCodigo = (): string => {
  let codigo = "";
  for (const byte of randomBytes(6)) codigo += ALFABETO[byte % 32];
  return codigo;
};

export const limparTexto = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WHATSAPP = /^[0-9+()\-\s]{8,30}$/;

export interface ClienteContrato {
  nome: string;
  email: string;
  whatsapp: string;
  observacao: string;
}

export type ParseCriar = { ok: true; cliente: ClienteContrato } | { ok: false; error: string };

/** Cadastro do contrato feito pelo administrador. Nome é obrigatório; e-mail e WhatsApp, se vierem, precisam ter formato válido. */
export const parseCriar = (body: unknown): ParseCriar => {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const nome = limparTexto(b.nome, 80);
  if (!nome) return { ok: false, error: "Informe o nome do cliente." };
  const email = limparTexto(b.email, 120);
  if (email && !EMAIL.test(email)) return { ok: false, error: "E-mail inválido." };
  const whatsapp = limparTexto(b.whatsapp, 30);
  if (whatsapp && !WHATSAPP.test(whatsapp)) return { ok: false, error: "WhatsApp inválido." };
  return { ok: true, cliente: { nome, email, whatsapp, observacao: limparTexto(b.observacao, 300) } };
};

export interface PedidoContrato {
  modelo: Modelo;
  telas: Tela[];
  escopo: Escopo;
  cidade: Cidade | null;
  inicioMs: number;
  dias: number;
  fimMs: number;
}

export interface PrecoContrato {
  valorPorDia: number;
  total: number;
  somaTelasPorDia: number;
  minimoPorDia: number | null;
  minimoAplicado: boolean;
  porTela: Partial<Record<Tela, number>>;
  calculadoEm: number;
}

export interface ComprovanteContrato {
  publicId: string;
  formato: string;
  bytes: number;
  enviadoEm: number;
}

export interface PagamentoContrato {
  comprovante: ComprovanteContrato | null;
  declaradoEm: number | null;
  confirmadoEm: number | null;
  confirmadoPor: string | null;
  /** Recado do administrador (ex.: "o comprovante não abriu, envie de novo"). */
  notaDoAdmin: string | null;
}

export interface HistoricoItem {
  em: number;
  por: "cliente" | "admin" | "sistema";
  acao: string;
  nota?: string;
}

export interface ContratoDoc {
  status: Status;
  codigo: string;
  tokenHash: string;
  tokenExpiresAt: number;
  criadoEm: number;
  atualizadoEm: number;
  cliente: ClienteContrato;
  pedido: PedidoContrato | null;
  preco: PrecoContrato | null;
  pagamento: PagamentoContrato;
  historico: HistoricoItem[];
}

export const pagamentoVazio = (): PagamentoContrato => ({ comprovante: null, declaradoEm: null, confirmadoEm: null, confirmadoPor: null, notaDoAdmin: null });

export const novoContrato = (cliente: ClienteContrato, token: string, codigo: string, config: ConfigContratos, agora: number): ContratoDoc => ({
  status: "aguardando_configuracao",
  codigo,
  tokenHash: hashToken(token),
  tokenExpiresAt: agora + config.validadeLinkDias * 86_400_000,
  criadoEm: agora,
  atualizadoEm: agora,
  cliente,
  pedido: null,
  preco: null,
  pagamento: pagamentoVazio(),
  historico: [{ em: agora, por: "admin", acao: "criou o contrato" }],
});

/** Junta ao histórico (guarda só os últimos `HISTORICO_MAX`). */
export const comHistorico = (historico: readonly HistoricoItem[], item: HistoricoItem): HistoricoItem[] => [...historico, item].slice(-HISTORICO_MAX);

const num = (value: unknown, padrao = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : padrao);
const numOuNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Lê o documento do Firestore com cuidado (o que está lá foi gravado por nós, mas nunca se lança por dado estranho). Null se não for um contrato. */
export const parseContrato = (raw: unknown): ContratoDoc | null => {
  if (!isRecord(raw)) return null;
  if (!(STATUS as readonly unknown[]).includes(raw.status) || typeof raw.tokenHash !== "string" || typeof raw.codigo !== "string") return null;
  const cliente = isRecord(raw.cliente) ? raw.cliente : {};
  let pedido: PedidoContrato | null = null;
  if (isRecord(raw.pedido)) {
    const p = raw.pedido;
    const telas = Array.isArray(p.telas) ? p.telas.filter((t): t is Tela => (TELAS as readonly unknown[]).includes(t)) : [];
    const cidade = isRecord(p.cidade) && typeof p.cidade.id === "string" ? { id: p.cidade.id, nome: limparTexto(p.cidade.nome, 60), uf: limparTexto(p.cidade.uf, 2) } : null;
    pedido = { modelo: p.modelo === "banner" ? "banner" : "text", telas, escopo: p.escopo === "todas" ? "todas" : "cidade", cidade, inicioMs: num(p.inicioMs), dias: num(p.dias), fimMs: num(p.fimMs) };
  }
  let preco: PrecoContrato | null = null;
  if (isRecord(raw.preco)) {
    const p = raw.preco;
    const porTela: Partial<Record<Tela, number>> = {};
    if (isRecord(p.porTela)) for (const tela of TELAS) if (typeof p.porTela[tela] === "number") porTela[tela] = p.porTela[tela] as number;
    preco = { valorPorDia: num(p.valorPorDia), total: num(p.total), somaTelasPorDia: num(p.somaTelasPorDia), minimoPorDia: numOuNull(p.minimoPorDia), minimoAplicado: p.minimoAplicado === true, porTela, calculadoEm: num(p.calculadoEm) };
  }
  const pg = isRecord(raw.pagamento) ? raw.pagamento : {};
  const comp = isRecord(pg.comprovante) && typeof pg.comprovante.publicId === "string" ? { publicId: pg.comprovante.publicId, formato: limparTexto(pg.comprovante.formato, 10), bytes: num(pg.comprovante.bytes), enviadoEm: num(pg.comprovante.enviadoEm) } : null;
  const historico: HistoricoItem[] = Array.isArray(raw.historico)
    ? raw.historico.filter(isRecord).map((h) => ({ em: num(h.em), por: h.por === "cliente" || h.por === "admin" ? h.por : "sistema", acao: limparTexto(h.acao, 80), ...(typeof h.nota === "string" ? { nota: limparTexto(h.nota, 300) } : {}) } as HistoricoItem)).slice(-HISTORICO_MAX)
    : [];
  return {
    status: raw.status as Status,
    codigo: raw.codigo,
    tokenHash: raw.tokenHash,
    tokenExpiresAt: num(raw.tokenExpiresAt),
    criadoEm: num(raw.criadoEm),
    atualizadoEm: num(raw.atualizadoEm),
    cliente: { nome: limparTexto(cliente.nome, 80), email: limparTexto(cliente.email, 120), whatsapp: limparTexto(cliente.whatsapp, 30), observacao: limparTexto(cliente.observacao, 300) },
    pedido,
    preco,
    pagamento: { comprovante: comp, declaradoEm: numOuNull(pg.declaradoEm), confirmadoEm: numOuNull(pg.confirmadoEm), confirmadoPor: typeof pg.confirmadoPor === "string" ? pg.confirmadoPor : null, notaDoAdmin: typeof pg.notaDoAdmin === "string" ? limparTexto(pg.notaDoAdmin, 300) : null },
    historico,
  };
};

/** O pedido e o preço que ficam gravados no contrato, a partir de uma seleção JÁ validada. O preço fica "congelado": mudar a tabela depois não altera. */
export const pedidoEPreco = (resultado: Extract<ResultadoSelecao, { ok: true }>, agora: number): { pedido: PedidoContrato; preco: PrecoContrato } => {
  const { selecao, cidade, cotacao } = resultado;
  return {
    pedido: { modelo: selecao.modelo, telas: selecao.telas, escopo: selecao.escopo, cidade, inicioMs: selecao.inicioMs, dias: selecao.dias, fimMs: cotacao.fimMs },
    preco: { valorPorDia: cotacao.valorPorDia, total: cotacao.total, somaTelasPorDia: cotacao.somaTelasPorDia, minimoPorDia: cotacao.minimoPorDia, minimoAplicado: cotacao.minimoAplicado, porTela: cotacao.porTela, calculadoEm: agora },
  };
};

/** Há algo à venda? (pelo menos uma tela com preço). Sem isso, o contrato não faz sentido e a rota avisa que os valores ainda não foram configurados. */
export const temPrecos = (config: ConfigContratos): boolean => (["text", "banner"] as const).some((m) => (["cidade", "todas"] as const).some((e) => TELAS.some((t) => config.precos[m][e][t] !== null)));

/** O que o CLIENTE pode ver: nunca o hash do token, o id da imagem do comprovante, o histórico interno, nem as observações do administrador. */
export const visaoPublica = (c: ContratoDoc, config: ConfigContratos, agora: number) => {
  const mostraPagamento = c.status === "aguardando_pagamento" || c.status === "comprovante_enviado" || c.status === "pago";
  return {
    codigo: c.codigo,
    status: c.status,
    rotulo: ROTULO_STATUS[c.status],
    cliente: { nome: c.cliente.nome },
    agoraMs: agora,
    validoAte: c.tokenExpiresAt,
    config: { precos: config.precos, minimoPorDia: config.minimoPorDia, dias: config.dias, antecedenciaHoras: config.antecedenciaHoras, cidades: config.cidades, contato: config.contato },
    pedido: c.pedido,
    preco: c.preco,
    pagamento: mostraPagamento
      ? {
          linkCartao: config.pagamento.linkCartao,
          linkPix: config.pagamento.linkPix,
          instrucoes: config.pagamento.instrucoes,
          valorTotal: c.preco ? c.preco.total : null,
          comprovanteEnviadoEm: c.pagamento.comprovante ? c.pagamento.comprovante.enviadoEm : null,
          confirmadoEm: c.pagamento.confirmadoEm,
          notaDoAdmin: c.pagamento.notaDoAdmin,
        }
      : null,
  };
};

export type ImagemValida = { ok: true; mime: "image/jpeg" | "image/png" | "image/webp"; bytes: number; dataUri: string } | { ok: false; error: string };

/** O comprovante: só JPEG, PNG ou WebP (conferido pelos primeiros bytes, não pelo que o navegador diz), até 3 MB. */
export const validarImagem = (valor: unknown): ImagemValida => {
  if (typeof valor !== "string") return { ok: false, error: "Envie a imagem do comprovante." };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(valor);
  if (!m) return { ok: false, error: "Envie o comprovante como imagem (JPG, PNG ou WebP)." };
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith("==") ? 2 : m[2].endsWith("=") ? 1 : 0);
  if (bytes <= 0) return { ok: false, error: "Imagem vazia." };
  if (bytes > COMPROVANTE_MAX_BYTES) return { ok: false, error: "A imagem passa de 3 MB. Reduza e envie de novo." };
  const inicio = Buffer.from(m[2].slice(0, 24), "base64");
  const jpeg = inicio[0] === 0xff && inicio[1] === 0xd8 && inicio[2] === 0xff;
  const png = inicio.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = inicio.subarray(0, 4).toString("ascii") === "RIFF" && inicio.subarray(8, 12).toString("ascii") === "WEBP";
  const mime = m[1] as "image/jpeg" | "image/png" | "image/webp";
  const confere = (mime === "image/jpeg" && jpeg) || (mime === "image/png" && png) || (mime === "image/webp" && webp);
  if (!confere) return { ok: false, error: "O arquivo não é uma imagem válida." };
  return { ok: true, mime, bytes, dataUri: valor };
};

/** Conta do Cloudinary dos anúncios e comprovantes. Para os comprovantes ela é OBRIGATÓRIA (nunca cai na conta de usuários): sem as 3 variáveis, devolve null. */
export const contaDosComprovantes = (env: NodeJS.ProcessEnv = process.env): { cloud_name: string; api_key: string; api_secret: string } | null => {
  const cloud_name = env.CLOUDINARY_NAME_ANUNCIOS;
  const api_key = env.CLOUDINARY_KEY_ANUNCIOS;
  const api_secret = env.CLOUDINARY_SECRET_ANUNCIOS;
  return cloud_name && api_key && api_secret ? { cloud_name, api_key, api_secret } : null;
};

/** Quem está chamando, como texto anônimo (hash do IP com sal): serve só para limitar tentativas, nunca para identificar a pessoa. */
export const chaveDoIp = (req: VercelRequest, env: NodeJS.ProcessEnv = process.env): string => {
  const forwarded = req.headers["x-forwarded-for"];
  const real = req.headers["x-real-ip"];
  const first = typeof forwarded === "string" ? (forwarded.split(",")[0] ?? "").trim() : "";
  const ip = first || (typeof real === "string" ? real.trim() : "") || "desconhecido";
  return `ip_${createHash("sha256").update(`${env.ADS_IP_SALT ?? "tugyn"}:${ip}`).digest("hex").slice(0, 24)}`;
};
