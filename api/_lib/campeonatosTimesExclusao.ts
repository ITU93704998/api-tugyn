import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { COLECAO_CT, type Dados, type InscricaoCT } from "./campeonatosTimesDominio";

/** Executada após marcar users.excluindoEm, antes de apagar times/perfil. Repetível se o job parar. */
export async function excluirIdentidadeCT(db: Firestore, uid: string): Promise<void> {
  for (;;) {
    const pagina = await db.collection(COLECAO_CT).where("envolvidos", "array-contains", uid).limit(10).get();
    if (pagina.empty) break;
    for (const doc of pagina.docs) await db.runTransaction(async (tx) => {
      const atual = await tx.get(doc.ref); if (!atual.exists) return;
      const c = atual.data()!;
      const [inscricoes, jogos, quota] = await Promise.all([tx.get(doc.ref.collection("inscricoes").limit(129)), tx.get(doc.ref.collection("jogos").limit(64)), tx.get(db.doc(`controleCampeonatosTimes/${uid}`))]);
      const antes = c.status === "inscricoes", anon = `removido_${createHash("sha256").update(`${doc.id}:${uid}`).digest("hex").slice(0, 20)}`;
      const afetadas = inscricoes.docs.filter((s) => s.get("donoId") === uid || (s.get("jogadores") as InscricaoCT["jogadores"] ?? []).some((a) => a.id === uid));
      // Todas as leituras antes das escritas (inclusive travas do elenco).
      const refs = antes ? afetadas.filter((s) => s.get("status") === "aprovada").flatMap((s) => (s.get("jogadores") as InscricaoCT["jogadores"]).map((a) => doc.ref.collection("atletas").doc(a.id))) : [];
      const travas = refs.length ? await tx.getAll(...refs) : [];
      travas.forEach((s) => { if (s.exists) tx.delete(s.ref); });
      let aprovados = Number(c.aprovados), pendentes = Number(c.pendentes);
      for (const s of afetadas) {
        const i = s.data() as InscricaoCT;
        const jogadores = i.jogadores.map((a) => a.id === uid ? { id: anon, nome: "Usuário removido", numero: null, posicao: null, foto: null } : a);
        const mudanca: Dados = { jogadores, atualizadoEm: Date.now() };
        if (i.donoId === uid) Object.assign(mudanca, { donoId: "", escudoUrl: null });
        if (antes && (i.status === "pendente" || i.status === "aprovada")) {
          aprovados -= i.status === "aprovada" ? 1 : 0; pendentes -= i.status === "pendente" ? 1 : 0;
          Object.assign(mudanca, { status: "cancelada", motivo: "Um participante excluiu a conta. Revise o elenco antes de pedir nova inscrição." });
        }
        tx.update(s.ref, mudanca);
      }
      for (const s of jogos.docs) {
        const mudanca: Dados = {};
        for (const campo of ["gols", "assistencias", "amarelos", "vermelhos"]) {
          const mapa = s.get(campo) as Record<string, number> | undefined;
          if (mapa && Object.prototype.hasOwnProperty.call(mapa, uid)) { const copia = { ...mapa, [anon]: mapa[uid] }; delete copia[uid]; mudanca[campo] = copia; }
        }
        if (Object.keys(mudanca).length) tx.update(s.ref, mudanca);
      }
      const mudanca: Dados = { envolvidos: (c.envolvidos as string[]).filter((u) => u !== uid), aprovados, pendentes, atualizadoEm: Date.now() };
      // Mesário que excluiu a conta sai da lista (nome e @usuário não ficam no campeonato).
      if (Array.isArray(c.mesarios) && c.mesarios.some((m: { uid?: unknown }) => m?.uid === uid)) mudanca.mesarios = c.mesarios.filter((m: { uid?: unknown }) => m?.uid !== uid);
      if (c.organizadorId === uid) {
        Object.assign(mudanca, { organizadorId: "", organizadorNome: "Usuário removido", patrocinadores: [] });
        if (c.status === "inscricoes" || c.status === "em_andamento") {
          Object.assign(mudanca, { status: "cancelado", motivoCancelamento: "O organizador excluiu a conta." });
          tx.set(db.doc(`controleCampeonatosTimes/${uid}`), { ativos: Math.max(0, Number(quota.get("ativos") ?? 0) - 1) });
        }
      }
      tx.update(doc.ref, mudanca);
    });
  }
  await db.doc(`controleCampeonatosTimes/${uid}`).delete();
  await db.doc(`liberacoesCampeonatosTimes/${uid}`).delete();
  await db.doc(`estatisticasAtletasCT/${uid}`).delete();
}
