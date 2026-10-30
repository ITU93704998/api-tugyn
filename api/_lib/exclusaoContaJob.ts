import { getAuth } from "firebase-admin/auth";
import { FieldPath, FieldValue, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { type DeletionOutcome, excluirConta } from "./accountDeletion";
import { getFirebaseApp } from "./auth";
import { deltaDeRemocao, notasDe } from "./avaliacoes";
import { apagarImagensDoUsuario } from "./cloudinaryCleanup";
import { percorrerComPrazo } from "./desafios";
import {
  ALERTA_TENTATIVAS,
  type EstadoDaEtapa,
  type EtapaPosExclusao,
  avaliarRestos,
  deveProcessar,
  etapasPendentes,
  paresDosDesafios,
} from "./exclusaoConta";
import { timestampMillis } from "./mediaCooldown";
import { COLECAO_RESERVAS } from "./midiaReservasJob";

/** Job/lápide da exclusão de conta (protocolo em `exclusaoConta.ts`). Só o servidor lê e grava (as regras negam ao app). */
export const COLECAO_EXCLUSOES = "exclusoesConta";
const LOTE_DE_EXCLUSOES = 5;

/**
 * Coleções fora do que foi analisado (notificações, convites, times...) que guardam o uid em algum
 * campo. Preencha quando souber, ex.: { collection: "notifications", field: "userId" }.
 */
const EXTRA_COLLECTIONS: { collection: string; field: string }[] = [
  { collection: "pushTokens", field: "uid" }, // tokens de notificação do usuário (api/push.ts)
  { collection: "pushDedupe", field: "targetUid" }, // registros de "já avisei" (api/push.ts)
  { collection: "desafios", field: "desafianteId" }, // desafios que ele criou (api/desafios.ts)
  { collection: "desafios", field: "desafiadoId" }, // desafios que ele recebeu
  { collection: "avaliacoes", field: "avaliadoId" }, // avaliações que ele recebeu (o resumo some junto com o perfil)
  { collection: "desafiosVagas", field: "uid" }, // vagas de desafio dele (api/desafios.ts)
  { collection: COLECAO_RESERVAS, field: "uid" }, // reservas de troca de imagem (as imagens somem na etapa "imagens")
];

const jobRef = (db: Firestore, uid: string) => db.doc(`${COLECAO_EXCLUSOES}/${uid}`);
const mensagem = (erro: unknown) => String((erro as Error)?.message ?? erro).slice(0, 300);

/** Desafios dele (vagas + documentos), lidos ANTES de apagar: `{ desafioId: adversário }`. */
const desafiosDoUsuario = async (db: Firestore, uid: string): Promise<Record<string, string>> => {
  const [vagas, criados, recebidos] = await Promise.all([
    db.doc(`desafiosVagas/${uid}`).get(),
    db.collection("desafios").where("desafianteId", "==", uid).select().get(),
    db.collection("desafios").where("desafiadoId", "==", uid).select().get(),
  ]);
  const ativos = vagas.get("ativos");
  const ids = [
    ...(ativos && typeof ativos === "object" ? Object.keys(ativos as Record<string, unknown>) : []),
    ...criados.docs.map((d) => d.id),
    ...recebidos.docs.map((d) => d.id),
  ];
  return paresDosDesafios(uid, ids);
};

/** Cria (ou retoma) a lápide antes de qualquer remoção. Os pares acumulam: numa nova tentativa as vagas já podem ter sumido. */
const registrarInicio = async (db: Firestore, uid: string, closeOwnedTurmas: boolean): Promise<void> => {
  const desafios = await desafiosDoUsuario(db, uid);
  await db.runTransaction(async (tx) => {
    const atual = await tx.get(jobRef(db, uid));
    const anteriores = (atual.get("desafios") as Record<string, string> | undefined) ?? {};
    tx.set(
      jobRef(db, uid),
      {
        uid,
        // Nunca volta de "pos_exclusao" para "excluindo" por uma nova chamada (a rotina decide isso na verificação).
        estado: atual.get("estado") === "pos_exclusao" ? "pos_exclusao" : "excluindo",
        closeOwnedTurmas: closeOwnedTurmas || atual.get("closeOwnedTurmas") === true,
        desafios: { ...anteriores, ...desafios },
        ...(atual.exists ? {} : { iniciadaEm: FieldValue.serverTimestamp() }),
        atualizadaEm: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
};

/** Os desafios dele foram apagados: a vaga que cada um ocupava no adversário é liberada. */
const liberarVagasDosAdversarios = async (db: Firestore, pares: Record<string, string>): Promise<void> => {
  const porAdversario = new Map<string, string[]>();
  for (const [id, outro] of Object.entries(pares)) porAdversario.set(outro, [...(porAdversario.get(outro) ?? []), id]);
  for (const [outro, ids] of porAdversario) {
    const ref = db.doc(`desafiosVagas/${outro}`);
    if (!(await ref.get()).exists) continue; // não cria documento para quem não tem
    await ref.set({ ativos: Object.fromEntries(ids.map((id) => [id, FieldValue.delete()])) }, { merge: true });
  }
};

/** Avaliações que ele DEU (api/avaliacoes.ts): cada uma sai do resumo do avaliado e é apagada (idempotente, por transação). */
const removerAvaliacoesDadas = async (db: Firestore, uid: string): Promise<void> => {
  const snap = await db.collection("avaliacoes").where("avaliadorId", "==", uid).get();
  for (const docSnap of snap.docs) {
    await db.runTransaction(async (tx) => {
      const atual = await tx.get(docSnap.ref);
      if (!atual.exists) return;
      const notas = notasDe(atual.data());
      const avaliadoId = atual.get("avaliadoId");
      if (notas && typeof avaliadoId === "string" && avaliadoId) {
        // O resumo mora na parte restrita do perfil (ver api/avaliacoes.ts).
        const perfilRef = db.doc(`users/${avaliadoId}/restrito/perfil`);
        const perfil = await tx.get(perfilRef);
        if (perfil.exists) {
          const d = deltaDeRemocao(notas);
          tx.update(perfilRef, {
            "avaliacao.convivencia": FieldValue.increment(d.convivencia),
            "avaliacao.comprometimento": FieldValue.increment(d.comprometimento),
            "avaliacao.fairPlay": FieldValue.increment(d.fairPlay),
            "avaliacao.total": FieldValue.increment(d.total),
          });
        }
      }
      tx.delete(docSnap.ref);
    });
  }
};

/** Roda uma etapa pós-exclusão e devolve o novo estado dela (nunca lança). */
const rodarEtapa = async (db: Firestore, uid: string, etapa: EtapaPosExclusao, job: Record<string, unknown>, anterior?: EstadoDaEtapa): Promise<EstadoDaEtapa> => {
  const tentativas = (anterior?.tentativas ?? 0) + 1;
  try {
    if (etapa === "avaliacoesDadas") await removerAvaliacoesDadas(db, uid);
    if (etapa === "vagasAdversarios") await liberarVagasDosAdversarios(db, (job.desafios as Record<string, string> | undefined) ?? {});
    if (etapa === "imagens") {
      // Conta do Cloudinary sem credencial no ambiente NÃO é sucesso: a etapa fica pendente e alerta.
      const pendencias = await apagarImagensDoUsuario(uid);
      if (pendencias.length) return { ok: false, tentativas, pendencias };
    }
    return { ok: true, tentativas };
  } catch (erro) {
    return { ok: false, tentativas, erro: mensagem(erro) };
  }
};

const contar = async (db: Firestore, colecao: string, campo: string, uid: string): Promise<number> =>
  (await db.collection(colecao).where(campo, "==", uid).limit(1).select().get()).size;

/** Verificação final: procura qualquer resto da conta. */
const verificarRestos = async (db: Firestore, uid: string, pares: Record<string, string>) => {
  let contaAuth = true;
  try {
    await getAuth(getFirebaseApp()).getUser(uid);
  } catch (erro) {
    if ((erro as { code?: string }).code !== "auth/user-not-found") throw erro;
    contaAuth = false;
  }
  const adversarios = [...new Set(Object.values(pares))];
  const vagasDeles = adversarios.length ? await db.getAll(...adversarios.map((o) => db.doc(`desafiosVagas/${o}`))) : [];
  const ids = new Set(Object.keys(pares));
  const vagasDeAdversarios = vagasDeles.filter((d) => Object.keys((d.get("ativos") as Record<string, unknown> | undefined) ?? {}).some((id) => ids.has(id))).length;
  const [perfil, vagas, usernames, dadas, recebidas, criados, recebidos, pushTokens, reservas] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`desafiosVagas/${uid}`).get(),
    contar(db, "usernames", "uid", uid),
    contar(db, "avaliacoes", "avaliadorId", uid),
    contar(db, "avaliacoes", "avaliadoId", uid),
    contar(db, "desafios", "desafianteId", uid),
    contar(db, "desafios", "desafiadoId", uid),
    contar(db, "pushTokens", "uid", uid),
    contar(db, COLECAO_RESERVAS, "uid", uid),
  ]);
  return avaliarRestos({
    perfil: perfil.exists,
    contaAuth,
    usernames,
    avaliacoesDadas: dadas,
    avaliacoesRecebidas: recebidas,
    desafios: criados + recebidos,
    vagas: vagas.exists,
    vagasDeAdversarios,
    pushTokens,
    reservas,
  });
};

/** O fluxo principal (idempotente), com a lápide gravada antes de qualquer remoção. */
export const executarExclusao = async (db: Firestore, uid: string, closeOwnedTurmas: boolean): Promise<DeletionOutcome> => {
  const outcome = await excluirConta(
    {
      db,
      aoIniciar: (u) => registrarInicio(db, u, closeOwnedTurmas),
      // As imagens são uma etapa do job (com retentativa); aqui não bloqueiam a exclusão da conta do Auth.
      apagarImagens: async () => undefined,
      apagarContaAuth: async (u) => {
        try {
          await getAuth(getFirebaseApp()).deleteUser(u);
        } catch (erro) {
          if ((erro as { code?: string }).code !== "auth/user-not-found") throw erro;
        }
      },
    },
    uid,
    { closeOwnedTurmas, extraCollections: EXTRA_COLLECTIONS },
  );
  if (outcome.ok) {
    await jobRef(db, uid).update({ estado: "pos_exclusao", contaExcluidaEm: FieldValue.serverTimestamp(), atualizadaEm: FieldValue.serverTimestamp() });
  }
  return outcome;
};

/**
 * Termina o job: etapas pendentes, depois a verificação final. Tudo certo → apaga a lápide. Devolve se concluiu.
 * Nunca lança por uma etapa: o que falhar fica gravado no job e a rotina diária tenta de novo.
 */
export const processarJob = async (db: Firestore, uid: string): Promise<boolean> => {
  const snap = await jobRef(db, uid).get();
  if (!snap.exists) return true;
  const job = snap.data() ?? {};

  if (job.estado === "excluindo") {
    // Retomada pela rotina: o fluxo principal com a mesma escolha da pessoa sobre as turmas.
    const outcome = await executarExclusao(db, uid, job.closeOwnedTurmas === true);
    if (!outcome.ok) {
      console.error(JSON.stringify({ evt: "account_delete_stuck", motivo: outcome.reason }));
      await jobRef(db, uid).update({ atualizadaEm: FieldValue.serverTimestamp(), bloqueio: outcome.reason });
      return false;
    }
  }

  const etapas = { ...((job.etapas as Partial<Record<EtapaPosExclusao, EstadoDaEtapa>> | undefined) ?? {}) };
  for (const etapa of etapasPendentes(etapas)) {
    etapas[etapa] = await rodarEtapa(db, uid, etapa, job, etapas[etapa]);
  }
  const pendentes = etapasPendentes(etapas);

  // Verificação final só quando as etapas passaram (senão o resultado já se sabe).
  const restos = pendentes.length ? null : await verificarRestos(db, uid, (job.desafios as Record<string, string> | undefined) ?? {});
  if (restos && restos.pendencias.length === 0) {
    await jobRef(db, uid).delete();
    console.log(JSON.stringify({ evt: "account_delete_concluded" }));
    return true;
  }
  for (const etapa of restos?.refazerEtapas ?? []) etapas[etapa] = { ok: false, tentativas: etapas[etapa]?.tentativas ?? 0 };
  const rodadas = Number(job.rodadas ?? 0) + 1;
  await jobRef(db, uid).update({
    etapas,
    rodadas,
    ...(restos?.refazerExclusao ? { estado: "excluindo" } : {}),
    pendencias: restos?.pendencias ?? pendentes,
    atualizadaEm: FieldValue.serverTimestamp(),
  });
  const alerta = rodadas >= ALERTA_TENTATIVAS ? console.error : console.warn;
  alerta(
    JSON.stringify({
      evt: rodadas >= ALERTA_TENTATIVAS ? "account_delete_stuck" : "account_delete_pending",
      rodadas,
      pendencias: restos?.pendencias ?? pendentes.map((e) => [e, ...(etapas[e]?.pendencias ?? [])].join(":")),
    }),
  );
  return false;
};

/** Rotina diária: termina as exclusões pendentes (e retoma as paradas em "excluindo"), em lotes com cursor, até o prazo. */
export const processarExclusoesPendentes = async (db: Firestore, prazoMs: number) => {
  let concluidas = 0;
  let pendentes = 0;
  const agora = Date.now();
  const { restantes } = await percorrerComPrazo<QueryDocumentSnapshot>({
    lote: LOTE_DE_EXCLUSOES,
    prazoMs,
    buscar: async (depoisDe, limite) => {
      // Pelo id (não por `atualizadaEm`, que muda ao processar e traria o mesmo job de volta na mesma rodada).
      let consulta = db.collection(COLECAO_EXCLUSOES).orderBy(FieldPath.documentId());
      if (depoisDe) consulta = consulta.startAfter(depoisDe.id);
      return (await consulta.limit(limite).get()).docs;
    },
    processar: async (doc) => {
      const job = { estado: doc.get("estado"), atualizadaEmMs: timestampMillis(doc.get("atualizadaEm")) };
      if (!deveProcessar(job, agora)) return; // em andamento agora (a pessoa ainda pode estar no meio)
      try {
        if (await processarJob(db, doc.id)) concluidas += 1;
        else pendentes += 1;
      } catch (erro) {
        pendentes += 1;
        console.error(JSON.stringify({ evt: "account_delete_job_failed", message: mensagem(erro) }));
      }
    },
  });
  return { concluidas, pendentes, restantes };
};
