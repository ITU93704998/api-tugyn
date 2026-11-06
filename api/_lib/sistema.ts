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
export const FUNCOES = ["desafios", "amistosos", "anuncios"] as const;
export type Funcao = (typeof FUNCOES)[number];

export interface ConfigSistema {
  versoes: Record<Plataforma, { min: string | null; latest: string | null }>;
  /** Texto da tela/faixa de atualização (substitui APP_UPDATE_MESSAGE quando preenchido). */
  mensagemAtualizacao: string | null;
  /** Aviso exibido no topo do app (manutenção, instabilidade). null = sem aviso. */
  aviso: string | null;
  /** false = função desligada (o servidor recusa ações novas; o app esconde o que depende dela). */
  funcoes: Record<Funcao, boolean>;
}

export const CONFIG_PADRAO: ConfigSistema = {
  versoes: { ios: { min: null, latest: null }, android: { min: null, latest: null } },
  mensagemAtualizacao: null,
  aviso: null,
  funcoes: { desafios: true, amistosos: true, anuncios: true },
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
    },
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

export interface PoliticaPublica {
  minVersion: string | null;
  latestVersion: string | null;
  storeUrl: string | null;
  message: string | null;
  aviso: string | null;
  funcoes: Record<Funcao, boolean>;
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
  };
};

/** Depois de salvar pelo painel: a próxima leitura nesta instância já vê o valor novo. */
export const esquecerConfig = (): void => {
  cacheConfig = null;
};

/** Recusa padronizada de uma função desligada (o app mostra a mensagem). */
export const FUNCAO_DESLIGADA: Record<Funcao, string> = {
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
