import { randomUUID } from "node:crypto";
import { type Firestore, type DocumentReference } from "firebase-admin/firestore";
import { DEDUPE_TTL_MS } from "../../api/_lib/push";
import { enviarAviso, type Aviso, type EnvioOptions } from "../../api/_lib/pushEnvio";
import type { PlannedEvent } from "./events";

export const EVENTS = "turmaPushEvents";
type State = "queued" | "done" | "uncertain" | "failed" | "expired" | "superseded";
export class PendingEvent extends Error { constructor() { super("Push event remains pending"); } }

/**
 * Schema-1 adapter: writes the existing API outbox, without editing its implementation.
 * The ledger and reservation commit together. Regression tests run the real API consumer.
 */
export async function enqueueEvent(db: Firestore, event: PlannedEvent, now = Date.now()): Promise<boolean> {
  const ledger = db.doc(`${EVENTS}/${event.id}`);
  const ref = db.doc(`pushDedupe/${event.aviso.dedupeKey}`);
  const notificationId = randomUUID();
  return db.runTransaction(async tx => {
    const [seen, existing] = await Promise.all([tx.get(ledger), tx.get(ref)]);
    if (seen.exists) return false;
    const previous = existing.data();
    let boundId: string = notificationId;
    let state: State = "queued";
    let create = true;
    if (previous) {
      const expiredPreparation = ["pending", "leased"].includes(previous.state) && Number(previous.leaseUntil ?? 0) <= now && Number(previous.deadlineAt ?? Infinity) <= now;
      const terminal = ["done", "failed", "expired"].includes(previous.state) || expiredPreparation;
      // Also bind an old completed occurrence if it was already sent for this change before trigger delivery.
      const sameOccurrence = Number(previous.at ?? 0) >= event.eventTimeMs || now - Number(previous.at ?? 0) < event.aviso.dedupeMs;
      if (previous.schema === 1 && (!terminal || sameOccurrence)) {
        create = false; boundId = previous.notificationId;
        if (["done", "failed", "expired", "uncertain"].includes(previous.state)) state = previous.state;
      } else if ((previous.schema !== 1 && previous.schema !== undefined) || (previous.schema === undefined && sameOccurrence)) {
        // Unknown schema fails closed; a legacy accepted record already covers this notification.
        create = false; boundId = typeof previous.notificationId === "string" ? previous.notificationId : "legacy";
        state = previous.schema === undefined ? "done" : "uncertain";
      }
    }
    if (create) {
      tx.set(ref, {
        schema: 1, state: "pending", aviso: { ...event.aviso, recipientUids: [...new Set(event.aviso.recipientUids)] },
        notificationId, createdAt: now, deadlineAt: now + Math.min(event.aviso.dedupeMs, 24 * 3600_000), at: now,
        owner: "", leaseUntil: 0, nextAttemptAt: now, batchIds: [], outcomes: {}, tries: {},
        evento: event.aviso.evento, turmaId: event.aviso.turmaId, targetUid: event.aviso.dedupeUid,
        expiresAt: new Date(now + DEDUPE_TTL_MS),
      });
    }
    tx.set(ledger, { schema: 1, state, outboxKey: event.aviso.dedupeKey, notificationId: boundId, eventTimeMs: event.eventTimeMs, createdAt: now, expiresAt: new Date(now + DEDUPE_TTL_MS) });
    return true;
  });
}

export async function dispatchEvent(db: Firestore, ledgerRef: DocumentReference, options: EnvioOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const ledger = (await ledgerRef.get()).data();
  if (!ledger || ledger.schema !== 1 || ledger.state !== "queued") return;
  if (typeof ledger.outboxKey !== "string" || ledger.outboxKey.includes("/")) throw new Error("Invalid outbox reference");
  const ref = db.doc(`pushDedupe/${ledger.outboxKey}`);
  const finish = async (state: State) => db.runTransaction(async tx => {
    const current = (await tx.get(ledgerRef)).data();
    if (current && current.notificationId === ledger.notificationId && current.state === "queued") tx.update(ledgerRef, { state, updatedAt: now() });
  });
  let job = (await ref.get()).data();
  if (!job || job.notificationId !== ledger.notificationId) { await finish("superseded"); return; }
  if (!["done", "uncertain", "failed", "expired"].includes(job.state)) {
    if (job.schema !== 1 || !job.aviso) throw new Error("Incompatible push outbox schema");
    // Existing consumer retains accepted-token progress, receipt tracking and token revocation logic.
    await enviarAviso(db, job.aviso as Aviso, options);
    job = (await ref.get()).data();
  }
  if (!job || job.notificationId !== ledger.notificationId) { await finish("superseded"); return; }
  if (["done", "uncertain", "failed", "expired"].includes(job.state)) { await finish(job.state as State); return; }
  // Eventarc retries and the minute worker both use this durable reservation, never a new event key.
  throw new PendingEvent();
}

export async function sweepEvents(db: Firestore, options: EnvioOptions = {}): Promise<Record<string, number>> {
  const snap = await db.collection(EVENTS).where("state", "==", "queued").limit(30).get();
  const counts = { examined: snap.size, completed: 0, pending: 0, failed: 0 };
  let index = 0;
  const until = Date.now() + 35_000;
  await Promise.all(Array.from({ length: Math.min(3, snap.size) }, async () => {
    while (index < snap.docs.length && Date.now() < until) {
      const doc = snap.docs[index++];
      try { await dispatchEvent(db, doc.ref, options); counts.completed++; }
      catch (error) { if (error instanceof PendingEvent) counts.pending++; else counts.failed++; }
    }
  }));
  return counts;
}
