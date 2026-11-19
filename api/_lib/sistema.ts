import type { VercelRequest } from "@vercel/node";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { compareVersions } from "./version";

/**
 * Saúde do sistema e configuração remota do app (painel › Plataforma › Saúde do sistema).
 *
 *  - `sistema/rotinas`: cada rotina automática grava aqui a última execução (quando, se deu certo, quanto durou, problemas),
 *    para o painel mostrar se alguma parou. Só o servidor lê e grava (as regras não liberam `sistema/*` para o app).
 *  - `sistema/config`: versão mínima/mais recente por plataforma, aviso exibido no app e interruptores de funções. Editada
 *    pelo painel (só administradores); a rota pública /api/version a lê (com cache curto) por cima das variáveis da Vercel.
 *  - `versoesApp/{uid}`: versão e plataforma do app de cada usuário, vista pela API no máximo 1 vez por dia; serve só para
 *    o painel saber quantos usuários estão em cada versão (antes de exigir uma versão nova).
 */

export const DOC_ROTINAS = "sistema/rotinas";
export const DOC_CONFIG = "sistema/config";
export const VERSOES_APP = "versoesApp";

export const ROTINAS = ["rotina_diaria", "pendencias_estatisticas", "push_reenvio", "push_recibos"] as const;
export type NomeRotina = (typeof ROTINAS)[number];

const VERSAO_RE = /^\d{1,4}(?:\.\d{1,4}){1,2}$/;
export const versaoValida = (v: unknown): v is string => typeof v === "string" && VERSAO_RE.test(v);

const numerosPequenos = (resumo: Record<string, unknown> | undefined): Record<string, number> => {
  const saida: Record<string, number> = {};
  for (const [k, v] of Object.entries(resumo ?? {}).slice(0, 15)) {
    if (/^[A-Za-z_]{1,40}$/.test(k) && typeof v === "number" && Number.isFinite(v)) saida[k] = Math.round(v);
  }
  return saida;
};

/**
 * Registra a execução de uma rotina. Melhor esforço: uma falha aqui nunca derruba a rotina (só vira log).
 * `falhas.{nome}` guarda a hora da última execução com problema (continua lá depois de uma execução boa).
 */
export const registrarRotina = async (
  db: Firestore,
  nome: NomeRotina,
  r: { ok: boolean; duracaoMs: number; problemas?: string[]; resumo?: Record<string, unknown> },
): Promise<void> => {
  const registro = {
    em: FieldValue.serverTimestamp(),
    ok: r.ok,
    duracaoMs: Math.max(0, Math.round(r.duracaoMs)),
    problemas: (r.problemas ?? []).slice(0, 10).map((p) => String(p).slice(0, 80)),
    resumo: numerosPequenos(r.resumo),
  };
  const campos: string[] = [nome];
  const dados: Record<string, unknown> = { [nome]: registro };
  if (!r.ok) {
    dados.falhas = { [nome]: FieldValue.serverTimestamp() };
    campos.push(`falhas.${nome}`);
  }
  try {
    await db.doc(DOC_ROTINAS).set(dados, { mergeFields: campos });
  } catch (erro) {
    console.warn(JSON.stringify({ evt: "rotina_registro_falhou", nome, message: (erro as Error)?.message ?? String(erro) }));
  }
};

// ─── Configuração remota ──────────────────────────────────────────────────────────────────────────────────────────────

export type Plataforma = "ios" | "android";
export const FUNCOES = ["desafios", "amistosos", "anuncios", "acompanharConfirmacoes"] as const;
export type Funcao = (typeof FUNCOES)[number];

/** Onde o app convida para o Tugyn Apoiador (cada um pode ser desligado no painel). */
export const CONVITES_APOIADOR = ["perfil", "inicio", "configuracoes", "posPartida", "espacoAnuncio"] as const;
export type ConviteApoiador = (typeof CONVITES_APOIADOR)[number];

/**
 * Divulgação do Tugyn Apoiador, editada no painel sem atualizar o app. O valor COBRADO é sempre o da loja (Play / App Store);
 * os preços daqui são só o texto dos convites (vazio = o app mostra o preço da loja, ou nenhum se a loja não respondeu).
 */
/** Acesso antecipado: cada novidade do app (pelo id usado no código) pode estar desligada, só para apoiadores ou para todos. */
export const ESTADOS_NOVIDADE = ["desligada", "apoiadores", "todos"] as const;
export type EstadoNovidade = (typeof ESTADOS_NOVIDADE)[number];
export interface NovidadeAntecipada {
  /** Mesmo id usado no app (useNovidadeLiberada). */
  id: string;
  /** Nome mostrado na tela do Apoiador. */
  titulo: string;
  estado: EstadoNovidade;
}
export const NOVIDADES_MAX = 30;
export const NOVIDADE_TITULO_MAX = 60;
export const ID_NOVIDADE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export interface ConfigApoiador {
  convites: Record<ConviteApoiador, boolean>;
  /** Ex.: "R$ 4,90". */
  precoMensal: string | null;
  /** Ex.: "R$ 39,90". */
  precoAnual: string | null;
  /** Depois de "Agora não" (ou do convite pós-partida), quantos dias até convidar de novo. */
  diasEntreConvites: number;
  /** Partidas salvas pelo usuário antes do primeiro convite pós-partida. */
  partidasParaConvite: number;
  novidades: NovidadeAntecipada[];
}

export const PRECO_APOIADOR_MAX = 20;
export const DIAS_CONVITE = { min: 1, max: 365, padrao: 30 } as const;
export const PARTIDAS_CONVITE = { min: 1, max: 100, padrao: 5 } as const;

export const APOIADOR_PADRAO: ConfigApoiador = {
  convites: { perfil: true, inicio: true, configuracoes: true, posPartida: true, espacoAnuncio: true },
  precoMensal: null,
  precoAnual: null,
  diasEntreConvites: DIAS_CONVITE.padrao,
  partidasParaConvite: PARTIDAS_CONVITE.padrao,
  novidades: [],
};

export interface ConfigSistema {
  versoes: Record<Plataforma, { min: string | null; latest: string | null }>;
  /** Texto da tela/faixa de atualização (substitui APP_UPDATE_MESSAGE quando preenchido). */
  mensagemAtualizacao: string | null;
  /** Aviso exibido no topo do app (manutenção, instabilidade). null = sem aviso. */
  aviso: string | null;
  /** false = função desligada (o servidor recusa ações novas; o app esconde o que depende dela). */
  funcoes: Record<Funcao, boolean>;
  apoiador: ConfigApoiador;
}

export const CONFIG_PADRAO: ConfigSistema = {
  versoes: { ios: { min: null, latest: null }, android: { min: null, latest: null } },
  mensagemAtualizacao: null,
  aviso: null,
  funcoes: { desafios: true, amistosos: true, anuncios: true, acompanharConfirmacoes: true },
  apoiador: APOIADOR_PADRAO,
};

export const MENSAGEM_MAX = 200;
export const AVISO_MAX = 160;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const textoOuNull = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const versaoOuNull = (v: unknown): string | null => (versaoValida(v) ? v : null);
const inteiroEntre = (v: unknown, faixa: { min: number; max: number; padrao: number }): number =>
  typeof v === "number" && Number.isInteger(v) && v >= faixa.min && v <= faixa.max ? v : faixa.padrao;
/** Texto de preço: precisa ter algum número (evita que um texto qualquer apareça no lugar do valor). */
const precoOuNull = (v: unknown): string | null => {
  const t = textoOuNull(v, PRECO_APOIADOR_MAX);
  return t && /\d/.test(t) ? t : null;
};

/** Lista de novidades do documento: descarta itens inválidos e ids repetidos (nunca quebra a política). */
export const normalizarNovidades = (bruto: unknown): NovidadeAntecipada[] => {
  if (!Array.isArray(bruto)) return [];
  const vistos = new Set<string>();
  const saida: NovidadeAntecipada[] = [];
  for (const item of bruto) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID_NOVIDADE_RE.test(item.id) || vistos.has(item.id)) continue;
    const titulo = textoOuNull(item.titulo, NOVIDADE_TITULO_MAX);
    if (!titulo) continue;
    const estado = (ESTADOS_NOVIDADE as readonly unknown[]).includes(item.estado) ? (item.estado as EstadoNovidade) : "desligada";
    vistos.add(item.id);
    saida.push({ id: item.id, titulo, estado });
    if (saida.length >= NOVIDADES_MAX) break;
  }
  return saida;
};

export const normalizarApoiador = (bruto: unknown): ConfigApoiador => {
  const a = isRecord(bruto) ? bruto : {};
  const c = isRecord(a.convites) ? a.convites : {};
  return {
    convites: Object.fromEntries(CONVITES_APOIADOR.map((k) => [k, c[k] !== false])) as Record<ConviteApoiador, boolean>,
    precoMensal: precoOuNull(a.precoMensal),
    precoAnual: precoOuNull(a.precoAnual),
    diasEntreConvites: inteiroEntre(a.diasEntreConvites, DIAS_CONVITE),
    partidasParaConvite: inteiroEntre(a.partidasParaConvite, PARTIDAS_CONVITE),
    novidades: normalizarNovidades(a.novidades),
  };
};

/** Lê o documento campo a campo: o que estiver inválido volta ao padrão (nunca bloqueia por erro de configuração). */
export const normalizarConfig = (bruto: unknown): ConfigSistema => {
  const d = isRecord(bruto) ? bruto : {};
  const v = isRecord(d.versoes) ? d.versoes : {};
  const plataforma = (p: Plataforma) => {
    const x = isRecord(v[p]) ? (v[p] as Record<string, unknown>) : {};
    return { min: versaoOuNull(x.min), latest: versaoOuNull(x.latest) };
  };
  const f = isRecord(d.funcoes) ? d.funcoes : {};
  return {
    versoes: { ios: plataforma("ios"), android: plataforma("android") },
    mensagemAtualizacao: textoOuNull(d.mensagemAtualizacao, MENSAGEM_MAX),
    aviso: textoOuNull(d.aviso, AVISO_MAX),
    funcoes: {
      desafios: f.desafios !== false,
      amistosos: f.amistosos !== false,
      anuncios: f.anuncios !== false,
      acompanharConfirmacoes: f.acompanharConfirmacoes !== false,
    },
    apoiador: normalizarApoiador(d.apoiador),
  };
};

const CACHE_CONFIG_MS = 30_000;
let cacheConfig: { valor: ConfigSistema; em: number } | null = null;

/**
 * Configuração atual, com cache de 30 s por instância. Se o Firestore falhar, usa a última lida (ou o padrão, que
 * deixa tudo ligado e sem versão mínima): problema de leitura nunca desliga função nem bloqueia o app.
 */
export const lerConfig = async (db: Firestore, agora = Date.now()): Promise<ConfigSistema> => {
  if (cacheConfig && agora - cacheConfig.em < CACHE_CONFIG_MS) return cacheConfig.valor;
  try {
    const snap = await db.doc(DOC_CONFIG).get();
    const valor = normalizarConfig(snap.exists ? snap.data() : null);
    cacheConfig = { valor, em: agora };
    return valor;
  } catch (erro) {
    console.warn(JSON.stringify({ evt: "config_sistema_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return cacheConfig?.valor ?? CONFIG_PADRAO;
  }
};

/**
 * Para decisões em que supor "ligado" é pior do que esperar (ex.: encerrar Live Activities quando a função foi desligada).
 * true/false só com leitura confiável (do Firestore ou do cache de 30 s). Se a leitura falhar, mantém o último estado
 * conhecido apenas se ele for "desligado"; caso contrário devolve null, e quem chama não age agora e tenta de novo depois.
 * (Não muda `lerConfig`, que continua "falha aberta" para versão mínima e as demais funções.)
 */
export const funcaoLigadaConfiavel = async (db: Firestore, funcao: Funcao, agora = Date.now()): Promise<boolean | null> => {
  if (cacheConfig && agora - cacheConfig.em < CACHE_CONFIG_MS) return cacheConfig.valor.funcoes[funcao];
  try {
    const snap = await db.doc(DOC_CONFIG).get();
    const valor = normalizarConfig(snap.exists ? snap.data() : null);
    cacheConfig = { valor, em: agora };
    return valor.funcoes[funcao];
  } catch (erro) {
    console.warn(JSON.stringify({ evt: "config_sistema_falhou_estrito", funcao, message: (erro as Error)?.message ?? String(erro) }));
    return cacheConfig && !cacheConfig.valor.funcoes[funcao] ? false : null;
  }
};

export interface PoliticaPublica {
  minVersion: string | null;
  latestVersion: string | null;
  storeUrl: string | null;
  message: string | null;
  aviso: string | null;
  funcoes: Record<Funcao, boolean>;
  apoiador: ConfigApoiador;
}

/**
 * Política que a rota pública devolve: o que estiver preenchido no painel vale por cima das variáveis da Vercel. Se a
 * mínima ficar maior que a mais recente, usa a mais recente (ninguém fica sem conseguir atualizar).
 */
export const aplicarConfigRemota = (
  base: { minVersion: string | null; latestVersion: string | null; storeUrl: string | null; message: string | null },
  cfg: ConfigSistema,
  plataforma: Plataforma | null,
): PoliticaPublica => {
  const remota = plataforma ? cfg.versoes[plataforma] : { min: null, latest: null };
  let minVersion = remota.min ?? base.minVersion;
  const latestVersion = remota.latest ?? base.latestVersion;
  if (minVersion && latestVersion && compareVersions(minVersion, latestVersion) > 0) minVersion = latestVersion;
  return {
    minVersion,
    latestVersion,
    storeUrl: base.storeUrl,
    message: cfg.mensagemAtualizacao ?? base.message,
    aviso: cfg.aviso,
    funcoes: { ...cfg.funcoes },
    apoiador: { ...cfg.apoiador, convites: { ...cfg.apoiador.convites }, novidades: cfg.apoiador.novidades.map((n) => ({ ...n })) },
  };
};

/** Depois de salvar pelo painel: a próxima leitura nesta instância já vê o valor novo. */
export const esquecerConfig = (): void => {
  cacheConfig = null;
};

/** Recusa padronizada de uma função desligada (o app mostra a mensagem). */
export const FUNCAO_DESLIGADA: Record<Funcao, string> = {
  acompanharConfirmacoes: "O acompanhamento de confirmações está temporariamente indisponível. Sua presença continua confirmada.",
  desafios: "Os desafios estão temporariamente indisponíveis. Tente novamente mais tarde.",
  amistosos: "Os amistosos estão temporariamente indisponíveis. Tente novamente mais tarde.",
  anuncios: "Os anúncios estão temporariamente desligados.",
};

// ─── Versão do app de cada usuário ─────────────────────────────────────────────────────────────────────────────────────

const diaSP = (ms: number): string => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
const vistos = new Map<string, string>();

/** Lê os cabeçalhos que o app manda (`X-App-Version`, `X-App-Platform`); null se faltarem ou forem inválidos. */
export const versaoDoPedido = (req: Pick<VercelRequest, "headers">): { versao: string; plataforma: Plataforma } | null => {
  const ler = (nome: string) => {
    const v = req.headers?.[nome];
    return typeof v === "string" ? v.trim() : Array.isArray(v) ? String(v[0] ?? "").trim() : "";
  };
  const versao = ler("x-app-version");
  const plataforma = ler("x-app-platform");
  if (!versaoValida(versao) || (plataforma !== "ios" && plataforma !== "android")) return null;
  return { versao, plataforma };
};

/**
 * Registra a versão do app deste usuário no máximo 1 vez por dia por instância (memória) — o painel só precisa da
 * distribuição. Melhor esforço: falha só vira log, e o pedido segue normalmente.
 */
export const registrarVersaoDoApp = async (
  db: Firestore,
  uid: string,
  req: Pick<VercelRequest, "headers">,
  agora = Date.now(),
): Promise<boolean> => {
  const v = versaoDoPedido(req);
  if (!v) return false;
  const chave = `${diaSP(agora)}|${v.versao}|${v.plataforma}`;
  if (vistos.get(uid) === chave) return false;
  if (vistos.size > 5000) vistos.clear();
  vistos.set(uid, chave);
  try {
    await db.doc(`${VERSOES_APP}/${uid}`).set({ uid, versao: v.versao, plataforma: v.plataforma, vistoEm: FieldValue.serverTimestamp() });
    return true;
  } catch (erro) {
    vistos.delete(uid);
    console.warn(JSON.stringify({ evt: "versao_app_registro_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return false;
  }
};
