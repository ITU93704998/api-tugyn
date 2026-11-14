import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { isSafeUid } from "./validation";

/**
 * Jogo de campeonato esquecido "ao vivo" (o organizador começou e nunca encerrou): depois de um tempo sem nenhuma ação
 * (lance, pausa, troca de tempo), o jogo é cancelado, como o "Zerar" do app: volta a não ter começado, sem cronômetro nem
 * lances, e pode ser jogado de novo ou lançado só com o placar. Assim o selo "Ao vivo" não fica para sempre na turma e
 * os jogos anteriores não ficam travados por um jogo que ninguém está jogando.
 *
 * Quem chama: a Function agendada `cancelarJogosAbandonados` (de hora em hora). Ela procura só os documentos
 * `turmas/{t}/campeonatos/{c}/aoVivo/{jogo}` parados (consulta de grupo por `atualizadoEm`): sem nenhum, custa 1 leitura.
 */

/** Sem nenhuma ação por este tempo, o jogo é cancelado. Um jogo de 2 × 90 min com intervalo não chega perto disso. */
export const ABANDONO_MS = 6 * 3600_000;
/** Por execução (o resto fica para a próxima hora). */
export const MAX_POR_VARREDURA = 50;

const ID_JOGO = /^[A-Za-z0-9_-]{1,40}$/;
const PERIODOS_EM_ANDAMENTO = ["t1", "intervalo", "t2"];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** O jogo está em andamento no documento do campeonato (marca do ao vivo, sem placar final)? */
export const jogoEmAndamento = (jogo: unknown): boolean => PERIODOS_EM_ANDAMENTO.includes(obj(obj(jogo).aoVivo).periodo as string);

/**
 * O que fazer com um documento ao vivo parado, a partir do estado lido na transação:
 *  - `manter`: houve ação recente (alguém mexeu entre a consulta e a transação);
 *  - `cancelar`: o jogo ainda está em andamento no campeonato → zera o jogo e apaga o documento ao vivo;
 *  - `apagar`: o jogo já não está em andamento (encerrado, zerado, campeonato excluído) → só apaga o documento que sobrou.
 */
export const planoDoAbandono = (campeonato: unknown, jogoId: string, atualizadoEmMs: number | null, agoraMs: number): "manter" | "cancelar" | "apagar" => {
  if (atualizadoEmMs !== null && agoraMs - atualizadoEmMs < ABANDONO_MS) return "manter";
  const jogo = obj(obj(campeonato).jogos)[jogoId];
  return campeonato && jogoEmAndamento(jogo) ? "cancelar" : "apagar";
};

/** Os campos do jogo cancelado (iguais ao "Zerar" do app). */
export const camposDoCancelamento = (jogoId: string): Record<string, unknown> => ({
  [`jogos.${jogoId}.aoVivo`]: null,
  [`jogos.${jogoId}.eventos`]: {},
  [`jogos.${jogoId}.golsCasa`]: null,
  [`jogos.${jogoId}.golsFora`]: null,
  [`jogos.${jogoId}.penaltis`]: null,
  [`jogos.${jogoId}.gols`]: {},
  [`jogos.${jogoId}.assistencias`]: {},
});

export const cancelarJogosAbandonados = async (db: Firestore, agoraMs = Date.now()): Promise<{ vistos: number; cancelados: number; apagados: number }> => {
  const corte = Timestamp.fromMillis(agoraMs - ABANDONO_MS);
  const parados = await db.collectionGroup("aoVivo").where("atualizadoEm", "<", corte).limit(MAX_POR_VARREDURA).get();
  let cancelados = 0;
  let apagados = 0;
  for (const vivo of parados.docs) {
    // Só o formato esperado: turmas/{turmaId}/campeonatos/{campeonatoId}/aoVivo/{jogoId}.
    const partes = vivo.ref.path.split("/");
    if (partes.length !== 6 || partes[0] !== "turmas" || partes[2] !== "campeonatos" || partes[4] !== "aoVivo") continue;
    const [, turmaId, , campeonatoId, , jogoId] = partes;
    if (!isSafeUid(turmaId) || !isSafeUid(campeonatoId) || !ID_JOGO.test(jogoId)) continue;
    const campRef = db.doc(`turmas/${turmaId}/campeonatos/${campeonatoId}`);
    try {
      const feito = await db.runTransaction(async (tx) => {
        const [campSnap, vivoSnap] = await tx.getAll(campRef, vivo.ref);
        if (!vivoSnap.exists) return "manter" as const;
        const em = vivoSnap.get("atualizadoEm");
        const plano = planoDoAbandono(campSnap.exists ? campSnap.data() : null, jogoId, em instanceof Timestamp ? em.toMillis() : null, agoraMs);
        if (plano === "manter") return plano;
        if (plano === "cancelar") tx.update(campRef, { ...camposDoCancelamento(jogoId), atualizadoEm: FieldValue.serverTimestamp() });
        tx.delete(vivo.ref);
        return plano;
      });
      if (feito === "cancelar") cancelados += 1;
      if (feito === "apagar") apagados += 1;
    } catch (e) {
      // Um campeonato com problema não impede os outros; a próxima execução tenta de novo.
      console.error(JSON.stringify({ evt: "campeonato_abandonado_falhou", turmaId, campeonatoId, jogoId, erro: String((e as Error)?.message ?? e) }));
    }
  }
  return { vistos: parados.size, cancelados, apagados };
};
