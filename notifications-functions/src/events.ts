import { createHash } from "node:crypto";
import {
  authorizeAttendanceConfirmed, authorizeGameOpened, authorizeJoinApproved, authorizeJoinRequest,
  DEDUPE_MS, DEDUPE_PARTIDA_MS, diaDeBrasilia,
} from "../../api/_lib/push";
import type { Aviso } from "../../api/_lib/pushEnvio";
import { isSafeUid } from "../../api/_lib/validation";

export type Data = Record<string, unknown>;
export interface Change { id: string; source: string; timeMs: number; turmaId: string; before: Data | null; after: Data | null }
export interface PlannedEvent { id: string; eventTimeMs: number; aviso: Aviso }
const uid = isSafeUid;
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const active = (turma: Data | null): turma is Data => !!turma && turma.ativo !== false && turma.status !== "encerrada" && uid(turma.creatorId);
function plan(change: Change, type: string, actor: string, aviso: Aviso): PlannedEvent {
  const id = createHash("sha256").update(JSON.stringify([change.source, change.id, type, actor])).digest("hex");
  return { id, eventTimeMs: change.timeMs, aviso };
}

/** Only actual status transitions, never a profile/statistics update of the participant. */
export function participantEvents(change: Change, participantId: string, turma: Data | null, current: Data | null): PlannedEvent[] {
  if (!uid(change.turmaId) || !uid(participantId) || !change.after || !current || !active(turma)) return [];
  const before = change.before?.status;
  const after = change.after.status;
  if (after === "pendente" && before !== "pendente" && current.status === "pendente") {
    const auth = authorizeJoinRequest(participantId, change.turmaId, turma, current);
    if (!auth.ok) return [];
    return [plan(change, "pedido_entrada", participantId, { evento: "pedido_entrada", turmaId: change.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_MS, recipientUids: [auth.recipientUid], dedupeUid: participantId, draft: auth.draft })];
  }
  if (before === "pendente" && after === "aprovado" && current.status === "aprovado" && Array.isArray(turma.participantes) && turma.participantes.includes(participantId)) {
    const auth = authorizeJoinApproved(turma.creatorId as string, change.turmaId, participantId, turma, current);
    if (!auth.ok) return [];
    return [plan(change, "pedido_aceito", participantId, { evento: "pedido_aceito", turmaId: change.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_MS, recipientUids: [auth.recipientUid], dedupeUid: participantId, draft: auth.draft })];
  }
  return [];
}

/** Names, photos, withdrawals, closing and reopening are not new attendance/opening events. */
export function gameEvents(change: Change, dayId: string, turma: Data | null, current: Data | null, nowMs: number): PlannedEvent[] {
  if (!uid(change.turmaId) || !active(turma) || !change.after || !current || dayId !== diaDeBrasilia(nowMs).id) return [];
  const events: PlannedEvent[] = [];
  if (!change.before && change.after.status === "aberta" && current.status === "aberta") {
    const creator = change.after.criadoPor;
    if (uid(creator)) {
      const auth = authorizeGameOpened(creator, change.turmaId, dayId, turma, current);
      if (auth.ok && auth.recipientUids.length) events.push(plan(change, "partida_aberta", creator, { evento: "partida_aberta", turmaId: change.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_PARTIDA_MS, recipientUids: auth.recipientUids, dedupeUid: creator, draft: auth.draft }));
    }
  }
  const previous = object(change.before?.confirmados);
  for (const actor of Object.keys(object(change.after.confirmados))) {
    if (!uid(actor) || Object.prototype.hasOwnProperty.call(previous, actor)) continue;
    const auth = authorizeAttendanceConfirmed(actor, change.turmaId, dayId, turma, current);
    if (auth.ok) events.push(plan(change, "presenca_confirmada", actor, { evento: "presenca_confirmada", turmaId: change.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_PARTIDA_MS, recipientUids: [auth.recipientUid], dedupeUid: actor, draft: auth.draft }));
  }
  return events;
}
