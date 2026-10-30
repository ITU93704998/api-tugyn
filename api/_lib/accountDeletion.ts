import { type DocumentData, FieldValue, type Firestore, type UpdateData, type WriteBatch } from "firebase-admin/firestore";

/**
 * Exclusão de conta: apaga ou anonimiza TUDO do usuário no Firestore, depois as imagens e, por
 * último, a conta do Firebase Auth. Usa o Admin SDK (ignora as regras de segurança).
 *
 * Duas garantias:
 *  1. IDEMPOTENTE: cada passo pode rodar de novo sem estragar nada. Se a rede ou o servidor falhar no
 *     meio, o usuário toca em "excluir" outra vez e termina. A conta do Auth só some no FIM, então ele
 *     continua conseguindo entrar para tentar de novo.
 *  2. NÃO DESTRÓI DADOS DE OUTRAS PESSOAS: quem organiza uma turma com outros participantes precisa
 *     escolher "encerrar as turmas" (ela fica como histórico, sem organizador). Turma só dele é apagada.
 */

export const REMOVED_NAME = "Usuário removido";

const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;
const BATCH_LIMIT = 400; // o Firestore aceita até 500 escritas por batch

export interface TurmaInfo {
  id: string;
  nome: string;
  /** Quantos OUTROS participantes aprovados ela tem. */
  membros: number;
}

export interface ExtraCollection {
  collection: string;
  /** Campo que guarda o uid do dono do documento. */
  field: string;
}

export interface DeletionOptions {
  /** Permite encerrar as turmas que ele organiza e que têm outros participantes. */
  closeOwnedTurmas: boolean;
  /** Coleções fora do que foi analisado (notificações, convites...) com o uid em algum campo. */
  extraCollections?: ExtraCollection[];
}

export interface DeletionReport {
  turmasExcluidas: number;
  turmasEncerradas: number;
  turmasDeixadas: number;
  partidasAnonimizadas: number;
  avisos: string[];
}

export type DeletionOutcome =
  | { ok: true; report: DeletionReport }
  | { ok: false; reason: "organizer_has_turmas"; turmas: TurmaInfo[] };

export interface DeletionDeps {
  db: Firestore;
  apagarImagens: (uid: string) => Promise<void>;
  /** Apaga a conta do Firebase Auth (ignora "usuário não existe"). */
  apagarContaAuth: (uid: string) => Promise<void>;
  /** Chamado depois da checagem de organizador e ANTES de qualquer remoção (grava a lápide/job da exclusão). */
  aoIniciar?: (uid: string) => Promise<void>;
}

/** Erro com o nome da etapa que falhou (vai para o log do servidor, nunca para o cliente). */
export class StepError extends Error {
  constructor(
    public readonly step: string,
    public readonly causa: unknown,
  ) {
    super(`Falha na etapa "${step}"`);
    this.name = "StepError";
  }
}

const etapa = async <T>(nome: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (erro) {
    throw new StepError(nome, erro);
  }
};

// ─── Utilitários puros ────────────────────────────────────────────────────────

/** O Firestore avisa que falta o índice de grupo de coleções (código 9 / FAILED_PRECONDITION). */
export const isMissingIndex = (erro: unknown): boolean => {
  const { code, message } = (typeof erro === "object" && erro !== null ? erro : {}) as {
    code?: unknown;
    message?: unknown;
  };
  return code === 9 || code === "failed-precondition" || (typeof message === "string" && /requires an index|FAILED_PRECONDITION/i.test(message));
};

/**
 * Troca o nome do jogador por "Usuário removido" em `jogadores`, que pode vir como lista de listas
 * (o app já gravou assim). Devolve o novo valor e se algo mudou.
 */
export const anonimizarJogadores = (valor: unknown, uid: string): { mudou: boolean; valor: unknown } => {
  if (Array.isArray(valor)) {
    let mudou = false;
    const novo = valor.map((item) => {
      const resultado = anonimizarJogadores(item, uid);
      mudou = mudou || resultado.mudou;
      return resultado.valor;
    });
    return { mudou, valor: novo };
  }
  if (typeof valor === "object" && valor !== null) {
    const jogador = valor as Record<string, unknown>;
    if (jogador.participanteId === uid && jogador.nomeJogador !== REMOVED_NAME) {
      return { mudou: true, valor: { ...jogador, nomeJogador: REMOVED_NAME } };
    }
  }
  return { mudou: false, valor };
};

type Escrita = (batch: WriteBatch) => void;

const commitar = async (db: Firestore, escritas: Escrita[]): Promise<void> => {
  for (let i = 0; i < escritas.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    escritas.slice(i, i + BATCH_LIMIT).forEach((escrever) => escrever(batch));
    await batch.commit();
  }
};

// ─── Levantamento ─────────────────────────────────────────────────────────────

interface TurmaDoUsuario {
  id: string;
  nome: string;
  dados: Record<string, unknown>;
  ehOrganizador: boolean;
  outros: number;
  participante: { status: string } | null;
}

const listaDe = (valor: unknown): string[] => (Array.isArray(valor) ? valor.filter((x): x is string => typeof x === "string") : []);

const levantarTurmas = async (db: Firestore, uid: string, avisos: string[]): Promise<TurmaDoUsuario[]> => {
  const [comoMembro, comoPendente, comoCriador] = await Promise.all([
    db.collection("turmas").where("participantes", "array-contains", uid).get(),
    db.collection("turmas").where("pendingParticipants", "array-contains", uid).get(),
    db.collection("turmas").where("creatorId", "==", uid).get(),
  ]);

  const ids = new Set<string>([...comoMembro.docs, ...comoPendente.docs, ...comoCriador.docs].map((d) => d.id));

  // Quem JÁ SAIU de uma turma não consta nas listas: só o documento de participante guarda o nome e as
  // estatísticas. Achar esses documentos exige um índice de grupo de coleções (ver firestore.indexes.json).
  try {
    const exMembros = await db.collectionGroup("participantes").where("id", "==", uid).get();
    for (const doc of exMembros.docs) {
      const turmaRef = doc.ref.parent.parent;
      if (turmaRef) ids.add(turmaRef.id);
    }
  } catch (erro) {
    if (!isMissingIndex(erro)) throw erro;
    avisos.push("indice_participantes_ausente");
  }

  const turmas: TurmaDoUsuario[] = [];
  for (const id of ids) {
    const [turmaSnap, participanteSnap] = await Promise.all([
      db.doc(`turmas/${id}`).get(),
      db.doc(`turmas/${id}/participantes/${uid}`).get(),
    ]);
    if (!turmaSnap.exists) continue;

    const dados = (turmaSnap.data() ?? {}) as Record<string, unknown>;
    turmas.push({
      id,
      nome: typeof dados.nome === "string" ? dados.nome : "Turma",
      dados,
      ehOrganizador: dados.creatorId === uid,
      outros: listaDe(dados.participantes).filter((p) => p !== uid).length,
      participante: participanteSnap.exists ? { status: String(participanteSnap.get("status") ?? "") } : null,
    });
  }
  return turmas;
};

// ─── Por turma ────────────────────────────────────────────────────────────────

/** Tira o usuário de uma turma que continua existindo (membro, pendente, ex-membro ou organizador que encerra). */
const sairDaTurma = async (
  db: Firestore,
  uid: string,
  turma: TurmaDoUsuario,
  encerrar: boolean,
): Promise<number> => {
  const turmaRef = db.doc(`turmas/${turma.id}`);
  const participanteRef = db.doc(`turmas/${turma.id}/participantes/${uid}`);
  const resumoRef = db.doc(`turmas/${turma.id}/resumo/atual`);

  const eraMembro = listaDe(turma.dados.participantes).includes(uid);
  const eraPendente = listaDe(turma.dados.pendingParticipants).includes(uid);

  // Estrutural primeiro (turma, participante, resumo): se uma etapa longa for interrompida, o essencial já foi.
  const escritas: Escrita[] = [];

  const resumoSnap = await resumoRef.get();
  const membros = resumoSnap.exists ? (resumoSnap.get("membros") as Record<string, unknown> | undefined) : undefined;
  const estaNoResumo = membros !== undefined && Object.prototype.hasOwnProperty.call(membros, uid);

  const partidasSnap = await db.collection(`turmas/${turma.id}/partidas`).get();
  const partidasAlteradas: Escrita[] = [];
  for (const partida of partidasSnap.docs) {
    const { mudou, valor } = anonimizarJogadores(partida.get("jogadores"), uid);
    if (mudou) {
      partidasAlteradas.push((batch) =>
        batch.update(partida.ref, { jogadores: valor, atualizadoEm: FieldValue.serverTimestamp() }),
      );
    }
  }

  if (eraMembro || eraPendente || encerrar || partidasAlteradas.length > 0) {
    const atualizacao: UpdateData<DocumentData> = {
      updatedAt: FieldValue.serverTimestamp(),
      // muda a "versão" da turma: os caches de partidas dos outros membros se renovam
      ultimaAtividade: FieldValue.serverTimestamp(),
    };
    if (eraMembro) {
      atualizacao.participantes = FieldValue.arrayRemove(uid);
      atualizacao.participantesCount = FieldValue.increment(-1);
    }
    if (eraPendente) atualizacao.pendingParticipants = FieldValue.arrayRemove(uid);
    if (encerrar) {
      Object.assign(atualizacao, {
        status: "encerrada",
        ativo: false,
        encerradaEm: FieldValue.serverTimestamp(),
        creatorName: REMOVED_NAME,
        creatorPhoto: "",
      });
    }
    escritas.push((batch) => batch.update(turmaRef, atualizacao));
  }

  if (turma.participante) {
    if (turma.participante.status === "pendente") {
      escritas.push((batch) => batch.delete(participanteRef)); // pedido sem histórico: some
    } else {
      escritas.push((batch) =>
        batch.update(participanteRef, {
          nome: REMOVED_NAME,
          urlPhoto: "",
          anonimizado: true,
          status: turma.participante?.status === "aprovado" ? "saiu" : turma.participante?.status,
          ...(turma.participante?.status === "aprovado" ? { saiuEm: FieldValue.serverTimestamp() } : {}),
          atualizadoEm: FieldValue.serverTimestamp(),
        }),
      );
    }
  }

  if (estaNoResumo) {
    escritas.push((batch) =>
      batch.update(resumoRef, { [`membros.${uid}`]: FieldValue.delete(), atualizadoEm: FieldValue.serverTimestamp() }),
    );
  }

  await commitar(db, [...escritas, ...partidasAlteradas]);
  return partidasAlteradas.length;
};

// ─── Fluxo completo ───────────────────────────────────────────────────────────

export const excluirConta = async (
  deps: DeletionDeps,
  uid: string,
  options: DeletionOptions,
): Promise<DeletionOutcome> => {
  if (!SAFE_UID.test(uid)) throw new Error("uid inválido");
  const { db } = deps;
  const avisos: string[] = [];

  const turmas = await etapa("levantamento", () => levantarTurmas(db, uid, avisos));

  // Antes de mexer em QUALQUER coisa: organizador com outros participantes precisa decidir.
  const comOutros = turmas.filter((t) => t.ehOrganizador && t.outros > 0);
  if (comOutros.length > 0 && !options.closeOwnedTurmas) {
    return {
      ok: false,
      reason: "organizer_has_turmas",
      turmas: comOutros.map((t) => ({ id: t.id, nome: t.nome, membros: t.outros })),
    };
  }

  if (deps.aoIniciar) await etapa("job", () => deps.aoIniciar!(uid));

  // Marcador de exclusão ANTES de apagar qualquer coisa: avaliações e desafios leem o perfil dentro da transação e recusam
  // a conta marcada, então nada novo aponta para ela depois da limpeza (nem resumo órfão em `restrito/perfil`).
  // Fica no perfil, que some no fim; se a exclusão parar no meio, o marcador continua e a pessoa só pode tentar de novo.
  await etapa("marcador", async () => {
    const perfil = db.doc(`users/${uid}`);
    if ((await perfil.get()).exists) await perfil.update({ excluindoEm: FieldValue.serverTimestamp() });
  });

  const relatorio: DeletionReport = {
    turmasExcluidas: 0,
    turmasEncerradas: 0,
    turmasDeixadas: 0,
    partidasAnonimizadas: 0,
    avisos,
  };

  for (const turma of turmas) {
    await etapa(`turma:${turma.id}`, async () => {
      if (turma.ehOrganizador && turma.outros === 0) {
        await db.recursiveDelete(db.doc(`turmas/${turma.id}`)); // turma só dele: some por inteiro
        relatorio.turmasExcluidas += 1;
        return;
      }
      relatorio.partidasAnonimizadas += await sairDaTurma(db, uid, turma, turma.ehOrganizador);
      if (turma.ehOrganizador) relatorio.turmasEncerradas += 1;
      else relatorio.turmasDeixadas += 1;
    });
  }

  await etapa("perfil", async () => {
    // Todas as reservas de username deste uid (não depende de o perfil ainda existir).
    const reservas = await db.collection("usernames").where("uid", "==", uid).get();
    for (const reserva of reservas.docs) await reserva.ref.delete();
    // Perfil e subcoleções (times, etc.).
    await db.recursiveDelete(db.doc(`users/${uid}`));
  });

  for (const extra of options.extraCollections ?? []) {
    await etapa(`extra:${extra.collection}`, async () => {
      const docs = await db.collection(extra.collection).where(extra.field, "==", uid).get();
      for (const doc of docs.docs) await db.recursiveDelete(doc.ref);
    });
  }

  await etapa("imagens", () => deps.apagarImagens(uid));

  // POR ÚLTIMO: só some a conta depois de tudo o mais ter dado certo.
  await etapa("conta", () => deps.apagarContaAuth(uid));

  return { ok: true, report: relatorio };
};
