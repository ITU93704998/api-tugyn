import type { VercelRequest, VercelResponse } from "@vercel/node";
import { type Firestore, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import {
  DEDUPE_MS,
  DEDUPE_PARTIDA_MS,
  MAX_TOKENS_PER_USER,
  type Authorization,
  authorizeGameOpened,
  authorizeAttendanceConfirmed,
  authorizeJoinApproved,
  authorizeJoinRequest,
  diaDeBrasilia,
  parsePushBody,
  tokenDocId,
} from "./_lib/push";
import { enviarAviso } from "./_lib/pushEnvio";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * POST /api/push   (corpo: { action, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - registrar   { token, platform }          guarda o token do aparelho para o usuário LOGADO (um token pertence a um usuário só)
 *  - remover     { token }                    apaga o token (sair da conta, desligar os avisos)
 *  - notificar   { evento: "pedido_entrada", turmaId }                   o solicitante avisa o organizador
 *  - notificar   { evento: "pedido_aceito", turmaId, userId }            o organizador avisa quem entrou
 *  - notificar   { evento: "partida_aberta", turmaId }                   o organizador abriu a partida de hoje: avisa os membros da turma
 *  - notificar   { evento: "presenca_confirmada", turmaId }             avisa o organizador apos confirmar presenca
 * Uma rota só (o plano gratuito da Vercel limita o número de funções). O uid vem SEMPRE do login; o destinatário vem SEMPRE do Firestore.
 */
const TOKENS = "pushTokens";

const registrar = async (db: Firestore, uid: string, token: string, platform: string): Promise<void> => {
  const ref = db.doc(`${TOKENS}/${tokenDocId(token)}`);
  const now = Date.now();
  const existing = await ref.get();
  // Se o token era de OUTRA pessoa (aparelho que trocou de conta), passa a ser desta: o aviso nunca vai para quem saiu.
  await ref.set({ uid, token, platform, updatedAt: now, createdAt: existing.exists && existing.get("uid") === uid ? (existing.get("createdAt") as number) ?? now : now });

  const mine = await db.collection(TOKENS).where("uid", "==", uid).get();
  if (mine.size > MAX_TOKENS_PER_USER) {
    const oldest = [...mine.docs].sort((a, b) => Number(a.get("updatedAt") ?? 0) - Number(b.get("updatedAt") ?? 0)).slice(0, mine.size - MAX_TOKENS_PER_USER);
    for (const doc of oldest) if (doc.id !== ref.id) await doc.ref.delete();
  }
};

const remover = async (db: Firestore, uid: string, token: string): Promise<void> => {
  const ref = db.doc(`${TOKENS}/${tokenDocId(token)}`);
  const snapshot = await ref.get();
  if (snapshot.exists && snapshot.get("uid") === uid) await ref.delete(); // ninguém apaga o token de outra pessoa
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res);
  if (!user) return; // requireUser já respondeu (401/500)
  if (!(await verificarAppCheck(req, res, "push"))) return;

  const parsed = parsePushBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const request = parsed.value;

  const limit = request.action === "notificar" ? 30 : 20;
  if (!(await dentroDoLimite(user.uid, `push-${request.action}`, limit, 3600))) {
    return res.status(429).json({ error: "Muitas requisições. Tente novamente mais tarde." });
  }

  let db: Firestore;
  try {
    db = getFirestore(getFirebaseApp());
  } catch (error) {
    console.error("[push] Firebase Admin não configurado:", error);
    return res.status(500).json({ error: "Servidor não configurado." });
  }

  try {
    if (request.action === "registrar") {
      await registrar(db, user.uid, request.token, request.platform);
      return res.status(200).json({ ok: true });
    }
    if (request.action === "remover") {
      await remover(db, user.uid, request.token);
      return res.status(200).json({ ok: true });
    }

    // notificar
    const turmaSnap = await db.doc(`turmas/${request.turmaId}`).get();
    const turma = turmaSnap.exists ? (turmaSnap.data() ?? null) : null;

    if (request.evento === "presenca_confirmada") {
      const { id: diaId } = diaDeBrasilia(Date.now());
      const jogoSnap = await db.doc(`turmas/${request.turmaId}/jogos/${diaId}`).get();
      const auth = authorizeAttendanceConfirmed(user.uid, request.turmaId, diaId, turma, jogoSnap.exists ? (jogoSnap.data() ?? null) : null);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      const resultado = await enviarAviso(db, { evento: "presenca_confirmada", turmaId: request.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_PARTIDA_MS, recipientUids: [auth.recipientUid], dedupeUid: user.uid, draft: auth.draft });
      return res.status(200).json(resultado);
    }

    if (request.evento === "partida_aberta") {
      // O "hoje" é o do SERVIDOR (Brasília): o app não escolhe o dia. A partida de hoje tem que existir, estar aberta e ter sido aberta por quem chama.
      const { id: diaId } = diaDeBrasilia(Date.now());
      const jogoSnap = await db.doc(`turmas/${request.turmaId}/jogos/${diaId}`).get();
      const auth = authorizeGameOpened(user.uid, request.turmaId, diaId, turma, jogoSnap.exists ? (jogoSnap.data() ?? null) : null);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      const resultado = await enviarAviso(db, { evento: "partida_aberta", turmaId: request.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_PARTIDA_MS, recipientUids: auth.recipientUids, dedupeUid: user.uid, draft: auth.draft });
      return res.status(200).json(resultado);
    }

    const targetUid = request.evento === "pedido_entrada" ? user.uid : request.userId;
    const partSnap = await db.doc(`turmas/${request.turmaId}/participantes/${targetUid}`).get();
    const participante = partSnap.exists ? (partSnap.data() ?? null) : null;

    const auth: Authorization =
      request.evento === "pedido_entrada"
        ? authorizeJoinRequest(user.uid, request.turmaId, turma, participante)
        : authorizeJoinApproved(user.uid, request.turmaId, request.userId, turma, participante);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const resultado = await enviarAviso(db, { evento: request.evento, turmaId: request.turmaId, dedupeKey: auth.dedupeKey, dedupeMs: DEDUPE_MS, recipientUids: [auth.recipientUid], dedupeUid: auth.recipientUid, draft: auth.draft });
    return res.status(200).json(resultado);
  } catch (error) {
    console.error("[push] falha:", error instanceof Error ? error.message : "erro desconhecido"); // sem token no log
    return res.status(503).json({ error: "Não foi possível agora. Tente novamente." });
  }
}
