import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldValue, type Firestore, type Transaction, Timestamp, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import {
  type DesafioRequest,
  apuracaoLiberadaEm,
  autorizarCancelamento,
  autorizarCriacao,
  autorizarResposta,
  avisoDeResultado,
  decidirApuracao,
  diaDeBrasiliaDe,
  ehDoDia,
  idDoDesafio,
  inicioDoDia,
  MAX_PARTIDAS_DO_DIA,
  motivoParaNaoAceitar,
  somarDoDesafio,
  somarDoDia,
  temporadaInfo,
  turmaDoDesafio,
  vagaVenceEm,
  vagasValidas,
  vencedorEntre,
  parseDesafioBody,
} from "./_lib/desafios";
import { DEDUPE_MS, type PushDraft } from "./_lib/push";
import { enviarAviso } from "./_lib/pushEnvio";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * POST /api/desafios   (corpo: { action, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - criar { desafiadoId, turmaId, temporada }               desafia um atleta numa turma ativa dos dois (temporada)
 *  - criar { tipo: "dia", desafiadoId, turmaId }            só a partida de hoje da turma (até 30 min antes)
 *  - responder { desafioId, aceitar }                         o desafiado aceita ou recusa
 *  - cancelar { desafioId }                                   quem desafiou desiste (só enquanto pendente)
 *  - apurar { desafioIds }                                    fecha os que já podem ter resultado (o app pede ao abrir a aba)
 * GET /api/desafios   (só a rotina diária da Vercel, com `Authorization: Bearer <CRON_SECRET>`)
 *  - expira e apura os desafios vencidos (`apurarEm` <= agora), mesmo que ninguém abra o app.
 * Pelo servidor porque as regras do Firestore não deixam o app gravar em `desafios` e o resultado soma números de turmas que
 * nem sempre o próprio usuário pode ler. Regras do desafio em `_lib/desafios.ts`.
 */

const COLECAO = "desafios";
const VAGAS = "desafiosVagas";
const LIMITE_POR_HORA = 40;
const MAX_POR_ROTINA = 60;
const MAX_REAVISOS_POR_ROTINA = 30;
/** Aviso de resultado que falhou: a rotina diária tenta de novo enquanto `reavisarTentativas` for 1 ou 2 (no máximo 2 vezes). */
const TENTATIVAS_DE_AVISO = 3;

/** A rotina diária pode levar alguns segundos (várias transações em sequência). */
export const config = { maxDuration: 60 };

type Resultado = { ok: true; body?: Record<string, unknown> } | { ok: false; status: number; code: string; error: string };

type EventoDesafio = "novo" | "aceito" | "resultado";

/**
 * Avisos são melhor esforço: a ação já está salva. O aviso leva o id do desafio (o toque abre a aba destacando ele) e o
 * anti-repetição é por pessoa (o resultado vai para os dois). false = o envio falhou e vale tentar de novo; quem não tem
 * aparelho cadastrado não é falha.
 */
const avisar = async (db: Firestore, para: string, desafioId: string, evento: EventoDesafio, draft: PushDraft): Promise<boolean> => {
  try {
    const comId: PushDraft = { ...draft, data: { ...draft.data, desafioId } };
    const dedupeKey = `desafio_${evento}_${desafioId}_${para}`;
    const envio = await enviarAviso(db, { evento: draft.data.tipo, turmaId: "", dedupeKey, dedupeMs: DEDUPE_MS, recipientUids: [para], dedupeUid: para, draft: comId });
    return envio.motivo !== "falha-envio";
  } catch (erro) {
    console.warn("[desafios] aviso não enviado:", (erro as Error)?.message ?? "erro");
    return false;
  }
};

/** Nome de quem venceu (o que ficou gravado no desafio), para o aviso do resultado. */
const nomeDoVencedor = (desafio: Record<string, unknown>, vencedorId: string | null): string | null => {
  if (!vencedorId) return null;
  const quem = vencedorId === desafio.desafianteId ? desafio.desafiante : desafio.desafiado;
  return String((quem as { nome?: unknown } | undefined)?.nome ?? "");
};

const vagasRef = (db: Firestore, uid: string) => db.doc(`${VAGAS}/${uid}`);

/** Grava (ou troca) a validade da vaga deste desafio para os dois atletas. */
const ocuparVaga = (tx: Transaction, db: Firestore, uids: string[], desafioId: string, venceEm: number): void => {
  for (const uid of uids) tx.set(vagasRef(db, uid), { uid, ativos: { [desafioId]: venceEm } }, { merge: true });
};

/** Libera a vaga deste desafio para os dois atletas (recusado, cancelado, expirado ou finalizado). */
const liberarVaga = (tx: Transaction, db: Firestore, uids: string[], desafioId: string): void => {
  for (const uid of uids) tx.set(vagasRef(db, uid), { ativos: { [desafioId]: FieldValue.delete() } }, { merge: true });
};

const participantesDe = (desafio: Record<string, unknown>): string[] =>
  [desafio.desafianteId, desafio.desafiadoId].filter((u): u is string => typeof u === "string" && u.length > 0);

const criar = async (db: Firestore, uid: string, pedido: Extract<DesafioRequest, { action: "criar" }>): Promise<Resultado> => {
  const { desafiadoId, turmaId } = pedido;
  const temporada = pedido.tipo === "temporada" ? pedido.temporada : undefined;
  const agoraMs = Date.now();
  // Id: a temporada ou o dia de hoje (o servidor confere depois se hoje tem partida nesta turma).
  const chave = pedido.tipo === "dia" ? `d${diaDeBrasiliaDe(agoraMs).replace(/-/g, "")}` : temporadaInfo(agoraMs, temporada === "proxima" ? 1 : 0).chave;
  const ref = db.doc(`${COLECAO}/${idDoDesafio(chave, uid, desafiadoId)}`);

  // Fora da transação: perfis, bloqueios e turma. Dentro dela: o desafio da dupla e as vagas dos dois (o limite é atômico).
  const [perfilA, perfilB, bloqueioA, bloqueioB, turma] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${desafiadoId}`).get(),
    db.doc(`users/${uid}/blocked/${desafiadoId}`).get(),
    db.doc(`users/${desafiadoId}/blocked/${uid}`).get(),
    db.doc(`turmas/${turmaId}`).get(),
  ]);
  const turmaDados = turma.exists ? (turma.data() ?? null) : null;

  const resultado = await db.runTransaction(async (tx) => {
    const [existente, vagasA, vagasB] = await tx.getAll(ref, vagasRef(db, uid), vagasRef(db, desafiadoId));
    const agora = Date.now();
    const ativosA = vagasValidas(vagasA.get("ativos"), agora);
    const ativosB = vagasValidas(vagasB.get("ativos"), agora);
    const auth = autorizarCriacao({
      uid,
      desafiadoId,
      tipo: pedido.tipo,
      temporada,
      turmaDados,
      agoraMs: agora,
      perfilDesafiante: perfilA.data() ?? null,
      perfilDesafiado: perfilB.exists ? (perfilB.data() ?? null) : null,
      bloqueio: bloqueioA.exists || bloqueioB.exists,
      turma: turmaDoDesafio({ id: turma.id, data: turmaDados }, uid, desafiadoId),
      ativosDesafiante: Object.keys(ativosA).length,
      ativosDesafiado: Object.keys(ativosB).length,
      existente: existente.exists ? (existente.data() ?? null) : null,
    });
    if (!auth.ok) return auth;
    // Recriar só depois de cancelado (`autorizarCriacao` já nega os outros casos).
    tx.set(ref, { ...auth.dados, criadoEm: FieldValue.serverTimestamp(), atualizadoEm: FieldValue.serverTimestamp() });
    // Vagas: regrava o mapa só com as válidas + a nova (o documento não cresce com vagas vencidas).
    const venceEm = vagaVenceEm(auth.dados, "pendente");
    tx.set(vagasRef(db, uid), { uid, ativos: { ...ativosA, [auth.id]: venceEm } });
    tx.set(vagasRef(db, desafiadoId), { uid: desafiadoId, ativos: { ...ativosB, [auth.id]: venceEm } });
    return auth;
  });
  if (!resultado.ok) return resultado;

  await avisar(db, desafiadoId, resultado.id, "novo", resultado.draft);
  return { ok: true, body: { desafioId: resultado.id } };
};

const responder = async (db: Firestore, uid: string, desafioId: string, aceitar: boolean): Promise<Resultado> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);

  // Aceitar: o que valia na criação precisa continuar valendo (bloqueio, turma, conta de quem desafiou).
  let motivo: string | null = null;
  if (aceitar) {
    const antes = await ref.get();
    const desafio = antes.exists ? (antes.data() ?? null) : null;
    if (desafio && desafio.desafiadoId === uid && desafio.status === "pendente") {
      const desafianteId = String(desafio.desafianteId);
      const turmaId = (desafio.turmas as { id?: unknown }[] | undefined)?.[0]?.id;
      const [bloqueioA, bloqueioB, perfil, turma] = await Promise.all([
        db.doc(`users/${uid}/blocked/${desafianteId}`).get(),
        db.doc(`users/${desafianteId}/blocked/${uid}`).get(),
        db.doc(`users/${desafianteId}`).get(),
        typeof turmaId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(turmaId) ? db.doc(`turmas/${turmaId}`).get() : null,
      ]);
      motivo = motivoParaNaoAceitar({
        bloqueio: bloqueioA.exists || bloqueioB.exists,
        turma: turma?.exists ? (turma.data() ?? null) : null,
        perfilDesafiante: perfil.exists ? (perfil.data() ?? null) : null,
        desafio,
      });
    }
  }

  const resultado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const desafio = snap.exists ? (snap.data() ?? null) : null;
    const auth = autorizarResposta(uid, desafio, aceitar, Date.now());
    if (!auth.ok) return auth;
    if (!desafio) return { ok: false as const, status: 404, code: "nao_encontrado", error: "Desafio não encontrado." };
    const uids = participantesDe(desafio);
    if (motivo) {
      // O convite não vale mais: é retirado (libera a vaga dos dois) e o desafiado recebe o motivo.
      tx.update(ref, { status: "cancelado", apurarEm: FieldValue.delete(), atualizadoEm: FieldValue.serverTimestamp() });
      liberarVaga(tx, db, uids, desafioId);
      return { ok: false as const, status: 409, code: "convite_invalido", error: `${motivo} O convite foi retirado.` };
    }
    if (aceitar) {
      tx.update(ref, {
        status: "aceito",
        // A rotina diária fecha o desafio quando o resultado puder sair.
        apurarEm: new Date(apuracaoLiberadaEm(desafio)),
        respondidoEm: FieldValue.serverTimestamp(),
        atualizadoEm: FieldValue.serverTimestamp(),
      });
      ocuparVaga(tx, db, uids, desafioId, vagaVenceEm(desafio, "aceito"));
    } else {
      tx.update(ref, { status: "recusado", apurarEm: FieldValue.delete(), respondidoEm: FieldValue.serverTimestamp(), atualizadoEm: FieldValue.serverTimestamp() });
      liberarVaga(tx, db, uids, desafioId);
    }
    return { ...auth, desafianteId: String(desafio.desafianteId) };
  });
  if (!resultado.ok) return resultado;
  if (resultado.draft) await avisar(db, resultado.desafianteId, desafioId, "aceito", resultado.draft);
  return { ok: true };
};

const cancelar = async (db: Firestore, uid: string, desafioId: string): Promise<Resultado> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const desafio = snap.exists ? (snap.data() ?? null) : null;
    const auth = autorizarCancelamento(uid, desafio);
    if (!auth.ok || !desafio) return auth;
    tx.update(ref, { status: "cancelado", apurarEm: FieldValue.delete(), atualizadoEm: FieldValue.serverTimestamp() });
    liberarVaga(tx, db, participantesDe(desafio), desafioId);
    return { ok: true as const };
  });
};

type StatusApuracao = "finalizado" | "expirado" | "nada" | "falhou";

/**
 * Fecha um desafio (ou só marca como expirado). `uid` null = rotina do servidor. Devolve o que aconteceu.
 * O aviso do resultado vai para quem não pediu a apuração (na rotina, para os dois).
 */
const apurarUm = async (db: Firestore, uid: string | null, desafioId: string): Promise<StatusApuracao> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);
  type Fechamento =
    | { status: "expirado" }
    | { status: "finalizado"; avisarA: string[]; vencedorNome: string | null; desafio: Record<string, unknown> };
  const fechado = await db.runTransaction(async (tx): Promise<Fechamento | null> => {
    const snap = await tx.get(ref);
    const desafio = snap.exists ? (snap.data() ?? null) : null;
    const decisao = decidirApuracao(uid, desafio, Date.now());
    if (!decisao.ok || decisao.acao === "nada" || !desafio) return null;
    const uids = participantesDe(desafio);

    if (decisao.acao === "expirar") {
      tx.update(ref, { status: "expirado", apurarEm: FieldValue.delete(), atualizadoEm: FieldValue.serverTimestamp() });
      liberarVaga(tx, db, uids, desafioId);
      return { status: "expirado" };
    }

    // Só a turma gravada no desafio (a escolhida ao desafiar; desafios antigos podem ter mais de uma).
    const turmas = Array.isArray(desafio.turmas) ? (desafio.turmas as { id?: unknown }[]) : [];
    const ids = turmas.map((t) => t?.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id));
    const a = String(desafio.desafianteId);
    const b = String(desafio.desafiadoId);
    let numerosA: { uid: string } & ReturnType<typeof somarDoDesafio>;
    let numerosB: typeof numerosA;

    if (ehDoDia(desafio)) {
      // Partida do dia: as partidas da turma enviadas entre o início do dia e o CORTE (a hora em que o resultado é
      // liberado), e delas só as daquele dia. O corte é o mesmo para qualquer hora em que a apuração rodar.
      const dia = String(desafio.dia ?? "");
      const inicio = /^\d{4}-\d{2}-\d{2}$/.test(dia) ? inicioDoDia(dia) : 0;
      const corte = apuracaoLiberadaEm(desafio);
      const partidas =
        ids.length && inicio
          ? await tx.get(
              db
                .collection(`turmas/${ids[0]}/partidas`)
                .where("salvadoEm", ">=", Timestamp.fromMillis(inicio))
                .where("salvadoEm", "<", Timestamp.fromMillis(corte))
                .select("data", "jogadores", "salvadoEm")
                .limit(MAX_PARTIDAS_DO_DIA),
            )
          : null;
      if ((partidas?.size ?? 0) >= MAX_PARTIDAS_DO_DIA) {
        console.warn(JSON.stringify({ evt: "desafio_dia_partidas_no_limite", desafioId, limite: MAX_PARTIDAS_DO_DIA }));
      }
      const lista = (partidas?.docs ?? []).map((p) => ({
        data: p.get("data"),
        salvadoEmMs: (p.get("salvadoEm") as Timestamp | undefined)?.toMillis?.() ?? 0,
        jogadores: p.get("jogadores"),
      }));
      numerosA = { uid: a, ...somarDoDia(lista, dia, a, corte) };
      numerosB = { uid: b, ...somarDoDia(lista, dia, b, corte) };
    } else {
      const chave = String(desafio.temporada);
      const docs = ids.length ? await tx.getAll(...ids.flatMap((id) => [db.doc(`turmas/${id}/participantes/${a}`), db.doc(`turmas/${id}/participantes/${b}`)])) : [];
      const dados = docs.map((d) => (d.exists ? (d.data() ?? null) : null));
      numerosA = { uid: a, ...somarDoDesafio(dados.filter((_, i) => i % 2 === 0), chave) };
      numerosB = { uid: b, ...somarDoDesafio(dados.filter((_, i) => i % 2 === 1), chave) };
    }
    const vencedorId = vencedorEntre(numerosA, numerosB);

    tx.update(ref, {
      status: "finalizado",
      apurarEm: FieldValue.delete(),
      resultado: {
        [a]: { gols: numerosA.gols, assistencias: numerosA.assistencias, jogos: numerosA.jogos, pontos: numerosA.pontos },
        [b]: { gols: numerosB.gols, assistencias: numerosB.assistencias, jogos: numerosB.jogos, pontos: numerosB.pontos },
        vencedorId,
      },
      finalizadoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    liberarVaga(tx, db, uids, desafioId);
    return {
      status: "finalizado",
      avisarA: uid === null ? [a, b] : [uid === a ? b : a],
      vencedorNome: nomeDoVencedor(desafio, vencedorId),
      desafio,
    };
  });
  if (!fechado) return "nada";
  if (fechado.status === "finalizado") {
    const falhos: string[] = [];
    for (const para of fechado.avisarA) {
      if (!(await avisar(db, para, desafioId, "resultado", avisoDeResultado(fechado.vencedorNome, fechado.desafio)))) falhos.push(para);
    }
    // Aviso perdido: a rotina diária tenta de novo (o resultado já está salvo; o app mostra de qualquer jeito).
    if (falhos.length) await ref.update({ reavisarPara: falhos, reavisarTentativas: 1 }).catch(() => undefined);
  }
  return fechado.status;
};

/** Rotina diária: reenvia os avisos de resultado que falharam (no máximo `TENTATIVAS_DE_AVISO` envios por pessoa). */
const reenviarAvisos = async (db: Firestore): Promise<number> => {
  const snap = await db
    .collection(COLECAO)
    .where("reavisarTentativas", "in", Array.from({ length: TENTATIVAS_DE_AVISO - 1 }, (_, i) => i + 1))
    .limit(MAX_REAVISOS_POR_ROTINA)
    .get();
  let enviados = 0;
  for (const doc of snap.docs) {
    const desafio = doc.data();
    const participantes = participantesDe(desafio);
    const para = (Array.isArray(desafio.reavisarPara) ? (desafio.reavisarPara as unknown[]) : []).filter(
      (u): u is string => typeof u === "string" && participantes.includes(u),
    );
    const limpar = { reavisarPara: FieldValue.delete(), reavisarTentativas: FieldValue.delete() };
    if (desafio.status !== "finalizado" || para.length === 0) {
      await doc.ref.update(limpar);
      continue;
    }
    const vencedor = (desafio.resultado as { vencedorId?: unknown } | undefined)?.vencedorId;
    const aviso = avisoDeResultado(nomeDoVencedor(desafio, typeof vencedor === "string" ? vencedor : null), desafio);
    const falhos: string[] = [];
    for (const uid of para) if (!(await avisar(db, uid, doc.id, "resultado", aviso))) falhos.push(uid);
    enviados += para.length - falhos.length;
    const tentativas = Number(desafio.reavisarTentativas) + 1;
    await doc.ref.update(falhos.length && tentativas < TENTATIVAS_DE_AVISO ? { reavisarPara: falhos, reavisarTentativas: tentativas } : limpar);
  }
  return enviados;
};

/** Apura cada id e diz o que aconteceu com cada um (o app tenta de novo só os que falharam). */
const apurarLista = async (db: Firestore, uid: string | null, desafioIds: string[]): Promise<Record<string, StatusApuracao>> => {
  const resultados: Record<string, StatusApuracao> = {};
  for (const id of desafioIds) {
    try {
      resultados[id] = await apurarUm(db, uid, id);
    } catch (erro) {
      resultados[id] = "falhou";
      console.warn(JSON.stringify({ evt: "desafio_apuracao_falhou", message: (erro as Error)?.message ?? String(erro) }));
    }
  }
  return resultados;
};

const apurar = async (db: Firestore, uid: string, desafioIds: string[]): Promise<Resultado> => {
  const resultados = await apurarLista(db, uid, desafioIds);
  // `atualizados` continua para apps antigos (só os que mudaram).
  const atualizados = Object.fromEntries(Object.entries(resultados).filter(([, s]) => s === "finalizado" || s === "expirado"));
  return { ok: true, body: { resultados, atualizados } };
};

/** Rotina diária: tudo que venceu (`apurarEm` <= agora), os mais atrasados primeiro. Idempotente: rodar de novo não repete nada. */
const rotinaDiaria = async (db: Firestore): Promise<Record<string, number>> => {
  const snap = await db
    .collection(COLECAO)
    .where("status", "in", ["pendente", "aceito"])
    .where("apurarEm", "<=", Timestamp.now())
    .orderBy("apurarEm")
    .select()
    .limit(MAX_POR_ROTINA)
    .get();
  const resultados = await apurarLista(db, null, snap.docs.map((d) => d.id));
  const contagem: Record<string, number> = { finalizado: 0, expirado: 0, nada: 0, falhou: 0, reavisos: 0 };
  for (const status of Object.values(resultados)) contagem[status] += 1;
  try {
    contagem.reavisos = await reenviarAvisos(db);
  } catch (erro) {
    console.warn(JSON.stringify({ evt: "desafios_reaviso_falhou", message: (erro as Error)?.message ?? String(erro) }));
  }
  return contagem;
};

const executar = (db: Firestore, uid: string, pedido: DesafioRequest): Promise<Resultado> => {
  switch (pedido.action) {
    case "criar":
      return criar(db, uid, pedido);
    case "responder":
      return responder(db, uid, pedido.desafioId, pedido.aceitar);
    case "cancelar":
      return cancelar(db, uid, pedido.desafioId);
    case "apurar":
      return apurar(db, uid, pedido.desafioIds);
  }
};

/** A Vercel chama a rotina com `Authorization: Bearer <CRON_SECRET>`. Sem o segredo configurado, ninguém entra. */
const ehRotinaAutorizada = (req: VercelRequest): boolean => {
  const segredo = process.env.CRON_SECRET;
  const recebido = req.headers.authorization ?? "";
  if (!segredo || segredo.length < 16) return false;
  const esperado = new Uint8Array(Buffer.from(`Bearer ${segredo}`));
  const atual = new Uint8Array(Buffer.from(recebido));
  return atual.length === esperado.length && timingSafeEqual(atual, esperado);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    if (!ehRotinaAutorizada(req)) return res.status(401).json({ error: "Não autorizado." });
    try {
      const contagem = await rotinaDiaria(getFirestore(getFirebaseApp()));
      console.log(JSON.stringify({ evt: "desafios_rotina", ...contagem }));
      return res.status(200).json({ success: true, ...contagem });
    } catch (erro) {
      console.error(JSON.stringify({ evt: "desafios_rotina_falhou", message: (erro as Error)?.message ?? String(erro) }));
      return res.status(500).json({ error: "Falha na rotina." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
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
