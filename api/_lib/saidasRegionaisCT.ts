import type { Firestore } from "firebase-admin/firestore";
import { listarCT } from "./campeonatosTimesServico";
import type { Dados } from "./campeonatosTimesDominio";

/** Consulta limitada à própria participação, sem elencos, pagamentos ou catálogo.
 * Só é carregada por ação explícita na área de saída. Paginação existente por cursor. */
export async function listarSaidasRegionaisCT(db: Firestore, uid: string, body: Dados) {
  const pagina = await listarCT(db, uid, { filtro: "meus", cursor: body.cursor });
  const itens = await Promise.all((pagina.campeonatos as Dados[]).map(async c => {
    const abertas = c.status === "inscricoes";
    const inscricoes = abertas ? await db.collection("campeonatosTimes").doc(String(c.id)).collection("inscricoes").where("donoId", "==", uid).limit(128).get() : null;
    return { id: c.id, nome: c.nome, podeCancelar: c.organizadorId === uid && (abertas || c.status === "em_andamento"),
      inscricoes: (inscricoes?.docs ?? []).filter(s => s.get("status") === "pendente" || s.get("status") === "aprovada").map(s => ({ timeId: s.id, nome: String(s.get("timeNome") ?? "Meu time").slice(0, 60) })) };
  }));
  return { itens, proximoCursor: pagina.proximoCursor };
}
