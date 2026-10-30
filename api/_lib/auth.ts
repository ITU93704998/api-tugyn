import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { type AcaoDaApi, RESPOSTA_SUSPENSA, acaoPermitida } from "./suspensao";
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
  /** A conta tem a permissão `admin` (claim definida pelo script definir-admin.js). Só `true` de verdade vale. */
  admin: boolean;
}

/** Status da conta lido há pouco (cada instância da função guarda por alguns segundos: menos leituras em rajadas). */
const STATUS_TTL_MS = 20_000;
type StatusDaConta = { status?: unknown; excluindoEm?: unknown } | null;
const statusRecente = new Map<string, { perfil: StatusDaConta; em: number }>();

const lerStatusDaConta = async (app: App, uid: string): Promise<StatusDaConta> => {
  const guardado = statusRecente.get(uid);
  if (guardado && Date.now() - guardado.em < STATUS_TTL_MS) return guardado.perfil;
  const snap = await getFirestore(app).doc(`users/${uid}`).get();
  const perfil = snap.exists ? { status: snap.get("status"), excluindoEm: snap.get("excluindoEm") } : null;
  if (statusRecente.size > 500) statusRecente.clear();
  statusRecente.set(uid, { perfil, em: Date.now() });
  return perfil;
};

/**
 * Exige `Authorization: Bearer <ID token do Firebase>` e devolve o uid REAL do usuário.
 * O uid sempre vem do token: nada que o cliente escreve no corpo decide quem ele é.
 * `acao` é obrigatória: conta suspensa só faz o que `PERMITIDAS_A_SUSPENSOS` deixa (política única em `suspensao.ts`).
 * Já responde 401/403 (ou 500/503, se o servidor estiver mal configurado ou fora do ar) e retorna null.
 */
export const requireUser = async (
  req: VercelRequest,
  res: VercelResponse,
  acao: AcaoDaApi,
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

  let user: AuthenticatedUser;
  try {
    // checkRevoked: contas desativadas/apagadas ou sessões revogadas deixam de funcionar na hora.
    const decoded = await getAuth(app).verifyIdToken(token, true);
    if (!isSafeUid(decoded.uid)) throw new Error("uid inesperado");
    user = { uid: decoded.uid, authTime: typeof decoded.auth_time === "number" ? decoded.auth_time : 0, admin: decoded.admin === true };
  } catch (erro) {
    // Conta desativada pela moderação: o app mostra o aviso de conta suspensa, e não "sessão expirada".
    if ((erro as { code?: unknown } | null)?.code === "auth/user-disabled") res.status(403).json(RESPOSTA_SUSPENSA);
    else res.status(401).json({ error: "Sessão inválida ou expirada." });
    return null;
  }

  let perfil: StatusDaConta;
  try {
    perfil = await lerStatusDaConta(app, user.uid);
  } catch (erro) {
    // Sem saber o status, não libera (falha fechada).
    console.error(JSON.stringify({ evt: "status_conta_falhou", acao, message: (erro as Error)?.message ?? String(erro) }));
    res.status(503).json({ error: "Serviço indisponível. Tente novamente." });
    return null;
  }
  if (!acaoPermitida(perfil, acao)) {
    console.log(JSON.stringify({ evt: "conta_suspensa_bloqueada", acao }));
    res.status(403).json(RESPOSTA_SUSPENSA);
    return null;
  }
  return user;
};
