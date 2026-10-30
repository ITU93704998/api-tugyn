import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { DEDUPE_TTL_MS, EXPO_RECEIPTS_MAX, QUERY_IN_LIMIT, type PushDraft, type PushResult, buildMessages, chunk, fetchExpoReceipts, isValidPushToken, sendExpoPush, tokenDocId, tokenNoPrazo } from "./push";

const COLLECTION = "pushDedupe";
/** Tickets aceitos pelo Expo à espera do recibo: `{ tickets: { ticketId: id hash do token }, enviadoEm, verificarApos }`. */
const RECIBOS = "pushRecibos";
/** O Expo sugere consultar os recibos cerca de 15 minutos depois do envio. */
export const RECIBO_ESPERA_MS = 15 * 60_000;
/** O Expo guarda os recibos por pelo menos 24 horas; depois disso, não há mais o que consultar. */
export const RECIBO_VALIDADE_MS = 24 * 3600_000;
const RECIBO_LEASE_MS = 5 * 60_000;
const RECIBO_TTL_MS = 3 * 24 * 3600_000;
/** Erros de recibo que indicam credencial APNs/FCM do projeto quebrada (afeta todos os avisos). */
const ERROS_DE_CREDENCIAL = new Set(["InvalidCredentials", "MismatchSenderId"]);
export const PUSH_LEASE_MS = 60_000;
const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 3;
type Outcome = "accepted" | "invalid" | "failed" | "uncertain";
type State = "leased" | "sending" | "pending" | "done" | "uncertain" | "failed" | "expired";

export interface Aviso {
  evento: string;
  turmaId: string;
  dedupeKey: string;
  dedupeMs: number;
  recipientUids: readonly string[];
  /** Preservado para a exclusão de conta já existente. */
  dedupeUid: string;
  draft: PushDraft;
}
interface Job {
  schema: 1;
  state: State;
  aviso: Aviso;
  notificationId: string;
  createdAt: number;
  deadlineAt: number;
  at: number;
  owner: string;
  leaseUntil: number;
  nextAttemptAt?: number;
  targetIds?: string[];
  batchIds: string[];
  outcomes: Record<string, Outcome>;
  tries: Record<string, number>;
}
export interface EnvioResult { enviados: number; motivo?: string; pendente?: boolean }
/** Injeção para testes: produção sempre usa relógio, UUID e transporte reais. */
export interface EnvioOptions {
  now?: () => number;
  send?: typeof sendExpoPush;
}
const hashOutbox = (ref: DocumentReference): string => createHash("sha256").update(ref.id).digest("hex").slice(0, 20);
const metric = (ref: DocumentReference, evt: string, details: Record<string, unknown> = {}) => {
  // Não registra UID, chave composta, token, corpo ou erro livre do provedor.
  console.log(JSON.stringify({ evt, outboxId: hashOutbox(ref), ...details }));
};
const terminalResult = (job: Job): EnvioResult => ({
  enviados: 0,
  motivo: job.state === "uncertain" ? "envio-incerto" : "repetido",
});

/** Toda decisão de propriedade é transacional; nenhuma chamada ao Expo ocorre no callback. */
async function claim(db: Firestore, ref: DocumentReference, now: () => number, aviso?: Aviso): Promise<{ job: Job } | { result: EnvioResult }> {
  const owner = randomUUID();
  const notificationId = randomUUID();
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const previous = snap.data();
    const time = now();
    if (previous && previous.schema !== 1) {
      if (previous.schema !== undefined) return { result: { enviados: 0, motivo: "envio-incerto" } };
      // Registros anteriores à outbox continuam respeitando a janela de deduplicação.
      if (!aviso || time - Number(previous.at ?? 0) < aviso.dedupeMs) return { result: { enviados: 0, motivo: "repetido" } };
    }
    let job = previous?.schema === 1 ? previous as Job : null;
    if (job) {
      if (job.state === "uncertain") return { result: terminalResult(job) };
      if (["done", "failed", "expired"].includes(job.state)) {
        if (!aviso || time - job.at < job.aviso.dedupeMs) return { result: terminalResult(job) };
        job = null; // Uma NOVA ação autorizada, fora da janela, pode criar outra ocorrência.
      } else {
        if (job.leaseUntil > time) return { result: { enviados: 0, motivo: "em-processamento", pendente: true } };
        if (job.state === "sending") {
          // Pode ter chegado ao Expo. Nenhum novo proprietário recebe permissão para reenviar.
          const outcomes = { ...job.outcomes };
          for (const id of job.batchIds) outcomes[id] = "uncertain";
          tx.update(ref, { state: "uncertain", outcomes, nextAttemptAt: FieldValue.delete(), updatedAt: time });
          return { result: { enviados: 0, motivo: "envio-incerto" } };
        }
        if (job.deadlineAt <= time) {
          tx.update(ref, { state: "expired", nextAttemptAt: FieldValue.delete(), updatedAt: time });
          return { result: { enviados: 0, motivo: "expirado" } };
        }
        if ((job.nextAttemptAt ?? 0) > time) return { result: { enviados: 0, motivo: "aguardando-retry", pendente: true } };
      }
    }
    if (!job) {
      if (!aviso) return { result: { enviados: 0, motivo: "inexistente" } };
      job = {
        schema: 1, state: "leased", aviso: { ...aviso, recipientUids: [...new Set(aviso.recipientUids)] },
        notificationId, createdAt: time, deadlineAt: time + Math.min(aviso.dedupeMs, 24 * 3600_000),
        at: time, owner, leaseUntil: time + PUSH_LEASE_MS, nextAttemptAt: time + PUSH_LEASE_MS,
        batchIds: [], outcomes: {}, tries: {},
      };
      tx.set(ref, { ...job, evento: aviso.evento, turmaId: aviso.turmaId, targetUid: aviso.dedupeUid, expiresAt: new Date(time + DEDUPE_TTL_MS) });
    } else {
      job = { ...job, state: "leased", owner, leaseUntil: time + PUSH_LEASE_MS, nextAttemptAt: time + PUSH_LEASE_MS };
      tx.update(ref, { state: job.state, owner, leaseUntil: job.leaseUntil, nextAttemptAt: job.nextAttemptAt, updatedAt: time });
    }
    return { job };
  });
}

async function tokensDosUsuarios(db: Firestore, uids: readonly string[], nowMs: number) {
  const tokens = new Map<string, DocumentReference>();
  for (const grupo of chunk([...new Set(uids)], QUERY_IN_LIMIT)) {
    const snap = await db.collection("pushTokens").where("uid", "in", grupo).get();
    // Lease: cadastro não renovado há 30 dias (ex.: logout sem internet num aparelho que não voltou) não recebe mais avisos.
    for (const doc of snap.docs) if (isValidPushToken(doc.get("token")) && tokenNoPrazo(doc.get("updatedAt"), nowMs)) tokens.set(doc.get("token"), doc.ref);
  }
  return tokens;
}

async function processar(db: Firestore, ref: DocumentReference, options: EnvioOptions, aviso?: Aviso): Promise<EnvioResult> {
  const now = options.now ?? Date.now;
  const reservation = await claim(db, ref, now, aviso);
  if ("result" in reservation) {
    if (reservation.result.motivo === "envio-incerto") metric(ref, "push_outbox_uncertain");
    return reservation.result;
  }
  const job = reservation.job;
  let tokenDocs: Map<string, DocumentReference>;
  try { tokenDocs = await tokensDosUsuarios(db, job.aviso.recipientUids, now()); }
  catch {
    // Nenhum envio começou: uma nova tentativa é segura e recuperável.
    await db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      if (data?.owner === job.owner && data.state === "leased") tx.update(ref, { state: "pending", leaseUntil: 0, nextAttemptAt: now() + RETRY_MS, updatedAt: now() });
    });
    metric(ref, "push_outbox_preparation_failed");
    return { enviados: 0, motivo: "falha-envio", pendente: true };
  }
  const targets = new Set(job.targetIds ?? [...tokenDocs.keys()].map(tokenDocId));
  const tokens = [...tokenDocs.keys()].filter(token => targets.has(tokenDocId(token)) && !job.outcomes[tokenDocId(token)]);
  const batchIds = tokens.map(tokenDocId);
  // Fencing: um processo que perdeu o lease durante a leitura de tokens não pode começar o envio.
  const started = await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    const time = now();
    if (data?.owner !== job.owner || data.state !== "leased" || data.leaseUntil <= time) return false;
    if (job.deadlineAt <= time) { tx.update(ref, { state: "expired", nextAttemptAt: FieldValue.delete(), updatedAt: time }); return false; }
    if (!tokens.length) {
      const state = Object.values(job.outcomes).includes("uncertain") ? "uncertain" : Object.values(job.outcomes).includes("failed") ? "failed" : "done";
      tx.update(ref, { state, at: time, leaseUntil: 0, nextAttemptAt: FieldValue.delete(), updatedAt: time });
      return true;
    }
    tx.update(ref, { state: "sending", batchIds, targetIds: [...targets], dispatchStartedAt: time, leaseUntil: time + PUSH_LEASE_MS, nextAttemptAt: time + PUSH_LEASE_MS, updatedAt: time });
    return true;
  });
  if (!started) return { enviados: 0, motivo: "reserva-perdida", pendente: true };
  if (!tokens.length) return { enviados: 0, motivo: tokenDocs.size ? "repetido" : "sem-dispositivos" };

  let results: PushResult[];
  metric(ref, "push_outbox_dispatch", { count: tokens.length, leaseMs: PUSH_LEASE_MS, ageMs: now() - job.createdAt });
  try {
    const draft = { ...job.aviso.draft, data: { ...job.aviso.draft.data, notificationId: job.notificationId } };
    results = await (options.send ?? sendExpoPush)(buildMessages(tokens, draft), { accessToken: process.env.EXPO_ACCESS_TOKEN });
  } catch {
    // Um transporte que lança pode ter enviado antes de falhar.
    results = tokens.map(token => ({ token, ok: false, invalid: false, uncertain: true, error: "rede" }));
  }
  const byToken = new Map(results.map(result => [result.token, result]));
  const outcomes = { ...job.outcomes };
  const tries = { ...job.tries };
  let enviados = 0;
  let pending = false;
  for (const token of tokens) {
    const id = tokenDocId(token);
    const result = byToken.get(token);
    tries[id] = (tries[id] ?? 0) + 1;
    if (result?.ok) { outcomes[id] = "accepted"; enviados++; }
    else if (result?.invalid) outcomes[id] = "invalid";
    else if (!result || result.uncertain) outcomes[id] = "uncertain";
    else if (result.retryable && tries[id] < MAX_ATTEMPTS) pending = true;
    else outcomes[id] = "failed";
  }
  const state: State = pending ? "pending" : Object.values(outcomes).includes("uncertain") ? "uncertain" : Object.values(outcomes).includes("failed") ? "failed" : "done";
  // Ticket aceito não é entrega: guarda os ids para consultar o recibo depois (consultarRecibos).
  const tickets: Record<string, string> = {};
  for (const token of tokens) {
    const ticketId = byToken.get(token)?.ticketId;
    if (ticketId) tickets[ticketId] = tokenDocId(token);
  }
  const reciboRef = db.doc(`${RECIBOS}/${randomUUID()}`);
  // Confirmação atômica do lote. Uma falha aqui deixa "sending": a recuperação não o reenvia às cegas.
  const confirmed = await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (data?.owner !== job.owner || data.notificationId !== job.notificationId || !["sending", "uncertain"].includes(data.state)) return false;
    const maxTry = Math.max(...Object.values(tries));
    const time = now();
    tx.update(ref, { state, outcomes, tries, at: time, leaseUntil: 0, updatedAt: time, nextAttemptAt: pending ? time + RETRY_MS * 2 ** (maxTry - 1) : FieldValue.delete() });
    if (Object.keys(tickets).length) {
      tx.set(reciboRef, { schema: 1, tickets, outboxId: hashOutbox(ref), enviadoEm: time, verificarApos: time + RECIBO_ESPERA_MS, expiresAt: new Date(time + RECIBO_TTL_MS) });
    }
    return true;
  }).catch(error => {
    metric(ref, "push_outbox_confirmation_failed", { accepted: enviados, ageMs: now() - job.createdAt });
    throw error;
  });
  if (!confirmed) {
    metric(ref, "push_outbox_confirmation_lost", { accepted: enviados });
    return { enviados, motivo: "envio-incerto" };
  }
  // Limpeza posterior ao checkpoint: falha ao apagar um token nunca provoca reenvio do lote aceito.
  for (const result of results) if (result.invalid) await tokenDocs.get(result.token)?.delete().catch(() => metric(ref, "push_token_cleanup_failed"));
  const errors: Record<string, number> = {};
  const knownCodes = new Set(["DeviceNotRegistered", "MessageTooBig", "MessageRateExceeded", "MismatchSenderId", "InvalidCredentials", "rede", "sem-resposta"]);
  for (const result of results) if (!result.ok) {
    const code = result.error && (knownCodes.has(result.error) || /^http-\d{3}$/.test(result.error)) ? result.error : "outro";
    errors[code] = (errors[code] ?? 0) + 1;
  }
  metric(ref, state === "uncertain" ? "push_outbox_uncertain" : "push_outbox_checkpoint", {
    state, accepted: enviados, pending, errors, ageMs: now() - job.createdAt,
    uncertain: Object.values(outcomes).filter(value => value === "uncertain").length,
    failed: Object.values(outcomes).filter(value => value === "failed").length,
  });
  const credenciais = Object.entries(errors).filter(([codigo]) => ERROS_DE_CREDENCIAL.has(codigo));
  if (credenciais.length) console.error(JSON.stringify({ evt: "push_credenciais_invalidas", ...Object.fromEntries(credenciais) }));
  return { enviados, ...(pending ? { motivo: "falha-envio", pendente: true } : state === "uncertain" ? { motivo: "envio-incerto" } : state === "failed" ? { motivo: "falha-definitiva" } : {}) };
}

export async function enviarAviso(db: Firestore, aviso: Aviso, options: EnvioOptions = {}): Promise<EnvioResult> {
  if (!aviso.recipientUids.length) return { enviados: 0, motivo: "sem-destinatarios" };
  return processar(db, db.doc(`${COLLECTION}/${aviso.dedupeKey}`), options, aviso);
}

/** Consulta indexada por um campo; concorrência, volume e duração limitados. Também aceita chamada de scheduler externo. */
export async function recuperarAvisosPendentes(db: Firestore, options: EnvioOptions & { limit?: number } = {}): Promise<Record<string, number>> {
  const now = options.now ?? Date.now;
  const snap = await db.collection(COLLECTION).where("nextAttemptAt", "<=", now()).orderBy("nextAttemptAt").limit(Math.min(Math.max(options.limit ?? 10, 1), 30)).get();
  const counts = { examinados: snap.size, aceitosExpo: 0, pendentes: 0, incertos: 0, falhas: 0 };
  let cursor = 0;
  const deadline = Date.now() + 40_000;
  await Promise.all(Array.from({ length: Math.min(3, snap.size) }, async () => {
    while (cursor < snap.docs.length && Date.now() < deadline) {
      const doc = snap.docs[cursor++];
      try {
        const result = await processar(db, doc.ref, options);
        counts.aceitosExpo += result.enviados;
        if (result.pendente) counts.pendentes++;
        if (result.motivo === "envio-incerto") counts.incertos++;
      } catch { counts.falhas++; metric(doc.ref, "push_outbox_recovery_failed"); }
    }
  }));
  return counts;
}

/**
 * Consulta os recibos dos tickets aceitos há pelo menos 15 minutos. `DeviceNotRegistered` apaga o token (se o aparelho não se registrou
 * de novo depois do envio); credencial APNs/FCM inválida gera o alerta `push_credenciais_invalidas`. Recibo ok ainda não quer dizer que
 * a pessoa viu o aviso. Chamado pelas mesmas rotinas protegidas da outbox; nunca registra token, UID ou texto do aviso.
 */
export async function consultarRecibos(db: Firestore, options: Pick<EnvioOptions, "now"> & { limit?: number; fetchReceipts?: typeof fetchExpoReceipts } = {}): Promise<Record<string, number>> {
  const now = options.now ?? Date.now;
  const buscar = options.fetchReceipts ?? fetchExpoReceipts;
  const snap = await db.collection(RECIBOS).where("verificarApos", "<=", now()).orderBy("verificarApos").limit(Math.min(Math.max(options.limit ?? 20, 1), 50)).get();
  const counts = { lotes: snap.size, entregues: 0, recusados: 0, tokensRemovidos: 0, aguardando: 0, semRecibo: 0, falhas: 0 };
  const erros: Record<string, number> = {};
  const deadline = Date.now() + 15_000;
  for (const doc of snap.docs) {
    if (Date.now() >= deadline) break;
    try {
      // Reserva curta: duas rotinas ao mesmo tempo não consultam o mesmo lote.
      const lote = await db.runTransaction(async tx => {
        const data = (await tx.get(doc.ref)).data();
        if (!data || Number(data.verificarApos) > now()) return null;
        tx.update(doc.ref, { verificarApos: now() + RECIBO_LEASE_MS });
        return data as { tickets?: Record<string, string>; enviadoEm?: number };
      });
      if (!lote) continue;
      const tickets = lote.tickets ?? {};
      const enviadoEm = Number(lote.enviadoEm ?? 0);
      const ids = Object.keys(tickets).slice(0, EXPO_RECEIPTS_MAX);
      const recibos = ids.length ? await buscar(ids, { accessToken: process.env.EXPO_ACCESS_TOKEN }) : new Map();
      if (!recibos) {
        // Falha de transporte: tenta de novo mais tarde, enquanto o Expo ainda guarda os recibos.
        counts.falhas++;
        if (now() - enviadoEm >= RECIBO_VALIDADE_MS) { counts.semRecibo += ids.length; await doc.ref.delete(); }
        else await doc.ref.update({ verificarApos: now() + RECIBO_ESPERA_MS });
        continue;
      }
      const restantes: Record<string, string> = {};
      const mortos = new Set<string>();
      for (const [id, tokenId] of Object.entries(tickets)) {
        const recibo = recibos.get(id);
        if (!recibo) { restantes[id] = tokenId; continue; }
        if (recibo.ok) { counts.entregues++; continue; }
        counts.recusados++;
        const codigo = recibo.error && /^[A-Za-z]{1,40}$/.test(recibo.error) ? recibo.error : "outro";
        erros[codigo] = (erros[codigo] ?? 0) + 1;
        if (codigo === "DeviceNotRegistered") mortos.add(tokenId);
      }
      for (const tokenId of mortos) {
        if (!/^[a-f0-9]{40}$/.test(tokenId)) continue;
        const tokenRef = db.doc(`pushTokens/${tokenId}`);
        const removido = await db.runTransaction(async tx => {
          const token = await tx.get(tokenRef);
          // Registrado de novo depois do envio: o aparelho voltou, não apaga.
          if (!token.exists || Number(token.get("updatedAt") ?? 0) > enviadoEm) return false;
          tx.delete(tokenRef);
          return true;
        });
        if (removido) counts.tokensRemovidos++;
      }
      const pendentes = Object.keys(restantes).length;
      if (pendentes && now() - enviadoEm < RECIBO_VALIDADE_MS) {
        counts.aguardando += pendentes;
        await doc.ref.update({ tickets: restantes, verificarApos: now() + RECIBO_ESPERA_MS });
      } else {
        counts.semRecibo += pendentes;
        await doc.ref.delete();
      }
    } catch {
      counts.falhas++;
      metric(doc.ref, "push_receipts_failed");
    }
  }
  if (snap.size) console.log(JSON.stringify({ evt: "push_receipts", ...counts, erros }));
  const credenciais = Object.entries(erros).filter(([codigo]) => ERROS_DE_CREDENCIAL.has(codigo));
  // Credencial quebrada derruba todos os avisos de uma plataforma: precisa de ação humana (renovar chave APNs/FCM no Expo).
  if (credenciais.length) console.error(JSON.stringify({ evt: "push_credenciais_invalidas", ...Object.fromEntries(credenciais) }));
  return counts;
}
