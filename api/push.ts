import type { VercelRequest, VercelResponse } from "@vercel/node";
import { type DocumentReference, type Firestore, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import {
  DEDUPE_MS,
  DEDUPE_PARTIDA_MS,
  DEDUPE_TTL_MS,
  MAX_TOKENS_PER_USER,
  QUERY_IN_LIMIT,
  type Authorization,
  type PushDraft,
  authorizeGameOpened,
  authorizeJoinApproved,
  authorizeJoinRequest,
  buildMessages,
  chunk,
  diaDeBrasilia,
  parsePushBody,
  sendExpoPush,
  tokenDocId,
} from "./_lib/push";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * POST /api/push   (corpo: { action, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - registrar   { token, platform }          guarda o token do aparelho para o usuário LOGADO (um token pertence a um usuário só)
 *  - remover     { token }                    apaga o token (sair da conta, desligar os avisos)
 *  - notificar   { evento: "pedido_entrada", turmaId }                   o solicitante avisa o organizador
 *  - notificar   { evento: "pedido_aceito", turmaId, userId }            o organizador avisa quem entrou
 *  - notificar   { evento: "partida_aberta", turmaId }                   o organizador abriu a partida de hoje: avisa os membros da turma
 * Uma rota só (o plano gratuito da Vercel limita o número de funções). O uid vem SEMPRE do login; o destinatário vem SEMPRE do Firestore.
 */
const TOKENS = "pushTokens";
const DEDUPE = "pushDedupe";

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

interface Aviso {
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
const enviarAviso = async (db: Firestore, aviso: Aviso): Promise<{ enviados: number; motivo?: string }> => {
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
