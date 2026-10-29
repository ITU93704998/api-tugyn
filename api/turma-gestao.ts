import type { VercelRequest, VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { type DocumentReference, FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { getAccount } from "./_lib/config";
import { DEDUPE_MS } from "./_lib/push";
import { enviarAviso } from "./_lib/pushEnvio";
import { dentroDoLimite } from "./_lib/rateLimit";
import { jogadoresParaRecalcular, somarEstatisticas } from "./_lib/estatisticas";
import { autorizarExclusao, autorizarTransferencia, bannerParaApagar, parseGestaoBody } from "./_lib/turmaGestao";

/**
 * POST /api/turma-gestao   (corpo: { action, turmaId, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - transferir { novoOrganizadorId }   o organizador passa a turma para um membro aprovado (e vira membro comum)
 *  - excluir                            o organizador apaga a turma inteira (só quando ele é o único membro)
 *  - estatisticas { jogadores }         o organizador, depois de enviar uma partida: recalcula o resumo geral desses jogadores
 *  - estatisticas-proprias (sem turma)  o próprio usuário recalcula o seu resumo geral
 * Pelo servidor (Admin SDK) porque as regras do Firestore não deixam o app trocar o dono, apagar a turma com tudo dentro
 * nem gravar o resumo geral (`users/{uid}.estatisticas`) de ninguém.
 */

/** Turmas grandes: apagar e atualizar todos os participantes pode demorar. Se estourar, é só tentar de novo. */
export const config = { maxDuration: 60 };

const LIMITE_POR_HORA = 20;
/** Recálculo do resumo: um por partida enviada (e reenvios), mais a abertura do próprio perfil. */
const LIMITE_ESTATISTICAS_POR_HORA = 60;
/** Quantos jogadores são recalculados ao mesmo tempo (cada um = 1 consulta + 1 leitura por turma + 1 escrita). */
const RECALCULOS_SIMULTANEOS = 8;
/** Uma transação/lote do Firestore aceita até 500 escritas: sobra margem para a turma e a prévia. */
const ESCRITAS_POR_LOTE = 450;

/**
 * Troca o dono da turma. Cada participante guarda `criadorId` (as regras confiam nele para liberar as estatísticas):
 * ele é atualizado em TODOS, senão o organizador antigo continuaria podendo mexer nos gols.
 * Até ~450 participantes vai tudo numa transação só (ou grava tudo, ou nada).
 */
const transferir = async (db: Firestore, uid: string, turmaId: string, novoId: string) => {
  const turmaRef = db.doc(`turmas/${turmaId}`);
  const novoRef = db.doc(`turmas/${turmaId}/participantes/${novoId}`);
  const participantesRef = db.collection(`turmas/${turmaId}/participantes`);
  const previewRef = db.doc(`turmaPreviews/${turmaId}`);

  let restantes: DocumentReference[] = [];
  const resultado = await db.runTransaction(async (tx) => {
    const [turmaSnap, novoSnap, participantes] = await Promise.all([
      tx.get(turmaRef),
      tx.get(novoRef),
      tx.get(participantesRef.select()), // só os ids: não baixa os dados de cada um
    ]);
    const auth = autorizarTransferencia(
      uid,
      turmaId,
      novoId,
      turmaSnap.exists ? (turmaSnap.data() ?? null) : null,
      novoSnap.exists ? (novoSnap.data() ?? null) : null,
    );
    if (!auth.ok) return auth;

    tx.update(turmaRef, {
      creatorId: novoId,
      creatorName: auth.creatorName,
      creatorPhoto: auth.creatorPhoto,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(previewRef, { creatorName: auth.creatorName }, { merge: true });

    const refs = participantes.docs.map((doc) => doc.ref);
    refs.slice(0, ESCRITAS_POR_LOTE).forEach((ref) => tx.update(ref, { criadorId: novoId }));
    restantes = refs.slice(ESCRITAS_POR_LOTE);
    return auth;
  });
  if (!resultado.ok) return resultado;

  // Turma muito grande (raro): o resto vai em lotes depois. Se falhar, o log aponta a turma para corrigir.
  for (let i = 0; i < restantes.length; i += ESCRITAS_POR_LOTE) {
    const batch = db.batch();
    restantes.slice(i, i + ESCRITAS_POR_LOTE).forEach((ref) => batch.update(ref, { criadorId: novoId }));
    try {
      await batch.commit();
    } catch (erro) {
      console.error(JSON.stringify({ evt: "turma_transfer_partial", turmaId, message: (erro as Error)?.message }));
      throw erro;
    }
  }

  // Aviso ao novo organizador: melhor esforço (a transferência já está salva).
  try {
    await enviarAviso(db, {
      evento: "organizacao_transferida",
      turmaId,
      dedupeKey: `organizacao_transferida_${turmaId}_${novoId}`,
      dedupeMs: DEDUPE_MS,
      recipientUids: [novoId],
      dedupeUid: novoId,
      draft: resultado.draft,
    });
  } catch (erro) {
    console.warn("[turma-gestao] aviso não enviado:", (erro as Error)?.message ?? "erro");
  }
  return { ok: true as const };
};

/** Apaga a turma com tudo dentro (participantes, resumo, partidas, partida de hoje), o código de convite, a prévia e o banner. */
const excluir = async (db: Firestore, uid: string, turmaId: string) => {
  const turmaRef = db.doc(`turmas/${turmaId}`);
  const turmaSnap = await turmaRef.get();
  const auth = autorizarExclusao(uid, turmaSnap.exists ? (turmaSnap.data() ?? null) : null);
  if (!auth.ok) return auth;

  // Primeiro o que aponta para a turma: se algo falhar no meio, a turma ainda existe e dá para tentar de novo.
  if (auth.codigoConvite) {
    const codigoRef = db.doc(`codigosConvite/${auth.codigoConvite}`);
    const codigo = await codigoRef.get();
    if (codigo.exists && codigo.get("turmaId") === turmaId) await codigoRef.delete();
  }
  await db.doc(`turmaPreviews/${turmaId}`).delete();
  await db.recursiveDelete(turmaRef);

  // Banner: melhor esforço (a turma já foi apagada; uma imagem esquecida não atrapalha ninguém).
  const banner = auth.bannerUrl ? bannerParaApagar(auth.bannerUrl) : null;
  const conta = banner ? getAccount(banner.bucket) : null;
  if (banner && conta) {
    try {
      await cloudinary.uploader.destroy(banner.publicId, { ...conta, resource_type: "image", invalidate: true });
    } catch (erro) {
      console.warn("[turma-gestao] banner não apagado:", (erro as Error)?.message ?? "erro");
    }
  }
  return { ok: true as const };
};

/**
 * Refaz o resumo geral de um usuário a partir das turmas em que ele está hoje (o mesmo que o próprio perfil soma) e grava em
 * `users/{uid}.estatisticas`. Conta não encontrada (excluída) é ignorada: não cria documento.
 */
const recalcularUsuario = async (db: Firestore, uid: string): Promise<void> => {
  const turmas = await db
    .collection("turmas")
    .where("participantes", "array-contains", uid)
    .select("status", "ativo")
    .get();
  const participantes = turmas.empty
    ? []
    : await db.getAll(...turmas.docs.map((t) => db.doc(`turmas/${t.id}/participantes/${uid}`)));
  const total = somarEstatisticas(
    turmas.docs.map((t) => t.data()),
    participantes.map((p) => (p.exists ? p.data() : null)),
  );
  try {
    await db.doc(`users/${uid}`).update({ estatisticas: { ...total, atualizadoEm: FieldValue.serverTimestamp() } });
  } catch (erro) {
    if ((erro as { code?: unknown })?.code === 5) return; // NOT_FOUND: conta excluída
    throw erro;
  }
};

/** Recalcula vários, alguns por vez. Falha de um não impede os outros; devolve quantos falharam. */
const recalcularVarios = async (db: Firestore, uids: string[]): Promise<number> => {
  let falhas = 0;
  for (let i = 0; i < uids.length; i += RECALCULOS_SIMULTANEOS) {
    const resultados = await Promise.allSettled(uids.slice(i, i + RECALCULOS_SIMULTANEOS).map((uid) => recalcularUsuario(db, uid)));
    falhas += resultados.filter((r) => r.status === "rejected").length;
  }
  return falhas;
};

const estatisticasDaPartida = async (db: Firestore, uid: string, turmaId: string, pedidos: string[]) => {
  const turmaSnap = await db.doc(`turmas/${turmaId}`).get();
  const auth = jogadoresParaRecalcular(uid, turmaSnap.exists ? (turmaSnap.data() ?? null) : null, pedidos);
  if (!auth.ok) return auth;
  const falhas = await recalcularVarios(db, auth.jogadores);
  if (falhas > 0) {
    console.warn(JSON.stringify({ evt: "estatisticas_parcial", turmaId, falhas, total: auth.jogadores.length }));
  }
  return { ok: true as const };
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await verificarAppCheck(req, res, "turma-gestao"))) return;

  const parsed = parseGestaoBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const request = parsed.value;

  const ehEstatistica = request.action === "estatisticas" || request.action === "estatisticas-proprias";
  const limiteOk = ehEstatistica
    ? await dentroDoLimite(user.uid, "estatisticas", LIMITE_ESTATISTICAS_POR_HORA, 3600)
    : await dentroDoLimite(user.uid, "turma-gestao", LIMITE_POR_HORA, 3600);
  if (!limiteOk) {
    return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
  }

  let db: Firestore;
  try {
    db = getFirestore(getFirebaseApp());
  } catch (error) {
    console.error("[turma-gestao] Firebase Admin não configurado:", error);
    return res.status(500).json({ error: "Servidor não configurado." });
  }

  try {
    if (request.action === "estatisticas-proprias") {
      await recalcularUsuario(db, user.uid);
      return res.status(200).json({ success: true });
    }

    const resultado =
      request.action === "transferir"
        ? await transferir(db, user.uid, request.turmaId, request.novoOrganizadorId)
        : request.action === "estatisticas"
          ? await estatisticasDaPartida(db, user.uid, request.turmaId, request.jogadores)
          : await excluir(db, user.uid, request.turmaId);
    if (!resultado.ok) return res.status(resultado.status).json({ code: resultado.code, error: resultado.error });

    if (request.action !== "estatisticas") {
      console.log(JSON.stringify({ evt: `turma_${request.action}`, turmaId: request.turmaId }));
    }
    return res.status(200).json({ success: true });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "turma_gestao_failed", action: request.action, message: (erro as Error)?.message ?? String(erro) }));
    return res.status(502).json({ error: "Não foi possível concluir agora. Tente novamente." });
  }
}
