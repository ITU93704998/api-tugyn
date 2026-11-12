import { enfileirarPerfil, mudouIdentidade, processarPerfil, recuperarPerfis } from "../../api/_lib/perfilSync";
import { captureLiveAttendance, dispatchLiveAttendance, invalidateLiveUser, sweepLiveAttendance } from "../../api/_lib/liveActivities";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { type Change, participantEvents, gameEvents } from "./events";
import { dispatchEvent, enqueueEvent, sweepEvents } from "./outbox";
import { isSafeUid } from "../../api/_lib/validation";
import { consultarRecibos, recuperarAvisosPendentes } from "../../api/_lib/pushEnvio";
import { registrarRotina } from "../../api/_lib/sistema";
import { mexeNosTrofeus, sincronizarTrofeusCampeonato } from "../../api/_lib/trofeusSync";

if (!getApps().length) initializeApp();
const db = getFirestore();
// Configure the SAME Expo project secret as the Vercel API; never place it in client configuration.
const expoAccessToken = defineSecret("EXPO_ACCESS_TOKEN");
const liveApnsKey = defineSecret("LIVE_ACTIVITY_APNS_KEY");
const region = process.env.TUGYN_PUSH_REGION || "southamerica-east1";
const triggerOptions = { region, retry: true, timeoutSeconds: 60, memory: "256MiB" as const, maxInstances: 3, concurrency: 10 };
const safe = isSafeUid;

export const captureTurmaParticipantNotification = onDocumentWritten({ ...triggerOptions, document: "turmas/{turmaId}/participantes/{participantId}" }, async event => {
  if (!event.data || !safe(event.params.turmaId) || !safe(event.params.participantId)) return;
  const before = event.data.before.exists ? event.data.before.data()! : null;
  const after = event.data.after.exists ? event.data.after.data()! : null;
  if (!after || before?.status !== after.status) await invalidateLiveUser(db, event.params.participantId, event.params.turmaId);
  if (!after || before?.status === after.status || (after.status !== "pendente" && !(before?.status === "pendente" && after.status === "aprovado"))) return;
  const [turma, current] = await Promise.all([db.doc(`turmas/${event.params.turmaId}`).get(), event.data.after.ref.get()]);
  const change: Change = { id: event.id, source: event.source, timeMs: event.data.after.updateTime?.toMillis() ?? Date.parse(event.time), turmaId: event.params.turmaId, before, after };
  for (const planned of participantEvents(change, event.params.participantId, turma.data() ?? null, current.data() ?? null)) await enqueueEvent(db, planned);
});

export const captureTurmaGameNotification = onDocumentWritten({ ...triggerOptions, document: "turmas/{turmaId}/jogos/{dayId}" }, async event => {
  if (!event.data || !safe(event.params.turmaId) || !/^\d{8}$/.test(event.params.dayId)) return;
  await captureLiveAttendance(db, event.params.turmaId, event.params.dayId);
  const before = event.data.before.exists ? event.data.before.data()! : null;
  const after = event.data.after.exists ? event.data.after.data()! : null;
  if (!after) return;
  const beforeIds = new Set(Object.keys(before?.confirmados ?? {}));
  const hasNewConfirmation = Object.keys(after.confirmados ?? {}).some(id => !beforeIds.has(id));
  if ((before || after.status !== "aberta") && !hasNewConfirmation) return;
  const [turma, current] = await Promise.all([db.doc(`turmas/${event.params.turmaId}`).get(), event.data.after.ref.get()]);
  const change: Change = { id: event.id, source: event.source, timeMs: event.data.after.updateTime?.toMillis() ?? Date.parse(event.time), turmaId: event.params.turmaId, before, after };
  for (const planned of gameEvents(change, event.params.dayId, turma.data() ?? null, current.data() ?? null, Date.now())) await enqueueEvent(db, planned);
});

export const deliverTurmaNotification = onDocumentCreated({ ...triggerOptions, document: "turmaPushEvents/{eventId}", secrets: [expoAccessToken] }, async event => {
  if (event.data) await dispatchEvent(db, event.data.ref);
});

// Runs independently of the app, including a partially successful send or a process interrupted before delivery.
export const retryTurmaNotifications = onSchedule({
  region, schedule: "every 1 minutes", timeZone: "America/Sao_Paulo", timeoutSeconds: 60,
  memory: "256MiB", maxInstances: 1, retryCount: 0, secrets: [expoAccessToken],
}, async () => {
  const inicio = Date.now();
  const perfis = recuperarPerfis(db, inicio + 15_000).catch(() => { console.error(JSON.stringify({ evt: 'perfil_sync_sweep_failed' })); });
  try {
    // Identidade tem fila independente: falha de envio Expo não impede o reparo.
    // A promessa é aguardada no finally para não continuar após a função terminar.
    // NOT-02 also covers API notifications without a turma event ledger (for example, challenges).
    const outbox = await recuperarAvisosPendentes(db, { limit: 3 });
    const events = await sweepEvents(db);

    console.log(JSON.stringify({ evt: "turma_push_sweep", outbox, events }));
    const falhas = Number((outbox as { falhas?: unknown } | null)?.falhas ?? 0) || 0;
    // Heartbeat for the admin panel (Saúde do sistema): last run, ok, duration.
    await registrarRotina(db, "push_reenvio", { ok: falhas === 0, duracaoMs: Date.now() - inicio, problemas: falhas ? [`falhas:${falhas}`] : [], resumo: { ...(outbox as object) } as Record<string, unknown> });
  } catch (erro) {
    await registrarRotina(db, "push_reenvio", { ok: false, duracaoMs: Date.now() - inicio, problemas: ["falha_geral"] });
    throw erro;
  } finally {
    await perfis;
  }
});

// Expo keeps receipts for ~24 h and suggests checking ~15 min after sending; the Vercel cron runs once a day.
export const checkPushReceipts = onSchedule({
  region, schedule: "every 15 minutes", timeZone: "America/Sao_Paulo", timeoutSeconds: 60,
  memory: "256MiB", maxInstances: 1, retryCount: 0, secrets: [expoAccessToken],
}, async () => {
  const inicio = Date.now();
  try {
    const recibos = await consultarRecibos(db, { limit: 30, prazoAte: Date.now() + 45_000 });
    console.log(JSON.stringify({ evt: "push_receipts_check", ...recibos }));
    const falhas = Number((recibos as { falhas?: unknown } | null)?.falhas ?? 0) || 0;
    await registrarRotina(db, "push_recibos", { ok: falhas === 0, duracaoMs: Date.now() - inicio, problemas: falhas ? [`falhas:${falhas}`] : [], resumo: { ...(recibos as object) } as Record<string, unknown> });
  } catch (erro) {
    await registrarRotina(db, "push_recibos", { ok: false, duracaoMs: Date.now() - inicio, problemas: ["falha_geral"] });
    throw erro;
  }
});

// Live Activities têm tokens e entrega próprios; nunca são tratadas como ExpoPushToken.
export const deliverTurmaLiveActivity = onDocumentWritten({
  ...triggerOptions, document: "liveActivityGames/{gameKey}", secrets: [liveApnsKey],
}, async event => {
  const before=event.data?.before.data(),after=event.data?.after.data();
  if(after?.dirty && (before?.version!==after.version || before?.enrollmentRevision!==after.enrollmentRevision || before?.dirty!==true)) await dispatchLiveAttendance(db,event.params.gameKey);
});

export const retryTurmaLiveActivities = onSchedule({
  region,schedule:"every 1 minutes",timeZone:"America/Sao_Paulo",timeoutSeconds:60,memory:"256MiB",maxInstances:1,retryCount:0,secrets:[liveApnsKey],
}, async()=>{await sweepLiveAttendance(db);});

export const invalidateTurmaLiveActivities = onDocumentWritten({ ...triggerOptions, document:"turmas/{turmaId}" },async event=>{
  if(process.env.LIVE_ACTIVITIES_ENABLED!=="true" || !event.data)return;
  const a=event.data.before.data(),b=event.data.after.data();
  if(a?.ativo===b?.ativo && a?.status===b?.status && a?.nome===b?.nome)return;
  const groups=await db.collection("liveActivityGames").where("turmaId","==",event.params.turmaId).limit(50).get();
  for(const group of groups.docs){const d=group.data();await captureLiveAttendance(db,event.params.turmaId,d.dayId,true);}
});

export const invalidateAccountLiveActivities = onDocumentWritten({ ...triggerOptions, document:"users/{uid}" },async event=>{
  if(!event.data)return;
  const a=event.data.before.data(),b=event.data.after.data(),uid=event.params.uid;
  // As duas tarefas são independentes: a falha de uma (ex.: Live Activities) não pode pular a outra (nome/foto nos grupos).
  // Roda as duas e, se alguma falhou, relança a primeira falha depois (as duas são idempotentes; a varredura recuperarPerfis cobre o resto).
  const tarefas:Promise<unknown>[]=[];
  if(a?.status!==b?.status || a?.excluindoEm!==b?.excluindoEm || !event.data.after.exists)tarefas.push(invalidateLiveUser(db,uid));
  if(!b || b.status==="suspended" || b.excluindoEm!=null)tarefas.push(enfileirarPerfil(db,uid));
  else if(mudouIdentidade(a,b))tarefas.push((async()=>{await enfileirarPerfil(db,uid);await processarPerfil(db,uid,Date.now()+20_000);})());
  const falha=(await Promise.allSettled(tarefas)).find((r):r is PromiseRejectedResult=>r.status==="rejected");
  if(falha)throw falha.reason;
});

// Galeria de troféus: acerta o perfil dos jogadores sempre que um campeonato encerra, é corrigido, reaberto ou apagado
// (inclusive quando a turma inteira é excluída). Lê o estado atual numa transação (ordem dos disparos não importa) e, se
// falhar, o Firebase tenta de novo (retry). Lances ao vivo de campeonato em andamento não disparam trabalho.
export const syncCampeonatoTrofeus = onDocumentWritten({ ...triggerOptions, document: "turmas/{turmaId}/campeonatos/{campeonatoId}" }, async event => {
  if (!event.data || !safe(event.params.turmaId) || !safe(event.params.campeonatoId)) return;
  const antes = event.data.before.exists ? event.data.before.data() : null;
  const depois = event.data.after.exists ? event.data.after.data() : null;
  if (!mexeNosTrofeus(antes, depois)) return;
  const r = await sincronizarTrofeusCampeonato(db, event.params.turmaId, event.params.campeonatoId);
  console.log(JSON.stringify({ evt: "trofeus_sync", ...r }));
});
