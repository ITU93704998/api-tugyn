import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { BUCKETS, getAccount, type Bucket } from "./config";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";

/**
 * Custos e cotas do painel: POST /api/version?resource=custos (só administradores).
 *
 *  custos       { atualizar? } → uso do Firestore (leituras, escritas e exclusões por dia, pelo Cloud Monitoring) e de cada
 *                                conta do Cloudinary (créditos do plano), comparado com os limites de `sistema/cotas`.
 *                                Guardado por 10 min nesta instância; `atualizar` refaz se tiver mais de 1 min.
 *  salvar-cotas { cotas }      → limites diários do Firestore e o percentual de alerta.
 *
 * O Cloud Monitoring exige que a conta de serviço do Firebase Admin tenha o papel "Monitoring Viewer"
 * (roles/monitoring.viewer). Sem ele, o painel mostra o aviso e o resto continua funcionando.
 * O dia do Firestore segue o fuso do Pacífico (é quando as cotas gratuitas do Firebase zeram).
 */

export const DOC_COTAS = "sistema/cotas";
const FUSO_COTAS = "America/Los_Angeles";
const HORA = 3_600_000;
const DIA = 24 * HORA;
const DIAS = 7;
const CACHE_MS = 10 * 60_000;
const ATUALIZAR_MIN_MS = 60_000;
const TIMEOUT_MS = 8_000;

export type Nivel = "ok" | "atencao" | "critico" | "sem_dados";
export type MetricaFirestore = "leituras" | "escritas" | "exclusoes";
export const METRICAS: Record<MetricaFirestore, string> = {
  leituras: "firestore.googleapis.com/document/read_count",
  escritas: "firestore.googleapis.com/document/write_count",
  exclusoes: "firestore.googleapis.com/document/delete_count",
};

export interface Cotas {
  firestore: Record<MetricaFirestore, number>;
  /** A partir de quantos % do limite fica "atenção" (100% ou mais = crítico). */
  alertaPct: number;
}

/** Cota gratuita diária do Firestore (plano Spark / faixa gratuita do Blaze). */
export const COTAS_PADRAO: Cotas = { firestore: { leituras: 50_000, escritas: 20_000, exclusoes: 20_000 }, alertaPct: 80 };
const LIMITE_MAX = 1_000_000_000;

const inteiroPositivo = (v: unknown, padrao: number): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= LIMITE_MAX ? v : padrao;

export const normalizarCotas = (v: unknown): Cotas => {
  const d = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const f = (typeof d.firestore === "object" && d.firestore !== null ? d.firestore : {}) as Record<string, unknown>;
  const pct = typeof d.alertaPct === "number" && Number.isInteger(d.alertaPct) && d.alertaPct >= 10 && d.alertaPct <= 99 ? d.alertaPct : COTAS_PADRAO.alertaPct;
  return {
    firestore: {
      leituras: inteiroPositivo(f.leituras, COTAS_PADRAO.firestore.leituras),
      escritas: inteiroPositivo(f.escritas, COTAS_PADRAO.firestore.escritas),
      exclusoes: inteiroPositivo(f.exclusoes, COTAS_PADRAO.firestore.exclusoes),
    },
    alertaPct: pct,
  };
};

/** Valida o que o painel manda (recusa em vez de corrigir em silêncio). */
export const parseCotasEnviadas = (v: unknown): { ok: true; value: Cotas } | { ok: false; error: string } => {
  const d = (typeof v === "object" && v !== null ? v : null) as Record<string, unknown> | null;
  const f = d && typeof d.firestore === "object" && d.firestore !== null ? (d.firestore as Record<string, unknown>) : null;
  if (!d || !f) return { ok: false, error: "Cotas inválidas." };
  for (const m of Object.keys(METRICAS) as MetricaFirestore[]) {
    const n = f[m];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || n > LIMITE_MAX) return { ok: false, error: "Os limites diários precisam ser números inteiros maiores que zero." };
  }
  if (typeof d.alertaPct !== "number" || !Number.isInteger(d.alertaPct) || d.alertaPct < 10 || d.alertaPct > 99) {
    return { ok: false, error: "O alerta precisa ficar entre 10% e 99%." };
  }
  return { ok: true, value: normalizarCotas(d) };
};

export const nivelPorPct = (pct: number | null, alertaPct: number): Nivel =>
  pct === null ? "sem_dados" : pct >= 100 ? "critico" : pct >= alertaPct ? "atencao" : "ok";

const PIOR: Nivel[] = ["critico", "atencao", "ok", "sem_dados"];
export const piorNivel = (niveis: Nivel[]): Nivel => {
  if (!niveis.length || niveis.every((n) => n === "sem_dados")) return "sem_dados";
  return PIOR.find((p) => niveis.includes(p)) ?? "ok";
};

// ─── Firestore (Cloud Monitoring) ─────────────────────────────────────────────────────────────────────────────────────

const diaNoFuso = (() => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO_COTAS, year: "numeric", month: "2-digit", day: "2-digit" });
  return (t: number): string => f.format(new Date(t));
})();

/** Os últimos `n` dias (fuso do Pacífico), do mais antigo para hoje. */
export const ultimosDias = (agora: number, n = DIAS): string[] => {
  const dias: string[] = [];
  for (let t = agora - (n + 1) * DIA; t <= agora; t += HORA) {
    const d = diaNoFuso(t);
    if (dias[dias.length - 1] !== d) dias.push(d);
  }
  return dias.slice(-n);
};

interface PontoMonitoring {
  interval?: { startTime?: string; endTime?: string };
  value?: { int64Value?: string | number; doubleValue?: number };
}

/** Soma por dia (Pacífico) os pontos horários de uma série do Monitoring. Pura: testada sem rede. */
export const somarPorDia = (series: Array<{ points?: PontoMonitoring[] }>, dias: string[]): number[] => {
  const porDia = new Map(dias.map((d) => [d, 0]));
  for (const s of series) {
    for (const p of s.points ?? []) {
      const fim = Date.parse(p.interval?.endTime ?? "");
      if (!Number.isFinite(fim)) continue;
      // O ponto cobre a hora que TERMINA em endTime: conta no dia da hora que começou.
      const dia = diaNoFuso(fim - 1);
      if (!porDia.has(dia)) continue;
      const bruto = p.value?.int64Value ?? p.value?.doubleValue ?? 0;
      const n = Number(bruto);
      if (Number.isFinite(n) && n > 0) porDia.set(dia, (porDia.get(dia) ?? 0) + n);
    }
  }
  return dias.map((d) => Math.round(porDia.get(d) ?? 0));
};

export interface UsoFirestore {
  disponivel: boolean;
  /** Por que não há números (sem permissão, API desligada, erro). */
  motivo: string;
  dias: string[];
  metricas: Array<{ id: MetricaFirestore; hoje: number; limite: number; pct: number; nivel: Nivel; porDia: number[]; media7d: number }>;
}

class FalhaMonitoring extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const projetoECredencial = () => {
  const app = getFirebaseApp();
  const credencial = app.options.credential;
  const projectId = app.options.projectId ?? (credencial as { projectId?: string } | undefined)?.projectId ?? process.env.FIREBASE_PROJECT_ID ?? "";
  return { credencial, projectId };
};

const comTempo = async (url: string, init: RequestInit): Promise<Response> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
};

async function lerMetrica(projectId: string, token: string, tipo: string, inicio: number, fim: number): Promise<Array<{ points?: PontoMonitoring[] }>> {
  const series: Array<{ points?: PontoMonitoring[] }> = [];
  let pagina = "";
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({
      filter: `metric.type = "${tipo}"`,
      "interval.startTime": new Date(inicio).toISOString(),
      "interval.endTime": new Date(fim).toISOString(),
      "aggregation.alignmentPeriod": "3600s",
      "aggregation.perSeriesAligner": "ALIGN_SUM",
      "aggregation.crossSeriesReducer": "REDUCE_SUM",
      view: "FULL",
    });
    if (pagina) q.set("pageToken", pagina);
    const r = await comTempo(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new FalhaMonitoring(r.status, (await r.text().catch(() => "")).slice(0, 300));
    const corpo = (await r.json()) as { timeSeries?: Array<{ points?: PontoMonitoring[] }>; nextPageToken?: string };
    series.push(...(corpo.timeSeries ?? []));
    pagina = corpo.nextPageToken ?? "";
    if (!pagina) break;
  }
  return series;
}

export const motivoDaFalha = (status: number): string =>
  status === 403
    ? "A conta de serviço do servidor não tem permissão para ler o uso. No Google Cloud (IAM), dê a ela o papel “Monitoring Viewer”."
    : status === 404
      ? "Projeto não encontrado no Cloud Monitoring."
      : status === 401
        ? "A credencial do servidor foi recusada pelo Google Cloud."
        : "O Cloud Monitoring não respondeu. Tente de novo em alguns minutos.";

export async function usoDoFirestore(cotas: Cotas, agora: number): Promise<UsoFirestore> {
  const dias = ultimosDias(agora);
  const vazio = (motivo: string): UsoFirestore => ({ disponivel: false, motivo, dias, metricas: [] });
  const { credencial, projectId } = projetoECredencial();
  if (!credencial || !projectId) return vazio("O servidor não sabe qual é o projeto do Firebase.");
  let token: string;
  try {
    token = (await credencial.getAccessToken()).access_token;
  } catch {
    return vazio("Não foi possível obter acesso ao Google Cloud com a credencial do servidor.");
  }
  try {
    const inicio = agora - (DIAS + 1) * DIA;
    const ids = Object.keys(METRICAS) as MetricaFirestore[];
    const series = await Promise.all(ids.map((id) => lerMetrica(projectId, token, METRICAS[id], inicio, agora)));
    return {
      disponivel: true,
      motivo: "",
      dias,
      metricas: ids.map((id, i) => {
        const porDia = somarPorDia(series[i], dias);
        const hoje = porDia[porDia.length - 1] ?? 0;
        const limite = cotas.firestore[id];
        const pct = Math.round((hoje / limite) * 1000) / 10;
        const anteriores = porDia.slice(0, -1);
        const media7d = anteriores.length ? Math.round(anteriores.reduce((s, n) => s + n, 0) / anteriores.length) : 0;
        return { id, hoje, limite, pct, nivel: nivelPorPct(pct, cotas.alertaPct), porDia, media7d };
      }),
    };
  } catch (erro) {
    const status = erro instanceof FalhaMonitoring ? erro.status : 0;
    console.error(JSON.stringify({ evt: "custos_monitoring_falhou", status, message: (erro as Error)?.message?.slice(0, 200) ?? "erro" }));
    return vazio(motivoDaFalha(status));
  }
}

// ─── Cloudinary ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface UsoCloudinary {
  conta: string;
  usos: Bucket[];
  disponivel: boolean;
  motivo: string;
  plano: string;
  creditos: { usados: number; limite: number; pct: number } | null;
  armazenamentoBytes: number;
  bandaBytes: number;
  transformacoes: number;
  atualizadoEm: string;
  nivel: Nivel;
}

const numero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Lê a resposta de `/usage` do Cloudinary. Pura: testada sem rede. */
export const lerUsoCloudinary = (conta: string, usos: Bucket[], corpo: Record<string, unknown>, alertaPct: number): UsoCloudinary => {
  const obj = (k: string) => (typeof corpo[k] === "object" && corpo[k] !== null ? (corpo[k] as Record<string, unknown>) : {});
  const cred = obj("credits");
  const limite = numero(cred.limit);
  const usados = numero(cred.usage);
  const pct = limite > 0 ? Math.round((typeof cred.used_percent === "number" ? cred.used_percent : (usados / limite) * 100) * 10) / 10 : null;
  return {
    conta,
    usos,
    disponivel: true,
    motivo: "",
    plano: typeof corpo.plan === "string" ? corpo.plan.slice(0, 40) : "",
    creditos: limite > 0 && pct !== null ? { usados, limite, pct } : null,
    armazenamentoBytes: numero(obj("storage").usage),
    bandaBytes: numero(obj("bandwidth").usage),
    transformacoes: numero(obj("transformations").usage),
    atualizadoEm: typeof corpo.last_updated === "string" ? corpo.last_updated.slice(0, 20) : "",
    nivel: nivelPorPct(pct, alertaPct),
  };
};

/** Contas distintas (o mesmo cloud_name pode servir a vários buckets). */
export const contasDoCloudinary = (ler: (b: Bucket) => { cloud_name: string; api_key: string; api_secret: string } | null = getAccount) => {
  const contas = new Map<string, { usos: Bucket[]; api_key: string; api_secret: string }>();
  for (const b of BUCKETS) {
    const c = ler(b);
    if (!c) continue;
    const atual = contas.get(c.cloud_name);
    if (atual) atual.usos.push(b);
    else contas.set(c.cloud_name, { usos: [b], api_key: c.api_key, api_secret: c.api_secret });
  }
  return contas;
};

export async function usoDoCloudinary(alertaPct: number): Promise<UsoCloudinary[]> {
  const contas = contasDoCloudinary();
  return Promise.all(
    [...contas].map(async ([conta, c]) => {
      try {
        const r = await comTempo(`https://api.cloudinary.com/v1_1/${encodeURIComponent(conta)}/usage`, {
          headers: { Authorization: `Basic ${Buffer.from(`${c.api_key}:${c.api_secret}`).toString("base64")}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return lerUsoCloudinary(conta, c.usos, (await r.json()) as Record<string, unknown>, alertaPct);
      } catch (erro) {
        console.error(JSON.stringify({ evt: "custos_cloudinary_falhou", message: (erro as Error)?.message?.slice(0, 120) ?? "erro" }));
        return {
          conta, usos: c.usos, disponivel: false, motivo: "O Cloudinary não respondeu.", plano: "", creditos: null,
          armazenamentoBytes: 0, bandaBytes: 0, transformacoes: 0, atualizadoEm: "", nivel: "sem_dados" as Nivel,
        };
      }
    }),
  );
}

// ─── Junta tudo ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Custos {
  geradoEm: number;
  nivel: Nivel;
  cotas: Cotas;
  firestore: UsoFirestore;
  cloudinary: UsoCloudinary[];
}

async function lerCotas(db: Firestore): Promise<Cotas> {
  const snap = await db.doc(DOC_COTAS).get();
  return normalizarCotas(snap.exists ? snap.data() : null);
}

let guardado: Custos | null = null;
/** Coleta em andamento: pedidos simultâneos nesta instância esperam a mesma (sem repetir as consultas externas). */
let emAndamento: Promise<Custos> | null = null;
/** Só para os testes. */
export const esquecerCustos = (): void => {
  guardado = null;
  emAndamento = null;
};

/** Coleta tudo (sem cache). Exportada para os testes, com o leitor de cotas e os coletores injetáveis. */
export async function coletarCustos(
  db: Firestore,
  agora: number,
  fontes: { firestore?: typeof usoDoFirestore; cloudinary?: typeof usoDoCloudinary } = {},
): Promise<Custos> {
  const cotas = await lerCotas(db);
  const [firestore, cloudinary] = await Promise.all([
    (fontes.firestore ?? usoDoFirestore)(cotas, agora),
    (fontes.cloudinary ?? usoDoCloudinary)(cotas.alertaPct),
  ]);
  const nivel = piorNivel([...firestore.metricas.map((m) => m.nivel), ...cloudinary.map((c) => c.nivel)]);
  return { geradoEm: agora, nivel, cotas, firestore, cloudinary };
}

/**
 * Com cache de 10 min por instância e uma coleta por vez. Cada instância da Vercel tem o seu cache (não é compartilhado):
 * o limite de frequência por administrador segura as rajadas. `forcar` ignora o cache (depois de salvar as cotas).
 */
export async function custos(db: Firestore, atualizar: boolean, forcar = false, coletar: typeof coletarCustos = coletarCustos): Promise<Custos> {
  const agora = Date.now();
  const idade = guardado ? agora - guardado.geradoEm : Infinity;
  if (!forcar && guardado && idade < CACHE_MS && !(atualizar && idade >= ATUALIZAR_MIN_MS)) return guardado;
  if (!emAndamento) {
    emAndamento = coletar(db, agora)
      .then((novo) => (guardado = novo))
      .finally(() => {
        emAndamento = null;
      });
  }
  return emAndamento;
}

export async function handleAdminCustos(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "moderacao");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Apenas administradores podem ver custos e cotas." });
  if (!(await dentroDoLimite(user.uid, "admin-custos", 30, 60))) return res.status(429).json({ error: "Muitas consultas seguidas. Aguarde um minuto." });

  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const db = getFirestore(getFirebaseApp());
    if (body.action === "custos") return res.status(200).json(await custos(db, body.atualizar === true));
    if (body.action === "salvar-cotas") {
      const parsed = parseCotasEnviadas(body.cotas);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      await db.doc(DOC_COTAS).set({ ...parsed.value, atualizadoEm: FieldValue.serverTimestamp(), atualizadoPor: user.uid });
      // Espera uma coleta antiga terminar (ela usou as cotas anteriores) e refaz com as novas.
      if (emAndamento) await emAndamento.catch(() => undefined);
      return res.status(200).json(await custos(db, false, true));
    }
    return res.status(400).json({ error: "Ação inválida." });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "admin_custos_falhou", acao: String(body.action).slice(0, 20), message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível concluir. Tente novamente." });
  }
}
