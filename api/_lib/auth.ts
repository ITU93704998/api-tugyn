import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { isSafeUid } from "./validation";

export const getFirebaseApp = (): App => {
  const existing = getApps()[0];
  if (existing) return existing;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    return initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Credenciais do Firebase Admin ausentes no servidor.");
  }
  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
};

export interface AuthenticatedUser {
  uid: string;
  /** Quando o usuário digitou a senha pela última vez (segundos desde 1970). */
  authTime: number;
}

/**
 * Exige `Authorization: Bearer <ID token do Firebase>` e devolve o uid REAL do usuário.
 * O uid sempre vem do token: nada que o cliente escreve no corpo decide quem ele é.
 * Já responde 401 (ou 500, se o servidor estiver mal configurado) e retorna null.
 */
export const requireUser = async (
  req: VercelRequest,
  res: VercelResponse,
): Promise<AuthenticatedUser | null> => {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? /^Bearer (\S+)$/.exec(header)?.[1] : undefined;

  if (!token) {
    res.status(401).json({ error: "Não autenticado." });
    return null;
  }

  let app: App;
  try {
    app = getFirebaseApp();
  } catch (error) {
    console.error("[auth] Firebase Admin não configurado:", error);
    res.status(500).json({ error: "Servidor não configurado." });
    return null;
  }

  try {
    // checkRevoked: contas desativadas/apagadas ou sessões revogadas deixam de funcionar na hora.
    const decoded = await getAuth(app).verifyIdToken(token, true);
    if (!isSafeUid(decoded.uid)) throw new Error("uid inesperado");
    return { uid: decoded.uid, authTime: typeof decoded.auth_time === "number" ? decoded.auth_time : 0 };
  } catch {
    res.status(401).json({ error: "Sessão inválida ou expirada." });
    return null;
  }
};
