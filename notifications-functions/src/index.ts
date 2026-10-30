import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { type Change, participantEvents, gameEvents } from "./events";
import { dispatchEvent, enqueueEvent, sweepEvents } from "./outbox";
import { isSafeUid } from "../../api/_lib/validation";
import { recuperarAvisosPendentes } from "../../api/_lib/pushEnvio";

if (!getApps().length) initializeApp();
const db = getFirestore();
// Configure the SAME Expo project secret as the Vercel API; never place it in client configuration.
const expoAccessToken = defineSecret("EXPO_ACCESS_TOKEN");
const region = process.env.TUGYN_PUSH_REGION || "southamerica-east1";
const triggerOptions = { region, retry: true, timeoutSeconds: 60, memory: "256MiB" as const, maxInstances: 3, concurrency: 10 };
const safe = isSafeUid;

export const captureTurmaParticipantNotification = onDocumentWritten({ ...triggerOptions, document: "turmas/{turmaId}/participantes/{participantId}" }, async event => {
  if (!event.data || !safe(event.params.turmaId) || !safe(event.params.participantId)) return;
  const before = event.data.before.exists ? event.data.before.data()! : null;
  const after = event.data.after.exists ? event.data.after.data()! : null;
  if (!after || before?.status === after.status || (after.status !== "pendente" && !(before?.status === "pendente" && after.status === "aprovado"))) return;
  const [turma, current] = await Promise.all([db.doc(`turmas/${event.params.turmaId}`).get(), event.data.after.ref.get()]);
  const change: Change = { id: event.id, source: event.source, timeMs: event.data.after.updateTime?.toMillis() ?? Date.parse(event.time), turmaId: event.params.turmaId, before, after };
  for (const planned of participantEvents(change, event.params.participantId, turma.data() ?? null, current.data() ?? null)) await enqueueEvent(db, planned);
});

export const captureTurmaGameNotification = onDocumentWritten({ ...triggerOptions, document: "turmas/{turmaId}/jogos/{dayId}" }, async event => {
  if (!event.data || !safe(event.params.turmaId) || !/^\d{8}$/.test(event.params.dayId)) return;
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
  // NOT-02 also covers API notifications without a turma event ledger (for example, challenges).
  const outbox = await recuperarAvisosPendentes(db, { limit: 3 });
  const events = await sweepEvents(db);
  console.log(JSON.stringify({ evt: "turma_push_sweep", outbox, events }));
});
