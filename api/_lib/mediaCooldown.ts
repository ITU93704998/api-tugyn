import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "./auth";
import { isSafeUid } from "./validation";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type CheckResult =
  | { allowed: true }
  | { allowed: false; status: 400 | 403 | 404 | 429 | 503; error: string; retryAfterSeconds?: number };

const timestampMillis = (value: unknown): number | null => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null && "toMillis" in value && typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
};

const cooldownResult = (value: unknown, label: string, now = Date.now()): CheckResult => {
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

/** Confere no Firestore antes de gastar uma chamada do Cloudinary. As regras do Firestore
 * repetem a mesma verificação no salvamento, protegendo contra alterações diretas pelo app. */
export const verificarIntervaloDaImagem = async (
  uid: string,
  tipo: "fotoPerfil" | "bannerTurma",
  turmaId?: unknown,
): Promise<CheckResult> => {
  const db = getFirestore(getFirebaseApp());

  if (tipo === "fotoPerfil") {
    const profile = await db.collection("users").doc(uid).get();
    return cooldownResult(profile.data()?.profileImageChangedAt, "A foto de perfil");
  }

  if (!isSafeUid(turmaId)) {
    return { allowed: false, status: 400, error: "Identificador da turma inválido." };
  }
  const turma = await db.collection("turmas").doc(turmaId).get();
  if (!turma.exists) return { allowed: false, status: 404, error: "Turma não encontrada." };
  if (turma.get("creatorId") !== uid) {
    return { allowed: false, status: 403, error: "Somente o organizador pode trocar o banner." };
  }
  return cooldownResult(turma.get("bannerChangedAt"), "O banner desta turma");
};
