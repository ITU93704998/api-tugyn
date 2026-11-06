import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAuth, type Auth } from "firebase-admin/auth";
import { FieldPath, FieldValue, Timestamp, getFirestore, type Firestore, type Query } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { ALERTA_TENTATIVAS, RETOMAR_APOS_MS, deveProcessar } from "./exclusaoConta";
import { COLECAO_EXCLUSOES, processarJob } from "./exclusaoContaJob";
import { consultar, parseMotivo, MOTIVO_MAX, MOTIVO_MIN } from "./moderacao";
import { dentroDoLimite } from "./rateLimit";
import { MAX_MEMBROS_RESUMO, PENDENCIAS, reconstruirResumoDaTurma, recalcularDaPartida } from "./recalculos";
import { CATEGORIAS, RELATOS, STATUS_RELATO, type Categoria, type StatusRelato } from "./relatos";
import { isSafeUid } from "./validation";

/**
 * Ferramentas de suporte do painel: POST /api/version?resource=suporte (só administradores).
 *
 *  turma-buscar     { termo }       → até 20 turmas pelo identificador, pelo código de convite (6 letras) ou pelo começo do nome
 *  turma-ficha      { id }          → dados, membros, partidas recentes, organizador temporário, resumo (e se a lista de membros
 *                                     do ranking bate com a oficial), pendências de recálculo e moderação. Fica em `adminAcessos`.
 *  turma-resumo     { id, motivo }  → reconstrói o resumo da turma a partir dos participantes (o mesmo do app)
 *  turma-recalcular { id, motivo }  → recalcula o resumo geral de todos os membros aprovados (o que não couber no tempo
 *                                     fica na fila durável `recalculosPendentes`, que a rotina termina)
 *  sessoes-encerrar { id, motivo }  → revoga as sessões da conta (o app pede login de novo; não suspende)
 *  exclusoes        {}              → exclusões de conta em andamento (as travadas e as paradas há mais tempo primeiro)
 *  exclusao-retomar { id }          → roda agora a retomada de uma exclusão parada (com reserva: uma retomada por vez)
 *  relatos          { status?, depoisDe? } → caixa de relatos do app, do mais recente ao mais antigo, em páginas (sem e-mail)
 *  relato           { id }          → um relato com o e-mail da conta (registrado em `adminAcessos`)
 *  relato-atualizar { id, status, nota, versao } → muda a situação e a nota (recusa se outro administrador mudou antes)
 *
 * Toda ação que muda algo grava `suporteLog/{id}` ANTES de agir ({ acao, alvoId, adminUid, motivo, estado: "iniciada" }) e
 * atualiza depois ("concluida" + resultado, ou "falhou" + erro). Se a ação deu certo mas o fechamento do registro falhar,
 * a resposta é de sucesso com `registroIncompleto: true` (nunca um erro que sugira que nada aconteceu).
 */

const ACESSOS = "adminAcessos";
export const LOG = "suporteLog";
const BUSCA_MAX = 20;
/** Membros mostrados na tela; a análise usa todos (até o limite do domínio + folga). */
const MEMBROS_NA_TELA = 200;
const MEMBROS_LEITURA = MAX_MEMBROS_RESUMO + 50;
const PARTIDAS_RECENTES = 10;
const EXCLUSOES_MAX = 50;
export const RELATOS_PAGINA = 50;
const NOTA_MAX = 1000;
/** Recálculo pelo painel: lotes pequenos, até este tempo (a função da Vercel tem 60 s); o resto fica na fila durável. */
const RECALCULO_LOTE = 16;
const RECALCULO_PRAZO_MS = 20_000;
/** Reserva da retomada de uma exclusão: outra retomada (painel ou rotina) espera este tempo. */
export const RESERVA_RETOMADA_MS = 5 * 60_000;
const CODIGO_CONVITE = /^[A-HJKMNP-Z2-9]{6}$/;

type Dados = Record<string, unknown>;

export class Recusa extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const txt = (v: unknown, max = 120): string => (typeof v === "string" ? v.slice(0, max) : "");
const ms = (v: unknown): number => {
  const fn = (v as { toMillis?: unknown } | null)?.toMillis;
  if (typeof fn === "function") {
    const n = fn.call(v);
    return Number.isFinite(n) ? n : 0;
  }
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const inteiro = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const mensagem = (erro: unknown) => String((erro as Error)?.message ?? erro).slice(0, 300);

async function registrarAcesso(db: Firestore, adminUid: string, alvoId: string, tipo: "turma" | "relato"): Promise<void> {
  await db.collection(ACESSOS).add({ adminUid, alvoId, tipo, em: FieldValue.serverTimestamp() });
}

/**
 * Executa uma ação administrativa com registro durável: grava a intenção antes (se isso falhar, nada é feito), roda a ação
 * e fecha o registro com o resultado. Falha da ação: registro "falhou" (melhor esforço) e o erro segue. Falha só no
 * fechamento: devolve o resultado com `registroIncompleto` (a ação aconteceu).
 */
export async function executarComRegistro<T extends Dados>(
  db: Firestore,
  acao: string,
  alvoId: string,
  adminUid: string,
  motivo: string,
  efeito: () => Promise<T>,
): Promise<T & { operacaoId: string; registroIncompleto?: true }> {
  const ref = db.collection(LOG).doc();
  await ref.set({ acao, alvoId, adminUid, motivo, estado: "iniciada", em: FieldValue.serverTimestamp() });
  let resultado: T;
  try {
    resultado = await efeito();
  } catch (erro) {
    await ref
      .update({ estado: "falhou", erro: erro instanceof Recusa ? erro.message : mensagem(erro), terminadaEm: FieldValue.serverTimestamp() })
      .catch(() => undefined);
    throw erro;
  }
  try {
    await ref.update({ estado: "concluida", resultado, terminadaEm: FieldValue.serverTimestamp() });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "suporte_registro_incompleto", acao, operacaoId: ref.id, message: mensagem(erro) }));
    return { ...resultado, operacaoId: ref.id, registroIncompleto: true };
  }
  console.log(JSON.stringify({ evt: "suporte", acao }));
  return { ...resultado, operacaoId: ref.id };
}

// ───────────────────────────── turmas ─────────────────────────────

export interface TurmaResumo {
  id: string;
  nome: string;
  organizador: string;
  membros: number;
  situacao: "ativa" | "encerrada";
  modalidade: string;
}

const situacaoDaTurma = (d: Dados): "ativa" | "encerrada" => (d.status === "encerrada" || d.ativo === false ? "encerrada" : "ativa");

const resumoDaTurma = (id: string, d: Dados): TurmaResumo => ({
  id,
  nome: txt(d.nome, 80),
  organizador: txt(d.creatorName, 80),
  membros: lista(d.participantes).length,
  situacao: situacaoDaTurma(d),
  modalidade: txt(d.modalidade, 20),
});

export type TipoBuscaTurma = "id" | "codigo" | "nome";
export const tipoBuscaTurma = (termo: string): TipoBuscaTurma => {
  if (CODIGO_CONVITE.test(termo.toUpperCase()) && termo.length === 6 && !/\s/.test(termo)) return "codigo";
  if (termo.length >= 15 && isSafeUid(termo)) return "id";
  return "nome";
};

/** Começo do nome como foi digitado e com a 1ª letra maiúscula (o Firestore diferencia maiúsculas). */
export const variantesDoNome = (termo: string): string[] => {
  const t = termo.trim();
  const capital = t.charAt(0).toLocaleUpperCase("pt-BR") + t.slice(1);
  return [...new Set([t, capital, t.toLocaleLowerCase("pt-BR")])].filter((v) => v.length >= 2);
};

export async function buscarTurmas(db: Firestore, termo: string): Promise<TurmaResumo[]> {
  const tipo = tipoBuscaTurma(termo);
  const achadas = new Map<string, TurmaResumo>();
  const add = (id: string, d: Dados | undefined) => {
    if (d && !achadas.has(id)) achadas.set(id, resumoDaTurma(id, d));
  };
  // Um código de convite também pode ser o começo de um nome: procura dos dois jeitos.
  if (tipo === "codigo") {
    const snap = await db.collection("turmas").where("codigoConvite", "==", termo.toUpperCase()).limit(5).get();
    snap.docs.forEach((d) => add(d.id, d.data()));
  }
  if (isSafeUid(termo)) {
    const snap = await db.doc(`turmas/${termo}`).get();
    if (snap.exists) add(snap.id, snap.data());
    if (tipo === "id") return [...achadas.values()];
  }
  for (const v of variantesDoNome(termo)) {
    if (achadas.size >= BUSCA_MAX) break;
    const snap = await db.collection("turmas").where("nome", ">=", v).where("nome", "<", v + "").limit(BUSCA_MAX).get();
    snap.docs.forEach((d) => add(d.id, d.data()));
  }
  return [...achadas.values()].slice(0, BUSCA_MAX);
}

export interface MembroDaFicha {
  uid: string;
  nome: string;
  status: string;
  jogos: number;
  gols: number;
  assistencias: number;
  /** Está em `turma.participantes` (lista que dá acesso) — deve bater com status "aprovado". */
  naLista: boolean;
}

export interface FichaDaTurma {
  turma: TurmaResumo & {
    organizadorId: string;
    criadaEm: number;
    ultimaAtividade: number;
    codigoConvite: string;
    encerradaPelaModeracao: boolean;
    temporario: { uid: string; nome: string; desde: number; expirado: boolean } | null;
  };
  /** Os primeiros 200 para a tela (`membrosNaTela`); a análise abaixo usa todos os documentos lidos. */
  membros: MembroDaFicha[];
  membrosAlemDoLimite: boolean;
  /** A turma tem mais documentos de participante do que a leitura cobre: contagens e diagnóstico ficam indeterminados. */
  analiseParcial: boolean;
  contagem: Record<string, number>;
  partidas: Array<{ id: string; nome: string; data: string; jogadores: number; gols: number; enviadaPor: string; salvaEm: number; corrigivelAte: number }>;
  /** Compara QUEM está no ranking com a lista oficial (não confere gols/assistências). `diverge: null` = não deu para saber. */
  resumo: { existe: boolean; membros: number; atualizadoEm: number; faltando: number | null; sobrando: number | null; diverge: boolean | null };
  pendencias: { jogadores: number; maisAntigaEm: number };
  /** Membros com lista e situação diferentes. null = análise parcial. */
  inconsistencias: number | null;
  moderacao: Awaited<ReturnType<typeof consultar>>;
}

const DIA = 86_400_000;

/** Compara o resumo com a lista oficial (aprovados em `participantes`). Pura: testada sem Firestore. */
export const compararResumo = (aprovadosNaLista: Iterable<string>, membrosDoResumo: Iterable<string>) => {
  const oficial = new Set(aprovadosNaLista);
  const resumo = new Set(membrosDoResumo);
  const faltando = [...oficial].filter((u) => !resumo.has(u)).length;
  const sobrando = [...resumo].filter((u) => !oficial.has(u)).length;
  return { faltando, sobrando, diverge: faltando + sobrando > 0 };
};

/**
 * Diagnóstico da ficha a partir dos documentos lidos. `completo: false` (havia mais documentos do que os lidos): nada é
 * classificado como faltando/sobrando/inconsistente, porque o que ficou de fora pode estar certo. Pura: testada sem Firestore.
 */
export const diagnosticarTurma = (
  participantesDaTurma: unknown,
  docs: Array<{ id: string; status: string }>,
  completo: boolean,
  resumo: { existe: boolean; membros: string[] },
) => {
  const naLista = new Set(lista(participantesDaTurma));
  const contagem: Record<string, number> = {};
  for (const d of docs) contagem[d.status] = (contagem[d.status] ?? 0) + 1;
  if (!completo) {
    return { contagem, inconsistencias: null, comparacao: { faltando: null, sobrando: null, diverge: null } };
  }
  const aprovadosNaLista = docs.filter((d) => d.status === "aprovado" && naLista.has(d.id)).map((d) => d.id);
  const ids = new Set(docs.map((d) => d.id));
  const inconsistencias =
    docs.filter((d) => (d.status === "aprovado") !== naLista.has(d.id)).length + [...naLista].filter((u) => !ids.has(u)).length;
  const comparacao = resumo.existe
    ? compararResumo(aprovadosNaLista, resumo.membros)
    : { faltando: aprovadosNaLista.length, sobrando: 0, diverge: true };
  return { contagem, inconsistencias, comparacao };
};

export async function fichaDaTurma(db: Firestore, id: string, adminUid: string, agora = Date.now()): Promise<FichaDaTurma> {
  const [turmaSnap, participantesSnap, partidasSnap, resumoSnap, pendSnap] = await Promise.all([
    db.doc(`turmas/${id}`).get(),
    db.collection(`turmas/${id}/participantes`).limit(MEMBROS_LEITURA + 1).get(),
    db.collection(`turmas/${id}/partidas`).orderBy("salvadoEm", "desc").limit(PARTIDAS_RECENTES).get(),
    db.doc(`turmas/${id}/resumo/atual`).get(),
    db.doc(`${PENDENCIAS}/${id}`).get(),
  ]);
  if (!turmaSnap.exists) throw new Recusa(404, "Turma não encontrada.");
  const d = (turmaSnap.data() ?? {}) as Dados;
  const naLista = new Set(lista(d.participantes));
  const completo = participantesSnap.docs.length <= MEMBROS_LEITURA;
  const lidos = participantesSnap.docs.slice(0, MEMBROS_LEITURA);
  const todos: MembroDaFicha[] = lidos.map((p) => {
    const pd = p.data() as Dados;
    return {
      uid: p.id,
      nome: txt(pd.nome, 80),
      status: txt(pd.status, 20) || "desconhecido",
      jogos: inteiro(pd.jogos),
      gols: inteiro(pd.gols),
      assistencias: inteiro(pd.assistencias),
      naLista: naLista.has(p.id),
    };
  });
  const membrosDoResumo = resumoSnap.exists ? Object.keys(((resumoSnap.get("membros") ?? {}) as Dados)) : [];
  const diag = diagnosticarTurma(d.participantes, todos.map((m) => ({ id: m.uid, status: m.status })), completo, { existe: resumoSnap.exists, membros: membrosDoResumo });

  const pendentes = pendSnap.exists ? ((pendSnap.get("pendentes") ?? {}) as Dados) : {};
  const marcas = Object.values(pendentes).map(ms).filter((n) => n > 0);

  const temp = (d.organizadorTemporario ?? null) as Dados | null;
  const desde = temp ? ms(temp.desde) : 0;
  const moderacao = await consultar(db, "turma", id);
  await registrarAcesso(db, adminUid, id, "turma");

  return {
    turma: {
      ...resumoDaTurma(id, d),
      organizadorId: txt(d.creatorId, 128),
      criadaEm: ms(d.createdAt) || ms(d.criadaEm),
      ultimaAtividade: ms(d.ultimaAtividade),
      codigoConvite: txt(d.codigoConvite, 10),
      encerradaPelaModeracao: d.encerradaPor === "moderacao",
      temporario: temp && isSafeUid(temp.uid) ? { uid: temp.uid as string, nome: txt(temp.nome, 80), desde, expirado: desde > 0 && agora - desde > DIA } : null,
    },
    membros: todos.slice(0, MEMBROS_NA_TELA),
    membrosAlemDoLimite: todos.length > MEMBROS_NA_TELA || !completo,
    analiseParcial: !completo,
    contagem: diag.contagem,
    partidas: partidasSnap.docs.map((p) => {
      const pd = p.data() as Dados;
      return {
        id: p.id,
        nome: txt(pd.nome, 80),
        data: txt(pd.data, 40),
        jogadores: inteiro(pd.totalJogadores),
        gols: inteiro(pd.totalGols),
        enviadaPor: txt(pd.enviadaPor, 128),
        salvaEm: ms(pd.salvadoEm),
        corrigivelAte: ms(pd.corrigivelAte),
      };
    }),
    resumo: { existe: resumoSnap.exists, membros: membrosDoResumo.length, atualizadoEm: resumoSnap.exists ? ms(resumoSnap.get("atualizadoEm")) : 0, ...diag.comparacao },
    pendencias: { jogadores: marcas.length, maisAntigaEm: marcas.length ? Math.min(...marcas) : 0 },
    inconsistencias: diag.inconsistencias,
    moderacao,
  };
}

async function reconstruirResumo(db: Firestore, id: string) {
  const snap = await db.doc(`turmas/${id}`).get();
  if (!snap.exists) throw new Recusa(404, "Turma não encontrada.");
  const membros = await reconstruirResumoDaTurma(db, id, snap.get("participantes"));
  return { membros };
}

async function recalcularTurma(db: Firestore, id: string) {
  const snap = await db.doc(`turmas/${id}`).get();
  if (!snap.exists) throw new Recusa(404, "Turma não encontrada.");
  const naLista = new Set(lista(snap.get("participantes")));
  const aprovados = await db.collection(`turmas/${id}/participantes`).where("status", "==", "aprovado").select().get();
  const uids = aprovados.docs.map((p) => p.id).filter((u) => naLista.has(u) && isSafeUid(u));
  if (!uids.length) return { total: 0, recalculados: 0, naFila: 0, falhas: 0 };
  // Primeiro a marca durável (a mesma do envio de partida): se o tempo acabar ou algo falhar, a rotina termina.
  await db.doc(`${PENDENCIAS}/${id}`).set(
    { pendentes: Object.fromEntries(uids.map((u) => [u, FieldValue.serverTimestamp()])), atualizadoEm: FieldValue.serverTimestamp() },
    { merge: true },
  );
  const fim = Date.now() + RECALCULO_PRAZO_MS;
  let recalculados = 0;
  let falhas = 0;
  let processados = 0;
  for (let i = 0; i < uids.length && Date.now() < fim; i += RECALCULO_LOTE) {
    const lote = uids.slice(i, i + RECALCULO_LOTE);
    const falhos = await recalcularDaPartida(db, id, lote);
    processados += lote.length;
    falhas += falhos.length;
    recalculados += lote.length - falhos.length;
  }
  return { total: uids.length, recalculados, naFila: uids.length - processados + falhas, falhas };
}

// ───────────────────────────── contas ─────────────────────────────

async function encerrarSessoes(auth: Auth, id: string) {
  try {
    await auth.revokeRefreshTokens(id);
  } catch (erro) {
    if ((erro as { code?: string })?.code === "auth/user-not-found") throw new Recusa(404, "Conta não encontrada.");
    throw erro;
  }
  return { ok: true };
}

export interface ExclusaoEmAndamento {
  uid: string;
  estado: "excluindo" | "pos_exclusao";
  iniciadaEm: number;
  atualizadaEm: number;
  contaExcluidaEm: number;
  rodadas: number;
  pendencias: string[];
  bloqueio: string;
  travada: boolean;
  podeRetomar: boolean;
  /** Há uma retomada em curso (reserva válida) até este horário. */
  retomadaAte: number;
}

/** Reserva de retomada ainda válida? */
export const reservaAtiva = (d: Dados, agora: number): boolean => ms(d.retomadaAte) > agora;

/** Leitura de um job de exclusão. Pura: testada sem Firestore. */
export const lerExclusao = (uid: string, d: Dados, agora: number): ExclusaoEmAndamento => {
  const estado = d.estado === "pos_exclusao" ? "pos_exclusao" : "excluindo";
  const atualizadaEm = ms(d.atualizadaEm);
  const rodadas = inteiro(d.rodadas);
  const parada = estado === "excluindo" && agora - atualizadaEm >= RETOMAR_APOS_MS;
  return {
    uid,
    estado,
    iniciadaEm: ms(d.iniciadaEm),
    atualizadaEm,
    contaExcluidaEm: ms(d.contaExcluidaEm),
    rodadas,
    pendencias: lista(d.pendencias).map((p) => p.slice(0, 80)).slice(0, 20),
    bloqueio: txt(d.bloqueio, 200),
    travada: rodadas >= ALERTA_TENTATIVAS || parada,
    podeRetomar: deveProcessar({ estado, atualizadaEmMs: atualizadaEm }, agora) && !reservaAtiva(d, agora),
    retomadaAte: reservaAtiva(d, agora) ? ms(d.retomadaAte) : 0,
  };
};

/**
 * As travadas (3+ rodadas) e as paradas há mais tempo primeiro, em duas consultas (cada uma com índice simples), e o total.
 * Assim uma exclusão com problema nunca fica fora da lista por causa da ordem dos ids.
 */
async function listarExclusoes(db: Firestore, agora = Date.now()) {
  const col = db.collection(COLECAO_EXCLUSOES);
  const [travadas, antigas, total] = await Promise.all([
    col.where("rodadas", ">=", ALERTA_TENTATIVAS).limit(EXCLUSOES_MAX).get(),
    col.orderBy("atualizadaEm", "asc").limit(EXCLUSOES_MAX).get(),
    col.count().get(),
  ]);
  const vistos = new Map<string, ExclusaoEmAndamento>();
  for (const d of [...travadas.docs, ...antigas.docs]) if (!vistos.has(d.id)) vistos.set(d.id, lerExclusao(d.id, d.data() as Dados, agora));
  const itens = [...vistos.values()].sort((a, b) => Number(b.travada) - Number(a.travada) || a.atualizadaEm - b.atualizadaEm);
  const n = total.data().count;
  return { exclusoes: itens, total: n, alemDoLimite: n > itens.length };
}

/** Reserva o job para esta retomada (transação). Recusa se outra retomada estiver em curso ou se não estiver parado. */
async function reservarRetomada(db: Firestore, id: string, adminUid: string): Promise<boolean> {
  const ref = db.doc(`${COLECAO_EXCLUSOES}/${id}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const agora = Date.now();
    const d = (snap.data() ?? {}) as Dados;
    if (reservaAtiva(d, agora)) throw new Recusa(409, "Outra retomada desta exclusão está em andamento. Tente de novo em alguns minutos.");
    const atual = lerExclusao(id, d, agora);
    // Exclusão começada há menos de 1 h pode estar rodando agora (a pessoa no app): não corre junto.
    if (!atual.podeRetomar) throw new Recusa(409, "Esta exclusão começou há pouco e ainda pode estar em andamento. Tente de novo em 1 hora.");
    tx.update(ref, { retomadaAte: Timestamp.fromMillis(agora + RESERVA_RETOMADA_MS), retomadaPor: adminUid });
    return true;
  });
}

async function retomarExclusao(db: Firestore, id: string, adminUid: string) {
  const ref = db.doc(`${COLECAO_EXCLUSOES}/${id}`);
  if (!(await reservarRetomada(db, id, adminUid))) return { concluida: true, exclusao: null };
  let concluida = false;
  try {
    concluida = await processarJob(db, id);
  } finally {
    // Libera a reserva (se o job ainda existe). Falhar aqui só faz a reserva vencer sozinha em 5 min.
    await ref.update({ retomadaAte: FieldValue.delete(), retomadaPor: FieldValue.delete() }).catch(() => undefined);
  }
  const depois = await ref.get();
  return { concluida, exclusao: depois.exists ? lerExclusao(id, depois.data() as Dados, Date.now()) : null };
}

// ───────────────────────────── relatos ─────────────────────────────

export interface Relato {
  id: string;
  uid: string;
  categoria: Categoria;
  texto: string;
  versao: string;
  plataforma: string;
  sistema: string;
  modelo: string;
  status: StatusRelato;
  nota: string;
  criadoEm: number;
  atualizadoEm: number;
}

export const lerRelato = (id: string, d: Dados): Relato => ({
  id,
  uid: txt(d.uid, 128),
  categoria: (CATEGORIAS as readonly unknown[]).includes(d.categoria) ? (d.categoria as Categoria) : "outro",
  texto: txt(d.texto, 2000),
  versao: txt(d.versao, 20),
  plataforma: txt(d.plataforma, 10),
  sistema: txt(d.sistema, 30),
  modelo: txt(d.modelo, 60),
  status: (STATUS_RELATO as readonly unknown[]).includes(d.status) ? (d.status as StatusRelato) : "aberto",
  nota: txt(d.nota, NOTA_MAX),
  criadoEm: ms(d.criadoEm),
  atualizadoEm: ms(d.atualizadoEm),
});

/**
 * Cursor da página seguinte: o criadoEm EXATO do último relato (segundos + nanossegundos do Timestamp) e o id.
 * Não usar milissegundos: o serverTimestamp tem precisão de microssegundos, e o startAfter com o valor arredondado
 * cairia antes do último relato, escondendo os que empatam no mesmo milissegundo.
 */
export interface CursorRelatos {
  s: number;
  n: number;
  id: string;
}

export const parseCursor = (v: unknown): CursorRelatos | null => {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Dados;
  return typeof c.s === "number" && Number.isSafeInteger(c.s) && c.s > 0 &&
    typeof c.n === "number" && Number.isInteger(c.n) && c.n >= 0 && c.n <= 999_999_999 &&
    typeof c.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(c.id)
    ? { s: c.s, n: c.n, id: c.id }
    : null;
};

/** Cursor a partir do relato (null se o criadoEm não for um Timestamp). */
export const cursorDoRelato = (id: string, criadoEm: unknown): CursorRelatos | null => {
  const t = criadoEm as { seconds?: unknown; nanoseconds?: unknown } | null;
  return t && typeof t === "object" && typeof t.seconds === "number" && typeof t.nanoseconds === "number"
    ? parseCursor({ s: t.seconds, n: t.nanoseconds, id })
    : null;
};

/**
 * Do mais recente ao mais antigo, com desempate pelo id, ordenado NO SERVIDOR antes do limite (o filtro por situação usa o
 * índice composto status + criadoEm desc). `proximo` é o cursor da página seguinte (null = acabou).
 */
export async function listarRelatos(db: Firestore, status: StatusRelato | null, depoisDe: CursorRelatos | null) {
  const base = db.collection(RELATOS);
  let q: Query = status ? base.where("status", "==", status) : base;
  q = q.orderBy("criadoEm", "desc").orderBy(FieldPath.documentId(), "desc");
  if (depoisDe) q = q.startAfter(new Timestamp(depoisDe.s, depoisDe.n), depoisDe.id);
  const [snap, abertos] = await Promise.all([q.limit(RELATOS_PAGINA + 1).get(), base.where("status", "==", "aberto").count().get()]);
  const docs = snap.docs.slice(0, RELATOS_PAGINA);
  const relatos = docs.map((d) => lerRelato(d.id, d.data() as Dados));
  const ultimo = docs[docs.length - 1];
  const proximo = snap.docs.length > RELATOS_PAGINA && ultimo ? cursorDoRelato(ultimo.id, ultimo.get("criadoEm")) : null;
  if (snap.docs.length > RELATOS_PAGINA && !proximo) console.warn(JSON.stringify({ evt: "relatos_cursor_invalido", id: ultimo?.id }));
  return { relatos, abertos: abertos.data().count, proximo };
}

async function abrirRelato(db: Firestore, auth: Auth, id: string, adminUid: string) {
  const snap = await db.doc(`${RELATOS}/${id}`).get();
  if (!snap.exists) throw new Recusa(404, "Relato não encontrado.");
  const relato = lerRelato(id, snap.data() as Dados);
  let email = "";
  let nome = "";
  let contaExiste = false;
  let emailIndisponivel = false;
  if (isSafeUid(relato.uid)) {
    const [conta, perfil] = await Promise.all([
      auth.getUser(relato.uid).catch((erro: unknown) => {
        // Só "não existe" quer dizer conta excluída; qualquer outra falha é indisponibilidade (avisada na tela).
        if ((erro as { code?: string })?.code !== "auth/user-not-found") emailIndisponivel = true;
        return null;
      }),
      db.doc(`users/${relato.uid}`).get(),
    ]);
    email = txt(conta?.email, 200);
    nome = txt(perfil.exists ? perfil.get("name") : conta?.displayName, 80);
    contaExiste = Boolean(conta) || perfil.exists || emailIndisponivel;
  }
  await registrarAcesso(db, adminUid, id, "relato");
  return { relato, email, nome, contaExiste, emailIndisponivel };
}

export const parseNota = (v: unknown): string | null => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const limpo = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim();
  return limpo.length <= NOTA_MAX ? limpo : null;
};

/** Atualiza com precondição: `versao` é o `atualizadoEm` que o painel leu. Mudou no meio? Recusa com 409. */
async function atualizarRelato(db: Firestore, id: string, status: StatusRelato, nota: string, versao: number, adminUid: string) {
  const ref = db.doc(`${RELATOS}/${id}`);
  const antes = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Recusa(404, "Relato não encontrado.");
    const atual = lerRelato(id, snap.data() as Dados);
    if (atual.atualizadoEm !== versao) throw new Recusa(409, "Outro administrador alterou este relato. Recarregue para ver a versão atual.");
    tx.update(ref, { status, nota, atualizadoEm: FieldValue.serverTimestamp(), atualizadoPor: adminUid });
    return { status: atual.status, nota: atual.nota };
  });
  const depois = await ref.get();
  return { relato: lerRelato(id, depois.data() as Dados), antes };
}

// ───────────────────────────── rota ─────────────────────────────

const ACOES_COM_MOTIVO = new Set(["turma-resumo", "turma-recalcular", "sessoes-encerrar"]);

export async function handleAdminSuporte(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "moderacao");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Apenas administradores podem usar as ferramentas de suporte." });
  if (!(await dentroDoLimite(user.uid, "admin-suporte", 60, 60))) return res.status(429).json({ error: "Muitas ações seguidas. Aguarde um minuto." });

  const body = (req.body ?? {}) as Dados;
  const acao = String(body.action ?? "");
  try {
    const app = getFirebaseApp();
    const db = getFirestore(app);
    if (acao === "turma-buscar") {
      const termo = typeof body.termo === "string" ? body.termo.trim() : "";
      if (termo.length < 2 || termo.length > 80) return res.status(400).json({ error: "Digite de 2 a 80 caracteres." });
      return res.status(200).json({ turmas: await buscarTurmas(db, termo) });
    }
    if (acao === "exclusoes") return res.status(200).json(await listarExclusoes(db));
    if (acao === "relatos") {
      const status = (STATUS_RELATO as readonly unknown[]).includes(body.status) ? (body.status as StatusRelato) : null;
      if (body.depoisDe !== undefined && body.depoisDe !== null && !parseCursor(body.depoisDe)) return res.status(400).json({ error: "Página inválida." });
      return res.status(200).json(await listarRelatos(db, status, parseCursor(body.depoisDe)));
    }

    if (!isSafeUid(body.id)) return res.status(400).json({ error: "Identificador inválido." });
    const id = body.id;
    let motivo = "";
    if (ACOES_COM_MOTIVO.has(acao)) {
      const m = parseMotivo(body.motivo);
      if (!m) return res.status(400).json({ error: `Escreva o motivo (de ${MOTIVO_MIN} a ${MOTIVO_MAX} caracteres).` });
      motivo = m;
    }
    const registrar = <T extends Dados>(efeito: () => Promise<T>, motivoDoLog = motivo) => executarComRegistro(db, acao, id, user.uid, motivoDoLog, efeito);
    if (acao === "turma-ficha") return res.status(200).json(await fichaDaTurma(db, id, user.uid));
    if (acao === "turma-resumo") return res.status(200).json(await registrar(() => reconstruirResumo(db, id)));
    if (acao === "turma-recalcular") return res.status(200).json(await registrar(() => recalcularTurma(db, id)));
    if (acao === "sessoes-encerrar") {
      if (id === user.uid) return res.status(400).json({ error: "Use “Sair” para encerrar a sua própria sessão." });
      return res.status(200).json(await registrar(() => encerrarSessoes(getAuth(app), id)));
    }
    if (acao === "exclusao-retomar") return res.status(200).json(await registrar(() => retomarExclusao(db, id, user.uid), "retomada pelo painel"));
    if (acao === "relato") return res.status(200).json(await abrirRelato(db, getAuth(app), id, user.uid));
    if (acao === "relato-atualizar") {
      if (!(STATUS_RELATO as readonly unknown[]).includes(body.status)) return res.status(400).json({ error: "Situação inválida." });
      const nota = parseNota(body.nota);
      if (nota === null) return res.status(400).json({ error: `A nota pode ter até ${NOTA_MAX} caracteres.` });
      if (typeof body.versao !== "number" || !Number.isFinite(body.versao)) return res.status(400).json({ error: "Recarregue o relato antes de salvar." });
      const versao = body.versao;
      return res.status(200).json(await registrar(() => atualizarRelato(db, id, body.status as StatusRelato, nota, versao, user.uid), `situação: ${String(body.status)}`));
    }
    return res.status(400).json({ error: "Ação inválida." });
  } catch (erro) {
    if (erro instanceof Recusa) return res.status(erro.status).json({ error: erro.message });
    console.error(JSON.stringify({ evt: "admin_suporte_falhou", acao: acao.slice(0, 20), message: mensagem(erro) }));
    return res.status(503).json({ error: "Não foi possível concluir. Tente novamente." });
  }
}
