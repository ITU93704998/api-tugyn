import { COLECAO_TITULOS_TIME, mesmaGeracaoDoTime, milissegundosTime, tituloDoTime } from "./galeriaTimes";
import { createHash } from "node:crypto";
import { FieldValue, type Firestore, type DocumentSnapshot } from "firebase-admin/firestore";
import { ID_TIME_CT, ID_CT, type InscricaoCT, type JogoCT } from "./campeonatosTimesDominio";
import { calcularTrofeusTimes, chaveTrofeuTimes } from "./campeonatosTimesTrofeus";
import { mesmoTrofeu, uidsDe } from "./trofeus";

/** Formato do controle: 3 = galeria dos times e revisão da fonte; 4 = títulos com a criação do time (timeCriadoEm). Subir força revalidar tudo. */
const VERSAO_CONTROLE = 4;
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
    // Já concluído nesta mesma revisão do campeonato (e no formato atual): nada mudou, nem precisa ler inscrições e jogos.
    // Mudança no campeonato, falha pendente ou controle de formato antigo seguem pela validação completa abaixo.
    const ld = l.data();
    if (c.exists && ld?.concluido === true && ld.versao === VERSAO_CONTROLE && ld.revisaoFonte === revisao(c)) return null;
    const [ins, jogos] = c.data()?.status === "encerrado"
      ? await Promise.all([tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17)), tx.get(ref.collection("jogos").limit(64))]) : [null, null];
    const atuais = calcularTrofeusTimes(id, c.exists ? c.data()! : null, (ins?.docs.map(d => d.data()) ?? []) as InscricaoCT[],
      Object.fromEntries(jogos?.docs.map(d => [d.id, d.data()]) ?? []) as Record<string, JogoCT>);
    const timeAtual = tituloDoTime(c.data(), (ins?.docs.map(d => d.data()) ?? []) as InscricaoCT[], atuais);
    const timeIds = [...new Set([...(Array.isArray(l.data()?.timeIds) ? l.data()!.timeIds.filter((s: unknown) => typeof s === "string" && ID_TIME_CT.test(s)) as string[] : []), ...(timeAtual ? [timeAtual.timeId] : [])])];
    const assinatura = createHash("sha256").update(JSON.stringify({ versao: VERSAO_CONTROLE, usuarios: [...atuais].sort(([a], [b]) => a.localeCompare(b)), time: timeAtual })).digest("hex");
    if (l.data()?.concluido === true && l.data()?.assinatura === assinatura) {
      // Resultado igual ao já concluído: só registra a revisão e o formato (uma vez), para as próximas entregas pararem antes das consultas.
      if (l.data()?.versao !== VERSAO_CONTROLE || l.data()?.revisaoFonte !== revisao(c)) tx.set(ledger, { revisaoFonte: revisao(c), versao: VERSAO_CONTROLE }, { merge: true });
      return null;
    }
    const envolvidos = [...new Set([...uidsDe(l.data()?.uids), ...atuais.keys()])];
    if (!envolvidos.length && !timeIds.length && !l.exists) return null;
    const fonte = revisao(c);
    const mesmoPlano = l.data()?.assinatura === assinatura && l.data()?.revisaoFonte === fonte && Array.isArray(l.data()?.pendentes);
    const pendentes = mesmoPlano ? uidsDe(l.data()?.pendentes) : envolvidos;
    // As falhas registradas valem enquanto o plano for o mesmo (acompanhamento das tentativas); plano novo começa limpo.
    const falhas = mesmoPlano && l.data()?.falhas && typeof l.data()?.falhas === "object" ? l.data()!.falhas : {};
    tx.set(ledger, { assinatura, revisaoFonte: fonte, timeIds, uids: envolvidos, pendentes, falhas, concluido: false, atualizadoEm: FieldValue.serverTimestamp() });
    return { atuais, timeAtual, timeIds, envolvidos: pendentes, assinatura, revisao: fonte };
  });
  if (!plano) return { gravados: 0, removidos: 0 };
  let gravados = 0, removidos = 0, indice = 0;
  const mudou = () => new Error("Premiação mudou: reconciliar estado atual");
  const conferir = (c: DocumentSnapshot, l: DocumentSnapshot) => {
    if (revisao(c) !== plano.revisao || l.data()?.assinatura !== plano.assinatura) throw mudou();
  };
  const falhasTimes: string[] = [];
  // Até dois times (campeão anterior e atual), na mesma revisão usada pelos atletas.
  // Uma falha da galeria do time não impede a premiação dos jogadores.
  for (const timeId of plano.timeIds) {
    const timeRef = db.doc(`times/${timeId}`), galeria = timeRef.collection(COLECAO_TITULOS_TIME).doc(id);
    try {
      const acao = await db.runTransaction(async tx => {
        const [c, l, time, g] = await tx.getAll(ref, ledger, timeRef, galeria); conferir(c, l);
        const novo = plano.timeAtual?.timeId === timeId ? plano.timeAtual : null;
        if (!time.exists) return "nenhuma";
        const atual = g.data();
        if (novo && mesmaGeracaoDoTime(time.data()!, novo)) {
          const valor = { ...novo.dados, timeLinkId: time.data()!.linkId, timeCriadoEm: milissegundosTime(time.data()!.criadoEm), conquistadoEm: atual && atual.timeLinkId === time.data()!.linkId && (atual.timeCriadoEm == null || atual.timeCriadoEm === milissegundosTime(time.data()!.criadoEm)) ? atual.conquistadoEm : novo.dados.conquistadoEm };
          if (atual && Object.entries(valor).every(([k, v]) => JSON.stringify(atual[k]) === JSON.stringify(v))) return "nenhuma";
          tx.set(galeria, valor); return "gravado";
        }
        if (g.exists) { tx.delete(galeria); return "removido"; }
        return "nenhuma";
      });
      if (acao === "gravado") gravados++; if (acao === "removido") removidos++;
    } catch (e) { if (e instanceof Error && e.message === mudou().message) throw e; falhasTimes.push(timeId); }
  }
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
  if (falhasTimes.length) throw new Error("Premiação parcial: galeria do time pendente; tentar novamente");
  await db.runTransaction(async tx => {
    const [c, l] = await tx.getAll(ref, ledger);
    conferir(c, l);
    if (!c.exists) tx.delete(ledger);
    else tx.set(ledger, { assinatura: plano.assinatura, revisaoFonte: plano.revisao, versao: VERSAO_CONTROLE, timeIds: plano.timeAtual ? [plano.timeAtual.timeId] : [], uids: [...plano.atuais.keys()], concluido: true, atualizadoEm: FieldValue.serverTimestamp() });
  });
  return { gravados, removidos };
}
