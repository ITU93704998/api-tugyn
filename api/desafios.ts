import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  FieldPath,
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
  Timestamp,
  getFirestore,
} from "firebase-admin/firestore";
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
  lerEmPaginas,
  MAX_PAGINAS_DO_DIA,
  MAX_PARTIDAS_DO_DIA,
  motivoParaNaoAceitar,
  percorrerComPrazo,
  problemasDaRotina,
  RECONCILIAR_DEPOIS_MS,
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
import { consultarRecibos, recuperarAvisosPendentes, enviarAviso } from "./_lib/pushEnvio";
import { bucketsSemCredenciais } from "./_lib/cloudinaryCleanup";
import { processarExclusoesPendentes } from "./_lib/exclusaoContaJob";
import { limparReservasDeMidia } from "./_lib/midiaReservasJob";
import { processarPendencias } from "./_lib/recalculos";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * POST /api/desafios   (corpo: { action, ... }, cabeçalho: Authorization: Bearer <login do Firebase>)
 *  - criar { desafiadoId, turmaId, temporada }               desafia um atleta numa turma ativa dos dois (temporada)
 *  - criar { tipo: "dia", desafiadoId, turmaId }            só a partida de hoje da turma (até 30 min antes)
 *  - responder { desafioId, aceitar }                         o desafiado aceita ou recusa
 *  - cancelar { desafioId }                                   quem desafiou desiste (só enquanto pendente)
 *  - apurar { desafioIds }                                    fecha os que já podem ter resultado (o app pede ao abrir a aba)
 * GET /api/desafios   (só a rotina diária da Vercel, com `Authorization: Bearer <CRON_SECRET>`; ver docs/rotina-diaria.md)
 *  - expira e apura os desafios vencidos (`apurarEm` <= agora), mesmo que ninguém abra o app, em lotes com cursor e prazo;
 *  - envia a fila de avisos de resultado (separada do cálculo), termina exclusões de conta e resolve reservas de imagem;
 *  - responde 500 `{ parcial: true, problemas }` quando algo falhou ou ficou na fila (sucesso parcial não sai como 200).
 * Pelo servidor porque as regras do Firestore não deixam o app gravar em `desafios` e o resultado soma números de turmas que
 * nem sempre o próprio usuário pode ler. Regras do desafio em `_lib/desafios.ts`.
 */

const COLECAO = "desafios";
const VAGAS = "desafiosVagas";
const LIMITE_POR_HORA = 40;
const LOTE_DE_APURACAO = 20;
const LOTE_DE_AVISOS = 20;
/**
 * Fila de avisos de resultado: `reavisarTentativas` = quantos envios já houve (0 = gravado pelo fechamento na rotina, ainda
 * não enviado). A rotina envia enquanto for 0, 1 ou 2 (no máximo `TENTATIVAS_DE_AVISO` envios por pessoa).
 */
const TENTATIVAS_DE_AVISO = 3;

/** A rotina diária pode levar alguns segundos (várias transações em sequência). */
export const config = { maxDuration: 60 };
/**
 * Prazo de cada etapa da rotina, contado do início da chamada (a função morre em `maxDuration`). O que não couber fica na
 * fila para a próxima rodada e a resposta sai como não-2xx (ver `problemasDaRotina`).
 */
const PRAZOS_DA_ROTINA_MS = { apuracao: 30_000, avisos: 38_000, exclusoes: 46_000, midia: 52_000 };

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
    return envio.pendente === true || envio.motivo !== "falha-envio";
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

/** Exportada para o teste de concorrência no emulador (`tests-emulador/`). */
export const criar = async (db: Firestore, uid: string, pedido: Extract<DesafioRequest, { action: "criar" }>): Promise<Resultado> => {
  const { desafiadoId, turmaId } = pedido;
  const temporada = pedido.tipo === "temporada" ? pedido.temporada : undefined;
  const agoraMs = Date.now();
  // Id: a temporada ou o dia de hoje (o servidor confere depois se hoje tem partida nesta turma).
  const chave = pedido.tipo === "dia" ? `d${diaDeBrasiliaDe(agoraMs).replace(/-/g, "")}` : temporadaInfo(agoraMs, temporada === "proxima" ? 1 : 0).chave;
  const ref = db.doc(`${COLECAO}/${idDoDesafio(chave, uid, desafiadoId)}`);

  // TUDO o que decide é lido DENTRO da transação (perfis, bloqueios, turma, o desafio da dupla e as vagas): um bloqueio,
  // uma saída da turma ou uma exclusão de conta que aconteça ao mesmo tempo faz a transação reler e decidir de novo.
  const resultado = await db.runTransaction(async (tx) => {
    const [existente, vagasA, vagasB, perfilA, perfilB, bloqueioA, bloqueioB, turma] = await tx.getAll(
      ref,
      vagasRef(db, uid),
      vagasRef(db, desafiadoId),
      db.doc(`users/${uid}`),
      db.doc(`users/${desafiadoId}`),
      db.doc(`users/${uid}/blocked/${desafiadoId}`),
      db.doc(`users/${desafiadoId}/blocked/${uid}`),
      db.doc(`turmas/${turmaId}`),
    );
    const turmaDados = turma.exists ? (turma.data() ?? null) : null;
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
      perfilDesafiante: perfilA.exists ? (perfilA.data() ?? null) : null,
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

/** Exportada para o teste de concorrência no emulador (`tests-emulador/`). */
export const responder = async (db: Firestore, uid: string, desafioId: string, aceitar: boolean): Promise<Resultado> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);

  const resultado = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const desafio = snap.exists ? (snap.data() ?? null) : null;
    const auth = autorizarResposta(uid, desafio, aceitar, Date.now());
    if (!auth.ok) return auth;
    if (!desafio) return { ok: false as const, status: 404, code: "nao_encontrado", error: "Desafio não encontrado." };
    const uids = participantesDe(desafio);

    // Aceitar: o que valia na criação precisa continuar valendo (bloqueio, turma, conta de quem desafiou). Lido DENTRO da
    // transação: um bloqueio, uma saída ou uma exclusão ao mesmo tempo faz a transação reler e decidir de novo.
    let motivo: string | null = null;
    if (aceitar) {
      const desafianteId = String(desafio.desafianteId);
      const turmaId = (desafio.turmas as { id?: unknown }[] | undefined)?.[0]?.id;
      const turmaValida = typeof turmaId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(turmaId);
      const [bloqueioA, bloqueioB, perfil, turma] = await tx.getAll(
        db.doc(`users/${uid}/blocked/${desafianteId}`),
        db.doc(`users/${desafianteId}/blocked/${uid}`),
        db.doc(`users/${desafianteId}`),
        // Sem turma válida no desafio, lê um id que nunca existe (getAll precisa de referências).
        db.doc(`turmas/${turmaValida ? turmaId : "_sem_turma_"}`),
      );
      motivo = motivoParaNaoAceitar({
        bloqueio: bloqueioA.exists || bloqueioB.exists,
        turma: turmaValida && turma.exists ? (turma.data() ?? null) : null,
        perfilDesafiante: perfil.exists ? (perfil.data() ?? null) : null,
        desafio,
      });
    }
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

/** "reconciliar" = não deu para ler tudo com segurança; o desafio continua aberto (o app trata como "nada"). */
type StatusApuracao = "finalizado" | "expirado" | "nada" | "falhou" | "reconciliar";

/**
 * Fecha um desafio (ou só marca como expirado). `uid` null = rotina do servidor. Devolve o que aconteceu.
 * O aviso do resultado vai para quem não pediu a apuração. Na rotina ele NÃO é enviado aqui: o fechamento grava os dois na
 * fila de avisos (`reavisarTentativas: 0`, na mesma transação) e a etapa de avisos envia depois, com o próprio prazo.
 */
const apurarUm = async (db: Firestore, uid: string | null, desafioId: string): Promise<StatusApuracao> => {
  const ref = db.doc(`${COLECAO}/${desafioId}`);
  type Fechamento =
    | { status: "expirado" }
    | { status: "reconciliar"; lidas: number }
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
      // Lida em páginas (todas na mesma transação). Se ainda houver partidas depois do teto, o resultado NÃO é fechado com
      // uma soma parcial: o desafio fica em reconciliação, volta para a fila e o log alerta.
      const partidas =
        ids.length && inicio
          ? await lerEmPaginas<QueryDocumentSnapshot>(async (depoisDe, limite) => {
              let consulta = db
                .collection(`turmas/${ids[0]}/partidas`)
                .where("salvadoEm", ">=", Timestamp.fromMillis(inicio))
                .where("salvadoEm", "<", Timestamp.fromMillis(corte))
                .orderBy("salvadoEm")
                .select("diaDoJogo", "data", "jogadores", "salvadoEm");
              if (depoisDe) consulta = consulta.startAfter(depoisDe);
              return (await tx.get(consulta.limit(limite))).docs;
            }, MAX_PARTIDAS_DO_DIA, MAX_PAGINAS_DO_DIA)
          : { itens: [], completo: true };
      if (!partidas.completo) {
        tx.update(ref, {
          apurarEm: new Date(Date.now() + RECONCILIAR_DEPOIS_MS),
          "reconciliacao.motivo": "partidas_acima_do_limite",
          "reconciliacao.lidas": partidas.itens.length,
          "reconciliacao.tentativas": FieldValue.increment(1),
          "reconciliacao.em": FieldValue.serverTimestamp(),
          atualizadoEm: FieldValue.serverTimestamp(),
        });
        return { status: "reconciliar", lidas: partidas.itens.length };
      }
      // A janela de ENVIO (início do dia até o corte) só delimita a busca: um jogo do dia não pode ter sido enviado antes
      // dele. Quem decide se a partida é do dia é o `diaDoJogo` (`partidaEhDoDia`).
      const lista = partidas.itens.map((p) => ({
        diaDoJogo: p.get("diaDoJogo"),
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
      reconciliacao: FieldValue.delete(),
      // Rotina: o aviso entra na fila junto com o resultado (nada se perde se a função parar antes de enviar).
      ...(uid === null ? { reavisarPara: [a, b], reavisarTentativas: 0 } : {}),
    });
    liberarVaga(tx, db, uids, desafioId);
    return {
      status: "finalizado",
      avisarA: uid === null ? [] : [uid === a ? b : a],
      vencedorNome: nomeDoVencedor(desafio, vencedorId),
      desafio,
    };
  });
  if (!fechado) return "nada";
  if (fechado.status === "reconciliar") {
    console.error(JSON.stringify({ evt: "desafio_reconciliacao_pendente", desafioId, lidas: fechado.lidas, paginas: MAX_PAGINAS_DO_DIA }));
  }
  if (fechado.status === "finalizado" && fechado.avisarA.length) {
    const falhos: string[] = [];
    for (const para of fechado.avisarA) {
      if (!(await avisar(db, para, desafioId, "resultado", avisoDeResultado(fechado.vencedorNome, fechado.desafio)))) falhos.push(para);
    }
    // Aviso perdido: a rotina diária tenta de novo (o resultado já está salvo; o app mostra de qualquer jeito).
    if (falhos.length) await ref.update({ reavisarPara: falhos, reavisarTentativas: 1 }).catch(() => undefined);
  }
  return fechado.status;
};

/**
 * Rotina diária: envia a fila de avisos de resultado — os novos (`reavisarTentativas` 0, gravados pelo fechamento) e os que
 * falharam (1 ou 2), no máximo `TENTATIVAS_DE_AVISO` envios por pessoa. Cursor pelo id: cada desafio é tentado uma vez por
 * rodada, mesmo que continue na fila.
 */
const enviarFilaDeAvisos = async (db: Firestore, prazoMs: number): Promise<{ enviados: number; restantes: boolean }> => {
  let enviados = 0;
  const { restantes } = await percorrerComPrazo<QueryDocumentSnapshot>({
    lote: LOTE_DE_AVISOS,
    prazoMs,
    buscar: async (depoisDe, limite) => {
      let consulta = db
        .collection(COLECAO)
        .where("reavisarTentativas", "in", Array.from({ length: TENTATIVAS_DE_AVISO }, (_, i) => i))
        .orderBy(FieldPath.documentId());
      if (depoisDe) consulta = consulta.startAfter(depoisDe.id);
      return (await consulta.limit(limite).get()).docs;
    },
    processar: async (doc) => {
      try {
        enviados += await enviarAvisoDaFila(db, doc);
      } catch (erro) {
        console.warn(JSON.stringify({ evt: "desafio_aviso_fila_falhou", desafioId: doc.id, message: (erro as Error)?.message ?? String(erro) }));
      }
    },
  });
  return { enviados, restantes };
};

/** Envia o aviso de um desafio da fila e atualiza a fila (quem falhou fica para a próxima rodada). Devolve quantos foram. */
const enviarAvisoDaFila = async (db: Firestore, doc: QueryDocumentSnapshot): Promise<number> => {
  const desafio = doc.data();
  const participantes = participantesDe(desafio);
  const para = (Array.isArray(desafio.reavisarPara) ? (desafio.reavisarPara as unknown[]) : []).filter(
    (u): u is string => typeof u === "string" && participantes.includes(u),
  );
  const limpar = { reavisarPara: FieldValue.delete(), reavisarTentativas: FieldValue.delete() };
  if (desafio.status !== "finalizado" || para.length === 0) {
    await doc.ref.update(limpar);
    return 0;
  }
  const vencedor = (desafio.resultado as { vencedorId?: unknown } | undefined)?.vencedorId;
  const aviso = avisoDeResultado(nomeDoVencedor(desafio, typeof vencedor === "string" ? vencedor : null), desafio);
  const falhos: string[] = [];
  for (const uid of para) if (!(await avisar(db, uid, doc.id, "resultado", aviso))) falhos.push(uid);
  const tentativas = Number(desafio.reavisarTentativas) + 1;
  await doc.ref.update(falhos.length && tentativas < TENTATIVAS_DE_AVISO ? { reavisarPara: falhos, reavisarTentativas: tentativas } : limpar);
  if (falhos.length && tentativas >= TENTATIVAS_DE_AVISO) {
    console.warn(JSON.stringify({ evt: "desafio_aviso_desistido", desafioId: doc.id, falhos: falhos.length }));
  }
  return para.length - falhos.length;
};

/** Apura cada id e diz o que aconteceu com cada um (o app tenta de novo só os que falharam). */
const apurarLista = async (db: Firestore, uid: string | null, desafioIds: string[]): Promise<Record<string, StatusApuracao>> => {
  const resultados: Record<string, StatusApuracao> = {};
  for (const id of desafioIds) {
    try {
      resultados[id] = await apurarUm(db, uid, id);
    } catch (erro) {
      resultados[id] = "falhou";
      console.warn(JSON.stringify({ evt: "desafio_apuracao_falhou", desafioId: id, message: (erro as Error)?.message ?? String(erro) }));
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

/**
 * Rotina diária, etapa de CÁLCULO: tudo que venceu (`apurarEm` <= hora da rotina), os mais atrasados primeiro, em lotes com
 * cursor até a fila acabar ou o prazo chegar (o resto fica para a próxima rodada). Não envia avisos (ver `apurarUm`).
 * Idempotente: rodar de novo não repete nada.
 */
const apurarVencidos = async (db: Firestore, prazoMs: number) => {
  const contagem: Record<StatusApuracao, number> = { finalizado: 0, expirado: 0, nada: 0, falhou: 0, reconciliar: 0 };
  const corte = Timestamp.now();
  let atrasoMaxMs = 0;
  const { restantes } = await percorrerComPrazo<QueryDocumentSnapshot>({
    lote: LOTE_DE_APURACAO,
    prazoMs,
    buscar: async (depoisDe, limite) => {
      let consulta = db
        .collection(COLECAO)
        .where("status", "in", ["pendente", "aceito"])
        .where("apurarEm", "<=", corte)
        .orderBy("apurarEm")
        .select("apurarEm");
      if (depoisDe) consulta = consulta.startAfter(depoisDe);
      return (await consulta.limit(limite).get()).docs;
    },
    processar: async (doc) => {
      const vence = (doc.get("apurarEm") as Timestamp | undefined)?.toMillis?.();
      if (typeof vence === "number") atrasoMaxMs = Math.max(atrasoMaxMs, corte.toMillis() - vence);
      const [status] = Object.values(await apurarLista(db, null, [doc.id]));
      contagem[status] += 1;
    },
  });
  return { contagem, restantes, atrasoMaxMs };
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
  if (!segredo || segredo.length < 16) {
    // Sem segredo a rotina NUNCA roda: alerta no log em vez de falhar em silêncio (ver docs/rotina-diaria.md).
    console.error(JSON.stringify({ evt: "rotina_sem_cron_secret" }));
    return false;
  }
  const esperado = new Uint8Array(Buffer.from(`Bearer ${segredo}`));
  const atual = new Uint8Array(Buffer.from(recebido));
  return atual.length === esperado.length && timingSafeEqual(atual, esperado);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    if (!ehRotinaAutorizada(req)) return res.status(401).json({ error: "Não autorizado." });
    const inicio = Date.now();
    try {
      const db = getFirestore(getFirebaseApp());
      const etapasComFalha: string[] = [];
      /** Cada etapa isolada: uma falha vira um problema no resumo (resposta não-2xx), sem impedir as outras. */
      const etapa = async <T>(nome: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn();
        } catch (erro) {
          etapasComFalha.push(nome);
          console.error(JSON.stringify({ evt: "rotina_etapa_falhou", etapa: nome, message: (erro as Error)?.message ?? String(erro) }));
          return null;
        }
      };

      // 1. CÁLCULO (prioridade): fecha os vencidos e grava os avisos na fila, na mesma transação de cada um.
      const apuracao = await etapa("apuracao", () => apurarVencidos(db, inicio + PRAZOS_DA_ROTINA_MS.apuracao));
      // 2. NOTIFICAÇÃO: separada do cálculo, com o próprio prazo. O que sobrar continua na fila.
      const avisos = await etapa("avisos", () => enviarFilaDeAvisos(db, inicio + PRAZOS_DA_ROTINA_MS.avisos));
      // 3. Exclusões de conta com etapas pendentes (ver `_lib/exclusaoConta.ts`).
      const exclusoes = await etapa("exclusoes", () => processarExclusoesPendentes(db, inicio + PRAZOS_DA_ROTINA_MS.exclusoes));
      // 4. Reservas de imagem vencidas: confirma as trocas e apaga os envios órfãos (ver `_lib/midiaReservas.ts`).
      const midia = await etapa("midia", () => limparReservasDeMidia(db, inicio + PRAZOS_DA_ROTINA_MS.midia));
      // Reaproveita o cron diário existente, sem adicionar função ou agendamento de outro plano.
      const recuperados = await etapa("push_outbox", () => recuperarAvisosPendentes(db, { limit: 3 }));
      // Recibos do Expo ficam disponíveis por ~24 h: a rotina diária alcança os avisos do dia anterior.
      await etapa("push_recibos", () => consultarRecibos(db));
      // Recálculos de perfil que o app não conseguiu pedir (ou que falharam): pendência durável gravada junto com a partida.
      await etapa("estatisticas_pendencias", () => processarPendencias(db));

      const resumo = {
        ...(apuracao?.contagem ?? {}),
        reavisos: avisos?.enviados ?? 0,
        atrasoMaxMs: apuracao?.atrasoMaxMs ?? 0,
        exclusoesConcluidas: exclusoes?.concluidas ?? 0,
        exclusoesPendentes: exclusoes?.pendentes ?? 0,
        reservasResolvidas: midia?.resolvidas ?? 0,
        duracaoMs: Date.now() - inicio,
      };
      const problemas = problemasDaRotina({
        falhou: apuracao?.contagem.falhou ?? 0,
        reconciliar: apuracao?.contagem.reconciliar ?? 0,
        apuracaoIncompleta: apuracao?.restantes ?? false,
        avisosIncompletos: avisos?.restantes ?? false,
        atrasoMaxMs: resumo.atrasoMaxMs,
        etapasComFalha: [
          ...etapasComFalha,
          ...(exclusoes?.restantes ? ["exclusoes_restantes"] : []),
          ...((exclusoes?.pendentes ?? 0) > 0 ? ["exclusoes_pendentes"] : []),
          ...(midia?.restantes ? ["midia_restante"] : []),
          ...((midia?.falhas ?? 0) > 0 ? ["midia_pendente"] : []),
          // Sem a credencial de uma conta, nem a limpeza de imagens nem a exclusão de conta terminam.
          ...bucketsSemCredenciais().map((bucket) => `credencial_ausente_${bucket}`),
        ],
      });
      console.log(JSON.stringify({ evt: "push_outbox_daily_recovery", ...(recuperados ?? {}) }));
      if (problemas.length) {
        // Sucesso parcial NÃO responde 200: a Vercel registra a execução como falha e o log traz o motivo.
        console.error(JSON.stringify({ evt: "desafios_rotina_incompleta", problemas, ...resumo }));
        return res.status(500).json({ success: false, parcial: true, problemas, ...resumo });
      }
      console.log(JSON.stringify({ evt: "desafios_rotina", ...resumo }));
      return res.status(200).json({ success: true, ...resumo });
    } catch (erro) {
      console.error(JSON.stringify({ evt: "desafios_rotina_falhou", message: (erro as Error)?.message ?? String(erro) }));
      return res.status(500).json({ error: "Falha na rotina." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res, "desafiar");
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
