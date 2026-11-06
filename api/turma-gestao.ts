import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { type DocumentReference, FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { getAccount } from "./_lib/config";
import { DEDUPE_MS } from "./_lib/push";
import { enviarAviso } from "./_lib/pushEnvio";
import { dentroDoLimite } from "./_lib/rateLimit";
import { jogadoresParaRecalcular } from "./_lib/estatisticas";
import { processarPendencias, recalcularDaPartida, recalcularUsuario, reconstruirResumoDaTurma } from "./_lib/recalculos";
import { enviarPartida, parsePartidaEnviada } from "./_lib/partidaEnvio";
import { autorizarExclusao, autorizarTemporario, autorizarTransferencia, bannerParaApagar, exigirOrganizador, parseGestaoBody } from "./_lib/turmaGestao";

/**
 * POST /api/turma-gestao   (corpo: { action, turmaId, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - transferir { novoOrganizadorId }   o organizador passa a turma para um membro aprovado (e vira membro comum)
 *  - excluir                            o organizador apaga a turma inteira (só quando ele é o único membro)
 *  - temporario { membroId | null }     o organizador escolhe (ou encerra) o organizador temporário por 24 h e o avisa
 *  - estatisticas { jogadores }         o organizador, depois de enviar uma partida: recalcula o resumo geral desses jogadores
 *  - estatisticas-proprias (sem turma)  o próprio usuário recalcula o seu resumo geral
 *  - partida { partidaId, partida, jogadores }  o organizador (ou o temporário no prazo) envia a partida: o servidor valida a
 *                                       lista, aplica só a diferença nos números dos membros e grava tudo numa transação
 *  - resumo                             o organizador pede a reconstrução do resumo da turma (auto-correção): o servidor o
 *                                       refaz a partir dos participantes aprovados (o app não grava mais o resumo inteiro)
 * Pelo servidor (Admin SDK) porque as regras do Firestore não deixam o app trocar o dono, apagar a turma com tudo dentro
 * nem gravar o resumo geral (`users/{uid}.estatisticas`) de ninguém.
 */

/** Turmas grandes: apagar e atualizar todos os participantes pode demorar. Se estourar, é só tentar de novo. */
export const config = { maxDuration: 60 };

const LIMITE_POR_HORA = 20;
/** Recálculo do resumo: um por partida enviada (e reenvios), mais a abertura do próprio perfil. */
const LIMITE_ESTATISTICAS_POR_HORA = 60;
/** Envios de partida (cada correção conta): folga para um dia de várias partidas e reenvios. */
const LIMITE_PARTIDAS_POR_HORA = 120;
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
      // A delegação era do organizador antigo: termina com a transferência (o novo escolhe, se quiser).
      organizadorTemporario: FieldValue.delete(),
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

/**
 * Escolhe (ou encerra) o organizador temporário. A hora é a do servidor (o prazo de 24 h conta dela) e o nome vem do
 * participante salvo. Depois avisa o escolhido por push (melhor esforço: a escolha já está salva). Os outros membros
 * veem o aviso na aba Avisos do app, a partir do próprio documento da turma (sem push).
 */
const definirTemporario = async (db: Firestore, uid: string, turmaId: string, membroId: string | null) => {
  const turmaRef = db.doc(`turmas/${turmaId}`);
  const resultado = await db.runTransaction(async (tx) => {
    const [turmaSnap, participanteSnap] = await Promise.all([
      tx.get(turmaRef),
      membroId ? tx.get(db.doc(`turmas/${turmaId}/participantes/${membroId}`)) : Promise.resolve(null),
    ]);
    const auth = autorizarTemporario(
      uid,
      turmaId,
      membroId,
      turmaSnap.exists ? (turmaSnap.data() ?? null) : null,
      participanteSnap?.exists ? (participanteSnap.data() ?? null) : null,
    );
    if (!auth.ok) return auth;
    tx.update(turmaRef, {
      organizadorTemporario: auth.membro
        ? { uid: auth.membro.uid, nome: auth.membro.nome, desde: FieldValue.serverTimestamp() }
        : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return auth;
  });
  if (!resultado.ok) return resultado;

  if (resultado.membro) {
    try {
      await enviarAviso(db, {
        evento: "organizador_temporario",
        turmaId,
        // Uma notificação por escolha (escolher a mesma pessoa de novo dentro de 10 min não repete o aviso).
        dedupeKey: `organizador_temporario_${turmaId}_${resultado.membro.uid}`,
        dedupeMs: DEDUPE_MS,
        recipientUids: [resultado.membro.uid],
        dedupeUid: resultado.membro.uid,
        draft: resultado.draft,
      });
    } catch (erro) {
      console.warn("[turma-gestao] aviso do temporário não enviado:", (erro as Error)?.message ?? "erro");
    }
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
 * Recalcula quem o organizador pediu (só membros) e limpa as pendências atendidas. Quem falhar continua pendente em
 * `recalculosPendentes/{turmaId}` (gravado pelo app junto com a partida) e a rotina do servidor tenta de novo.
 */
const estatisticasDaPartida = async (db: Firestore, uid: string, turmaId: string, pedidos: string[]) => {
  const turmaSnap = await db.doc(`turmas/${turmaId}`).get();
  const turma = turmaSnap.exists ? (turmaSnap.data() ?? null) : null;
  // Organizador temporário: o próprio participante diz se ele saiu e voltou depois da escolha (1 leitura, só nesse caso).
  const participante =
    turma && turma.creatorId !== uid ? ((await db.doc(`turmas/${turmaId}/participantes/${uid}`).get()).data() ?? null) : null;
  const auth = jogadoresParaRecalcular(uid, turma, pedidos, Date.now(), participante);
  if (!auth.ok) return auth;
  const falhos = await recalcularDaPartida(db, turmaId, auth.jogadores);
  if (falhos.length > 0) {
    console.warn(JSON.stringify({ evt: "estatisticas_parcial", turmaId, falhas: falhos.length, total: auth.jogadores.length }));
  }
  return { ok: true as const, falhos };
};

/** Reconstrução do resumo da turma pedida pelo organizador (auto-correção do app). */
const reconstruirResumo = async (db: Firestore, uid: string, turmaId: string) => {
  const turmaSnap = await db.doc(`turmas/${turmaId}`).get();
  const turma = turmaSnap.exists ? (turmaSnap.data() ?? null) : null;
  const negado = exigirOrganizador(uid, turma);
  if (negado) return negado;
  await reconstruirResumoDaTurma(db, turmaId, turma?.participantes);
  return { ok: true as const };
};

/** Só o scheduler do servidor (`Authorization: Bearer <CRON_SECRET>`), nunca um login de usuário. */
const ehRotinaAutorizada = (req: VercelRequest): boolean => {
  const segredo = process.env.CRON_SECRET;
  if (!segredo || segredo.length < 16) return false;
  const esperado = new Uint8Array(Buffer.from(`Bearer ${segredo}`));
  const atual = new Uint8Array(Buffer.from(typeof req.headers.authorization === "string" ? req.headers.authorization : ""));
  return atual.length === esperado.length && timingSafeEqual(atual, esperado);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // GET protegido: processa os recálculos pendentes (para um scheduler mais frequente que o cron diário de desafios).
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    if (!ehRotinaAutorizada(req)) return res.status(401).json({ error: "Não autorizado." });
    try {
      return res.status(200).json({ ok: true, ...(await processarPendencias(getFirestore(getFirebaseApp()))) });
    } catch {
      console.error(JSON.stringify({ evt: "estatisticas_pendencias_falhou" }));
      return res.status(503).json({ error: "Não foi possível processar agora." });
    }
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res, "turma-gestao");
  if (!user) return;
  if (!(await verificarAppCheck(req, res, "turma-gestao"))) return;

  // Envio da partida: corpo e limite próprios (lista de jogadores), mesma autenticação e App Check.
  if ((req.body as { action?: unknown } | undefined)?.action === "partida") {
    return enviarPartidaRota(req, res, user.uid);
  }

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
          : request.action === "temporario"
            ? await definirTemporario(db, user.uid, request.turmaId, request.membroId)
            : request.action === "resumo"
              ? await reconstruirResumo(db, user.uid, request.turmaId)
              : await excluir(db, user.uid, request.turmaId);
    if (!resultado.ok) return res.status(resultado.status).json({ code: resultado.code, error: resultado.error });

    // Sucesso parcial: diz QUEM ficou para depois (a pendência durável continua gravada e a rotina do servidor tenta de novo).
    const falhos = "falhos" in resultado && Array.isArray(resultado.falhos) ? (resultado.falhos as string[]) : [];
    if (falhos.length > 0) return res.status(202).json({ success: false, pendentes: falhos });
    if (request.action !== "estatisticas") {
      console.log(JSON.stringify({ evt: `turma_${request.action}`, turmaId: request.turmaId }));
    }
    return res.status(200).json({ success: true });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "turma_gestao_failed", action: request.action, message: (erro as Error)?.message ?? String(erro) }));
    return res.status(502).json({ error: "Não foi possível concluir agora. Tente novamente." });
  }
}

async function enviarPartidaRota(req: VercelRequest, res: VercelResponse, uid: string) {
  res.setHeader("Cache-Control", "no-store");
  const parsed = parsePartidaEnviada((req.body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return res.status(parsed.status).json({ code: parsed.code, error: parsed.error });
  if (!(await dentroDoLimite(uid, "enviar-partida", LIMITE_PARTIDAS_POR_HORA, 3600))) {
    return res.status(429).json({ error: "Muitos envios seguidos. Tente novamente mais tarde." });
  }
  try {
    const db = getFirestore(getFirebaseApp());
    const resultado = await enviarPartida(db, uid, parsed.value);
    if (!resultado.ok) return res.status(resultado.status).json({ code: resultado.code, error: resultado.error });
    // Resumo geral do perfil de quem mudou (a pendência gravada na transação garante o recálculo se isto falhar).
    let pendentes: string[] = [];
    if (resultado.participantesAlterados.length) {
      pendentes = await recalcularDaPartida(db, parsed.value.turmaId, resultado.participantesAlterados).catch(() => resultado.participantesAlterados);
    }
    console.log(JSON.stringify({ evt: "turma_partida", turmaId: parsed.value.turmaId, alterado: resultado.alterado, jogadores: resultado.participantesAlterados.length }));
    return res.status(200).json({
      success: true,
      atualizacao: resultado.atualizacao,
      alterado: resultado.alterado,
      participantesAlterados: resultado.participantesAlterados,
      corrigivelAte: resultado.corrigivelAte,
      ...(pendentes.length ? { pendentes } : {}),
    });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "turma_partida_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return res.status(502).json({ error: "Não foi possível enviar agora. A partida continua salva no aparelho: tente de novo." });
  }
}
