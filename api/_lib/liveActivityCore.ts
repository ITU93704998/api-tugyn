/** Estado mínimo para a tela bloqueada. Nunca inclui nomes/fotos de participantes. */
export const LIVE_ACTIVITY_NAME = "TurmaAttendance";
export const LIVE_MAX_MS = 7.5 * 3600_000;
export const LIVE_GROUPS = "liveActivityGames";
export const LIVE_SUBSCRIPTIONS = "liveActivitySubscriptions";
export interface AttendanceProps {
  turmaId: string;
  diaId: string;
  nome: string;
  horario: string;
  local: string;
  total: number;
  status: "aberta" | "encerrada" | "cancelada";
  expiraEm: number;
  atualizadoEm: number;
}
export const safeLiveId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const safeLiveDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{8}$/.test(v)) return false;
  const iso = `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0,10) === iso;
};
export const dataLive = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function millisLive(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis(): number }).toMillis();
  return 0;
}
const texto = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max) : "";
export function attendanceSnapshot(turmaId: string, diaId: string, turma: Record<string, unknown> | null, jogo: Record<string, unknown> | null, now: number): AttendanceProps {
  const expiraEm = millisLive(jogo?.expiraEm);
  return {
    turmaId, diaId, nome: texto(turma?.nome,60) || "Partida da turma", horario: texto(jogo?.horario,5), local: texto(jogo?.local,80),
    total: Math.min(500,Object.keys(dataLive(jogo?.confirmados)).filter(safeLiveId).length),
    status: !turma || turma.ativo === false || turma.status === "encerrada" || !jogo ? "cancelada" : jogo.status !== "aberta" || expiraEm <= now ? "encerrada" : "aberta",
    expiraEm, atualizadoEm: now,
  };
}
export function canFollowAttendance(uid: string, turma: Record<string, unknown> | null, participante: Record<string, unknown> | null, jogo: Record<string, unknown> | null, now: number): boolean {
  if (!turma || turma.ativo === false || turma.status === "encerrada" || !jogo || jogo.status !== "aberta" || millisLive(jogo.expiraEm) <= now) return false;
  if (turma.creatorId === uid) return true;
  return participante?.status === "aprovado" && Array.isArray(turma.participantes) && turma.participantes.includes(uid) && Object.prototype.hasOwnProperty.call(dataLive(jogo.confirmados),uid);
}
export function livePayload(props: AttendanceProps, end: boolean, now: number) {
  const seconds = Math.floor(now / 1000);
  return { aps: {
    timestamp: seconds, event: end ? "end" : "update",
    "content-state": { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(props) },
    // O servidor só envia quando o contador muda (sem heartbeat). Por isso o conteúdo vale até o fim da partida: ninguém
    // confirmar por alguns minutos não é "desatualizado". Se a atividade passar do fim sem receber o encerramento, aí sim fica
    // marcada como desatualizada na tela.
    ...(end ? { "dismissal-date": seconds + 60 } : { "stale-date": Math.floor(Math.max(props.expiraEm, now + 60_000) / 1000) }),
  } };
}
