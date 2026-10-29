import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import {
  type DesafioRequest,
  autorizarCancelamento,
  autorizarCriacao,
  autorizarResposta,
  avisoDeResultado,
  decidirApuracao,
  idDoDesafio,
  somarDoDesafio,
  temporadaInfo,
  turmaDoDesafio,
  vencedorEntre,
  parseDesafioBody,
} from "./_lib/desafios";
import { DEDUPE_MS, type PushDraft } from "./_lib/push";
import { enviarAviso } from "./_lib/pushEnvio";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * POST /api/desafios   (corpo: { action, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - criar { desafiadoId, turmaId, temporada }               desafia um atleta numa turma ativa dos dois
 *  - responder { desafioId, aceitar }                         o desafiado aceita ou recusa
 *  - cancelar { desafioId }                                   quem desafiou desiste (só enquanto pendente)
 *  - apurar { desafioIds }                                    fecha os que já podem ter resultado (o app pede ao abrir a aba)
 * Pelo servidor porque as regras do Firestore não deixam o app gravar em `desafios` e o resultado soma números de turmas que
 * nem sempre o próprio usuário pode ler. Regras do desafio em `_lib/desafios.ts`.
 */

const COLECAO = "desafios";
const LIMITE_POR_HORA = 40;

type Resultado = { ok: true; body?: Record<string, unknown> } | { ok: false; status: number; code: string; error: string };

/** Avisos são melhor esforço: a ação já está salva. */
const avisar = async (db: Firestore, para: string, dedupeKey: string, draft: PushDraft): Promise<void> => {
  try {
    await enviarAviso(db, { evento: draft.data.tipo, turmaId: "", dedupeKey, dedupeMs: DEDUPE_MS, recipientUids: [para], dedupeUid: para, draft });
  } catch (erro) {
    console.warn("[desafios] aviso não enviado:", (erro as Error)?.message ?? "erro");
  }
};

const contarAtivos = async (db: Firestore, uid: string): Promise<number> => {
  const snap = await db
    .collection(COLECAO)
    .where("participantes", "array-contains", uid)
    .where("status", "in", ["pendente", "aceito"])
    .count()
    .get();
  return snap.data().count;
};

const criar = async (db: Firestore, uid: string, desafiadoId: string, turmaId: string, temporada: "atual" | "proxima"): Promise<Resultado> => {
  const agoraMs = Date.now();
  const chave = temporadaInfo(agoraMs, temporada === "atual" ? 0 : 1).chave;
  const ref = db.doc(`${COLECAO}/${idDoDesafio(chave, uid, desafiadoId)}`);

  const [perfilA, perfilB, bloqueioA, bloqueioB, turma, existente, ativosA, ativosB] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${desafiadoId}`).get(),
    db.doc(`users/${uid}/blocked/${desafiadoId}`).get(),
    db.doc(`users/${desafiadoId}/blocked/${uid}`).get(),
    db.doc(`turmas/${turmaId}`).get(),
    ref.get(),
    contarAtivos(db, uid),
    contarAtivos(db, desafiadoId),
  ]);

  const auth = autorizarCriacao({
    uid,
    desafiadoId,
    temporada,
    agoraMs,
    perfilDesafiante: perfilA.data() ?? null,
    perfilDesafiado: perfilB.exists ? (perfilB.data() ?? null) : null,
    bloqueio: bloqueioA.exists || bloqueioB.exists,
    turma: turmaDoDesafio({ id: turma.id, data: turma.exists ? (turma.data() ?? null) : null }, uid, desafiadoId),
    ativosDesafiante: ativosA,
    ativosDesafiado: ativosB,
    existente: existente.exists ? (existente.data() ?? null) : null,
  });
  if (!auth.ok) return auth;

  // Dois toques ao mesmo tempo: a transação garante um desafio só (o cancelado pode ser refeito).
  const criado = await db.runTransaction(async (tx) => {
    const atual = await tx.get(ref);
    if (atual.exists && atual.get("status") !== "cancelado") return false;
    tx.set(ref, { ...auth.dados, criadoEm: FieldValue.serverTimestamp(), atualizadoEm: FieldValue.serverTimestamp() });
    return true;
  });
  if (!criado) return { ok: false, status: 409, code: "ja_existe", error: "Vocês já têm um desafio nesta temporada." };

  await avisar(db, desafiadoId, `desafio_novo_${auth.id}`, auth.draft);
  return { ok: true, body: { desafioId: auth.id } };
};

const responder = async (db: Firestore, uid: string, desafioId: string, aceitar: boolean): Promise<Resultado> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);
  const resultado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const auth = autorizarResposta(uid, snap.exists ? (snap.data() ?? null) : null, aceitar, Date.now());
    if (!auth.ok) return auth;
    tx.update(ref, {
      status: aceitar ? "aceito" : "recusado",
      respondidoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    return { ...auth, desafianteId: String(snap.get("desafianteId")) };
  });
  if (!resultado.ok) return resultado;
  if (resultado.draft) await avisar(db, resultado.desafianteId, `desafio_aceito_${desafioId}`, resultado.draft);
  return { ok: true };
};

const cancelar = async (db: Firestore, uid: string, desafioId: string): Promise<Resultado> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const auth = autorizarCancelamento(uid, snap.exists ? (snap.data() ?? null) : null);
    if (!auth.ok) return auth;
    tx.update(ref, { status: "cancelado", atualizadoEm: FieldValue.serverTimestamp() });
    return { ok: true as const };
  });
};

/** Fecha um desafio (ou só marca como expirado). Devolve o novo status, ou null se nada mudou. */
const apurarUm = async (db: Firestore, uid: string, desafioId: string): Promise<string | null> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);
  type Fechamento =
    | { status: "expirado" }
    | { status: "finalizado"; outro: string; vencedorNome: string | null; rotulo: string };
  const fechado = await db.runTransaction(async (tx): Promise<Fechamento | null> => {
    const snap = await tx.get(ref);
    const desafio = snap.exists ? (snap.data() ?? null) : null;
    const decisao = decidirApuracao(uid, desafio, Date.now());
    if (!decisao.ok || decisao.acao === "nada" || !desafio) return null;

    if (decisao.acao === "expirar") {
      tx.update(ref, { status: "expirado", atualizadoEm: FieldValue.serverTimestamp() });
      return { status: "expirado" };
    }

    // Só a turma gravada no desafio (a escolhida ao desafiar; desafios antigos podem ter mais de uma).
    const turmas = Array.isArray(desafio.turmas) ? (desafio.turmas as { id?: unknown }[]) : [];
    const ids = turmas.map((t) => t?.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id));
    const a = String(desafio.desafianteId);
    const b = String(desafio.desafiadoId);
    const chave = String(desafio.temporada);
    const docs = ids.length ? await tx.getAll(...ids.flatMap((id) => [db.doc(`turmas/${id}/participantes/${a}`), db.doc(`turmas/${id}/participantes/${b}`)])) : [];
    const dados = docs.map((d) => (d.exists ? (d.data() ?? null) : null));
    const numerosA = { uid: a, ...somarDoDesafio(dados.filter((_, i) => i % 2 === 0), chave) };
    const numerosB = { uid: b, ...somarDoDesafio(dados.filter((_, i) => i % 2 === 1), chave) };
    const vencedorId = vencedorEntre(numerosA, numerosB);

    tx.update(ref, {
      status: "finalizado",
      resultado: {
        [a]: { gols: numerosA.gols, assistencias: numerosA.assistencias, jogos: numerosA.jogos, pontos: numerosA.pontos },
        [b]: { gols: numerosB.gols, assistencias: numerosB.assistencias, jogos: numerosB.jogos, pontos: numerosB.pontos },
        vencedorId,
      },
      finalizadoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    const nomes: Record<string, unknown> = {
      [a]: (desafio.desafiante as { nome?: unknown } | undefined)?.nome,
      [b]: (desafio.desafiado as { nome?: unknown } | undefined)?.nome,
    };
    return { status: "finalizado", outro: uid === a ? b : a, vencedorNome: vencedorId ? String(nomes[vencedorId] ?? "") : null, rotulo: String(desafio.temporadaRotulo ?? "") };
  });
  if (!fechado) return null;
  if (fechado.status === "finalizado") {
    await avisar(db, fechado.outro, `desafio_resultado_${desafioId}`, avisoDeResultado(fechado.vencedorNome, fechado.rotulo));
  }
  return fechado.status;
};

const apurar = async (db: Firestore, uid: string, desafioIds: string[]): Promise<Resultado> => {
  const atualizados: Record<string, string> = {};
  for (const id of desafioIds) {
    try {
      const status = await apurarUm(db, uid, id);
      if (status) atualizados[id] = status;
    } catch (erro) {
      console.warn(JSON.stringify({ evt: "desafio_apuracao_falhou", message: (erro as Error)?.message ?? String(erro) }));
    }
  }
  return { ok: true, body: { atualizados } };
};

const executar = (db: Firestore, uid: string, pedido: DesafioRequest): Promise<Resultado> => {
  switch (pedido.action) {
    case "criar":
      return criar(db, uid, pedido.desafiadoId, pedido.turmaId, pedido.temporada);
    case "responder":
      return responder(db, uid, pedido.desafioId, pedido.aceitar);
    case "cancelar":
      return cancelar(db, uid, pedido.desafioId);
    case "apurar":
      return apurar(db, uid, pedido.desafioIds);
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await verificarAppCheck(req, res, "desafios"))) return;

  const parsed = parseDesafioBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  if (!(await dentroDoLimite(user.uid, "desafios", LIMITE_POR_HORA, 3600))) {
    return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
  }

  let db: Firestore;
  try {
    db = getFirestore(getFirebaseApp());
  } catch (error) {
    console.error("[desafios] Firebase Admin não configurado:", error);
    return res.status(500).json({ error: "Servidor não configurado." });
  }

  try {
    const resultado = await executar(db, user.uid, parsed.value);
    if (!resultado.ok) return res.status(resultado.status).json({ code: resultado.code, error: resultado.error });
    if (parsed.value.action !== "apurar") console.log(JSON.stringify({ evt: `desafio_${parsed.value.action}` }));
    return res.status(200).json({ success: true, ...(resultado.body ?? {}) });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "desafios_failed", action: parsed.value.action, message: (erro as Error)?.message ?? String(erro) }));
    return res.status(502).json({ error: "Não foi possível concluir agora. Tente novamente." });
  }
}
