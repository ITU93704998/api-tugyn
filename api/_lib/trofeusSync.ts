import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { calcularTrofeus, chaveDoTrofeu, mesmoTrofeu, planoDosTrofeus, uidsDe } from "./trofeus";
import { isSafeUid } from "./validation";

/**
 * Acerta a galeria de troféus de UM campeonato a partir do estado ATUAL (lido dentro de uma transação), nunca de um evento
 * ou de um pedido do app. Por isso é idempotente e a ordem não importa: dois disparos fora de ordem terminam no mesmo
 * resultado (o último estado gravado), e repetir não regrava nada.
 *
 *  - quem ganha: grava o troféu (só em contas que existem); se já tem o mesmo troféu, não mexe (a data da conquista fica);
 *  - quem ganhou antes e não ganha mais (placar corrigido, jogo reaberto, campeonato ou turma excluídos, turma moderada):
 *    o troféu sai;
 *  - o registro `trofeusCampeonatos/<chave>` guarda quem recebeu; sem ninguém e sem campeonato, é apagado.
 *
 * Quem chama: o gatilho das Functions (`syncCampeonatoTrofeus`, com nova tentativa automática em caso de falha) e a rota
 * `turma-gestao` (ação "trofeus", reconciliação manual).
 */
export const sincronizarTrofeusCampeonato = async (
  db: Firestore,
  turmaId: string,
  campeonatoId: string,
): Promise<{ recebem: number; gravados: number; removidos: number }> => {
  if (!isSafeUid(turmaId) || !isSafeUid(campeonatoId)) return { recebem: 0, gravados: 0, removidos: 0 };
  const chave = chaveDoTrofeu(turmaId, campeonatoId);
  const registroRef = db.doc(`trofeusCampeonatos/${chave}`);
  return db.runTransaction(async (tx) => {
    const [turmaSnap, campSnap, registroSnap] = await tx.getAll(
      db.doc(`turmas/${turmaId}`),
      db.doc(`turmas/${turmaId}/campeonatos/${campeonatoId}`),
      registroRef,
    );
    const turma = turmaSnap.exists ? (turmaSnap.data() ?? null) : null;
    const anteriores = uidsDe(registroSnap.data()?.uids);
    // Só membros da turma (ou o criador) recebem; quem já tinha recebido continua aceito (pode ter saído da turma depois).
    const aceitos = new Set<string>([...anteriores, ...uidsDe(turma?.participantes)]);
    if (typeof turma?.creatorId === "string") aceitos.add(turma.creatorId);
    const atuais = calcularTrofeus(turmaId, campeonatoId, turma, campSnap.exists ? (campSnap.data() ?? null) : null, (u) => aceitos.has(u));
    const { gravar, remover } = planoDosTrofeus(anteriores, atuais);

    const envolvidos = [...gravar.map(([u]) => u), ...remover];
    const leituras = envolvidos.length
      ? await tx.getAll(...envolvidos.flatMap((u) => [db.doc(`users/${u}`), db.doc(`users/${u}/restrito/trofeus`)]))
      : [];
    const conta = new Map(envolvidos.map((u, i) => [u, { existe: leituras[2 * i].exists, galeria: leituras[2 * i + 1].data() }]));
    const agora = FieldValue.serverTimestamp();

    let gravados = 0;
    const recebem: string[] = [];
    for (const [u, trofeu] of gravar) {
      const c = conta.get(u);
      if (!c?.existe) continue; // conta excluída
      recebem.push(u);
      const atual = (c.galeria?.itens as Record<string, unknown> | undefined)?.[chave];
      if (atual && mesmoTrofeu(atual, trofeu)) continue;
      const em = (atual as { em?: unknown } | undefined)?.em ?? agora; // corrigido: mantém a data da conquista
      tx.set(db.doc(`users/${u}/restrito/trofeus`), { itens: { [chave]: { ...trofeu, em } }, atualizadoEm: agora }, { merge: true });
      gravados += 1;
    }
    let removidos = 0;
    for (const u of remover) {
      const c = conta.get(u);
      if (!c?.existe || !(c.galeria?.itens as Record<string, unknown> | undefined)?.[chave]) continue;
      tx.set(db.doc(`users/${u}/restrito/trofeus`), { itens: { [chave]: FieldValue.delete() }, atualizadoEm: agora }, { merge: true });
      removidos += 1;
    }

    const mudouRegistro = JSON.stringify([...anteriores].sort()) !== JSON.stringify([...recebem].sort());
    if (!recebem.length && !campSnap.exists) {
      if (registroSnap.exists) tx.delete(registroRef);
    } else if (mudouRegistro || !registroSnap.exists) {
      tx.set(registroRef, { uids: recebem, turmaId, campeonatoId, atualizadoEm: agora });
    }
    return { recebem: recebem.length, gravados, removidos };
  });
};

/** O gatilho precisa olhar este campeonato? Só quando ele está ou esteve encerrado, ou foi apagado (lances ao vivo não). */
export const mexeNosTrofeus = (antes: Record<string, unknown> | null | undefined, depois: Record<string, unknown> | null | undefined): boolean =>
  !depois || antes?.status === "encerrado" || depois.status === "encerrado";
