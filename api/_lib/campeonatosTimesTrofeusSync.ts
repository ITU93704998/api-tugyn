import { createHash } from "node:crypto";
import { FieldValue, type Firestore, type DocumentSnapshot } from "firebase-admin/firestore";
import { ID_CT, type InscricaoCT, type JogoCT } from "./campeonatosTimesDominio";
import { calcularTrofeusTimes, chaveTrofeuTimes } from "./campeonatosTimesTrofeus";
import { mesmoTrofeu, uidsDe } from "./trofeus";

const revisao = (s: DocumentSnapshot): string => s.updateTime ? `${s.updateTime.seconds}:${s.updateTime.nanoseconds}` : "ausente";
/** Ledger durável antes das galerias: uma falha parcial nunca perde os destinatários a remover.
 * Transações pequenas por atleta evitam uma transação enorme com até 480 galerias.
 * Toda escrita confere a revisão atual do campeonato: um worker antigo não premia depois da correção.
 * Repetir não altera a data da conquista nem regrava galerias iguais. */
export async function sincronizarTrofeusTimes(db: Firestore, id: string): Promise<{ gravados: number; removidos: number }> {
  if (!ID_CT.test(id)) throw new Error("Identificador de campeonato inválido");
  const inicio = Date.now(), ref = db.doc(`campeonatosTimes/${id}`), ledger = ref.collection("premiacaoControle").doc("estado"), chave = chaveTrofeuTimes(id);
  const plano = await db.runTransaction(async tx => {
    const [c, l] = await tx.getAll(ref, ledger);
    const [ins, jogos] = c.data()?.status === "encerrado"
      ? await Promise.all([tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17)), tx.get(ref.collection("jogos").limit(64))]) : [null, null];
    const atuais = calcularTrofeusTimes(id, c.exists ? c.data()! : null, (ins?.docs.map(d => d.data()) ?? []) as InscricaoCT[],
      Object.fromEntries(jogos?.docs.map(d => [d.id, d.data()]) ?? []) as Record<string, JogoCT>);
    const assinatura = createHash("sha256").update(JSON.stringify([...atuais].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
    if (l.data()?.concluido === true && l.data()?.assinatura === assinatura) return null;
    const envolvidos = [...new Set([...uidsDe(l.data()?.uids), ...atuais.keys()])];
    if (!envolvidos.length && !l.exists) return null;
    const fonte = revisao(c);
    const mesmoPlano = l.data()?.assinatura === assinatura && l.data()?.revisaoFonte === fonte && Array.isArray(l.data()?.pendentes);
    const pendentes = mesmoPlano ? uidsDe(l.data()?.pendentes) : envolvidos;
    // As falhas registradas valem enquanto o plano for o mesmo (acompanhamento das tentativas); plano novo começa limpo.
    const falhas = mesmoPlano && l.data()?.falhas && typeof l.data()?.falhas === "object" ? l.data()!.falhas : {};
    tx.set(ledger, { assinatura, revisaoFonte: fonte, uids: envolvidos, pendentes, falhas, concluido: false, atualizadoEm: FieldValue.serverTimestamp() });
    return { atuais, envolvidos: pendentes, assinatura, revisao: fonte };
  });
  if (!plano) return { gravados: 0, removidos: 0 };
  let gravados = 0, removidos = 0, indice = 0;
  const mudou = () => new Error("Premiação mudou: reconciliar estado atual");
  const conferir = (c: DocumentSnapshot, l: DocumentSnapshot) => {
    if (revisao(c) !== plano.revisao || l.data()?.assinatura !== plano.assinatura) throw mudou();
  };
  // Erros que valem para todos (plano velho, prazo da execução) param tudo; o de uma galeria fica só naquele atleta.
  let limite = 0, fatal: Error | null = null;
  let feitos: string[] = [], falhos: { uid: string; erro: string }[] = [];
  const trabalhador = async () => {
    while (indice < limite && !fatal) {
      if (Date.now() - inicio > 45_000) { fatal = new Error("Premiação parcial: continuar em nova tentativa"); break; }
      const uid = plano.envolvidos[indice++], usuario = db.doc(`users/${uid}`), galeria = usuario.collection("restrito").doc("trofeus");
      let acao: string;
      try { acao = await db.runTransaction(async tx => {
        const [c, l, u, g] = await tx.getAll(ref, ledger, usuario, galeria);
        conferir(c, l);
        // Nunca recria dados pessoais de uma conta excluída ou em exclusão.
        if (!u.exists || u.data()?.excluindoEm) return "nenhuma";
        const atual = g.data()?.itens?.[chave], novo = plano.atuais.get(uid), agora = FieldValue.serverTimestamp();
        if (novo) {
          if (atual && mesmoTrofeu(atual, novo)) return "nenhuma";
          tx.set(galeria, { itens: { [chave]: { ...novo, em: atual?.em ?? agora } }, atualizadoEm: agora }, { merge: true });
          return "gravado";
        }
        if (!atual) return "nenhuma";
        tx.set(galeria, { itens: { [chave]: FieldValue.delete() }, atualizadoEm: agora }, { merge: true });
        return "removido";
      }); } catch (e) {
        if (e instanceof Error && e.message === mudou().message) { fatal = e; break; }
        falhos.push({ uid, erro: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        continue;
      }
      feitos.push(uid);
      if (acao === "gravado") gravados++;
      if (acao === "removido") removidos++;
    }
  };
  // Confirma no ledger quem recebeu (sai dos pendentes) e quem falhou (fica pendente, com a contagem de tentativas).
  const confirmar = async () => {
    const ok = new Set(feitos), erros = falhos;
    feitos = []; falhos = [];
    if (!ok.size && !erros.length) return;
    await db.runTransaction(async tx => {
      const [c, l] = await tx.getAll(ref, ledger);
      conferir(c, l);
      const anteriores = (l.data()?.falhas ?? {}) as Record<string, { tentativas?: number }>;
      const falhas: Record<string, unknown> = {};
      for (const uid of ok) if (anteriores[uid]) falhas[uid] = FieldValue.delete();
      for (const { uid, erro } of erros) falhas[uid] = { erro, tentativas: Number(anteriores[uid]?.tentativas ?? 0) + 1, em: FieldValue.serverTimestamp() };
      tx.set(ledger, { pendentes: uidsDe(l.data()?.pendentes).filter(u => !ok.has(u)), ...(Object.keys(falhas).length ? { falhas } : {}) }, { merge: true });
    });
  };
  const comFalha: { uid: string; erro: string }[] = [];
  for (let offset = 0; offset < plano.envolvidos.length && !fatal; offset += 32) {
    limite = Math.min(offset + 32, plano.envolvidos.length);
    await Promise.all(Array.from({ length: Math.min(8, limite - offset) }, trabalhador));
    comFalha.push(...falhos);
    // Retoma a partir do confirmado, mesmo quando a premiação inteira excede o timeout. Plano velho não confirma nada.
    if (fatal && (fatal as Error).message === mudou().message) throw fatal;
    await confirmar();
  }
  if (fatal) throw fatal;
  // Alguém ficou sem a galeria: não conclui. O retry da Function repete só os pendentes (os demais já receberam).
  if (comFalha.length) {
    console.warn(JSON.stringify({ evt: "trofeus_times_falha_parcial", campeonatoId: id, falhas: comFalha.length }));
    throw new Error(`Premiação parcial: ${comFalha.length} galeria(s) com falha (${comFalha[0].erro})`);
  }
  await db.runTransaction(async tx => {
    const [c, l] = await tx.getAll(ref, ledger);
    conferir(c, l);
    if (!c.exists) tx.delete(ledger);
    else tx.set(ledger, { assinatura: plano.assinatura, uids: [...plano.atuais.keys()], concluido: true, atualizadoEm: FieldValue.serverTimestamp() });
  });
  return { gravados, removidos };
}
