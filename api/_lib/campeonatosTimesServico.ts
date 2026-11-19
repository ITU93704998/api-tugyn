import { ID_MODELO_TROFEU, MAX_MODELOS_TROFEU, modelosGravados, nomeDoModelo, normalizarDesenhoTrofeu } from "./desenhoTrofeu";
import { completarFotosInscricoesCT } from "./campeonatosTimesFotos";
import { createHash, randomBytes } from "node:crypto";
import { FieldPath, type Firestore, type Transaction, type DocumentSnapshot, type QuerySnapshot, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { calcularTrofeusTimes } from "./campeonatosTimesTrofeus";
import { perfilDisponivel } from "./suspensao";
import { sortear } from "./campeonato/tabela";
import { localizacaoDoPerfil } from "./mapaUsuarios";
import { milissegundosTime } from "./galeriaTimes";
import {
  COLECAO_CT, ID_CT, ID_TIME_CT, ID_JOGO_CT, MAX_ATIVOS_CT, RecusaCT, exigirCT, objetoCT, textoCT, numeroCT,
  novoCT, ordemManualCT, elencoCT, treinadorCT, fotoAtletaCT, requisitosDoCT, mensagemRequisitosCT, ID_PESSOA_CT, gerarJogosCT, tabelaCT, registrarResultadoCT, resultadoEditavelCT, tentativaCT, type Dados, type InscricaoCT, type JogoCT,
  whatsappCT, podeLancarCT, mesariosDoCT, suspensoesCT, MAX_MESARIOS_CT, mesarioPodeCorrigirCT, prazoCorrecaoMesarioCT, motivoCorrecaoCT, comCorrecaoCT,
} from "./campeonatosTimesDominio";
import { temResultado } from "./campeonato/classificacao";
import { amistososDoAtleta, campeonatosTurmaDoAtleta, timeDoDocumento, type TimeDoAtleta } from "./cardsAtleta";
import { PREMIUM_CT, lerDevolucaoPremiumCT, reservarPremiumCT } from "./campeonatosTimesPremium";
import { agendarAvisosCT, avisoCT, dispararAvisosCT, reaisCT, textosCT, timeTodo } from "./campeonatosTimesAvisos";
import type { Aviso } from "./pushEnvio";

/** Nome comparável na busca: sem acento, minúsculo, espaços simples. */
export const normalizarBuscaCT = (v: unknown): string =>
  typeof v === "string" ? v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim() : "";

const raiz = (db: Firestore, id: string) => db.doc(`${COLECAO_CT}/${id}`);

// ── Vínculo exclusivo do atleta no campeonato ──
// Chave: campeonatosTimes/{campeonatoId}/atletas/{jogadorId} = { timeId, status: "pendente" | "aprovado", desde, atualizadoEm }.
// Reservado já no PEDIDO (pendente), sempre dentro da transação que grava a inscrição: duas inscrições simultâneas com o
// mesmo atleta disputam o mesmo documento e só uma conclui. Travas antigas (só { timeId }) valem como aprovadas.
// Liberação: pedido recusado, ou inscrição cancelada/removida ANTES do início. Saída do elenco geral não libera.
const trava = (ref: FirebaseFirestore.DocumentReference, jogadorId: string) => ref.collection("atletas").doc(jogadorId);
/** Histórico (rastreabilidade): uma entrada por operação, na mesma transação. */
const historicoAtletas = (tx: Transaction, ref: FirebaseFirestore.DocumentReference, registro: Dados) =>
  tx.set(ref.collection("historicoAtletas").doc(randomBytes(10).toString("hex")), registro);
/** Recusa citando os atletas que já representam outro time (nomes na mensagem, ids nos detalhes para a tela). */
function conflitoDeAtletas(atletas: { id: string; nome: string }[]): RecusaCT {
  const nomes = atletas.map((a) => a.nome);
  const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(", ")} e ${nomes.at(-1)}`;
  const msg = atletas.length === 1
    ? `O jogador ${lista} já está inscrito neste campeonato por outro time. Cada jogador pode representar apenas um time por campeonato. Remova-o da lista de inscritos para continuar.`
    : `Os jogadores ${lista} já estão inscritos neste campeonato por outro time. Cada jogador pode representar apenas um time por campeonato. Remova-os da lista de inscritos para continuar.`;
  return new RecusaCT(409, msg, "atleta_em_outro_time", { conflitos: atletas.map((a) => a.id) });
}
const dados = (s: DocumentSnapshot): Dados => s.exists ? (s.data() ?? {}) : {};
const snapCT = (s: DocumentSnapshot): Dados => { exigirCT(s.exists, "Campeonato não encontrado.", 404); return dados(s); };
const controle = (db: Firestore, uid: string) => db.doc(`controleCampeonatosTimes/${uid}`);
const dono = (camp: Dados, uid: string) => exigirCT(camp.organizadorId === uid, "Somente o organizador pode fazer isso.", 403);
/** Organizador ou mesário (lançar placar e marcar jogo). */
const lancador = (camp: Dados, uid: string) => exigirCT(podeLancarCT(camp, uid), "Somente o organizador ou um mesário pode fazer isso.", 403);
const ativa = (camp: Dados) => camp.status === "inscricoes" || camp.status === "em_andamento";
const podeInscrever = (camp: Dados, agora: number) => exigirCT(camp.status === "inscricoes" && Number(camp.inscricoesAte) > agora, "As inscrições deste campeonato estão fechadas.", 409);

/** DTO explícito: não expõe assinaturas de idempotência, controle de cotas ou dados privados do perfil. */
export function resumoCT(id: string, d: Dados): Dados {
  return Object.fromEntries(["nome", "descricao", "modalidade", "formato", "status", "organizadorId", "organizadorNome", "cityId", "cidade", "estado", "inscricoesAte", "dataInicio", "inscricaoCentavos", "maxTimes", "aprovados", "criadoEm", "atualizadoEm"].map((k) => [k, d[k] ?? null]).concat([["id", id]]));
}
/** Papel de quem pede em "Meus campeonatos": organiza, é mesário ou joga (dono ou atleta de um time). Pedidos em análise só para quem organiza. */
export function papelCT(d: Dados, uid: string): Dados {
  if (d.organizadorId === uid) return { papel: "organizador", pendentes: Math.max(0, Number(d.pendentes ?? 0) || 0) };
  const mesario = Array.isArray(d.mesarios) && (d.mesarios as { uid?: unknown }[]).some((m) => m?.uid === uid);
  return { papel: mesario ? "mesario" : "jogador" };
}
export function detalheCT(id: string, d: Dados): Dados {
  const dto = resumoCT(id, d);
  dto.revisaoResultados = Number(d.premiacaoVersao ?? 0);
  // Versão dos dados editáveis (sobre, regulamento, inscrição, premiação, datas): o formulário de edição a devolve.
  dto.infoVersao = Number(d.infoVersao ?? 0) || 0;
  for (const k of ["locais", "premiacao", "regrasTexto", "genero", "faixaEtaria", "minJogadores", "maxJogadores", "requisitos", "patrocinadores", "campeaoTimeId", "motivoCancelamento", "grupos", "trofeuDesenho", "regulamentoPdf"]) dto[k] = d[k] ?? null;
  dto.sorteio = d.sorteio === "manual" ? "manual" : "automatico";
  dto.mesarios = mesariosDoCT(d);
  return dto;
}

/** Grupos + mata-mata sem gastar crédito: liberado para todos (fase de testes, `PREMIUM_CT`) ou liberação da conta. */
export async function gruposLiberadosCT(db: Firestore, uid: string): Promise<boolean> {
  if (PREMIUM_CT.gruposParaTodos) return true;
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
  // Campeonatos de TESTE gravados na produção (`testeTugyn: true`, script de teste) só aparecem no catálogo para contas
  // marcadas como testadoras (`testadorTugyn: true` no perfil, gravado pelo mesmo script). "Meus" já é só de quem participa.
  let testador = false;
  if (body.filtro === "abertos" && body.escopo !== undefined) {
    exigirCT(body.escopo === "cidade" || body.escopo === "estado", "Região inválida.");
    const perfil = dados(await db.doc(`users/${uid}`).get());
    testador = perfil.testadorTugyn === true;
    const loc = localizacaoDoPerfil(perfil);
    if (!loc || (body.escopo === "cidade" && !loc.id)) return { campeonatos: [], proximoCursor: null, local: loc ? { cidade: loc.cidade, uf: loc.uf } : null, semLocalizacao: true };
    local = { cidade: loc.cidade, uf: loc.uf };
    q = body.escopo === "cidade" ? q.where("cityId", "==", loc.id) : q.where("estado", "==", loc.uf);
  }
  else if (body.filtro === "abertos") testador = dados(await db.doc(`users/${uid}`).get()).testadorTugyn === true;
  if (body.filtro === "abertos") {
    if (body.modalidade) { exigirCT(["campo", "society", "futsal"].includes(String(body.modalidade)), "Modalidade inválida."); q = q.where("modalidade", "==", body.modalidade); }
    if (body.cityId && body.escopo === undefined) { exigirCT(typeof body.cityId === "string" && /^[a-z0-9_]{1,100}$/.test(body.cityId), "Cidade inválida."); q = q.where("cityId", "==", body.cityId); }
  }
  const campoOrdem = body.filtro === "abertos" ? "inscricoesAte" : "criadoEm";
  const sentido = body.filtro === "abertos" ? "asc" : "desc";
  if (body.filtro === "abertos") q = q.where("inscricoesAte", ">", Date.now());
  q = q.orderBy(campoOrdem, sentido).orderBy(FieldPath.documentId(), sentido);
  const busca = normalizarBuscaCT(body.busca);
  if (body.busca != null && body.busca !== "") exigirCT(busca.length >= 2 && busca.length <= 40, "Digite de 2 a 40 letras para buscar.");
  if (body.cursor) {
    exigirCT(typeof body.cursor === "string" && body.cursor.length <= 240, "Página inválida.");
    let c: unknown; try { c = JSON.parse(Buffer.from(body.cursor, "base64url").toString("utf8")); } catch { throw new RecusaCT(400, "Página inválida."); }
    exigirCT(Array.isArray(c) && c.length === 2 && typeof c[0] === "number" && Number.isSafeInteger(c[0]) && c[0] > 0 && typeof c[1] === "string" && ID_CT.test(c[1]), "Página inválida.");
    q = q.startAfter(c[0], c[1]);
  }
  const resumo = (s: QueryDocumentSnapshot) => body.filtro === "meus" ? { ...resumoCT(s.id, s.data()), ...papelCT(s.data(), uid) } : resumoCT(s.id, s.data());
  const cursorDe = (d: QueryDocumentSnapshot) => Buffer.from(JSON.stringify([d.get(campoOrdem), d.id])).toString("base64url");
  // Busca por nome: sem índice de texto no Firestore, cada página olha até 100 campeonatos da mesma consulta (na ordem do
  // prazo) e devolve até 30 com o nome. O cursor continua de onde parou: nada fica de fora, só exige "ver mais".
  // `buscaLimitada`: a página acabou na janela de 100 (pode haver mais adiante).
  if (busca) {
    const s = await q.limit(100).get();
    const achados = s.docs.filter((d) => (testador || d.get("testeTugyn") !== true) && normalizarBuscaCT(d.get("nome")).includes(busca));
    const corte = achados.length > 30 ? achados[29] : s.size >= 100 ? s.docs[s.docs.length - 1] : null;
    return { campeonatos: achados.slice(0, 30).map(resumo), proximoCursor: corte ? cursorDe(corte) : null, buscaLimitada: Boolean(corte) && achados.length <= 30, ...(local ? { local } : {}) };
  }
  const s = await q.limit(21).get();
  const pagina = s.docs.slice(0, 20), ultimo = pagina.at(-1);
  const visiveis = body.filtro === "abertos" && !testador ? pagina.filter((s) => s.get("testeTugyn") !== true) : pagina;
  return { campeonatos: visiveis.map(resumo), proximoCursor: s.docs.length > 20 && ultimo ? Buffer.from(JSON.stringify([ultimo.get(campoOrdem), ultimo.id])).toString("base64url") : null, ...(local ? { local } : {}) };
}

export async function lerDetalheCT(db: Firestore, uid: string, body: Dados): Promise<Dados> {
  const id = campoId(body), ref = raiz(db, id);
  // Mesmo instante de leitura para metadados, elencos e tabela; não mistura fases durante início/resultado concorrente.
  const ler = () => db.runTransaction(async (tx) => {
  const camp = snapCT(await tx.get(ref));
  const organizador = camp.organizadorId === uid, lanca = podeLancarCT(camp, uid), agoraDetalhe = Date.now();
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
  // Pagamento e contato: o WhatsApp do dono só para o organizador (e o próprio dono), e só com o campeonato ativo; o aviso
  // "Já paguei" para o organizador e o dono. "Como pagar" e o WhatsApp da organização: organizador e dono/técnico de time APROVADO.
  const ativo = ativa(camp);
  const visiveis = comFotos.map(({ tentativaId: _interno, tentativasTotal: _total, timeLinkId: _identidadeTime, timeCriadoEm: _criacaoTime, whatsappDono, pagamentoAvisadoEm, ...i }) => ({ ...i, pago: organizador || i.donoId === uid ? i.pago : false, motivo: organizador || i.donoId === uid ? i.motivo : null,
    whatsappDono: ativo && (organizador || i.donoId === uid) && (i.status === "aprovada" || i.status === "pendente") ? whatsappDono ?? null : null,
    pagamentoAvisadoEm: organizador || i.donoId === uid ? pagamentoAvisadoEm ?? null : null }));
  const vePagamento = ativo && (organizador || aprovadas.some((i) => i.donoId === uid || i.treinador?.id === uid));
  const campeonatoDto = { ...detalheCT(id, camp), pagamentoTexto: vePagamento ? (camp.pagamentoTexto as string | undefined) ?? null : null, whatsappOrganizacao: vePagamento ? (camp.whatsappOrganizacao as string | undefined) ?? null : null };
  return { antigas, detalhe: { campeonato: campeonatoDto, inscricoes: visiveis, jogos: Object.values(jogos).map((j) => ({ ...j, correcoes: Array.isArray(j.correcoes) ? j.correcoes.map(({ por: _quem, ...k }) => k) : undefined, versao: Number(j.versao ?? 0), podeEditarResultado: (camp.status === "em_andamento" ? lanca && (organizador || mesarioPodeCorrigirCT(j, agoraDetalhe)) : organizador && camp.status === "encerrado") && Boolean(j.casa && j.fora) && resultadoEditavelCT(j, jogos), prazoCorrecaoAte: !organizador && lanca && camp.status === "em_andamento" && temResultado(j) ? prazoCorrecaoMesarioCT(j) : null })),
    classificacao: Object.keys(jogos).length ? tabelaCT(aprovadas, jogos, (camp.ordem ?? []) as string[], objetoCT(camp.grupos) as Record<string, string[]>) : [],
    // Suspensões automáticas (cartões), por jogo pendente: a tela mostra no cartão do jogo e no formulário do resultado.
    suspensoes: camp.status === "em_andamento" ? suspensoesCT(aprovadas, jogos) : [] } };
  }, { readOnly: true });
  const primeira = await ler();
  if (!primeira.antigas.length) return primeira.detalhe;
  // A migração não bloqueia nem modifica o snapshot de jogos: transação separada só das fotos.
  await completarFotosInscricoesCT(db, id, primeira.antigas);
  // Relê mesmo se outro pedido já recuperou tudo, mantendo o DTO coerente e atual.
  return (await ler()).detalhe;
}

/** `_gruposLiberado`: mantido por compatibilidade; quem decide é `reservarPremiumCT`, dentro da transação. */
export async function criarCT(db: Firestore, uid: string, body: Dados, _gruposLiberado: boolean, agora = Date.now()): Promise<Dados> {
  exigirCT(typeof body.chavePedido === "string" && /^[A-Za-z0-9_-]{12,100}$/.test(body.chavePedido), "Identificador do pedido inválido.");
  const id = `ct_${createHash("sha256").update(`${uid}:${body.chavePedido}`).digest("hex").slice(0, 24)}`;
  const ref = raiz(db, id), limite = controle(db, uid);
  return db.runTransaction(async (tx) => {
    const perfil = await autorUsuario(tx, db, uid);
    const [existente, cota] = await tx.getAll(ref, limite);
    // Um retry de criação já confirmada deve funcionar mesmo depois do prazo ou da liberação expirar.
    // O formato premium é conferido abaixo (liberado para todos, liberação da conta ou 1 crédito), na mesma transação.
    const novo = novoCT(body, existente.exists ? Number(existente.get("criadoEm")) : agora, true);
    const assinatura = createHash("sha256").update(JSON.stringify(novo)).digest("hex");
    if (existente.exists) {
      exigirCT(existente.get("pedidoHash") === assinatura, "Este pedido já foi usado com outros dados.", 409);
      return { campeonatoId: id, campeonato: detalheCT(id, dados(existente)) };
    }
    // Grupos + mata-mata: lê agora (antes das gravações) e grava o gasto do crédito junto com a criação.
    const premium = novo.formato === "grupos_mata" ? await reservarPremiumCT(tx, db, uid, id, agora) : null;
    const cidade = localizacaoDoPerfil(perfil);
    exigirCT(cidade?.id && cidade.cidade, "Complete a cidade no seu perfil antes de criar o campeonato.", 409);
    const ativos = Number(cota.get("ativos") ?? 0);
    exigirCT(ativos < MAX_ATIVOS_CT, `Você pode organizar até ${MAX_ATIVOS_CT} campeonatos em andamento.`, 409);
    const camp = { ...novo, organizadorId: uid, organizadorNome: textoCT(perfil.name ?? perfil.displayName, 100, "Organizador") || "Organizador",
      cityId: cidade.id, cidade: cidade.cidade, estado: cidade.uf, status: "inscricoes", aprovados: 0, pendentes: 0, pedidosTotal: 0,
      envolvidos: [uid], ordem: [], grupos: {}, patrocinadores: [], campeaoTimeId: null, criadoEm: agora, atualizadoEm: agora, pedidoHash: assinatura,
      ...(premium?.creditoId ? { creditoPremium: premium.creditoId } : {}) };
    tx.create(ref, camp);
    premium?.gravar();
    tx.set(limite, { ativos: ativos + 1 });
    return { campeonatoId: id, campeonato: detalheCT(id, camp) };
  });
}

export async function inscreverCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  let avisos: Aviso[] = [];
  const id = campoId(body), tid = timeId(body), ref = raiz(db, id), ir = ref.collection("inscricoes").doc(tid);
  const tentativaId = tentativaCT(body.tentativaId);
  // undefined (app antigo): mantém o número que já estava no pedido.
  const whatsappNovo = body.whatsapp === undefined ? undefined : whatsappCT(body.whatsapp, "Seu WhatsApp");
  exigirCT(Array.isArray(body.jogadorIds) && body.jogadorIds.length >= 1 && body.jogadorIds.length <= 30 && body.jogadorIds.every((id) => typeof id === "string"), "Seleção de jogadores inválida.");
  // O técnico entra na assinatura só quando existe: pedidos antigos (sem técnico) continuam com a mesma assinatura.
  const tecnicoPedido = typeof body.treinadorId === "string" && body.treinadorId ? body.treinadorId : null;
  const assinatura = createHash("sha256").update(JSON.stringify([uid, tid, Array.isArray(body.jogadorIds) ? [...body.jogadorIds].sort() : body.jogadorIds, ...(tecnicoPedido ? [tecnicoPedido] : [])])).digest("hex");
  const tentativaRef = tentativaId ? ir.collection("tentativas").doc(tentativaId) : null;
  await db.runTransaction(async (tx) => {
    avisos = [];
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
    const tecnicoAnterior = typeof objetoCT(anteriores.treinador).id === "string" ? objetoCT(anteriores.treinador).id as string : null;
    const assinaturaAnterior = createHash("sha256").update(JSON.stringify([uid, tid, Array.isArray(anteriores.jogadores) ? (anteriores.jogadores as { id: string }[]).map((j) => j.id).sort() : [], ...(tecnicoAnterior ? [tecnicoAnterior] : [])])).digest("hex");
    if (tentativaId && anteriores.tentativaId === tentativaId && anteriores.donoId === uid) {
      exigirCT(assinaturaAnterior === assinatura, "Os dados desta tentativa mudaram. Abra um novo pedido.", 409);
      tx.set(tentativaRef!, { assinatura, criadoEm: agora });
      return;
    }
    exigirCT(!ins.exists || tentativaId, "Atualize o aplicativo e abra uma nova tentativa de inscrição.", 409);
    exigirCT(Number(anteriores.tentativasTotal ?? 0) < 64, "O limite de reenvios desta inscrição foi atingido.", 409);
    podeInscrever(camp, agora);
    exigirCT(ts.exists, "Este time não existe mais.", 404);
    const time = dados(ts), jogadores = elencoCT(time, camp, uid, body.jogadorIds), treinador = treinadorCT(time, body.treinadorId);
    // O técnico que não joga também precisa ter a conta disponível (lido junto, depois dos atletas).
    const tecnicoAParte = treinador && !jogadores.some((j) => j.id === treinador.id) ? treinador.id : null;
    const perfis = await tx.getAll(...[...jogadores.map((j) => j.id), ...(tecnicoAParte ? [tecnicoAParte] : [])].map((p) => db.doc(`users/${p}`)));
    exigirCT(perfis.every((s) => s.exists && perfilDisponivel(dados(s))), "Há uma conta indisponível no elenco escolhido.", 409);
    const perfilTecnico = treinador ? perfis[tecnicoAParte ? jogadores.length : jogadores.findIndex((j) => j.id === treinador.id)] : null;
    const anterior = dados(ins);
    exigirCT(anterior.status !== "aprovada", "Este time já está aprovado; o elenco inscrito está fechado.", 409);
    const pendente = anterior.status === "pendente";
    exigirCT(pendente || Number(camp.pendentes) < Number(camp.maxTimes) * 4, "Há muitos pedidos aguardando análise. Tente novamente depois.", 409);
    exigirCT(ins.exists || Number(camp.pedidosTotal) < 128, "O limite de pedidos deste campeonato foi atingido.", 409);
    // Vínculos: lê as travas dos atletas novos e dos do pedido pendente anterior (que podem sair) antes de qualquer gravação.
    const novosIds = jogadores.map((j) => j.id);
    const anterioresIds = pendente && Array.isArray(anterior.jogadores) ? (anterior.jogadores as { id: string }[]).map((j) => j.id) : [];
    const todosIds = [...new Set([...novosIds, ...anterioresIds])];
    const travas = new Map((await tx.getAll(...todosIds.map((j) => trava(ref, j)))).map((s, k) => [todosIds[k], s]));
    const emConflito = jogadores.filter((j) => { const s = travas.get(j.id)!; return s.exists && s.get("timeId") !== tid; });
    if (emConflito.length) throw conflitoDeAtletas(emConflito);
    // Ninguém treina um time e joga por outro no mesmo campeonato (o título e a taça ficariam com o time errado).
    // Técnico que não joga aqui: não pode estar reservado como atleta de outro time.
    if (treinador && !novosIds.includes(treinador.id)) {
      const t = await tx.get(trava(ref, treinador.id));
      exigirCT(!(t.exists && t.get("timeId") !== tid), `${treinador.nome} já está inscrito como atleta por outro time neste campeonato e não pode ser o técnico deste.`, 409);
    }
    // Atletas escolhidos: não podem ser o técnico de outro time com pedido pendente ou aprovado.
    const tecnicosFora = (await tx.get(ref.collection("inscricoes").where("treinador.id", "in", novosIds))).docs
      .filter((s) => s.id !== tid && (s.get("status") === "pendente" || s.get("status") === "aprovada"));
    if (tecnicosFora.length) {
      const nomes = tecnicosFora.map((s) => (s.get("treinador") as InscricaoCT["treinador"])?.nome).filter(Boolean);
      throw new RecusaCT(409, `${nomes.join(", ")} já é técnico de outro time neste campeonato e não pode jogar por este.`, "tecnico_em_outro_time");
    }
    const liberados = anterioresIds.filter((j) => !novosIds.includes(j) && travas.get(j)?.get("timeId") === tid);
    const registro: InscricaoCT = { timeLinkId: typeof time.linkId === "string" ? time.linkId : null, timeCriadoEm: milissegundosTime(time.criadoEm) || null, timeId: tid, donoId: uid, timeNome: textoCT(time.nome, 60, "Time", true),
      escudoUrl: typeof time.escudoUrl === "string" && time.escudoUrl.startsWith("https://") ? time.escudoUrl.slice(0, 800) : null,
      cor: typeof time.cor === "string" && /^#[a-f0-9]{6}$/i.test(time.cor) ? time.cor : null,
      jogadores: jogadores.map((j, k) => ({ ...j, foto: fotoAtletaCT(perfis[k].get("profileImage")) })),
      treinador: treinador ? { ...treinador, foto: fotoAtletaCT(perfilTecnico?.get("profileImage")) ?? treinador.foto } : null, status: "pendente", pago: anterior.pago === true, motivo: null,
      whatsappDono: whatsappNovo === undefined ? (typeof anterior.whatsappDono === "string" ? anterior.whatsappDono : null) : whatsappNovo, pagamentoAvisadoEm: null, criadoEm: Number(anterior.criadoEm ?? agora), atualizadoEm: agora, tentativaId, tentativasTotal: Number(anterior.tentativasTotal ?? 0) + 1 };
    const envolvidos = Array.isArray(camp.envolvidos) ? camp.envolvidos as string[] : [];
    if (tentativaRef) tx.create(tentativaRef, { assinatura, criadoEm: agora });
    // Compatibilidade com a primeira versão que só guardava o último ID: preserva-o antes de substituir.
    if (typeof anterior.tentativaId === "string" && anterior.tentativaId !== tentativaId) {
      tx.set(ir.collection("tentativas").doc(anterior.tentativaId), { assinatura: assinaturaAnterior, criadoEm: Number(anterior.criadoEm ?? agora) });
    }
    tx.set(ir, registro);
    for (const j of novosIds) { const s = travas.get(j)!; tx.set(trava(ref, j), { timeId: tid, status: "pendente", desde: s.exists ? Number(s.get("desde") ?? agora) : agora, atualizadoEm: agora }); }
    for (const j of liberados) tx.delete(trava(ref, j));
    historicoAtletas(tx, ref, { acao: "reservou", timeId: tid, jogadorIds: novosIds, liberados, por: uid, em: agora });
    tx.update(ref, { pendentes: Number(camp.pendentes) + (pendente ? 0 : 1), pedidosTotal: Number(camp.pedidosTotal) + (ins.exists ? 0 : 1), envolvidos: [...new Set([...envolvidos, uid, ...jogadores.map((j) => j.id), ...(treinador ? [treinador.id] : [])])], atualizadoEm: agora });
    // Pedido novo (não o reenvio de um pendente): avisa o organizador.
    if (!pendente) avisos = agendarAvisosCT(tx, db, [avisoCT("pedido", id, `${tid}_${registro.tentativasTotal}`, [camp.organizadorId as string], ...textosCT.pedido(camp, registro.timeNome), uid)], agora);
  });
  return avisos;
}

export async function responderCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), tid = timeId(body), ref = raiz(db, id), ir = ref.collection("inscricoes").doc(tid);
  exigirCT(typeof body.aceitar === "boolean", "Resposta inválida.");
  const motivo = textoCT(body.motivo, 300, "Motivo");
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
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
      // O técnico também é conferido de novo: precisa continuar no elenco do time e com a conta disponível.
      const tecnicoId = i.treinador?.id || null;
      let tecnico: InscricaoCT["treinador"] = null;
      if (tecnicoId) {
        try { tecnico = treinadorCT(dados(ts), tecnicoId); } catch { throw new RecusaCT(409, "O técnico escolhido não faz mais parte do elenco do time. Peça ao dono para revisar o pedido."); }
      }
      const tecnicoAParte = tecnicoId && tecnicoId !== i.donoId && !atuais.some((a) => a.id === tecnicoId) ? tecnicoId : null;
      const perfis = await tx.getAll(db.doc(`users/${i.donoId}`), ...atuais.map((a) => db.doc(`users/${a.id}`)), ...(tecnicoAParte ? [db.doc(`users/${tecnicoAParte}`)] : []));
      exigirCT(perfis.every((s) => s.exists && perfilDisponivel(dados(s))), "Há uma conta indisponível no elenco inscrito (atletas ou técnico). Peça ao dono para revisar o pedido.", 409);
      const perfilTecnico = !tecnicoId ? null : tecnicoAParte ? perfis[perfis.length - 1] : tecnicoId === i.donoId ? perfis[0] : perfis[1 + atuais.findIndex((a) => a.id === tecnicoId)];
      const refs = atuais.map((a) => trava(ref, a.id));
      const travas = await tx.getAll(...refs);
      // Pedidos anteriores à reserva no pendente não têm trava: a aprovação reserva (o primeiro aprovado vence).
      const emConflito = atuais.filter((_, k) => travas[k].exists && travas[k].get("timeId") !== tid);
      if (emConflito.length) throw conflitoDeAtletas(emConflito);
      refs.forEach((r, k) => tx.set(r, { timeId: tid, status: "aprovado", desde: travas[k].exists ? Number(travas[k].get("desde") ?? agora) : agora, atualizadoEm: agora }));
      historicoAtletas(tx, ref, { acao: "aprovou", timeId: tid, jogadorIds: atuais.map((a) => a.id), por: uid, em: agora });
      tx.update(ir, { status: "aprovada", jogadores: atuais.map((j, k) => ({ ...j, foto: fotoAtletaCT(perfis[k + 1].get("profileImage")) })),
        ...(tecnico ? { treinador: { ...tecnico, foto: fotoAtletaCT(perfilTecnico?.get("profileImage")) ?? tecnico.foto } } : {}), motivo: null, atualizadoEm: agora });
      const vez = `${tid}_${Number(i.tentativasTotal ?? 0)}`;
      avisos = [avisoCT("aprovada", id, `dono_${vez}`, [i.donoId], ...textosCT.aprovadaDono(camp, i.timeNome), uid),
        // Atletas e o técnico (sem repetir o dono nem quem joga e também treina).
        avisoCT("aprovada", id, `atletas_${vez}`, [...new Set([...atuais.map((a) => a.id), ...(tecnicoId ? [tecnicoId] : [])])].filter((a) => a !== i.donoId), ...textosCT.aprovadaAtleta(camp, i.timeNome), uid)].filter((a): a is Aviso => Boolean(a));
    } else {
      // Recusa libera as reservas deste pedido (só as que ainda são deste time).
      const refs = (Array.isArray(i.jogadores) ? i.jogadores : []).map((a) => trava(ref, a.id));
      const travas = refs.length ? await tx.getAll(...refs) : [];
      const liberados = travas.flatMap((s, k) => s.exists && s.get("timeId") === tid ? [refs[k]] : []);
      liberados.forEach((r) => tx.delete(r));
      tx.update(ir, { status: "recusada", motivo: motivo || null, whatsappDono: null, pagamentoAvisadoEm: null, atualizadoEm: agora });
      historicoAtletas(tx, ref, { acao: "liberou", motivo: "recusada", timeId: tid, jogadorIds: liberados.map((r) => r.id), por: uid, em: agora });
      avisos = [avisoCT("recusada", id, `${tid}_${Number(i.tentativasTotal ?? 0)}`, [i.donoId], ...textosCT.recusada(camp, i.timeNome, motivo), uid)].filter((a): a is Aviso => Boolean(a));
    }
    tx.update(ref, { aprovados: Number(camp.aprovados) + (body.aceitar ? 1 : 0), pendentes: Math.max(0, Number(camp.pendentes) - 1), atualizadoEm: agora });
    avisos = agendarAvisosCT(tx, db, avisos, agora);
  });
  return avisos;
}

export async function cancelarInscricaoCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), tid = timeId(body), ref = raiz(db, id), ir = ref.collection("inscricoes").doc(tid);
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
    await autorUsuario(tx, db, uid);
    const [cs, ins] = await tx.getAll(ref, ir);
    const camp = snapCT(cs); exigirCT(camp.status === "inscricoes", "O elenco já está fechado para este campeonato.", 409);
    exigirCT(ins.exists, "Inscrição não encontrada.", 404); const i = dados(ins) as unknown as InscricaoCT;
    exigirCT(uid === i.donoId || uid === camp.organizadorId, "Você não pode cancelar esta inscrição.", 403);
    if (i.status === "cancelada") return;
    // Antes do início (único momento em que se cancela): libera os vínculos do pedido pendente ou da inscrição aprovada.
    const refs = (i.status === "aprovada" || i.status === "pendente") && Array.isArray(i.jogadores) ? i.jogadores.map((a) => trava(ref, a.id)) : [];
    const travas = refs.length ? await tx.getAll(...refs) : [];
    const liberados = travas.flatMap((s, k) => s.exists && s.get("timeId") === tid ? [refs[k]] : []);
    liberados.forEach((r) => tx.delete(r));
    tx.update(ir, { status: "cancelada", whatsappDono: null, pagamentoAvisadoEm: null, atualizadoEm: agora });
    if (liberados.length) historicoAtletas(tx, ref, { acao: "liberou", motivo: uid === i.donoId ? "cancelada" : "removida", timeId: tid, jogadorIds: liberados.map((r) => r.id), por: uid, em: agora });
    tx.update(ref, { aprovados: Number(camp.aprovados) - (i.status === "aprovada" ? 1 : 0), pendentes: Number(camp.pendentes) - (i.status === "pendente" ? 1 : 0), atualizadoEm: agora });
    // Removida pelo organizador: avisa o time. Desistência do dono: avisa o organizador (só de inscrição aprovada ou pendente).
    if (i.status === "aprovada" || i.status === "pendente") {
      const vez = `${tid}_${Number(i.tentativasTotal ?? 0)}`;
      avisos = agendarAvisosCT(tx, db, [uid === i.donoId
        ? avisoCT("desistiu", id, vez, [camp.organizadorId as string], ...textosCT.desistiu(camp, i.timeNome), uid)
        : avisoCT("removida", id, vez, i.status === "aprovada" ? timeTodo(i) : [i.donoId], ...textosCT.removida(camp, i.timeNome), uid)], agora);
    }
  });
  return avisos;
}

export async function iniciarCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), ref = raiz(db, id);
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
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
    // Técnicos: quem saiu do time ou ficou com a conta indisponível deixa de ser técnico (é opcional: não impede o início).
    const tecnicosAParte = [...new Set(inscricoes.map((i) => i.treinador?.id).filter((t): t is string => Boolean(t) && !uids.includes(t as string)))];
    const perfisTecnicos = new Map((tecnicosAParte.length ? await tx.getAll(...tecnicosAParte.map((t) => db.doc(`users/${t}`))) : []).map((s, k) => [tecnicosAParte[k], s]));
    const semTecnico = inscricoes.flatMap((i, k) => {
      const t = i.treinador?.id; if (!t) return [];
      let noTime = true; try { treinadorCT(dados(times[k]), t); } catch { noTime = false; }
      const perfil = perfisTecnicos.get(t);
      const disponivel = perfil ? perfil.exists && perfilDisponivel(dados(perfil)) : true; // quem também joga ou é dono já foi conferido acima
      return noTime && disponivel ? [] : [i.timeId];
    });
    // Automático: sorteio no servidor. Manual: a ordem do sorteio feito por fora, conferida time a time.
    const ordem = camp.sorteio === "manual" ? ordemManualCT(body.ordem, inscricoes.map((i) => i.timeId)) : sortear(inscricoes.map((i) => i.timeId));
    const gerados = gerarJogosCT(camp.formato as Parameters<typeof gerarJogosCT>[0], ordem);
    for (const [jid, jogo] of Object.entries(gerados.jogos)) tx.create(ref.collection("jogos").doc(jid), jogo);
    for (const tid of semTecnico) tx.update(ref.collection("inscricoes").doc(tid), { treinador: null, atualizadoEm: agora });
    tx.update(ref, { status: "em_andamento", ordem, grupos: gerados.grupos, iniciadoEm: agora, atualizadoEm: agora });
    // O técnico retirado acima não recebe "Campeonato iniciado".
    const paraAvisar = inscricoes.map((i) => (semTecnico.includes(i.timeId) ? { ...i, treinador: null } : i));
    avisos = agendarAvisosCT(tx, db, [avisoCT("iniciado", id, "1", paraAvisar.flatMap(timeTodo), ...textosCT.iniciado(camp), uid)], agora);
  });
  return avisos;
}

export async function resultadoCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), ref = raiz(db, id);
  exigirCT(typeof body.jogoId === "string" && ID_JOGO_CT.test(body.jogoId), "Jogo inválido.");
  const jid = body.jogoId;
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
    const perfil = await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref));
    // Em andamento: organizador ou mesário. Reabrir um encerrado (corrigir placar depois do título): só o organizador.
    if (camp.status === "encerrado") dono(camp, uid); else lancador(camp, uid);
    exigirCT(camp.status === "em_andamento" || camp.status === "encerrado", "Este campeonato não recebe resultados.", 409);
    const org = String(camp.organizadorId);
    const [ins, js, ct] = await Promise.all([tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17)), tx.get(ref.collection("jogos").limit(64)), tx.get(controle(db, org))]);
    const anteriores = Object.fromEntries(js.docs.map((s) => [s.id, { ...s.data(), id: s.id } as JogoCT]));
    let novo: ReturnType<typeof registrarResultadoCT>;
    try { novo = registrarResultadoCT(camp, ins.docs.map((s) => s.data() as InscricaoCT), anteriores, jid, body); }
    catch (e) { if (e instanceof RecusaCT) throw e; throw new RecusaCT(400, e instanceof Error ? e.message : "Resultado inválido."); }
    const alterados = Object.entries(novo.jogos).filter(([j, jogo]) => JSON.stringify(anteriores[j]) !== JSON.stringify(jogo));
    // Retry idêntico após a finalização não reabre nem altera a revisão.
    if (!alterados.length) return;
    // Correção (o jogo já tinha resultado): motivo obrigatório, prazo do mesário e registro no histórico do jogo.
    const jogoAntes = anteriores[jid], posicao = alterados.findIndex((x) => x[0] === jid), correcao = posicao >= 0 && temResultado(jogoAntes);
    let motivo = "";
    if (correcao) {
      motivo = motivoCorrecaoCT(body.motivo);
      if (camp.organizadorId !== uid) exigirCT(mesarioPodeCorrigirCT(jogoAntes, agora), "O prazo do mesário para corrigir este jogo (24 horas depois do lançamento) acabou. Peça a correção ao organizador.", 403);
      const bruto = typeof perfil.name === "string" ? perfil.name : typeof perfil.displayName === "string" ? perfil.displayName : "";
      const nome = bruto.replace(/\s+/g, " ").trim().slice(0, 100) || "Organização";
      novo.jogos[jid] = comCorrecaoCT(jogoAntes, novo.jogos[jid], { uid, nome }, motivo, agora);
    } else if (posicao >= 0) novo.jogos[jid] = { ...novo.jogos[jid], lancadoEm: agora };
    if (posicao >= 0) alterados[posicao] = [jid, novo.jogos[jid]];
    for (const [j, jogo] of alterados) tx.set(ref.collection("jogos").doc(j), jogo);
    // Ter campeão calculado significa pronto para revisão, não autorização para premiar.
    const status = "em_andamento";
    if (camp.status === "encerrado") {
      const ativos = Number(ct.get("ativos") ?? 0) + 1;
      exigirCT(ativos <= MAX_ATIVOS_CT, "Encerre outro campeonato antes de reabrir este.", 409);
      tx.set(controle(db, org), { ativos: Math.max(0, ativos) });
    }
    tx.update(ref, { status, campeaoTimeId: novo.campeaoTimeId, atualizadoEm: agora, finalizadoEm: null, premiacaoVersao: Number(camp.premiacaoVersao ?? 0) + 1 });
    // Avisos: o resultado para os dois times e a suspensão nova (cartões) para o atleta.
    const inscricoes = ins.docs.map((s) => s.data() as InscricaoCT);
    const jogo = novo.jogos[jid], porTime = (t: string | null) => inscricoes.find((i) => i.timeId === t);
    const casa = porTime(jogo.casa), fora = porTime(jogo.fora);
    const lista: (Aviso | null)[] = [avisoCT("resultado", id, `${jid}_v${Number(jogo.versao ?? 0)}`, [...timeTodo(casa), ...timeTodo(fora)],
      ...textosCT.resultado(camp, casa?.timeNome ?? "", Number(jogo.golsCasa), Number(jogo.golsFora), fora?.timeNome ?? "", Boolean(jogo.wo), correcao ? motivo : undefined), uid)];
    const antes = new Set(suspensoesCT(inscricoes, anteriores).map((s) => `${s.atletaId}_${s.jogoId}`));
    for (const s of suspensoesCT(inscricoes, novo.jogos)) if (!antes.has(`${s.atletaId}_${s.jogoId}`)) lista.push(avisoCT("suspenso", id, `${s.atletaId}_${s.jogoId}`, [s.atletaId], ...textosCT.suspenso(camp, s.motivo), uid));
    avisos = agendarAvisosCT(tx, db, lista, agora);
  });
  return avisos;
}

/** Finaliza explicitamente sobre a revisão que o organizador conferiu. A mesma transação
 * valida o estado atual e libera a cota uma única vez; o gatilho durável distribui os títulos. */
export async function finalizarCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), ref = raiz(db, id);
  let avisos: Aviso[] = [];
  await db.runTransaction(async tx => {
    avisos = [];
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref)); dono(camp, uid);
    exigirCT(typeof body.revisaoEsperada === "number" && Number.isSafeInteger(body.revisaoEsperada) && body.revisaoEsperada >= 0, "Revise os resultados antes de finalizar.");
    if (body.revisaoEsperada !== Number(camp.premiacaoVersao ?? 0)) throw new RecusaCT(409, "Os resultados mudaram. Confira o campeonato antes de finalizar.", "campeonato_desatualizado");
    if (camp.status === "encerrado") return; // resposta perdida: não duplica cota nem prêmios
    exigirCT(camp.status === "em_andamento", "Somente um campeonato em andamento pode ser finalizado.", 409);
    const [ins, js, cota, todas] = await Promise.all([
      tx.get(ref.collection("inscricoes").where("status", "==", "aprovada").limit(17)),
      tx.get(ref.collection("jogos").limit(64)), tx.get(controle(db, uid)),
      // Todas as inscrições (pendentes também): o WhatsApp dos donos sai de todas ao encerrar.
      tx.get(ref.collection("inscricoes").limit(129)),
    ]);
    exigirCT(js.docs.length > 0 && js.docs.every(j => j.get("status") === "finalizado"), "Conclua todos os jogos antes de finalizar o campeonato.", 409);
    const inscricoes = ins.docs.map(s => s.data() as InscricaoCT);
    const jogos = Object.fromEntries(js.docs.map(s => [s.id, { ...s.data(), id: s.id } as JogoCT]));
    // Recalcula campeão e confere placares/estatísticas; nenhum vencedor vem do cliente.
    exigirCT(calcularTrofeusTimes(id, { ...camp, status: "encerrado" }, inscricoes, jogos).size > 0, "Não foi possível validar o campeão e os resultados. Confira os jogos antes de finalizar.", 409);
    tx.update(ref, { status: "encerrado", finalizadoEm: agora, atualizadoEm: agora });
    // Campeonato encerrado: o WhatsApp dos donos sai das inscrições.
    for (const s of todas.docs) if (s.get("whatsappDono") || s.get("pagamentoAvisadoEm")) tx.update(s.ref, { whatsappDono: null, pagamentoAvisadoEm: null });
    tx.set(controle(db, uid), { ativos: Math.max(0, Number(cota.get("ativos") ?? 0) - 1) });
    const campeao = inscricoes.find((i) => i.timeId === camp.campeaoTimeId);
    const vez = `v${Number(camp.premiacaoVersao ?? 0)}`;
    avisos = agendarAvisosCT(tx, db, campeao ? [
      avisoCT("encerrado", id, `campeao_${vez}`, timeTodo(campeao), ...textosCT.campeao(camp, campeao.timeNome), uid),
      avisoCT("encerrado", id, `outros_${vez}`, inscricoes.filter((i) => i !== campeao).flatMap(timeTodo).filter((u) => !timeTodo(campeao).includes(u)), ...textosCT.encerrado(camp, campeao.timeNome), uid),
    ] : [], agora);
  });
  return avisos;
}

export async function administrarCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), ref = raiz(db, id), acao = body.acao;
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref));
    if (acao === "agendarJogo") lancador(camp, uid); else dono(camp, uid);
    if (acao === "cancelar") {
      const motivo = textoCT(body.motivo, 500, "Motivo do cancelamento", true);
      if (camp.status === "cancelado") return;
      exigirCT(camp.status !== "encerrado", "Um campeonato encerrado não pode ser cancelado.", 409);
      const [cota, todas] = await Promise.all([tx.get(controle(db, uid)), tx.get(ref.collection("inscricoes").limit(129))]);
      // Cancelado antes do início: o crédito premium gasto volta para a conta do organizador.
      const devolver = await lerDevolucaoPremiumCT(tx, db, camp, id, agora);
      tx.update(ref, { status: "cancelado", motivoCancelamento: motivo, atualizadoEm: agora });
      devolver();
      // Campeonato cancelado: o WhatsApp dos donos sai das inscrições.
      for (const s of todas.docs) if (s.get("whatsappDono") || s.get("pagamentoAvisadoEm")) tx.update(s.ref, { whatsappDono: null, pagamentoAvisadoEm: null, atualizadoEm: agora });
      tx.set(controle(db, uid), { ativos: Math.max(0, Number(cota.get("ativos") ?? 0) - 1) });
      avisos = agendarAvisosCT(tx, db, [avisoCT("cancelado", id, "1", Array.isArray(camp.envolvidos) ? camp.envolvidos as string[] : [], ...textosCT.cancelado(camp, motivo), uid)], agora);
    } else if (acao === "alterarDatas" || acao === "editarInfo") {
      // Antes do início, o organizador muda as datas (imprevisto) e/ou sobre, regulamento, inscrição e premiação, numa
      // gravação só. Mesmos limites da criação. `infoVersaoEsperada` (versão que o formulário abriu) recusa um formulário
      // antigo em vez de desfazer a edição feita em outro aparelho; sem ela (app antigo), não confere.
      exigirCT(camp.status === "inscricoes", acao === "editarInfo" ? "Os dados do campeonato só podem mudar antes do início." : "As datas só podem mudar antes do início. Depois, marque a data de cada jogo.", 409);
      const versao = Number(camp.infoVersao ?? 0) || 0;
      if (body.infoVersaoEsperada !== undefined && body.infoVersaoEsperada !== versao) throw new RecusaCT(409, "O campeonato foi editado em outro aparelho. Confira os dados e salve de novo.", "campeonato_editado");
      const mudanca: Dados = {};
      // O que muda para quem já está no campeonato (o "Sobre" não gera aviso).
      const mudouParaTimes: string[] = [];
      if (acao === "editarInfo") {
        const p = objetoCT(body.premiacao);
        exigirCT((p.trofeus === undefined || typeof p.trofeus === "boolean") && (p.medalhas === undefined || typeof p.medalhas === "boolean"), "Premiação inválida.");
        const premiacao = { valorCentavos: numeroCT(p.valorCentavos ?? 0, 0, 100_000_000, "Prêmio em dinheiro"), trofeus: p.trofeus === true, medalhas: p.medalhas === true, texto: textoCT(p.texto, 1000, "Premiação") };
        const regrasTexto = textoCT(body.regrasTexto, 5000, "Regulamento");
        // Valor da inscrição: opcional (versões sem o campo mantêm o atual). Só um controle do organizador; o app não cobra.
        const inscricaoCentavos = body.inscricaoCentavos === undefined ? Number(camp.inscricaoCentavos ?? 0) : numeroCT(body.inscricaoCentavos, 0, 10_000_000, "Valor da inscrição");
        Object.assign(mudanca, { descricao: textoCT(body.descricao, 2000, "Descrição"), regrasTexto, premiacao, inscricaoCentavos });
        const antes = objetoCT(camp.premiacao);
        if (inscricaoCentavos !== Number(camp.inscricaoCentavos ?? 0)) mudouParaTimes.push(inscricaoCentavos > 0 ? `o valor da inscrição (agora ${reaisCT(inscricaoCentavos)})` : "o valor da inscrição (agora grátis)");
        if (premiacao.valorCentavos !== Number(antes.valorCentavos ?? 0) || premiacao.trofeus !== (antes.trofeus === true) || premiacao.medalhas !== (antes.medalhas === true) || premiacao.texto !== String(antes.texto ?? "")) mudouParaTimes.push("a premiação");
        if (regrasTexto !== String(camp.regrasTexto ?? "")) mudouParaTimes.push("o regulamento");
      }
      // Datas: sempre em alterarDatas; em editarInfo, só quando vierem.
      let datasNovas: { inscricoesAte: number; dataInicio: number | null } | null = null;
      if (acao === "alterarDatas" || body.inscricoesAte !== undefined) {
        // Manter o prazo atual (mesmo já encerrado) é permitido: dá para mudar só o início. Um prazo NOVO segue a regra da criação.
        const mantemPrazo = body.inscricoesAte === camp.inscricoesAte;
        const inscricoesAte = mantemPrazo ? Number(camp.inscricoesAte) : numeroCT(body.inscricoesAte, agora + 60_000, agora + 180 * 86_400_000, "Prazo de inscrição");
        // Início mantido (mesmo já passado hoje): continua valendo. Um início NOVO: no fim das inscrições ou depois, e não antes de ontem.
        const mantemInicio = body.dataInicio != null && body.dataInicio === (camp.dataInicio ?? null);
        const dataInicio = body.dataInicio == null ? null : mantemInicio ? Number(camp.dataInicio) : numeroCT(body.dataInicio, Math.max(inscricoesAte, agora - 86_400_000), agora + 365 * 86_400_000, "Início do campeonato");
        exigirCT(dataInicio === null || dataInicio >= inscricoesAte, "Início do campeonato: precisa ser no fim das inscrições ou depois.");
        if (inscricoesAte !== camp.inscricoesAte || dataInicio !== (camp.dataInicio ?? null)) {
          mudanca.inscricoesAte = inscricoesAte; mudanca.dataInicio = dataInicio;
          datasNovas = { inscricoesAte, dataInicio };
        }
      }
      if (!Object.keys(mudanca).length) return;
      // Avisa quem está no campeonato AGORA (times aprovados e com pedido em análise, e os mesários), não o histórico de
      // envolvidos (que inclui quem já saiu). Em lotes de até 500 pessoas por aviso. Leitura antes de qualquer gravação.
      if (datasNovas || mudouParaTimes.length) {
        const ativos = await tx.get(ref.collection("inscricoes").where("status", "in", ["aprovada", "pendente"]).limit(129));
        const mesarios = Array.isArray(camp.mesarios) ? (camp.mesarios as { uid?: unknown }[]).map((m) => m?.uid).filter((u): u is string => typeof u === "string") : [];
        const para = [...new Set([...ativos.docs.flatMap((s) => timeTodo(s.data() as InscricaoCT)), ...mesarios])].filter((u) => u !== uid);
        const lotes = Array.from({ length: Math.ceil(para.length / 500) }, (_, k) => para.slice(k * 500, k * 500 + 500));
        const d = datasNovas;
        avisos = agendarAvisosCT(tx, db, [
          ...(d ? lotes.map((lote, k) => avisoCT("datas", id, `${d.inscricoesAte}_${d.dataInicio ?? 0}_${k}`, lote, ...textosCT.datas(camp, d.inscricoesAte, d.dataInicio), uid)) : []),
          ...(mudouParaTimes.length ? lotes.map((lote, k) => avisoCT("dados", id, `v${versao + 1}_${k}`, lote, ...textosCT.dados(camp, mudouParaTimes), uid)) : []),
        ], agora);
      }
      // Uma gravação só no documento (com o atualizadoEm), e a versão sobe para o próximo formulário conferir.
      tx.update(ref, { ...mudanca, infoVersao: versao + 1, atualizadoEm: agora });
      return;
    } else if (acao === "marcarPagamento") {
      const tid = timeId(body); exigirCT(typeof body.pago === "boolean", "Pagamento inválido.");
      const ir = ref.collection("inscricoes").doc(tid), i = await tx.get(ir);
      exigirCT(i.exists && i.get("status") === "aprovada", "A inscrição precisa estar aprovada.", 409);
      const avisado = Number(i.get("pagamentoAvisadoEm") ?? 0) || 0, antes = i.get("pago") === true;
      tx.update(ir, { pago: body.pago, pagamentoAvisadoEm: null, atualizadoEm: agora });
      // Confirmou o pagamento, ou respondeu "Ainda não" a um "Já paguei": o dono fica sabendo.
      const timeNome = String(i.get("timeNome") ?? "Time"), donoTime = i.get("donoId") as string;
      if (body.pago && !antes) avisos = agendarAvisosCT(tx, db, [avisoCT("pagamento", id, `${tid}_pago_${agora}`, [donoTime], ...textosCT.pagamentoConfirmado(camp, timeNome), uid)], agora);
      else if (!body.pago && avisado) avisos = agendarAvisosCT(tx, db, [avisoCT("pagamento", id, `${tid}_pendente_${avisado}`, [donoTime], ...textosCT.pagamentoPendente(camp, timeNome), uid)], agora);
    } else if (acao === "agendarJogo") {
      exigirCT(camp.status === "em_andamento", "Só é possível agendar jogos em andamento.", 409);
      exigirCT(typeof body.jogoId === "string" && ID_JOGO_CT.test(body.jogoId), "Jogo inválido.");
      const jr = ref.collection("jogos").doc(body.jogoId), jogo = await tx.get(jr);
      exigirCT(jogo.exists && jogo.get("status") !== "finalizado", "Jogo não disponível para agendamento.", 409);
      const quando = body.quando == null ? null : numeroCT(body.quando, agora - 86_400_000, agora + 365 * 86_400_000, "Data do jogo");
      const local = textoCT(body.local, 80, "Local");
      exigirCT(!local || (camp.locais as { nome: string }[]).some((l) => l.nome === local), "Escolha um dos locais cadastrados no campeonato.");
      const casaId = jogo.get("casa"), foraId = jogo.get("fora");
      const lados = typeof casaId === "string" && typeof foraId === "string" ? await tx.getAll(ref.collection("inscricoes").doc(casaId), ref.collection("inscricoes").doc(foraId)) : [];
      tx.update(jr, { quando, local: local || null });
      // Data ou local mudou (com os dois adversários definidos): avisa os dois times.
      if (lados.length === 2 && (quando !== (jogo.get("quando") ?? null) || (local || null) !== (jogo.get("local") ?? null)) && (quando || local)) {
        const [c, f] = lados.map((s) => dados(s) as unknown as InscricaoCT);
        avisos = agendarAvisosCT(tx, db, [avisoCT("jogo_marcado", id, `${body.jogoId}_${quando ?? 0}_${createHash("sha1").update(local).digest("hex").slice(0, 8)}`, [...timeTodo(c), ...timeTodo(f)], ...textosCT.jogoMarcado(camp, c.timeNome, f.timeNome, quando, local), uid)], agora);
      }
    } else throw new RecusaCT(400, "Ação administrativa inválida.");
    tx.update(ref, { atualizadoEm: agora });
  });
  return avisos;
}

/**
 * Pagamento e contato depois da aprovação (o Tugyn não recebe nem repassa dinheiro; só liga as pessoas):
 * - "pagamentoContato" (organizador): "Como pagar" (até 500 letras) e o WhatsApp da organização;
 * - "contatoDono" (dono do time): troca ou apaga o próprio WhatsApp na inscrição;
 * - "avisarPagamento" (dono de time aprovado): "Já paguei", com push ao organizador;
 * - "pedirContato" (organizador): push pedindo ao dono que informe o WhatsApp (no máximo um por dia).
 * Só com o campeonato em inscrições ou em andamento.
 */
export async function contatoCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), ref = raiz(db, id), acao = body.acao;
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref));
    exigirCT(ativa(camp), "Este campeonato já terminou.", 409);
    if (acao === "pagamentoContato") {
      dono(camp, uid);
      const pagamentoTexto = textoCT(body.pagamentoTexto, 500, "Como pagar");
      const whatsappOrganizacao = whatsappCT(body.whatsappOrganizacao, "WhatsApp da organização");
      tx.update(ref, { pagamentoTexto: pagamentoTexto || null, whatsappOrganizacao, atualizadoEm: agora });
      return;
    }
    const tid = timeId(body), ir = ref.collection("inscricoes").doc(tid), s = await tx.get(ir);
    exigirCT(s.exists, "Inscrição não encontrada.", 404);
    const i = dados(s) as unknown as InscricaoCT;
    exigirCT(i.status === "pendente" || i.status === "aprovada", "Esta inscrição não está mais ativa.", 409);
    if (acao === "contatoDono") {
      exigirCT(i.donoId === uid, "Somente o dono do time pode fazer isso.", 403);
      tx.update(ir, { whatsappDono: whatsappCT(body.whatsapp, "Seu WhatsApp"), atualizadoEm: agora });
    } else if (acao === "avisarPagamento") {
      exigirCT(i.donoId === uid, "Somente o dono do time pode fazer isso.", 403);
      exigirCT(i.status === "aprovada", "A inscrição precisa estar aprovada.", 409);
      // Já pago ou já avisado (toque repetido / resposta perdida): nada muda e não manda outro push.
      if (i.pago === true || i.pagamentoAvisadoEm) return;
      tx.update(ir, { pagamentoAvisadoEm: agora, atualizadoEm: agora });
      avisos = agendarAvisosCT(tx, db, [avisoCT("pagamento", id, `${tid}_avisou_${agora}`, [camp.organizadorId as string], ...textosCT.pagamentoAvisado(camp, i.timeNome), uid)], agora);
    } else if (acao === "pedirContato") {
      dono(camp, uid);
      // Já informou, ou já foi pedido nas últimas 24 h: nada muda e não sai outro aviso. A marca fica na inscrição porque
      // a fila de avisos regrava o registro do aviso (não serve de trava contra repetição).
      const pedidoEm = Number((i as unknown as Dados).contatoPedidoEm ?? 0) || 0;
      if (i.whatsappDono || (pedidoEm && agora - pedidoEm < 86_400_000)) return;
      tx.update(ir, { contatoPedidoEm: agora });
      avisos = agendarAvisosCT(tx, db, [avisoCT("contato", id, `${tid}_${agora}`, [i.donoId], ...textosCT.pedirContato(camp, i.timeNome), uid)], agora);
    } else throw new RecusaCT(400, "Ação inválida.");
  });
  return avisos;
}

/**
 * Transferência de um atleta entre dois times APROVADOS, só pelo organizador e só antes do início (depois da tabela,
 * gols, assistências e títulos já ficam ligados ao time do atleta). Numa transação: confere o vínculo atual, o elenco geral
 * do destino, os limites de atletas e os titulares exigidos do time de origem; move o vínculo e grava no histórico.
 */
export async function transferirAtletaCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  let avisos: Aviso[] = [];
  const id = campoId(body), ref = raiz(db, id);
  const de = timeId({ timeId: body.deTimeId }), para = timeId({ timeId: body.paraTimeId });
  exigirCT(de !== para, "Escolha outro time de destino.");
  const jid = body.jogadorId;
  exigirCT(typeof jid === "string" && ID_PESSOA_CT.test(jid), "Atleta inválido.");
  const motivo = textoCT(body.motivo, 300, "Motivo da transferência", true);
  await db.runTransaction(async (tx) => {
    avisos = [];
    await autorUsuario(tx, db, uid);
    const ira = ref.collection("inscricoes").doc(de), irb = ref.collection("inscricoes").doc(para);
    const [cs, sa, sb, tb, vinculo, perfil] = await tx.getAll(ref, ira, irb, db.doc(`times/${para}`), trava(ref, jid), db.doc(`users/${jid}`));
    const camp = snapCT(cs); dono(camp, uid);
    exigirCT(camp.status === "inscricoes", "Transferências só antes do início do campeonato: depois da tabela, gols e cartões já ficam ligados ao time.", 409);
    exigirCT(sa.exists && sb.exists, "Inscrição não encontrada.", 404);
    const a = dados(sa) as unknown as InscricaoCT, b = dados(sb) as unknown as InscricaoCT;
    exigirCT(a.status === "aprovada" && b.status === "aprovada", "Os dois times precisam estar aprovados.", 409);
    const atleta = a.jogadores.find((j) => j.id === jid);
    exigirCT(atleta, "Este atleta não está inscrito pelo time de origem.", 409);
    exigirCT(vinculo.exists && vinculo.get("timeId") === de, "O vínculo deste atleta mudou. Atualize o campeonato.", 409);
    exigirCT(!b.jogadores.some((j) => j.id === jid), "O atleta já está no time de destino.", 409);
    exigirCT(a.treinador?.id !== jid, `${atleta.nome} é o técnico de ${a.timeNome}: tire-o de técnico antes de transferir (não dá para treinar um time e jogar por outro).`, 409);
    exigirCT(tb.exists, "O time de destino não existe mais.", 409);
    const t = dados(tb), jogadoresTime = objetoCT(t.jogadores), camisa = objetoCT(objetoCT(t.camisas)[jid]);
    exigirCT(Array.isArray(t.membros) && t.membros.includes(jid) && Object.prototype.hasOwnProperty.call(jogadoresTime, jid), `${atleta.nome} precisa fazer parte do elenco de ${b.timeNome} no Tugyn.`, 409);
    exigirCT(camisa.posicao !== "treinador", "Treinador não conta como atleta inscrito.", 409);
    exigirCT(perfil.exists && perfilDisponivel(dados(perfil)), "A conta deste atleta está indisponível.", 409);
    const restantes = a.jogadores.filter((j) => j.id !== jid);
    exigirCT(restantes.length >= Number(camp.minJogadores), `${a.timeNome} ficaria com menos de ${camp.minJogadores} atletas.`, 409);
    exigirCT(b.jogadores.length + 1 <= Number(camp.maxJogadores), `${b.timeNome} já tem o máximo de ${camp.maxJogadores} atletas.`, 409);
    const requisitos = requisitosDoCT(camp);
    const erroOrigem = requisitos ? mensagemRequisitosCT(requisitos, restantes.map((j) => j.posicao)) : null;
    exigirCT(!erroOrigem, `${a.timeNome}: ${erroOrigem}`, 409);
    const novo = { id: jid, nome: textoCT(objetoCT(jogadoresTime[jid]).nome, 80, "Nome do jogador", true), foto: fotoAtletaCT(perfil.get("profileImage")),
      numero: typeof camisa.numero === "number" && Number.isInteger(camisa.numero) && camisa.numero >= 0 && camisa.numero <= 99 ? camisa.numero : null,
      posicao: typeof camisa.posicao === "string" ? camisa.posicao.slice(0, 30) : null };
    tx.update(ira, { jogadores: restantes, atualizadoEm: agora });
    tx.update(irb, { jogadores: [...b.jogadores, novo], atualizadoEm: agora });
    tx.set(trava(ref, jid), { timeId: para, status: "aprovado", desde: agora, atualizadoEm: agora });
    historicoAtletas(tx, ref, { acao: "transferiu", jogadorIds: [jid], deTimeId: de, timeId: para, motivo, por: uid, em: agora });
    tx.update(ref, { atualizadoEm: agora });
    avisos = agendarAvisosCT(tx, db, [
      avisoCT("transferido", id, `${jid}_${agora}_atleta`, [jid], ...textosCT.transferidoAtleta(camp, a.timeNome, b.timeNome), uid),
      avisoCT("transferido", id, `${jid}_${agora}_donos`, [a.donoId, b.donoId].filter((u) => u !== jid), ...textosCT.transferidoDono(camp, atleta.nome, a.timeNome, b.timeNome), uid),
    ], agora);
  });
  return avisos;
}

/**
 * Mesários (até ${MAX_MESARIOS_CT}): o organizador convida pelo @usuário; o mesário lança placares e marca jogos, nada mais.
 * `remover`: o uid de um mesário atual. A pessoa entra em `envolvidos` para ver o campeonato em "Meus campeonatos".
 */
export async function mesarioCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const id = campoId(body), ref = raiz(db, id);
  const remover = typeof body.remover === "string" ? body.remover : null;
  const userName = remover ? "" : String(body.userName ?? "").trim().replace(/^@+/, "").toLowerCase();
  exigirCT(remover ? ID_PESSOA_CT.test(remover) : /^[a-z0-9._]{4,30}$/.test(userName), "Digite um @usuário válido.");
  let avisos: Aviso[] = [];
  await db.runTransaction(async (tx) => {
    avisos = [];
    await autorUsuario(tx, db, uid);
    const camp = snapCT(await tx.get(ref)); dono(camp, uid);
    exigirCT(ativa(camp), "Mesários só em campeonatos com inscrições abertas ou em andamento.", 409);
    const atuais = mesariosDoCT(camp);
    if (remover) {
      if (!atuais.some((m) => m.uid === remover)) return;
      tx.update(ref, { mesarios: atuais.filter((m) => m.uid !== remover), atualizadoEm: agora });
      return;
    }
    const reserva = await tx.get(db.doc(`usernames/${userName}`));
    const alvo = typeof reserva.get("uid") === "string" ? String(reserva.get("uid")) : "";
    exigirCT(alvo && ID_PESSOA_CT.test(alvo), `Não encontramos @${userName}.`, 404);
    exigirCT(alvo !== camp.organizadorId, "Você já é o organizador.", 409);
    if (atuais.some((m) => m.uid === alvo)) return;
    exigirCT(atuais.length < MAX_MESARIOS_CT, `O campeonato pode ter até ${MAX_MESARIOS_CT} mesários.`, 409);
    const perfil = dados(await tx.get(db.doc(`users/${alvo}`)));
    exigirCT(perfilDisponivel(Object.keys(perfil).length ? perfil : null), "Esta conta está indisponível.", 409);
    const envolvidos = Array.isArray(camp.envolvidos) ? camp.envolvidos as string[] : [];
    tx.update(ref, { mesarios: [...atuais, { uid: alvo, nome: textoCT(perfil.name, 80, "Nome") || userName, userName }], envolvidos: [...new Set([...envolvidos, alvo])], atualizadoEm: agora });
    avisos = agendarAvisosCT(tx, db, [avisoCT("mesario", id, alvo, [alvo], ...textosCT.mesario(camp), uid)], agora);
  });
  return avisos;
}

export const idDoCT = campoId;
export { ativa as campeonatoAtivoCT };

const HORA = 3600_000;
const participa = (i: InscricaoCT, uid: string) => i.donoId === uid || i.jogadores.some((j) => j.id === uid);

/**
 * "Meus próximos jogos": jogos pendentes (com os dois adversários) dos times em que a pessoa joga ou é dona, nos
 * campeonatos em andamento. Ordem: com data primeiro (mais cedo antes), depois os sem data. Até 10.
 * Lê os jogos uma vez por campeonato (suspensões e pendentes saem da mesma leitura) e só se a pessoa tiver time inscrito.
 * `incompleto`: a pessoa está em mais campeonatos em andamento do que o limite lido.
 */
export async function proximosJogosCT(db: Firestore, uid: string): Promise<Dados> {
  const camps = await db.collection(COLECAO_CT).where("envolvidos", "array-contains", uid).where("status", "==", "em_andamento").limit(LIMITE_PROXIMOS).get();
  const lista = (await Promise.all(camps.docs.map(async (c) => {
    const ins = await c.ref.collection("inscricoes").where("status", "==", "aprovada").limit(17).get();
    const inscricoes = ins.docs.map((s) => ({ ...s.data(), timeId: s.id } as unknown as InscricaoCT));
    const meus = new Set(inscricoes.filter((i) => participa(i, uid)).map((i) => i.timeId));
    if (!meus.size) return [];
    const nome = (tid: string | null) => inscricoes.find((i) => i.timeId === tid);
    const todos = (await c.ref.collection("jogos").limit(64).get()).docs.map((s) => ({ ...s.data(), id: s.id } as JogoCT));
    const susp = suspensoesCT(inscricoes, Object.fromEntries(todos.map((j) => [j.id, j])));
    return todos.filter((j) => j.status === "pendente" && j.casa && j.fora && (meus.has(j.casa) || meus.has(j.fora))).map((j) => ({
      campeonatoId: c.id, campeonatoNome: String(c.get("nome") ?? ""), jogoId: j.id, fase: j.fase ?? null,
      quando: typeof j.quando === "number" ? j.quando : null, local: typeof j.local === "string" ? j.local : null,
      casa: { timeId: j.casa, nome: nome(j.casa)?.timeNome ?? "", escudo: nome(j.casa)?.escudoUrl ?? null },
      fora: { timeId: j.fora, nome: nome(j.fora)?.timeNome ?? "", escudo: nome(j.fora)?.escudoUrl ?? null },
      suspenso: susp.some((s) => s.jogoId === j.id && s.atletaId === uid),
    }));
  }))).flat();
  lista.sort((a, b) => (a.quando ?? Number.MAX_SAFE_INTEGER) - (b.quando ?? Number.MAX_SAFE_INTEGER));
  return { jogos: lista.slice(0, 10), incompleto: camps.size >= LIMITE_PROXIMOS };
}
const LIMITE_PROXIMOS = 10;

const COLECAO_ESTATISTICAS = "estatisticasAtletasCT";
const VALIDADE_ESTATISTICAS = HORA;
/** Formato do documento guardado: mudou o que é calculado, sobe o número (o guardado antigo é recalculado). */
const VERSAO_ESTATISTICAS = 2;
type TimeNoCard = TimeDoAtleta & { amistososGols: number; gols: number; assistencias: number; jogos: number; titulos: number; campeonatos: number };
const MAX_TIMES_CARD = 30;
/** Ordem da tela: atuais primeiro, depois mais jogos e mais gols. Ex-time sem nenhum número fica de fora. */
const ordenarTimesCard = (ts: TimeNoCard[]): TimeNoCard[] => ts
  .filter((t) => t.atual || t.jogos || t.amistososGols || t.campeonatos)
  .sort((a, b) => Number(b.atual) - Number(a.atual) || b.jogos - a.jogos || (b.gols + b.amistososGols) - (a.gols + a.amistososGols));
const listaTimesCard = (v: unknown): TimeNoCard[] => Array.isArray(v) ? (v as TimeNoCard[]).filter((t) => t && typeof t.timeId === "string") : [];
/** Time do card: o escolhido (se a pessoa ainda está nele) ou, no automático, o time atual com mais jogos (depois, mais gols). */
export const timeDoCardCT = (porTime: TimeNoCard[], escolhido: unknown): string | null => {
  const atuais = porTime.filter((t) => t.atual);
  if (typeof escolhido === "string" && atuais.some((t) => t.timeId === escolhido)) return escolhido;
  const ordem = [...atuais].sort((a, b) => b.jogos - a.jogos || (b.gols + b.amistososGols) - (a.gols + a.amistososGols) || a.timeId.localeCompare(b.timeId));
  return ordem[0]?.timeId ?? null;
};
/**
 * Números dos cards do perfil que o servidor calcula (guardados por 1 h em `estatisticasAtletasCT/{uid}`):
 *  - card Times: campeonatos entre times (campeonatos, jogos do time em que estava inscrita, gols, assistências, cartões e
 *    títulos) mais os gols dos amistosos, com a divisão por time e o time do card;
 *  - card Turmas: a parte dos campeonatos da turma (as partidas das turmas o app já soma).
 * Vencido o prazo, só um pedido recalcula (reserva de 1 min no próprio documento); os outros recebem o último resultado.
 * `incompleto`: a pessoa passou de algum limite de leitura e os totais são parciais.
 * Perfil privado: o visitante recebe só a parte do card Turmas (o card aparece mesmo no perfil privado); o card Times segue
 * a regra dos troféus (só o dono vê). Perfil suspenso ou com a exclusão em andamento: nada.
 */
export async function estatisticasAtletaCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Dados> {
  const alvo = body.uid == null ? uid : String(body.uid);
  exigirCT(ID_PESSOA_CT.test(alvo), "Pessoa inválida.");
  let privado = false;
  if (alvo !== uid) {
    const perfil = dados(await db.doc(`users/${alvo}`).get());
    if (!perfilDisponivel(Object.keys(perfil).length ? perfil : null)) return { estatisticas: null, privado: true, campeonatosTurma: null };
    privado = perfil.isPublic === false;
  }
  const ref = db.doc(`${COLECAO_ESTATISTICAS}/${alvo}`);
  const valido = (s: DocumentSnapshot) => s.exists && !!s.get("estatisticas") && s.get("versao") === VERSAO_ESTATISTICAS && Number(s.get("calculadoEm") ?? 0) > agora - VALIDADE_ESTATISTICAS;
  const resposta = (d: Dados): Dados => {
    const porTime = listaTimesCard(d.porTime);
    const base = { calculadoEm: Number(d.calculadoEm ?? 0), incompleto: d.incompleto === true, campeonatosTurma: d.campeonatosTurma ?? null };
    if (privado) return { ...base, estatisticas: null, privado: true };
    return { ...base, estatisticas: d.estatisticas, amistosos: d.amistosos ?? { gols: 0 }, porTime, totalTimes: Math.max(porTime.length, Number(d.totalTimes ?? 0)), timeDoCard: timeDoCardCT(porTime, d.timeDoCard), ...(alvo === uid ? { timeDoCardEscolhido: typeof d.timeDoCard === "string" ? d.timeDoCard : null } : {}) };
  };
  const cache = await ref.get();
  if (valido(cache)) return resposta(cache.data()!);
  const reserva = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    // Outro pedido terminou entre a leitura acima e agora: usa o resultado dele.
    if (valido(s)) return { pronto: s, ocupado: false };
    if (Number(s.get("calculandoAte") ?? 0) > agora) return { pronto: s.get("estatisticas") ? s : null, ocupado: true }; // vencido (ou do formato antigo) vale até o cálculo terminar
    tx.set(ref, { ...(s.data() ?? {}), calculandoAte: agora + 60_000 });
    return { pronto: null, ocupado: false };
  });
  if (reserva.pronto) return resposta(reserva.pronto.data()!);
  if (reserva.ocupado) {
    // Primeira vez desta pessoa e outro pedido calculando: espera ele terminar (até 1,5 s) em vez de calcular junto.
    for (let i = 0; i < 3; i++) {
      await new Promise((ok) => setTimeout(ok, ESPERA_ESTATISTICAS_MS));
      const s = await ref.get();
      if (s.get("estatisticas")) return resposta(s.data()!);
    }
    return { estatisticas: null, calculando: true };
  }
  try {
    return resposta(await calcularEstatisticasCT(db, ref, alvo, agora, cache.get("timeDoCard")));
  } catch (e) {
    await ref.update({ calculandoAte: 0 }).catch(() => undefined); // solta a reserva: o próximo pedido tenta de novo
    throw e;
  }
}
const ESPERA_ESTATISTICAS_MS = 500;

/**
 * Escolher o time do card (`timeId`) ou voltar ao automático (`null`). Só um time em que a pessoa está hoje.
 * Acerta também, no cálculo guardado, quais times são atuais (entrou num time novo ou saiu de um depois do cálculo), sem
 * refazer os números: o escolhido aparece na hora, mesmo que o cálculo seja de antes de entrar no time.
 */
export async function timeDoCardEscolherCT(db: Firestore, uid: string, body: Dados): Promise<Dados> {
  const timeId = body.timeId == null ? null : String(body.timeId);
  if (timeId !== null) exigirCT(/^[A-Za-z0-9_-]{1,140}$/.test(timeId), "Time inválido.");
  const atuais = new Map<string, TimeDoAtleta>();
  const busca = await db.collection("times").where("membros", "array-contains", uid).limit(20).get();
  for (const t of busca.docs) atuais.set(t.id, timeDoDocumento(t.id, t.data(), true));
  if (timeId !== null && !atuais.has(timeId)) {
    // Fora dos 20 da busca: confere direto no time.
    const t = await db.doc(`times/${timeId}`).get();
    const membros = t.exists && Array.isArray(t.get("membros")) ? (t.get("membros") as unknown[]) : [];
    if (membros.includes(uid)) atuais.set(timeId, timeDoDocumento(timeId, t.data() ?? {}, true));
  }
  exigirCT(timeId === null || atuais.has(timeId), "Você não está mais neste time.", 409);
  const ref = db.doc(`${COLECAO_ESTATISTICAS}/${uid}`);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const guardada = listaTimesCard(s.get("porTime"));
    if (!s.exists || !s.get("porTime")) { tx.set(ref, { timeDoCard: timeId }, { merge: true }); return; }
    const conhecidos = new Set(guardada.map((t) => t.timeId));
    const zerado = { amistososGols: 0, gols: 0, assistencias: 0, jogos: 0, titulos: 0, campeonatos: 0 };
    const novos = [...atuais.values()].filter((t) => !conhecidos.has(t.timeId)).map((t) => ({ ...t, ...zerado }));
    const todos = [...guardada.map((t) => ({ ...t, ...(atuais.get(t.timeId) ?? {}), atual: atuais.has(t.timeId) })), ...novos];
    const ficam = ordenarTimesCard(todos);
    // A lista guardada já pode estar cortada: o total segue o anterior, com os times que entraram e os que saíram.
    const totalTimes = Math.max(ficam.length, Number(s.get("totalTimes") ?? guardada.length) + novos.length - (todos.length - ficam.length));
    tx.set(ref, { timeDoCard: timeId, porTime: ficam.slice(0, MAX_TIMES_CARD), totalTimes }, { merge: true });
  });
  return { timeDoCard: timeId };
}

async function calcularEstatisticasCT(db: Firestore, ref: ReturnType<Firestore["doc"]>, alvo: string, agora: number, timeDoCard: unknown): Promise<Dados> {
  const [camps, amistosos, turma] = await Promise.all([
    db.collection(COLECAO_CT).where("envolvidos", "array-contains", alvo).limit(LIMITE_CAMPEONATOS_ESTATISTICAS).get(),
    amistososDoAtleta(db, alvo),
    campeonatosTurmaDoAtleta(db, alvo),
  ]);
  const est = { campeonatos: 0, jogos: 0, gols: 0, assistencias: 0, amarelos: 0, vermelhos: 0, titulos: 0 };
  const porTime = new Map<string, TimeNoCard>();
  const doTime = (timeId: string, info: () => TimeDoAtleta): TimeNoCard => {
    let t = porTime.get(timeId);
    if (!t) { t = { ...(amistosos.times.get(timeId) ?? info()), amistososGols: 0, gols: 0, assistencias: 0, jogos: 0, titulos: 0, campeonatos: 0 }; porTime.set(timeId, t); }
    return t;
  };
  for (const [timeId, info] of amistosos.times) doTime(timeId, () => info);
  for (const [timeId, gols] of amistosos.gols) {
    const info = amistosos.times.get(timeId);
    if (info) doTime(timeId, () => info).amistososGols = gols;
  }
  await Promise.all(camps.docs.filter((c) => c.get("status") === "em_andamento" || c.get("status") === "encerrado").map(async (c) => {
    const ins = await c.ref.collection("inscricoes").where("status", "==", "aprovada").limit(17).get();
    const meu = ins.docs.find((s) => (s.data() as InscricaoCT).jogadores?.some((j) => j.id === alvo));
    if (!meu) return;
    const i = meu.data() as InscricaoCT;
    // Time apagado ou de que a pessoa saiu: nome, cor e escudo da inscrição (como o time estava naquele campeonato).
    const t = doTime(meu.id, () => timeDoDocumento(meu.id, { nome: i.timeNome, cor: i.cor, escudoUrl: i.escudoUrl, sigla: String(i.timeNome ?? "").replace(/[^A-Za-zÀ-ÿ0-9]/g, "").slice(0, 3) }, false));
    est.campeonatos++; t.campeonatos++;
    if (c.get("status") === "encerrado" && c.get("campeaoTimeId") === meu.id) { est.titulos++; t.titulos++; }
    const js = await c.ref.collection("jogos").where("status", "==", "finalizado").limit(64).get();
    for (const s of js.docs) {
      const j = s.data() as JogoCT;
      if (j.casa !== meu.id && j.fora !== meu.id) continue;
      const g = Number(objetoCT(j.gols)[alvo] ?? 0), a = Number(objetoCT(j.assistencias)[alvo] ?? 0);
      est.jogos++; t.jogos++;
      est.gols += g; t.gols += g; est.assistencias += a; t.assistencias += a;
      est.amarelos += Number(objetoCT(j.amarelos)[alvo] ?? 0); est.vermelhos += Number(objetoCT(j.vermelhos)[alvo] ?? 0);
    }
  }));
  const golsAmistosos = [...porTime.values()].reduce((x, t) => x + t.amistososGols, 0);
  // A lista guardada mostra até 30 times; o total (e os números do card) contam todos.
  const ordenados = ordenarTimesCard([...porTime.values()]);
  const lista = ordenados.slice(0, MAX_TIMES_CARD);
  const totalTimes = ordenados.length;
  const { incompleto: turmaIncompleta, ...campeonatosTurma } = turma;
  const incompleto = camps.size >= LIMITE_CAMPEONATOS_ESTATISTICAS || turmaIncompleta || amistosos.incompleto;
  const doc = { estatisticas: est, amistosos: { gols: golsAmistosos }, porTime: lista, totalTimes, campeonatosTurma, calculadoEm: agora, incompleto, versao: VERSAO_ESTATISTICAS, calculandoAte: 0 };
  await ref.set(doc, { merge: true }); // merge: a escolha do time do card (`timeDoCard`) continua
  return { ...doc, timeDoCard };
}
const LIMITE_CAMPEONATOS_ESTATISTICAS = 60;

/**
 * Rotina agendada (functions, a cada 30 min): avisa o organizador quando o prazo de inscrições acaba e os dois times
 * na véspera do jogo (12 h a 24 h antes). A chave de cada aviso evita repetição entre execuções.
 * Lembretes: uma consulta de grupo nos jogos com `quando` na janela (índice de grupo em jogos.quando), então a execução
 * sem jogo próximo custa uma leitura, não uma por campeonato em andamento. Prazos e jogos da janela são lidos em páginas.
 * `truncado`: algum limite de segurança foi atingido (vai no log da rotina).
 */
export async function avisosAgendadosCT(db: Firestore, agora = Date.now()): Promise<{ prazos: number; lembretes: number; truncado: boolean }> {
  const avisos: (Aviso | null)[] = [];
  let truncado = false;
  const base = db.collection(COLECAO_CT).where("status", "==", "inscricoes").where("inscricoesAte", ">", agora - 24 * HORA).where("inscricoesAte", "<=", agora)
    .orderBy("inscricoesAte").orderBy(FieldPath.documentId());
  let cursor: [number, string] | null = null;
  for (let pagina = 0; ; pagina++) {
    if (pagina === 10) { truncado = true; break; }
    const prazos: QuerySnapshot = await (cursor ? base.startAfter(...cursor) : base).limit(100).get();
    for (const c of prazos.docs) {
      const d = c.data();
      if (d.testeTugyn === true || d.excluindo === true) continue;
      avisos.push(avisoCT("prazo", c.id, String(d.inscricoesAte), [d.organizadorId as string], ...textosCT.prazo(d, Number(d.aprovados ?? 0), Number(d.maxTimes ?? 0))));
    }
    if (prazos.size < 100) break;
    const ultimo: QueryDocumentSnapshot = prazos.docs[prazos.docs.length - 1];
    cursor = [Number(ultimo.get("inscricoesAte")), ultimo.id];
  }
  // Grupo "jogos" também existe em turmas/{id}/jogos: só valem os que estão dentro de campeonatosTimes.
  const janela = db.collectionGroup("jogos").where("quando", ">", agora + 12 * HORA).where("quando", "<=", agora + 24 * HORA).orderBy("quando");
  const porCampeonato = new Map<string, JogoCT[]>();
  let ultimoJogo: QueryDocumentSnapshot | null = null;
  for (let pagina = 0; ; pagina++) {
    if (pagina === 20) { truncado = true; break; }
    const js: QuerySnapshot = await (ultimoJogo ? janela.startAfter(ultimoJogo) : janela).limit(300).get();
    for (const s of js.docs) {
      const camp = s.ref.parent.parent;
      if (!camp || camp.parent.id !== COLECAO_CT) continue;
      const j = { ...s.data(), id: s.id } as JogoCT;
      if (j.status !== "pendente" || !j.casa || !j.fora) continue;
      porCampeonato.set(camp.id, [...(porCampeonato.get(camp.id) ?? []), j]);
    }
    if (js.size < 300) break;
    ultimoJogo = js.docs[js.docs.length - 1];
  }
  for (const [cid, jogos] of porCampeonato) {
    const c = await db.collection(COLECAO_CT).doc(cid).get();
    if (!c.exists || c.get("status") !== "em_andamento" || c.get("testeTugyn") === true || c.get("excluindo") === true) continue;
    const lados = await Promise.all([...new Set(jogos.flatMap((j) => [j.casa as string, j.fora as string]))].map((tid) => c.ref.collection("inscricoes").doc(tid).get()));
    const porTime = new Map(lados.filter((s) => s.exists).map((s) => [s.id, s.data() as InscricaoCT]));
    for (const j of jogos) {
      const casa = porTime.get(j.casa as string), fora = porTime.get(j.fora as string);
      avisos.push(avisoCT("lembrete", c.id, `${j.id}_${j.quando}`, [...timeTodo(casa), ...timeTodo(fora)], ...textosCT.lembrete(dados(c), casa?.timeNome ?? "", fora?.timeNome ?? "", Number(j.quando), typeof j.local === "string" ? j.local : "")));
    }
  }
  const validos = avisos.filter((a): a is Aviso => Boolean(a));
  // Sem transação de ação aqui: `enviarAviso` cria o registro da chave na fila (e não repete uma chave já enviada).
  await dispararAvisosCT(db, validos);
  return { prazos: validos.filter((a) => a.dedupeKey.startsWith("ct_prazo_")).length, lembretes: validos.filter((a) => a.dedupeKey.startsWith("ct_lembrete_")).length, truncado };
}

/** Modelos de troféu salvos da conta (até 10, num documento só: 1 leitura para abrir o editor). */
export async function lerModelosTrofeuCT(db: Firestore, uid: string): Promise<Dados> {
  const s = await db.doc(`users/${uid}/restrito/modelosTrofeu`).get();
  return { modelos: modelosGravados(s.get("modelos")) };
}

/**
 * Adiciona ou remove UM modelo, sempre sobre a lista atual lida na transação (nunca a lista que o aparelho tinha): dois
 * aparelhos salvando ao mesmo tempo ficam com os dois modelos; remover um id que já saiu não apaga mais nada.
 * Conta suspensa ou em exclusão não grava. Devolve a lista confirmada.
 */
export async function alterarModelosTrofeuCT(db: Firestore, uid: string, body: Dados, novoId: () => string = () => randomBytes(6).toString("hex")): Promise<Dados> {
  const operacao = body.operacao;
  exigirCT(operacao === "adicionar" || operacao === "remover", "Operação inválida.");
  let novo: { nome: string; desenho: string } | null = null, removerId: string | null = null;
  if (operacao === "adicionar") {
    const nome = nomeDoModelo(body.nome), desenho = normalizarDesenhoTrofeu(body.desenho);
    exigirCT(nome, "Dê um nome de até 30 letras ao modelo.");
    exigirCT(desenho, "O troféu é inválido. Monte-o de novo no editor.");
    novo = { nome, desenho };
  } else {
    exigirCT(typeof body.id === "string" && ID_MODELO_TROFEU.test(body.id), "Modelo inválido.");
    removerId = body.id;
  }
  const ref = db.doc(`users/${uid}/restrito/modelosTrofeu`);
  return db.runTransaction(async (tx) => {
    await autorUsuario(tx, db, uid);
    const atuais = modelosGravados((await tx.get(ref)).get("modelos"));
    let modelos = atuais;
    if (novo) {
      // Repetir o mesmo pedido (toque duplo, nova tentativa) não cria uma cópia.
      if (!atuais.some((m) => m.nome === novo!.nome && m.desenho === novo!.desenho)) {
        exigirCT(atuais.length < MAX_MODELOS_TROFEU, `Você já tem ${MAX_MODELOS_TROFEU} modelos. Apague um para salvar outro.`, 409);
        let id = novoId();
        while (atuais.some((m) => m.id === id)) id = novoId();
        modelos = [{ id, ...novo }, ...atuais];
      }
    } else modelos = atuais.filter((m) => m.id !== removerId);
    if (modelos !== atuais) tx.set(ref, { modelos, atualizadoEm: Date.now() });
    return { modelos };
  });
}
