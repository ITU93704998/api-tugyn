import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { DEDUPE_TTL_MS, QUERY_IN_LIMIT, type PushDraft, buildMessages, chunk, sendExpoPush } from "./push";

/** Envio dos avisos (lê e grava no Firestore). Usado por `api/push.ts` e `api/turma-gestao.ts`. */

const TOKENS = "pushTokens";
const DEDUPE = "pushDedupe";

/** Aparelhos (token → documento) dos usuários, em grupos de 30 (limite do operador `in`). */
const tokensDosUsuarios = async (db: Firestore, uids: readonly string[]): Promise<Map<string, DocumentReference>> => {
  const tokens = new Map<string, DocumentReference>();
  for (const grupo of chunk(uids, QUERY_IN_LIMIT)) {
    const snapshot = await db.collection(TOKENS).where("uid", "in", grupo).get();
    for (const doc of snapshot.docs) {
      const token = doc.get("token");
      if (typeof token === "string") tokens.set(token, doc.ref);
    }
  }
  return tokens;
};

export interface Aviso {
  evento: string;
  turmaId: string;
  dedupeKey: string;
  dedupeMs: number;
  recipientUids: readonly string[];
  /** Pessoa gravada no registro de "já avisei" (a exclusão de conta apaga os registros por este campo). */
  dedupeUid: string;
  draft: PushDraft;
}

/** O caminho comum dos avisos: anti-repetição, aparelhos dos destinatários, envio, limpeza de token morto e diagnóstico (só códigos de erro). */
export const enviarAviso = async (db: Firestore, aviso: Aviso): Promise<{ enviados: number; motivo?: string }> => {
  const dedupeRef = db.doc(`${DEDUPE}/${aviso.dedupeKey}`);
  const previous = await dedupeRef.get();
  if (previous.exists && Date.now() - Number(previous.get("at") ?? 0) < aviso.dedupeMs) return { enviados: 0, motivo: "repetido" };
  if (aviso.recipientUids.length === 0) return { enviados: 0, motivo: "sem-destinatarios" };

  const tokenDocs = await tokensDosUsuarios(db, aviso.recipientUids);
  if (tokenDocs.size === 0) return { enviados: 0, motivo: "sem-dispositivos" };

  const results = await sendExpoPush(buildMessages([...tokenDocs.keys()], aviso.draft), { accessToken: process.env.EXPO_ACCESS_TOKEN });
  for (const result of results) if (result.invalid) await tokenDocs.get(result.token)?.delete(); // aparelho que não existe mais

  // Diagnóstico: só os CÓDIGOS de erro e quantos (ex.: {"InvalidCredentials":2} = credenciais do FCM/APNs não configuradas). Nunca o token.
  const falhas = new Map<string, number>();
  for (const result of results) if (!result.ok) falhas.set(result.error ?? "desconhecido", (falhas.get(result.error ?? "desconhecido") ?? 0) + 1);
  if (falhas.size > 0) console.warn("[push] falhas de envio:", JSON.stringify(Object.fromEntries(falhas)));

  const enviados = results.filter((result) => result.ok).length;
  if (enviados > 0) {
    const now = Date.now();
    await dedupeRef.set({ evento: aviso.evento, turmaId: aviso.turmaId, targetUid: aviso.dedupeUid, at: now, expiresAt: new Date(now + DEDUPE_TTL_MS) });
  }
  return { enviados, ...(enviados === 0 ? { motivo: "falha-envio" } : {}) };
};
