import { randomBytes } from "node:crypto";
import type { VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { type DocumentReference, FieldValue, type Firestore } from "firebase-admin/firestore";
import { validateCampaignInput } from "./adCore";
import { bannerOk, montarCampanha, validarAnuncio } from "./anuncioContrato";
import { type ConfigContratos, datasAoAprovar, linkExpirado, proximoStatus } from "./contratoCore";
import { ContratoModelo, MODELO_DOC, PDF_URL_SEGUNDOS, acharVersao, limparNomePdf, parseModelo, proximaVersao, validarPdf } from "./contratoModelo";
import { Conflito, Invalido, NaoEncontrado, lerNaTransacao, responder } from "./contratosComuns";
import { type ContratoDoc, comHistorico, contaDosComprovantes, limparTexto, validarImagem, visaoPublica } from "./contratos";

/**
 * Fase 2 do contrato: o contrato em PDF, o anúncio do cliente (texto ou banner 3,2 : 1) com o aceite, e a análise (aprovar ou pedir ajustes).
 * Tudo roda dentro da rota `api/contratos`; cada mudança de etapa é conferida DENTRO da transação.
 */

const ETAPAS_COM_PDF = ["pago", "em_analise", "ajustes_solicitados", "aprovado"] as const;
const ID_CAMPANHAS = "adCampaigns";

export interface CtxCliente {
  db: Firestore;
  res: VercelResponse;
  body: Record<string, unknown>;
  agora: number;
  encontrado: { ref: DocumentReference; data: ContratoDoc };
  config: ConfigContratos;
  /** Hash anônimo do IP (só serve de registro do aceite). */
  ipHash: string;
}

export const lerModelo = async (db: Firestore): Promise<ContratoModelo | null> => {
  const snapshot = await db.doc(MODELO_DOC).get();
  return snapshot.exists ? parseModelo(snapshot.data()) : null;
};

const urlDoPdf = (conta: { cloud_name: string; api_key: string; api_secret: string }, publicId: string, agora: number): { url: string; expiraEmS: number } => {
  const expiraEmS = Math.floor(agora / 1000) + PDF_URL_SEGUNDOS;
  // arquivo "raw" PRIVADO: só abre por este endereço assinado, que expira em 5 minutos
  return { url: cloudinary.utils.private_download_url(publicId, "", { ...conta, resource_type: "raw", type: "authenticated", expires_at: expiraEmS }), expiraEmS };
};

const destruir = (conta: { cloud_name: string; api_key: string; api_secret: string }, publicId: string, tipo: "upload" | "authenticated", recurso: "image" | "raw") =>
  cloudinary.uploader.destroy(publicId, { ...conta, type: tipo, resource_type: recurso }).catch(() => undefined);

const aleatorio = (): string => randomBytes(12).toString("base64url");

// ─────────────────────────── CLIENTE ───────────────────────────

/** O cliente abre o contrato (PDF): devolve um endereço temporário e REGISTRA que esta versão foi aberta (condição para aceitar). */
export const clientePdf = async (c: CtxCliente) => {
  const { db, res, encontrado, agora } = c;
  if (!(ETAPAS_COM_PDF as readonly string[]).includes(encontrado.data.status)) return responder(res, 409, { error: "O contrato fica disponível depois da confirmação do pagamento." });
  const modelo = await lerModelo(db);
  if (!modelo) return responder(res, 404, { error: "O contrato ainda não está disponível. Fale com a Tugyn ADS." });
  const conta = contaDosComprovantes();
  if (!conta) return responder(res, 503, { error: "O contrato ainda não está disponível. Fale com a Tugyn ADS." });
  const { url, expiraEmS } = urlDoPdf(conta, modelo.publicId, agora);
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, encontrado.ref);
      if (atual.tokenHash !== encontrado.data.tokenHash || linkExpirado(atual, agora) || !(ETAPAS_COM_PDF as readonly string[]).includes(atual.status)) throw new Conflito();
      tx.update(encontrado.ref, { pdfSolicitado: { versao: modelo.versao, em: agora }, atualizadoEm: agora });
    });
  } catch (error) {
    if (error instanceof Conflito || error instanceof NaoEncontrado) return responder(res, 409, { error: "O contrato mudou. Atualize a página." });
    throw error;
  }
  return responder(res, 200, { url, versao: modelo.versao, nome: modelo.nome, expiraEm: expiraEmS * 1000 });
};

/** O cliente envia a imagem do banner: sobe para o Cloudinary (pública, na pasta do administrador) e SÓ fica se tiver a proporção 3,2 : 1. */
export const clienteImagem = async (c: CtxCliente) => {
  const { db, res, body, agora, encontrado, config } = c;
  const d = encontrado.data;
  if (!proximoStatus(d.status, "enviar_anuncio", "cliente") || !d.pedido) return responder(res, 409, { error: "Não é possível enviar a imagem neste momento." });
  if (d.pedido.modelo !== "banner") return responder(res, 409, { error: "Este contrato é de anúncio só de texto: não leva imagem." });
  const imagem = validarImagem(body.imagem);
  if (!imagem.ok) return responder(res, 400, { error: imagem.error });
  const conta = contaDosComprovantes();
  if (!conta) return responder(res, 503, { error: "O envio de imagens ainda não está disponível. Fale com a Tugyn ADS." });

  const enviado = await cloudinary.uploader.upload(imagem.dataUri, {
    ...conta,
    // `anuncios/<uid do administrador>/contratos/<nome>`: o painel reconhece esse caminho e apaga a imagem junto com a campanha
    folder: `anuncios/${d.criadoPor || "contratos"}/contratos`,
    public_id: aleatorio(),
    type: "upload",
    resource_type: "image",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    tags: ["anuncio", `contrato_${encontrado.ref.id}`],
  });
  const largura = Number(enviado.width);
  const altura = Number(enviado.height);
  if (!bannerOk(largura, altura)) {
    await destruir(conta, enviado.public_id, "upload", "image");
    return responder(res, 400, { error: "A imagem precisa ter a proporção 3,2 : 1 (por exemplo, 1280 × 400). Use o recorte da página." });
  }
  let anterior: string | null = null;
  let gravado: ContratoDoc | null = null;
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, encontrado.ref);
      if (atual.tokenHash !== d.tokenHash || linkExpirado(atual, agora) || !proximoStatus(atual.status, "enviar_anuncio", "cliente")) throw new Conflito();
      anterior = atual.rascunhoImagem ? atual.rascunhoImagem.publicId : null;
      const rascunhoImagem = { url: String(enviado.secure_url), publicId: enviado.public_id, largura, altura, bytes: Number(enviado.bytes ?? imagem.bytes) };
      gravado = { ...atual, rascunhoImagem, atualizadoEm: agora };
      tx.update(encontrado.ref, { rascunhoImagem, atualizadoEm: agora });
    });
  } catch (error) {
    await destruir(conta, enviado.public_id, "upload", "image");
    if (error instanceof Conflito || error instanceof NaoEncontrado) return responder(res, 409, { error: "O contrato mudou. Atualize a página." });
    throw error;
  }
  // o rascunho anterior (se não for o do anúncio já enviado) não serve mais
  const g = gravado as unknown as ContratoDoc;
  if (anterior && anterior !== enviado.public_id && !(g.anuncio?.imagem && g.anuncio.imagem.publicId === anterior)) await destruir(conta, anterior, "upload", "image");
  return responder(res, 200, { contrato: visaoPublica(g, config, agora, await lerModelo(db)) });
};

/** O cliente envia o anúncio para análise, aceitando o contrato (só depois de ABRIR o PDF desta versão). */
export const clienteEnviarAnuncio = async (c: CtxCliente) => {
  const { db, res, body, agora, encontrado, config, ipHash } = c;
  const d = encontrado.data;
  const proximo = proximoStatus(d.status, "enviar_anuncio", "cliente");
  if (!proximo || !d.pedido) return responder(res, 409, { error: "Não é possível enviar o anúncio neste momento." });
  const modelo = await lerModelo(db);
  if (!modelo) return responder(res, 503, { error: "O contrato ainda não está disponível. Fale com a Tugyn ADS." });
  if (!(d.pdfSolicitado && d.pdfSolicitado.versao === modelo.versao)) return responder(res, 409, { error: "Abra e leia o contrato antes de enviar o anúncio." });
  const jaAceitou = d.aceite !== null && d.aceite.versao === modelo.versao;
  if (!jaAceitou && body.aceito !== true) return responder(res, 400, { error: "Confirme que você leu e concorda com o contrato." });
  const imagem = d.pedido.modelo === "banner" ? (d.rascunhoImagem ?? d.anuncio?.imagem ?? null) : null;
  const v = validarAnuncio(d.pedido.modelo, body.anuncio, imagem);
  if (!v.ok) return responder(res, 400, { error: Object.values(v.erros)[0] ?? "Anúncio inválido.", erros: v.erros });
  // ensaio da aprovação: o anúncio já precisa passar na validação OFICIAL de campanhas (senão você não conseguiria aprovar)
  const ensaio = validateCampaignInput(montarCampanha({ codigo: d.codigo, clienteNome: d.cliente.nome, modelo: d.pedido.modelo, telas: d.pedido.telas, escopo: d.pedido.escopo, cidadeId: d.pedido.cidade ? d.pedido.cidade.id : null, anuncio: v.anuncio, inicioMs: d.pedido.inicioMs, fimMs: d.pedido.fimMs }));
  if (!ensaio.ok) return responder(res, 400, { error: Object.values(ensaio.errors)[0] ?? "O anúncio não passou na validação.", erros: ensaio.errors });

  let gravado: ContratoDoc | null = null;
  let imagemAntiga: string | null = null;
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, encontrado.ref);
      const novoStatus = proximoStatus(atual.status, "enviar_anuncio", "cliente");
      if (atual.tokenHash !== d.tokenHash || linkExpirado(atual, agora) || !novoStatus || !atual.pdfSolicitado || atual.pdfSolicitado.versao !== modelo.versao) throw new Conflito();
      const aceite = jaAceitou && atual.aceite && atual.aceite.versao === modelo.versao ? atual.aceite : { versao: modelo.versao, sha256: modelo.sha256, nomeArquivo: modelo.nome, aceitoEm: agora, ipHash, pdfAbertoEm: atual.pdfSolicitado.em };
      const anuncio = { ...v.anuncio, enviadoEm: agora };
      imagemAntiga = atual.anuncio?.imagem && v.anuncio.imagem && atual.anuncio.imagem.publicId !== v.anuncio.imagem.publicId ? atual.anuncio.imagem.publicId : null;
      const historico = comHistorico(atual.historico, { em: agora, por: "cliente", acao: jaAceitou ? "reenviou o anúncio" : "enviou o anúncio e aceitou o contrato", nota: `contrato v${modelo.versao}` });
      gravado = { ...atual, status: novoStatus, anuncio, rascunhoImagem: null, aceite, ajustes: null, atualizadoEm: agora, historico };
      tx.update(encontrado.ref, { status: novoStatus, anuncio, rascunhoImagem: null, aceite, ajustes: null, atualizadoEm: agora, historico });
    });
  } catch (error) {
    if (error instanceof Conflito || error instanceof NaoEncontrado) return responder(res, 409, { error: "O contrato mudou. Atualize a página." });
    throw error;
  }
  const conta = contaDosComprovantes();
  if (imagemAntiga && conta) await destruir(conta, imagemAntiga, "upload", "image"); // a imagem que foi trocada no reenvio
  return responder(res, 200, { contrato: visaoPublica(gravado as unknown as ContratoDoc, config, agora, modelo) });
};

// ─────────────────────────── ADMINISTRADOR ───────────────────────────

/** Cadastra uma versão nova do contrato em PDF (a anterior fica guardada). */
export const adminModeloEnviar = async (db: Firestore, body: Record<string, unknown>, uid: string, agora: number, res: VercelResponse) => {
  const pdf = validarPdf(body.pdf);
  if (!pdf.ok) return responder(res, 400, { error: pdf.error });
  const conta = contaDosComprovantes();
  if (!conta) return responder(res, 503, { error: "Conta do Cloudinary dos anúncios não configurada." });
  const nome = limparNomePdf(body.nome);
  const enviado = await cloudinary.uploader.upload(pdf.dataUri, { ...conta, resource_type: "raw", type: "authenticated", folder: "contrato-modelo", public_id: `contrato-${aleatorio()}.pdf`, tags: ["contrato-modelo"] });
  let versao = 0;
  try {
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(db.doc(MODELO_DOC));
      const novo = proximaVersao(snapshot.exists ? parseModelo(snapshot.data()) : null, { nome, bytes: pdf.bytes, sha256: pdf.sha256, publicId: enviado.public_id }, agora, uid);
      versao = novo.versao;
      tx.set(db.doc(MODELO_DOC), novo as unknown as Record<string, unknown>);
    });
  } catch (error) {
    await destruir(conta, enviado.public_id, "authenticated", "raw");
    throw error;
  }
  return responder(res, 200, { ok: true, versao, nome, bytes: pdf.bytes });
};

/** Endereço temporário (5 minutos) do PDF, para o administrador conferir (a versão atual ou uma anterior). */
export const adminModeloUrl = async (db: Firestore, body: Record<string, unknown>, agora: number, res: VercelResponse) => {
  const modelo = await lerModelo(db);
  if (!modelo) return responder(res, 404, { error: "Nenhum contrato cadastrado ainda." });
  const pedida = typeof body.versao === "number" && Number.isInteger(body.versao) ? body.versao : undefined;
  const versao = acharVersao(modelo, pedida);
  if (!versao) return responder(res, 404, { error: "Versão não encontrada." });
  const conta = contaDosComprovantes();
  if (!conta) return responder(res, 503, { error: "Conta do Cloudinary dos anúncios não configurada." });
  const { url, expiraEmS } = urlDoPdf(conta, versao.publicId, agora);
  return responder(res, 200, { url, versao: versao.versao, nome: versao.nome, expiraEm: expiraEmS * 1000 });
};

/**
 * Aprova: cria a campanha (ATIVA, com as datas do contrato; se o início já passou, começa agora e mantém os dias) e marca o contrato
 * como aprovado, TUDO na mesma transação. Publicar para o app é feito pelo painel logo depois (a mesma função do botão Publicar).
 */
export const adminAprovar = async (db: Firestore, ref: DocumentReference, uid: string, agora: number, res: VercelResponse) => {
  let resposta: Record<string, unknown> = {};
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, ref);
      const novoStatus = proximoStatus(atual.status, "aprovar", "admin");
      if (!novoStatus || !atual.anuncio || !atual.pedido) throw new Conflito();
      const datas = datasAoAprovar(atual.pedido, agora);
      const entrada = montarCampanha({ codigo: atual.codigo, clienteNome: atual.cliente.nome, modelo: atual.pedido.modelo, telas: atual.pedido.telas, escopo: atual.pedido.escopo, cidadeId: atual.pedido.cidade ? atual.pedido.cidade.id : null, anuncio: atual.anuncio, inicioMs: datas.inicioMs, fimMs: datas.fimMs });
      const validada = validateCampaignInput(entrada);
      if (!validada.ok) throw new Invalido(Object.values(validada.errors)[0] ?? "A campanha não passou na validação.", validada.errors);
      const campanha = db.collection(ID_CAMPANHAS).doc();
      tx.set(campanha, { ...validada.value, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      const pedido = { ...atual.pedido, inicioMs: datas.inicioMs, fimMs: datas.fimMs };
      const historico = comHistorico(atual.historico, { em: agora, por: "admin", acao: "aprovou o anúncio", nota: datas.deslocado ? "início ajustado para a aprovação (os dias contratados foram mantidos)" : "campanha criada" });
      tx.update(ref, { status: novoStatus, campanhaId: campanha.id, pedido, tokenExpiresAt: datas.fimMs, aprovadoEm: agora, ajustes: null, atualizadoEm: agora, historico, aprovadoPor: uid });
      resposta = { ok: true, campanhaId: campanha.id, inicioMs: datas.inicioMs, fimMs: datas.fimMs, deslocado: datas.deslocado };
    });
  } catch (error) {
    if (error instanceof NaoEncontrado) return responder(res, 404, { error: "Contrato não encontrado." });
    if (error instanceof Conflito) return responder(res, 409, { error: "Esta ação não é possível na etapa atual do contrato." });
    if (error instanceof Invalido) return responder(res, 400, { error: error.message, erros: error.erros });
    throw error;
  }
  return responder(res, 200, resposta);
};

/** Pede ajustes: o cliente volta ao formulário, vê o seu recado e reenvia. */
export const adminPedirAjustes = async (db: Firestore, ref: DocumentReference, nota: string, agora: number, res: VercelResponse) => {
  const texto = limparTexto(nota, 300);
  if (texto.length < 3) return responder(res, 400, { error: "Explique ao cliente o que precisa ser corrigido." });
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, ref);
      const novoStatus = proximoStatus(atual.status, "pedir_ajustes", "admin");
      if (!novoStatus) throw new Conflito();
      tx.update(ref, { status: novoStatus, ajustes: { nota: texto, em: agora }, atualizadoEm: agora, historico: comHistorico(atual.historico, { em: agora, por: "admin", acao: "pediu ajustes no anúncio", nota: texto }) });
    });
  } catch (error) {
    if (error instanceof NaoEncontrado) return responder(res, 404, { error: "Contrato não encontrado." });
    if (error instanceof Conflito) return responder(res, 409, { error: "Esta ação não é possível na etapa atual do contrato." });
    throw error;
  }
  return responder(res, 200, { ok: true });
};
