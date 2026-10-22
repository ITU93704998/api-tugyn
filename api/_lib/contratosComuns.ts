import type { VercelResponse } from "@vercel/node";
import { type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import { parseConfig } from "./contratoCore";
import { COLECAO, CONFIG_DOC, type ContratoDoc, TOKEN_FORMATO, hashToken, parseContrato } from "./contratos";

/** Peças usadas pela rota de contratos e pelos tratadores da Fase 2. */
export class Conflito extends Error {}
export class NaoEncontrado extends Error {}
/** A validação do anúncio (ou da campanha) falhou: vira 400 com a mensagem. */
export class Invalido extends Error {
  constructor(message: string, readonly erros: Record<string, string> = {}) {
    super(message);
  }
}

export const responder = (res: VercelResponse, status: number, body: Record<string, unknown>) => res.status(status).json(body);

export const lerConfig = async (db: Firestore) => {
  const snapshot = await db.doc(CONFIG_DOC).get();
  return parseConfig(snapshot.exists ? snapshot.data() : null);
};

export const buscarPorToken = async (db: Firestore, token: unknown) => {
  if (typeof token !== "string" || !TOKEN_FORMATO.test(token)) return null;
  const snapshot = await db.collection(COLECAO).where("tokenHash", "==", hashToken(token)).limit(1).get();
  const doc = snapshot.docs[0];
  if (!doc) return null;
  const data = parseContrato(doc.data());
  return data ? { ref: doc.ref, data } : null;
};

export const lerNaTransacao = async (tx: Transaction, ref: DocumentReference): Promise<ContratoDoc> => {
  const snapshot = await tx.get(ref);
  const doc = snapshot.exists ? parseContrato(snapshot.data()) : null;
  if (!doc) throw new NaoEncontrado();
  return doc;
};
