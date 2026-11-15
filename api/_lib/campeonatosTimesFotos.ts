import type { Firestore } from "firebase-admin/firestore";
import { ID_CT, ID_TIME_CT, ID_PESSOA_CT, fotoAtletaCT, type AtletaCT } from "./campeonatosTimesDominio";
import { perfilDisponivel } from "./suspensao";

const faltaFoto = (j: AtletaCT) => !Object.prototype.hasOwnProperty.call(j, "foto");

/** Recuperação preguiçosa e durável: chamada somente para inscrições antigas visíveis no detalhe.
 * Uma transação preenche só foto ausente; null explícito e alterações concorrentes são preservados.
 * Não depende do time atual, não reabre campeonato nem dispara a premiação. */
export async function completarFotosInscricoesCT(db: Firestore, campeonatoId: string, times: string[]): Promise<number> {
  if (!ID_CT.test(campeonatoId)) return 0;
  const ids = [...new Set(times)].filter(id => ID_TIME_CT.test(id)).slice(0, 128);
  if (!ids.length) return 0;
  const ref = db.doc(`campeonatosTimes/${campeonatoId}`);
  return db.runTransaction(async tx => {
    const [camp, ...inscricoes] = await tx.getAll(ref, ...ids.map(id => ref.collection("inscricoes").doc(id)));
    if (!camp.exists) return 0;
    const antigas = inscricoes.filter(s => s.exists && Array.isArray(s.data()?.jogadores) && (s.data()!.jogadores as AtletaCT[]).some(faltaFoto));
    const uids = [...new Set(antigas.flatMap(s => (s.data()!.jogadores as AtletaCT[]).filter(faltaFoto).map(j => j.id)))].filter(id => typeof id === "string" && ID_PESSOA_CT.test(id));
    // Projeção reduz o payload: não carrega bio, estatísticas ou outros dados pessoais do perfil.
    const perfis = uids.length ? await tx.getAll(...uids.map(uid => db.doc(`users/${uid}`)), { fieldMask: ["profileImage", "status", "excluindoEm"] }) : [];
    const fotos = new Map(perfis.map(p => [p.id, p.exists && perfilDisponivel(p.data()) ? fotoAtletaCT(p.get("profileImage")) : null]));
    let preenchidas = 0;
    for (const s of antigas) {
      const jogadores = (s.data()!.jogadores as AtletaCT[]).map(j => {
        if (!faltaFoto(j)) return j;
        preenchidas++;
        return { ...j, foto: fotos.get(j.id) ?? null };
      });
      // Não altera atualizadoEm (histórico), elenco, camisas, resultados ou revisão da finalização.
      tx.update(s.ref, { jogadores });
    }
    return preenchidas;
  });
}
