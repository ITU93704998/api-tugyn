import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { COLECAO_EXCLUSOES } from "./exclusaoContaJob";
import { dentroDoLimite } from "./rateLimit";
import { PENDENCIAS } from "./recalculos";
import {
  AVISO_MAX,
  type ConfigSistema,
  DOC_CONFIG,
  DOC_ROTINAS,
  FUNCOES,
  MENSAGEM_MAX,
  type NomeRotina,
  type Plataforma,
  ROTINAS,
  VERSOES_APP,
  esquecerConfig,
  lerConfig,
  normalizarConfig,
  versaoValida,
} from "./sistema";
import { compareVersions, resolvePolicy } from "./version";

/**
 * POST /api/version?resource=sistema (só administradores) — painel › Plataforma › Saúde do sistema.
 *  - saude          filas (quantos itens e há quanto tempo o mais antigo espera), última execução de cada rotina,
 *                   distribuição das versões do app (30 dias) e a configuração remota em vigor
 *  - salvar-config  versão mínima/mais recente por plataforma, mensagem de atualização, aviso no app e interruptores;
 *                   cada alteração fica no histórico (`sistema/config/historico`: quem, quando, antes e depois)
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

export type Nivel = "ok" | "atencao" | "critico" | "sem_dados";

const ms = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const fn = (v as { toMillis?: unknown } | null)?.toMillis;
  if (typeof fn === "function") {
    const n = fn.call(v);
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  }
  return 0;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ─── Rotinas ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Intervalo esperado de cada rotina e a partir de quanto tempo sem rodar ela merece atenção / é crítica. */
export const ROTINA_INFO: Record<NomeRotina, { nome: string; frequencia: string; atencaoMs: number; criticoMs: number; opcional: boolean }> = {
  push_reenvio: { nome: "Reenvio de notificações", frequencia: "a cada 1 min (Functions)", atencaoMs: 5 * MIN, criticoMs: 15 * MIN, opcional: false },
  push_recibos: { nome: "Recibos das notificações", frequencia: "a cada 15 min (Functions)", atencaoMs: 45 * MIN, criticoMs: 2 * HORA, opcional: false },
  rotina_diaria: { nome: "Rotina diária (desafios, exclusões, imagens)", frequencia: "1 vez por dia (cron da Vercel)", atencaoMs: 26 * HORA, criticoMs: 50 * HORA, opcional: false },
  pendencias_estatisticas: { nome: "Recálculo de estatísticas pendentes", frequencia: "agendador externo (opcional)", atencaoMs: 26 * HORA, criticoMs: 72 * HORA, opcional: true },
};

export interface EstadoRotina {
  id: NomeRotina;
  nome: string;
  frequencia: string;
  nivel: Nivel;
  ultimaExecucao: number;
  ok: boolean | null;
  duracaoMs: number;
  problemas: string[];
  resumo: Record<string, number>;
  ultimaFalha: number;
  motivo: string;
}

export const avaliarRotina = (id: NomeRotina, registro: unknown, ultimaFalha: unknown, agora: number): EstadoRotina => {
  const info = ROTINA_INFO[id];
  const r = isRecord(registro) ? registro : null;
  const em = r ? ms(r.em) : 0;
  const base = {
    id,
    nome: info.nome,
    frequencia: info.frequencia,
    ultimaExecucao: em,
    ok: r ? r.ok === true : null,
    duracaoMs: r ? ms(r.duracaoMs) : 0,
    problemas: r && Array.isArray(r.problemas) ? r.problemas.filter((p): p is string => typeof p === "string").slice(0, 10) : [],
    resumo: r && isRecord(r.resumo) ? (Object.fromEntries(Object.entries(r.resumo).filter(([, v]) => typeof v === "number")) as Record<string, number>) : {},
    ultimaFalha: ms(ultimaFalha),
  };
  if (!em) {
    return { ...base, nivel: info.opcional ? "sem_dados" : "atencao", motivo: info.opcional ? "Ainda não executou (agendador opcional)." : "Nenhuma execução registrada ainda." };
  }
  const parada = agora - em;
  if (parada >= info.criticoMs) return { ...base, nivel: "critico", motivo: "Parou: está há muito tempo sem rodar." };
  if (parada >= info.atencaoMs) return { ...base, nivel: "atencao", motivo: "Atrasada em relação ao esperado." };
  if (base.ok === false) return { ...base, nivel: "atencao", motivo: "A última execução teve problemas." };
  return { ...base, nivel: "ok", motivo: "Rodando normalmente." };
};

// ─── Filas ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const FILA_INFO = {
  recalculos: { nome: "Recálculo de estatísticas", descricao: "turmas com perfis esperando recálculo", atencaoMs: HORA, criticoMs: DIA },
  push_pendentes: { nome: "Notificações aguardando reenvio", descricao: "avisos que falharam e serão tentados de novo", atencaoMs: 10 * MIN, criticoMs: HORA },
  push_recibos: { nome: "Recibos a conferir", descricao: "confirmações de entrega da Apple/Google", atencaoMs: HORA, criticoMs: DIA },
  eventos_turma: { nome: "Eventos de turma na fila", descricao: "avisos de turma ainda não entregues", atencaoMs: 10 * MIN, criticoMs: HORA },
  exclusoes: { nome: "Exclusões de conta em andamento", descricao: "contas com etapas de exclusão pendentes", atencaoMs: DIA, criticoMs: 3 * DIA },
} as const;
export type NomeFila = keyof typeof FILA_INFO;

export interface EstadoFila {
  id: NomeFila;
  nome: string;
  descricao: string;
  total: number | null;
  esperaMaxMs: number;
  nivel: Nivel;
}

export const avaliarFila = (id: NomeFila, total: number | null, maisAntigo: number, agora: number): EstadoFila => {
  const info = FILA_INFO[id];
  const esperaMaxMs = total && maisAntigo ? Math.max(0, agora - maisAntigo) : 0;
  let nivel: Nivel = "ok";
  if (total === null) nivel = "sem_dados";
  else if (total > 0 && esperaMaxMs >= info.criticoMs) nivel = "critico";
  else if (total > 0 && esperaMaxMs >= info.atencaoMs) nivel = "atencao";
  return { id, nome: info.nome, descricao: info.descricao, total, esperaMaxMs, nivel };
};

const contar = async (q: FirebaseFirestore.Query): Promise<number | null> => {
  try {
    return (await q.count().get()).data().count;
  } catch {
    return null;
  }
};
const maisAntigo = async (q: FirebaseFirestore.Query, campo: string): Promise<number> => {
  try {
    const s = await q.limit(1).get();
    return s.empty ? 0 : ms(s.docs[0].get(campo));
  } catch {
    return 0;
  }
};

const lerFilas = async (db: Firestore, agora: number): Promise<EstadoFila[]> => {
  const pend = db.collection(PENDENCIAS);
  const outbox = db.collection("pushDedupe").where("nextAttemptAt", "<=", agora);
  const recibos = db.collection("pushRecibos").where("verificarApos", "<=", agora);
  const eventos = db.collection("turmaPushEvents").where("state", "==", "queued");
  const exclusoes = db.collection(COLECAO_EXCLUSOES);
  const [nPend, aPend, nOut, aOut, nRec, aRec, nEv, nExc] = await Promise.all([
    contar(pend),
    maisAntigo(pend.orderBy("atualizadoEm"), "atualizadoEm"),
    contar(outbox),
    maisAntigo(outbox.orderBy("nextAttemptAt"), "nextAttemptAt"),
    contar(recibos),
    maisAntigo(recibos.orderBy("verificarApos"), "verificarApos"),
    contar(eventos),
    contar(exclusoes),
  ]);
  return [
    avaliarFila("recalculos", nPend, aPend, agora),
    avaliarFila("push_pendentes", nOut, aOut, agora),
    avaliarFila("push_recibos", nRec, aRec, agora),
    // Eventos e exclusões: sem horário confiável para ordenar; só a quantidade (muitos = atenção).
    { ...avaliarFila("eventos_turma", nEv, 0, agora), nivel: nEv === null ? "sem_dados" : nEv > 500 ? "critico" : nEv > 50 ? "atencao" : "ok" },
    { ...avaliarFila("exclusoes", nExc, 0, agora), nivel: nExc === null ? "sem_dados" : nExc > 20 ? "atencao" : "ok" },
  ];
};

// ─── Versões do app ───────────────────────────────────────────────────────────────────────────────────────────────────

export const VERSOES_LIMITE = 20_000;

export interface Distribuicao {
  geradoEm: number;
  total30d: number;
  total7d: number;
  /** A consulta bateu no limite: os números são uma amostra (os mais recentes ficam de fora). */
  parcial: boolean;
  versoes: Array<{ versao: string; plataforma: Plataforma; usuarios30d: number; usuarios7d: number }>;
}

export const resumirVersoes = (docs: Array<{ versao: unknown; plataforma: unknown; vistoEm: unknown }>, agora: number, parcial = false): Distribuicao => {
  const mapa = new Map<string, { versao: string; plataforma: Plataforma; usuarios30d: number; usuarios7d: number }>();
  let total30d = 0;
  let total7d = 0;
  for (const d of docs) {
    if (!versaoValida(d.versao) || (d.plataforma !== "ios" && d.plataforma !== "android")) continue;
    const visto = ms(d.vistoEm);
    if (!visto || agora - visto > 30 * DIA) continue;
    const recente = agora - visto <= 7 * DIA;
    const chave = `${d.plataforma}|${d.versao}`;
    const item = mapa.get(chave) ?? { versao: d.versao, plataforma: d.plataforma, usuarios30d: 0, usuarios7d: 0 };
    item.usuarios30d++;
    total30d++;
    if (recente) {
      item.usuarios7d++;
      total7d++;
    }
    mapa.set(chave, item);
  }
  const versoes = [...mapa.values()].sort((a, b) => a.plataforma.localeCompare(b.plataforma) || (compareVersions(b.versao, a.versao) ?? 0));
  return { geradoEm: agora, total30d, total7d, parcial, versoes };
};

const CACHE_VERSOES_MS = 5 * MIN;
let cacheVersoes: { valor: Distribuicao; em: number } | null = null;

const lerVersoes = async (db: Firestore, agora: number, atualizar: boolean): Promise<Distribuicao> => {
  if (cacheVersoes && !atualizar && agora - cacheVersoes.em < CACHE_VERSOES_MS) return cacheVersoes.valor;
  const snap = await db
    .collection(VERSOES_APP)
    .where("vistoEm", ">=", new Date(agora - 30 * DIA))
    .select("versao", "plataforma", "vistoEm")
    .limit(VERSOES_LIMITE)
    .get();
  const valor = resumirVersoes(snap.docs.map((d) => d.data() as { versao: unknown; plataforma: unknown; vistoEm: unknown }), agora, snap.size >= VERSOES_LIMITE);
  cacheVersoes = { valor, em: agora };
  return valor;
};

// ─── Configuração ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

/** Valida o que o painel mandou. Versão vazia = sem valor no painel (vale a variável da Vercel). */
export const parseConfigEnviada = (body: unknown): Parse<ConfigSistema> => {
  const b = isRecord(body) ? body : {};
  const v = isRecord(b.versoes) ? b.versoes : {};
  const versoes = {} as ConfigSistema["versoes"];
  for (const p of ["ios", "android"] as const) {
    const x = isRecord(v[p]) ? (v[p] as Record<string, unknown>) : {};
    const ler = (campo: "min" | "latest"): string | null | undefined => {
      const valor = typeof x[campo] === "string" ? (x[campo] as string).trim() : x[campo];
      if (valor === null || valor === undefined || valor === "") return null;
      return versaoValida(valor) ? valor : undefined;
    };
    const min = ler("min");
    const latest = ler("latest");
    const nome = p === "ios" ? "iOS" : "Android";
    if (min === undefined || latest === undefined) return { ok: false, error: `Versão inválida no ${nome}: use o formato 5.4 ou 5.4.1.` };
    if (min && latest && (compareVersions(min, latest) ?? 0) > 0) {
      return { ok: false, error: `No ${nome}, a versão mínima (${min}) não pode ser maior que a mais recente (${latest}).` };
    }
    versoes[p] = { min, latest };
  }
  const texto = (valor: unknown, max: number, nome: string): Parse<string | null> => {
    if (valor === null || valor === undefined) return { ok: true, value: null };
    if (typeof valor !== "string") return { ok: false, error: `${nome} inválido.` };
    const t = valor.replace(/\s+/g, " ").trim();
    if (t.length > max) return { ok: false, error: `${nome}: no máximo ${max} caracteres.` };
    return { ok: true, value: t || null };
  };
  const mensagem = texto(b.mensagemAtualizacao, MENSAGEM_MAX, "Mensagem de atualização");
  if (!mensagem.ok) return mensagem;
  const aviso = texto(b.aviso, AVISO_MAX, "Aviso no app");
  if (!aviso.ok) return aviso;
  const f = isRecord(b.funcoes) ? b.funcoes : {};
  const funcoes = {} as ConfigSistema["funcoes"];
  for (const nome of FUNCOES) {
    if (typeof f[nome] !== "boolean") return { ok: false, error: "Interruptores inválidos." };
    funcoes[nome] = f[nome] as boolean;
  }
  return { ok: true, value: { versoes, mensagemAtualizacao: mensagem.value, aviso: aviso.value, funcoes } };
};

/** O que vale hoje vindo das variáveis da Vercel (para o painel mostrar a origem de cada valor). */
const configDaVercel = () => {
  const ios = resolvePolicy(process.env, "ios").policy;
  const android = resolvePolicy(process.env, "android").policy;
  return {
    versoes: { ios: { min: ios.minVersion, latest: ios.latestVersion }, android: { min: android.minVersion, latest: android.latestVersion } },
    mensagemAtualizacao: ios.message,
    lojas: { ios: ios.storeUrl, android: android.storeUrl },
  };
};

export class ConfigMudou extends Error {}

/**
 * `base`: a configuração que o painel tinha carregado quando o administrador começou a editar. Se a gravada mudou desde então
 * (outro administrador ou outra aba salvou), recusa: gravar a cópia inteira poderia religar uma função desligada por outro.
 */
export const salvarConfig = async (db: Firestore, uid: string, nova: ConfigSistema, base: ConfigSistema): Promise<ConfigSistema> => {
  const ref = db.doc(DOC_CONFIG);
  await db.runTransaction(async (tx) => {
    const atual = await tx.get(ref);
    const antes = normalizarConfig(atual.exists ? atual.data() : null);
    if (JSON.stringify(antes) !== JSON.stringify(normalizarConfig(base))) throw new ConfigMudou();
    tx.set(ref, { ...nova, atualizadoPor: uid, atualizadoEm: FieldValue.serverTimestamp() });
    tx.create(ref.collection("historico").doc(), { antes, depois: nova, por: uid, em: FieldValue.serverTimestamp() });
  });
  esquecerConfig();
  return nova;
};

const lerHistorico = async (db: Firestore) => {
  try {
    const snap = await db.doc(DOC_CONFIG).collection("historico").orderBy("em", "desc").limit(10).get();
    return snap.docs.map((d) => ({ em: ms(d.get("em")), por: String(d.get("por") ?? "").slice(0, 128), antes: normalizarConfig(d.get("antes")), depois: normalizarConfig(d.get("depois")) }));
  } catch {
    return [];
  }
};

// ─── Rota ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ORDEM: Record<Nivel, number> = { critico: 3, atencao: 2, sem_dados: 1, ok: 0 };
export const nivelGeral = (niveis: Nivel[]): Nivel =>
  niveis.reduce<Nivel>((pior, n) => (n !== "sem_dados" && ORDEM[n] > ORDEM[pior] ? n : pior), "ok");

const saude = async (db: Firestore, atualizar: boolean) => {
  const agora = Date.now();
  esquecerConfig();
  const [rotinasSnap, filas, versoes, config, historico] = await Promise.all([
    db.doc(DOC_ROTINAS).get(),
    lerFilas(db, agora),
    lerVersoes(db, agora, atualizar).catch(() => null),
    lerConfig(db, agora),
    lerHistorico(db),
  ]);
  const dados = rotinasSnap.exists ? (rotinasSnap.data() ?? {}) : {};
  const falhas = isRecord(dados.falhas) ? dados.falhas : {};
  const rotinas = ROTINAS.map((id) => avaliarRotina(id, dados[id], falhas[id], agora));
  return {
    geradoEm: agora,
    nivel: nivelGeral([...rotinas.map((r) => r.nivel), ...filas.map((f) => f.nivel)]),
    rotinas,
    filas,
    versoes,
    config,
    vercel: configDaVercel(),
    historico,
  };
};

export async function handleAdminSistema(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "moderacao");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Apenas administradores podem ver a saúde do sistema." });
  if (!(await dentroDoLimite(user.uid, "admin-sistema", 60, 60))) return res.status(429).json({ error: "Muitas consultas seguidas. Aguarde um minuto." });

  const body = req.body ?? {};
  try {
    const db = getFirestore(getFirebaseApp());
    if (body.action === "saude") return res.status(200).json(await saude(db, body.atualizar === true));
    if (body.action === "salvar-config") {
      const parsed = parseConfigEnviada(body.config);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const base = parseConfigEnviada(body.base);
      if (!base.ok) return res.status(400).json({ error: "Atualize o painel (recarregue a página) antes de salvar." });
      let config: ConfigSistema;
      try {
        config = await salvarConfig(db, user.uid, parsed.value, base.value);
      } catch (erro) {
        if (erro instanceof ConfigMudou) return res.status(409).json({ code: "config_mudou", error: "Outro administrador alterou a configuração enquanto você editava. Recarregue para ver a versão atual e refaça a sua mudança." });
        throw erro;
      }
      console.log(JSON.stringify({ evt: "sistema_config_salva", funcoes: config.funcoes, aviso: Boolean(config.aviso) }));
      return res.status(200).json({ config });
    }
    return res.status(400).json({ error: "Ação inválida." });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "admin_sistema_falhou", acao: String(body.action).slice(0, 20), message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível concluir. Tente novamente." });
  }
}
