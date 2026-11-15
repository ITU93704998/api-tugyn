import { completarFotosInscricoesCT } from "./campeonatosTimesFotos";
import { createHash } from "node:crypto";
import { FieldPath, type Firestore, type Transaction, type DocumentSnapshot } from "firebase-admin/firestore";
import { calcularTrofeusTimes } from "./campeonatosTimesTrofeus";
import { perfilDisponivel } from "./suspensao";
import { sortear } from "./campeonato/tabela";
import { localizacaoDoPerfil } from "./mapaUsuarios";
import {
  COLECAO_CT, ID_CT, ID_TIME_CT, ID_JOGO_CT, MAX_ATIVOS_CT, RecusaCT, exigirCT, objetoCT, textoCT, numeroCT,
  novoCT, elencoCT, fotoAtletaCT, gerarJogosCT, tabelaCT, registrarResultadoCT, resultadoEditavelCT, tentativaCT, type Dados, type InscricaoCT, type JogoCT,
} from "./campeonatosTimesDominio";

const raiz = (db: Firestore, id: string) => db.doc(`${COLECAO_CT}/${id}`);
const dados = (s: DocumentSnapshot): Dados => s.exists ? (s.data() ?? {}) : {};
const snapCT = (s: DocumentSnapshot): Dados => { exigirCT(s.exists, "Campeonato não encontrado.", 404); return dados(s); };
const controle = (db: Firestore, uid: string) => db.doc(`controleCampeonatosTimes/${uid}`);
const dono = (camp: Dados, uid: string) => exigirCT(camp.organizadorId === uid, "Somente o organizador pode fazer isso.", 403);
const ativa = (camp: Dados) => camp.status === "inscricoes" || camp.status === "em_andamento";
const podeInscrever = (camp: Dados, agora: number) => exigirCT(camp.status === "inscricoes" && Number(camp.inscricoesAte) > agora, "As inscrições deste campeonato estão fechadas.", 409);

/** DTO explícito: não expõe assinaturas de idempotência, controle de cotas ou dados privados do perfil. */
export function resumoCT(id: string, d: Dados): Dados {
  return Object.fromEntries(["nome", "descricao", "modalidade", "formato", "status", "organizadorId", "organizadorNome", "cityId", "cidade", "estado", "inscricoesAte", "dataInicio", "inscricaoCentavos", "maxTimes", "aprovados", "criadoEm", "atualizadoEm"].map((k) => [k, d[k] ?? null]).concat([["id", id]]));
}
export function detalheCT(id: string, d: Dados): Dados {
  const dto = resumoCT(id, d);
  dto.revisaoResultados = Number(d.premiacaoVersao ?? 0);
  for (const k of ["locais", "premiacao", "regrasTexto", "genero", "faixaEtaria", "minJogadores", "maxJogadores", "patrocinadores", "campeaoTimeId", "motivoCancelamento", "grupos"]) dto[k] = d[k] ?? null;
  return dto;
}

export async function gruposLiberadosCT(db: Firestore, uid: string): Promise<boolean> {
  // Liberação administrativa para homologação. O checkout por campeonato será integrado depois; o cliente nunca concede.
  const s = await db.doc(`liberacoesCampeonatosTimes/${uid}`).get();
  const d = dados(s);
  return d.gruposMata === true && (d.expiraEm == null || (typeof d.expiraEm === "number" && d.expiraEm > Date.now()));
}

async function autorUsuario(tx: Transaction, db: Firestore, uid: string): Promise<Dados> {
  const p = dados(await tx.get(db.doc(`users/${uid}`)));
  exigirCT(perfilDisponivel(Object.keys(p).length ? p : null), "Seu perfil não está disponível para esta ação.", 403);
  return p;
}
function campoId(body: Dados): string { exigirCT(typeof body.campeonatoId === "string" && ID_CT.test(body.campeonatoId), "Campeonato inválido."); return body.campeonatoId; }
function timeId(body: Dados): string { exigirCT(typeof body.timeId === "string" && ID_TIME_CT.test(body.timeId), "Time inválido."); return body.timeId; }

export async function listarCT(db: Firestore, uid: string, body: Dados): Promise<Dados> {
  exigirCT(body.filtro === "meus" || body.filtro === "abertos", "Filtro inválido.");
  let q = db.collection(COLECAO_CT).where(body.filtro === "meus" ? "envolvidos" : "status", body.filtro === "meus" ? "array-contains" : "==", body.filtro === "meus" ? uid : "inscricoes");
  // Região do catálogo: `escopo` "cidade" (a cidade do perfil) ou "estado" (todas as cidades do estado do perfil). A cidade e o
  // estado vêm do perfil de quem pede, lido aqui (nunca do cliente). Sem localização no perfil: lista vazia, com o aviso.
  let local: { cidade: string; uf: string } | null = null;
  if (body.filtro === "abertos" && body.escopo !== undefined) {
    exigirCT(body.escopo === "cidade" || body.escopo === "estado", "Região inválida.");
    const loc = localizacaoDoPerfil(dados(await db.doc(`users/${uid}`).get()));
    if (!loc || (body.escopo === "cidade" && !loc.id)) return { campeonatos: [], proximoCursor: null, local: loc ? { cidade: loc.cidade, uf: loc.uf } : null, semLocalizacao: true };
    local = { cidade: loc.cidade, uf: loc.uf };
    q = body.escopo === "cidade" ? q.where("cityId", "==", loc.id) : q.where("estado", "==", loc.uf);
  }
  if (body.filtro === "abertos") {
    if (body.modalidade) { exigirCT(["campo", "society", "futsal"].includes(String(body.modalidade)), "Modalidade inválida."); q = q.where("modalidade", "==", body.modalidade); }
    if (body.cityId && body.escopo === undefined) { exigirCT(typeof body.cityId === "string" && /^[a-z0-9_]{1,100}$/.test(body.cityId), "Cidade inválida."); q = q.where("cityId", "==", body.cityId); }
  }
  const campoOrdem = body.filtro === "abertos" ? "inscricoesAte" : "criadoEm";
  const sentido = body.filtro === "abertos" ? "asc" : "desc";
  if (body.filtro === "abertos") q = q.where("inscricoesAte", ">", Date.now());
  q = q.orderBy(campoOrdem, sentido).orderBy(FieldPath.documentId(), sentido);
  if (body.cursor) {
    exigirCT(typeof body.cursor === "string" && body.cursor.length <= 240, "Página inválida.");
    let c: unknown; try { c = JSON.parse(Buffer.from(body.cursor, "base64url").toString("utf8")); } catch { throw new RecusaCT(400, "Página inválida."); }
    exigirCT(Array.isArray(c) && c.length === 2 && typeof c[0] === "number" && Number.isSafeInteger(c[0]) && c[0] > 0 && typeof c[1] === "string" && ID_CT.test(c[1]), "Página inválida.");
    q = q.startAfter(c[0], c[1]);
  }
  const s = await q.limit(21).get();
  const pagina = s.docs.slice(0, 20), ultimo = pagina.at(-1);
  return { campeonatos: pagina.map((s) => resumoCT(s.id, s.data())), proximoCursor: s.docs.length > 20 && ultimo ? Buffer.from(JSON.stringify([ultimo.get(campoOrdem), ultimo.id])).toString("base64url") : null, ...(local ? { local } : {}) };
}

export async function lerDetalheCT(db: Firestore, uid: string, body: Dados): Promise<Dados> {
  const id = campoId(body), ref = raiz(db, id);
  // Mesmo instante de leitura para metadados, elencos e tabela; não mistura fases durante início/resultado concorrente.
  const ler = () => db.runTransaction(async (tx) => {
  const camp = snapCT(await tx.get(ref));
  const organizador = camp.organizadorId === uid;
  const [insc, minhas, js] = await Promise.all([
    tx.get((organizador ? ref.collection("inscricoes") : ref.collection("inscricoes").where("status", "==", "aprovada")).limit(129)),
    organizador ? Promise.resolve(null) : tx.get(ref.collection("inscricoes").where("donoId", "==", uid).limit(128)),
    tx.get(ref.collection("jogos").orderBy("ordem").limit(64)),
  ]);
  const inscricoes = [...new Map([...insc.docs, ...(minhas?.docs ?? [])].map((s) => [s.id, { ...s.data(), timeId: s.id } as unknown as InscricaoCT])).values()];
  const jogos = Object.fromEntries(js.docs.map((s) => [s.id, { ...s.data(), id: s.id } as JogoCT]));
  const aprovadas = inscricoes.filter((i) => i.status === "aprovada");
  const antigas = inscricoes.filter(i => i.jogadores.some(j => !Object.prototype.hasOwnProperty.call(j, "foto"))).map(i => i.timeId);
  const comFotos = inscricoes.map(i => ({ ...i, jogadores: i.jogadores.map(j => ({ ...j, foto: fotoAtletaCT(j.foto) })) }));
  const visiveis = comFotos.map(({ tentativaId: _interno, tentativasTotal: _total, ...i }) => ({ ...i, pago: organizador || i.donoId === uid ? i.pago : false, motivo: organizador || i.donoId === uid ? i.motivo : null }));
  return { antigas, detalhe: { campeonato: detalheCT(id, camp), inscricoes: visiveis, jogos: Object.values(jogos).map((j) => ({ ...j, versao: Number(j.versao ?? 0), podeEditarResultado: organizador && (camp.status === "em_andamento" || camp.status === "encerrado") && Boolean(j.casa && j.fora) && resultadoEditavelCT(j, jogos) })),
    classificacao: Object.keys(jogos).length ? tabelaCT(aprovadas, jogos, (camp.ordem ?? []) as string[], objetoCT(camp.grupos) as Record<string, string[]>) : [] } };
  }, { readOnly: true });
  const primeira = await ler();
  if (!primeira.antigas.length) return primeira.detalhe;
  // A migração não bloqueia nem modifica o snapshot de jogos: transação separada só das fotos.
  await completarFotosInscricoesCT(db, id, primeira.antigas);
  // Relê mesmo se outro pedido já recuperou tudo, mantendo o DTO coerente e atual.
  return (await ler()).detalhe;
}

export async function criarCT(db: Firestore, uid: string, body: Dados, gruposLiberado: boolean, agora = Date.now()): Promise<Dados> {
  exigirCT(typeof body.chavePedido === "string" && /^[A-Za-z0-9_-]{12,100}$/.test(body.chavePedido), "Identificador do pedido inválido.");
  const id = `ct_${createHash("sha256").update(`${uid}:${body.chavePedido}`).digest("hex").slice(0, 24)}`;
  const ref = raiz(db, id), limite = controle(db, uid);
  return db.runTransaction(async (tx) => {
    const perfil = await autorUsuario(tx, db, uid);
    const [existente, cota] = await tx.getAll(ref, limite);
    // Um retry de criação já confirmada deve funcionar mesmo depois do prazo ou da liberação expirar.
    const novo = novoCT(body, existente.exists ? Number(existente.get("criadoEm")) : agora, existente.exists || gruposLiberado);
    const assinatura = createHash("sha256").update(JSON.stringify(novo)).digest("hex");
    if (existente.exists) {
      exigirCT(existente.get("pedidoHash") === assinatura, "Este pedido já foi usado com outros dados.", 409);
      return { campeonatoId: id, campeonato: detalheCT(id, dados(existente)) };
    }
    if (novo.formato === "grupos_mata") {
      const liberacao = await tx.get(db.doc(`liberacoesCampeonatosTimes/${uid}`));
      exigirCT(liberacao.get("gruposMata") === true && (liberacao.get("expiraEm") == null || Number(liberacao.get("expiraEm")) > agora), "A liberação deste formato expirou.", 403);
    }
    const cidade = localizacaoDoPerfil(perfil);
    exigirCT(cidade?.id && cidade.cidade, "Complete a cidade no seu perfil antes de criar o campeonato.", 409);
    const ativos = Number(cota.get("ativos") ?? 0);
    exigirCT(ativos < MAX_ATIVOS_CT, `Você pode organizar até ${MAX_ATIVOS_CT} campeonatos em andamento.`, 409);
    const camp = { ...novo, organizadorId: uid, organizadorNome: textoCT(perfil.name ?? perfil.displayName, 100, "Organizador") || "Organizador",
      cityId: cidade.id, cidade: cidade.cidade, estado: cidade.uf, status: "inscricoes", aprovados: 0, pendentes: 0, pedidosTotal: 0,
      envolvidos: [uid], ordem: [], grupos: {}, patrocinadores: [], campeaoTimeId: null, criadoEm: agora, atualizadoEm: agora, pedidoHash: assinatura };
    tx.create(ref, camp);
    tx.set(limite, { ativos: ativos + 1 });
    return { campeonatoId: id, campeonato: detalheCT(id, camp) };
  });
}

export async function inscreverCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), tid = timeId(body), ref = raiz(db, id), ir = ref.collection("inscricoes").doc(tid);
  const tentativaId = tentativaCT(body.tentativaId);
  exigirCT(Array.isArray(body.jogadorIds) && body.jogadorIds.length >= 1 && body.jogadorIds.length <= 30 && body.jogadorIds.every((id) => typeof id === "string"), "Seleção de jogadores inválida.");
  const assinatura = createHash("sha256").update(JSON.stringify([uid, tid, Array.isArray(body.jogadorIds) ? [...body.jogadorIds].sort() : body.jogadorIds])).digest("hex");
  const tentativaRef = tentativaId ? ir.collection("tentativas").doc(tentativaId) : null;
  await db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const [cs, ts, ins] = await tx.getAll(ref, db.doc(`times/${tid}`), ir);
    const camp = snapCT(cs);
    // O histórico reconhece T1 mesmo depois de T2: uma entrega fora de ordem nunca reaplica pedido antigo.
    const tentativa = tentativaRef ? await tx.get(tentativaRef) : null;
    if (tentativa?.exists && ins.get("donoId") === uid) {
      exigirCT(tentativa.get("assinatura") === assinatura, "Os dados desta tentativa mudaram. Abra um novo pedido.", 409);
      return;
    }
    const anteriores = dados(ins);
    const assinaturaAnterior = createHash("sha256").update(JSON.stringify([uid, tid, Array.isArray(anteriores.jogadores) ? (anteriores.jogadores as { id: string }[]).map((j) => j.id).sort() : []])).digest("hex");
    if (tentativaId && anteriores.tentativaId === tentativaId && anteriores.donoId === uid) {
      exigirCT(assinaturaAnterior === assinatura, "Os dados desta tentativa mudaram. Abra um novo pedido.", 409);
      tx.set(tentativaRef!, { assinatura, criadoEm: agora });
      return;
    }
    exigirCT(!ins.exists || tentativaId, "Atualize o aplicativo e abra uma nova tentativa de inscrição.", 409);
    exigirCT(Number(anteriores.tentativasTotal ?? 0) < 64, "O limite de reenvios desta inscrição foi atingido.", 409);
    podeInscrever(camp, agora);
    exigirCT(ts.exists, "Este time não existe mais.", 404);
    const time = dados(ts), jogadores = elencoCT(time, camp, uid, body.jogadorIds);
    const perfis = await tx.getAll(...jogadores.map((j) => db.doc(`users/${j.id}`)));
    exigirCT(perfis.every((s) => s.exists && perfilDisponivel(dados(s))), "Há uma conta indisponível no elenco escolhido.", 409);
    const anterior = dados(ins);
    exigirCT(anterior.status !== "aprovada", "Este time já está aprovado; o elenco inscrito está fechado.", 409);
    const pendente = anterior.status === "pendente";
    exigirCT(pendente || Number(camp.pendentes) < Number(camp.maxTimes) * 4, "Há muitos pedidos aguardando análise. Tente novamente depois.", 409);
    exigirCT(ins.exists || Number(camp.pedidosTotal) < 128, "O limite de pedidos deste campeonato foi atingido.", 409);
    const registro: InscricaoCT = { timeId: tid, donoId: uid, timeNome: textoCT(time.nome, 60, "Time", true),
      escudoUrl: typeof time.escudoUrl === "string" && time.escudoUrl.startsWith("https://") ? time.escudoUrl.slice(0, 800) : null,
      cor: typeof time.cor === "string" && /^#[a-f0-9]{6}$/i.test(time.cor) ? time.cor : null,
      jogadores: jogadores.map((j, k) => ({ ...j, foto: fotoAtletaCT(perfis[k].get("profileImage")) })), status: "pendente", pago: anterior.pago === true, motivo: null, criadoEm: Number(anterior.criadoEm ?? agora), atualizadoEm: agora, tentativaId, tentativasTotal: Number(anterior.tentativasTotal ?? 0) + 1 };
    const envolvidos = Array.isArray(camp.envolvidos) ? camp.envolvidos as string[] : [];
    if (tentativaRef) tx.create(tentativaRef, { assinatura, criadoEm: agora });
    // Compatibilidade com a primeira versão que só guardava o último ID: preserva-o antes de substituir.
    if (typeof anterior.tentativaId === "string" && anterior.tentativaId !== tentativaId) {
      tx.set(ir.collection("tentativas").doc(anterior.tentativaId), { assinatura: assinaturaAnterior, criadoEm: Number(anterior.criadoEm ?? agora) });
    }
    tx.set(ir, registro);
    tx.update(ref, { pendentes: Number(camp.pendentes) + (pendente ? 0 : 1), pedidosTotal: Number(camp.pedidosTotal) + (ins.exists ? 0 : 1), envolvidos: [...new Set([...envolvidos, uid, ...jogadores.map((j) => j.id)])], atualizadoEm: agora });
  });
}

export async function responderCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), tid = timeId(body), ref = raiz(db, id), ir = ref.collection("inscricoes").doc(tid);
  exigirCT(typeof body.aceitar === "boolean", "Resposta inválida.");
  const motivo = textoCT(body.motivo, 300, "Motivo");
  await db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const [cs, ins, ts] = await tx.getAll(ref, ir, db.doc(`times/${tid}`));
    const camp = snapCT(cs); dono(camp, uid); exigirCT(camp.status === "inscricoes", "As inscrições estão fechadas.", 409);
    exigirCT(ins.exists, "Pedido não encontrado.", 404);
    const i = dados(ins) as unknown as InscricaoCT;
    if (i.status === (body.aceitar ? "aprovada" : "recusada")) return;
    exigirCT(i.status === "pendente", "Este pedido já foi respondido.", 409);
    if (body.aceitar) {
      exigirCT(Number(camp.aprovados) < Number(camp.maxTimes), "As vagas do campeonato foram preenchidas.", 409);
      exigirCT(ts.exists, "Este time não existe mais.", 409);
      // Confere novamente o elenco: pode ter saído do time enquanto o pedido aguardava.
      const atuais = elencoCT(dados(ts), camp, i.donoId, i.jogadores.map((j) => j.id));
      const perfis = await tx.getAll(db.doc(`users/${i.donoId}`), ...atuais.map((a) => db.doc(`users/${a.id}`)));
      exigirCT(perfis.every((s) => s.exists && perfilDisponivel(dados(s))), "Há uma conta indisponível no elenco inscrito. Peça ao dono para revisar o pedido.", 409);
      const refs = atuais.map((a) => ref.collection("atletas").doc(a.id));
      const travas = await tx.getAll(...refs);
      exigirCT(travas.every((s) => !s.exists || s.get("timeId") === tid), "Um atleta já está inscrito por outro time neste campeonato.", 409);
      refs.forEach((r) => tx.set(r, { timeId: tid }));
      tx.update(ir, { status: "aprovada", jogadores: atuais.map((j, k) => ({ ...j, foto: fotoAtletaCT(perfis[k + 1].get("profileImage")) })), motivo: null, atualizadoEm: agora });
    } else tx.update(ir, { status: "recusada", motivo: motivo || null, atualizadoEm: agora });
    tx.update(ref, { aprovados: Number(camp.aprovados) + (body.aceitar ? 1 : 0), pendentes: Math.max(0, Number(camp.pendentes) - 1), atualizadoEm: agora });
  });
}

export async function cancelarInscricaoCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), tid = timeId(body), ref = raiz(db, id), ir = ref.collection("inscricoes").doc(tid);
  await db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const [cs, ins] = await tx.getAll(ref, ir);
    const camp = snapCT(cs); exigirCT(camp.status === "inscricoes", "O elenco já está fechado para este campeonato.", 409);
    exigirCT(ins.exists, "Inscrição não encontrada.", 404); const i = dados(ins) as unknown as InscricaoCT;
    exigirCT(uid === i.donoId || uid === camp.organizadorId, "Você não pode cancelar esta inscrição.", 403);
    if (i.status === "cancelada") return;
    const refs = i.status === "aprovada" ? i.jogadores.map((a) => ref.collection("atletas").doc(a.id)) : [];
    const travas = refs.length ? await tx.getAll(...refs) : [];
    travas.forEach((s, k) => { if (s.get("timeId") === tid) tx.delete(refs[k]); });
    tx.update(ir, { status: "cancelada", atualizadoEm: agora });
    tx.update(ref, { aprovados: Number(camp.aprovados) - (i.status === "aprovada" ? 1 : 0), pendentes: Number(camp.pendentes) - (i.status === "pendente" ? 1 : 0), atualizadoEm: agora });
  });
}

export async function iniciarCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), ref = raiz(db, id);
  await db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref)); dono(camp, uid);
    if (camp.status === "em_andamento") return;
    exigirCT(camp.status === "inscricoes", "Este campeonato não pode ser iniciado.", 409);
    const ins = await tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17));
    exigirCT(ins.size === Number(camp.maxTimes), `São necessários ${camp.maxTimes} times aprovados para iniciar.`, 409);
    const inscricoes = ins.docs.map((s) => s.data() as InscricaoCT);
    const times = await tx.getAll(...inscricoes.map((i) => db.doc(`times/${i.timeId}`)));
    const uids = [...new Set(inscricoes.flatMap((i) => [i.donoId, ...i.jogadores.map((j) => j.id)]))];
    const perfis = await tx.getAll(...uids.map((u) => db.doc(`users/${u}`)));
    exigirCT(perfis.every((s) => s.exists && perfilDisponivel(dados(s))), "Há uma conta indisponível nos elencos. Revise as inscrições antes de iniciar.", 409);
    times.forEach((s, k) => { exigirCT(s.exists, "Um time aprovado foi excluído. Remova a inscrição antes de iniciar.", 409); elencoCT(dados(s), camp, inscricoes[k].donoId, inscricoes[k].jogadores.map((j) => j.id)); });
    const ordem = sortear(inscricoes.map((i) => i.timeId));
    const gerados = gerarJogosCT(camp.formato as Parameters<typeof gerarJogosCT>[0], ordem);
    for (const [jid, jogo] of Object.entries(gerados.jogos)) tx.create(ref.collection("jogos").doc(jid), jogo);
    tx.update(ref, { status: "em_andamento", ordem, grupos: gerados.grupos, iniciadoEm: agora, atualizadoEm: agora });
  });
}

export async function resultadoCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), ref = raiz(db, id);
  exigirCT(typeof body.jogoId === "string" && ID_JOGO_CT.test(body.jogoId), "Jogo inválido.");
  const jid = body.jogoId;
  await db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref)); dono(camp, uid);
    exigirCT(camp.status === "em_andamento" || camp.status === "encerrado", "Este campeonato não recebe resultados.", 409);
    const [ins, js, ct] = await Promise.all([tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17)), tx.get(ref.collection("jogos").limit(64)), tx.get(controle(db, uid))]);
    const anteriores = Object.fromEntries(js.docs.map((s) => [s.id, { ...s.data(), id: s.id } as JogoCT]));
    let novo: ReturnType<typeof registrarResultadoCT>;
    try { novo = registrarResultadoCT(camp, ins.docs.map((s) => s.data() as InscricaoCT), anteriores, jid, body); }
    catch (e) { if (e instanceof RecusaCT) throw e; throw new RecusaCT(400, e instanceof Error ? e.message : "Resultado inválido."); }
    const alterados = Object.entries(novo.jogos).filter(([j, jogo]) => JSON.stringify(anteriores[j]) !== JSON.stringify(jogo));
    // Retry idêntico após a finalização não reabre nem altera a revisão.
    if (!alterados.length) return;
    for (const [j, jogo] of alterados) tx.set(ref.collection("jogos").doc(j), jogo);
    // Ter campeão calculado significa pronto para revisão, não autorização para premiar.
    const status = "em_andamento";
    if (camp.status === "encerrado") {
      const ativos = Number(ct.get("ativos") ?? 0) + 1;
      exigirCT(ativos <= MAX_ATIVOS_CT, "Encerre outro campeonato antes de reabrir este.", 409);
      tx.set(controle(db, uid), { ativos: Math.max(0, ativos) });
    }
    tx.update(ref, { status, campeaoTimeId: novo.campeaoTimeId, atualizadoEm: agora, finalizadoEm: null, premiacaoVersao: Number(camp.premiacaoVersao ?? 0) + 1 });
  });
}

/** Finaliza explicitamente sobre a revisão que o organizador conferiu. A mesma transação
 * valida o estado atual e libera a cota uma única vez; o gatilho durável distribui os títulos. */
export async function finalizarCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), ref = raiz(db, id);
  await db.runTransaction(async tx => {
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref)); dono(camp, uid);
    exigirCT(typeof body.revisaoEsperada === "number" && Number.isSafeInteger(body.revisaoEsperada) && body.revisaoEsperada >= 0, "Revise os resultados antes de finalizar.");
    if (body.revisaoEsperada !== Number(camp.premiacaoVersao ?? 0)) throw new RecusaCT(409, "Os resultados mudaram. Confira o campeonato antes de finalizar.", "campeonato_desatualizado");
    if (camp.status === "encerrado") return; // resposta perdida: não duplica cota nem prêmios
    exigirCT(camp.status === "em_andamento", "Somente um campeonato em andamento pode ser finalizado.", 409);
    const [ins, js, cota] = await Promise.all([
      tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17)),
      tx.get(ref.collection("jogos").limit(64)), tx.get(controle(db, uid)),
    ]);
    exigirCT(js.docs.length > 0 && js.docs.every(j => j.get("status") === "finalizado"), "Conclua todos os jogos antes de finalizar o campeonato.", 409);
    const inscricoes = ins.docs.map(s => s.data() as InscricaoCT);
    const jogos = Object.fromEntries(js.docs.map(s => [s.id, { ...s.data(), id: s.id } as JogoCT]));
    // Recalcula campeão e confere placares/estatísticas; nenhum vencedor vem do cliente.
    exigirCT(calcularTrofeusTimes(id, { ...camp, status: "encerrado" }, inscricoes, jogos).size > 0, "Não foi possível validar o campeão e os resultados. Confira os jogos antes de finalizar.", 409);
    tx.update(ref, { status: "encerrado", finalizadoEm: agora, atualizadoEm: agora });
    tx.set(controle(db, uid), { ativos: Math.max(0, Number(cota.get("ativos") ?? 0) - 1) });
  });
}

export async function administrarCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<void> {
  const id = campoId(body), ref = raiz(db, id), acao = body.acao;
  await db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref)); dono(camp, uid);
    if (acao === "cancelar") {
      const motivo = textoCT(body.motivo, 500, "Motivo do cancelamento", true);
      if (camp.status === "cancelado") return;
      exigirCT(camp.status !== "encerrado", "Um campeonato encerrado não pode ser cancelado.", 409);
      const cota = await tx.get(controle(db, uid));
      tx.update(ref, { status: "cancelado", motivoCancelamento: motivo, atualizadoEm: agora });
      tx.set(controle(db, uid), { ativos: Math.max(0, Number(cota.get("ativos") ?? 0) - 1) });
    } else if (acao === "marcarPagamento") {
      const tid = timeId(body); exigirCT(typeof body.pago === "boolean", "Pagamento inválido.");
      const ir = ref.collection("inscricoes").doc(tid), i = await tx.get(ir);
      exigirCT(i.exists && i.get("status") === "aprovada", "A inscrição precisa estar aprovada.", 409);
      tx.update(ir, { pago: body.pago, atualizadoEm: agora });
    } else if (acao === "agendarJogo") {
      exigirCT(camp.status === "em_andamento", "Só é possível agendar jogos em andamento.", 409);
      exigirCT(typeof body.jogoId === "string" && ID_JOGO_CT.test(body.jogoId), "Jogo inválido.");
      const jr = ref.collection("jogos").doc(body.jogoId), jogo = await tx.get(jr);
      exigirCT(jogo.exists && jogo.get("status") !== "finalizado", "Jogo não disponível para agendamento.", 409);
      const quando = body.quando == null ? null : numeroCT(body.quando, agora - 86_400_000, agora + 365 * 86_400_000, "Data do jogo");
      const local = textoCT(body.local, 80, "Local");
      exigirCT(!local || (camp.locais as { nome: string }[]).some((l) => l.nome === local), "Escolha um dos locais cadastrados no campeonato.");
      tx.update(jr, { quando, local: local || null });
    } else throw new RecusaCT(400, "Ação administrativa inválida.");
    tx.update(ref, { atualizadoEm: agora });
  });
}

export const idDoCT = campoId;
export { ativa as campeonatoAtivoCT };
