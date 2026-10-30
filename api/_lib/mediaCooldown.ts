const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type TipoDeImagem = "fotoPerfil" | "bannerTurma";

export type CheckResult =
  | { allowed: true }
  | { allowed: false; status: 400 | 403 | 404 | 409 | 429 | 503; error: string; retryAfterSeconds?: number };

export const timestampMillis = (value: unknown): number | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value && typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
};

const cooldownResult = (value: unknown, label: string, now: number): CheckResult => {
  if (value === undefined || value === null) return { allowed: true };
  const changedAt = timestampMillis(value);
  if (changedAt === null) {
    return { allowed: false, status: 503, error: "Não foi possível validar o prazo para trocar esta imagem." };
  }
  const retryAt = changedAt + WEEK_MS;
  if (now >= retryAt) return { allowed: true };
  const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  return {
    allowed: false,
    status: 429,
    error: label + " só pode ser trocado uma vez a cada 7 dias. Tente novamente depois.",
    retryAfterSeconds,
  };
};

/**
 * Prazo e propriedade da troca, a partir do documento-alvo (`users/{uid}` ou `turmas/{id}`, null se não existe). Pura: a API
 * chama DENTRO da transação que reserva a troca (`_lib/midiaReservas.ts`). As regras do Firestore repetem o prazo quando o
 * app grava a referência, protegendo contra alterações diretas.
 */
export const checarIntervalo = (
  uid: string,
  tipo: TipoDeImagem,
  alvo: Record<string, unknown> | null,
  now = Date.now(),
): CheckResult => {
  if (tipo === "fotoPerfil") return cooldownResult(alvo?.profileImageChangedAt, "A foto de perfil", now);
  if (!alvo) return { allowed: false, status: 404, error: "Turma não encontrada." };
  if (alvo.creatorId !== uid) {
    return { allowed: false, status: 403, error: "Somente o organizador pode trocar o banner." };
  }
  return cooldownResult(alvo.bannerChangedAt, "O banner desta turma", now);
};
