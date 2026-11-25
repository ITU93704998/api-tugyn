import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAuth, type Auth, type UserRecord } from "firebase-admin/auth";
import { FieldValue, getFirestore, type Firestore, type Query } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { RecusaMapa, gerarMapa, lerMapa } from "./mapaUsuarios";
import { consultar, type EstadoDoAlvo } from "./moderacao";
import { dentroDoLimite } from "./rateLimit";
import { isSafeUid } from "./validation";

/**
 * Usuários e estatísticas do painel (Tugyn APP › Plataforma): POST /api/version?resource=usuarios, só para a permissão `admin`.
 *
 *  buscar       { termo }  → até 20 contas. Termo com formato de e-mail: busca EXATA no Auth (registrada em `adminAcessos`).
 *                            Termo com formato de uid: a conta. Senão: começo do @ ou do nome (sem diferenciar maiúsculas).
 *  ficha        { id }     → perfil, conta (e-mail, criação, último acesso, provedores), turmas, times, pedido de revisão
 *                            e a situação de moderação (histórico e denúncias). Cada ficha aberta fica em `adminAcessos`.
 *  mapa         {}         → o último mapa de usuários gerado (totais por estado e cidade; 1 leitura). null = nunca gerado.
 *  gerar-mapa   {}         → lê a localização dos perfis e grava o mapa novo (1 leitura por perfil). Uma geração por vez na
 *                            plataforma (409), mapa de menos de 10 min volta sem varrer ({ recente: true }), geração nova
 *                            até 3 por hora por administrador (429); base grande: { andamento: { lidos } } e o próximo
 *                            clique continua de onde parou.
 *  estatisticas { atualizar? } → números da plataforma. Sem `atualizar`: devolve os SALVOS em `sistema/estatisticas`
 *                            (1 leitura; só calcula se nunca foram calculados). Com `atualizar` (botão do painel): refaz
 *                            as contagens do Firestore + a leitura das contas no Auth e salva, se os salvos tiverem mais de 1 min.
 *
 * `adminAcessos/{id}` = { adminUid, alvoId, tipo: "ficha" | "busca-email", em }: quem consultou dados pessoais e quando.
 * Clientes não leem nem gravam essa coleção (as regras do Firestore negam tudo que não está liberado).
 */

const ACESSOS = "adminAcessos";
const BUSCA_MAX = 20;
const TERMO_MIN = 2;
const TERMO_MAX = 80;
const TURMAS_MAX = 50;
const TIMES_MAX = 50;
const DIA_MS = 86_400_000;
/** Leitura das contas no Auth: 1.000 por página, até 50 páginas (50 mil contas) por cálculo. */
const AUTH_PAGINA = 1000;
const AUTH_PAGINAS_MAX = 50;
/** Onde ficam as últimas estatísticas calculadas: abrir a tela lê só este documento. */
export const DOC_ESTATISTICAS = "sistema/estatisticas";
const ATUALIZAR_MIN_MS = 60_000;
const FUSO = "America/Sao_Paulo";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Recusa extends Error {
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
const dataDoAuth = (v: unknown): number => {
  if (typeof v !== "string" || !v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};

// ───────────────────────────── busca ─────────────────────────────

export interface UsuarioResumo {
  uid: string;
  nome: string;
  username: string;
  foto: string;
  cidade: string;
  status: "active" | "suspended";
  criadoEm: number;
}

type Dados = Record<string, unknown>;

const resumo = (uid: string, d: Dados): UsuarioResumo => {
  const loc = (d.location ?? {}) as Dados;
  const cidade = [txt(loc.city, 60), txt(loc.state, 30)].filter(Boolean).join(" / ");
  return {
    uid,
    nome: txt(d.name),
    username: txt(d.userName, 40),
    foto: txt(d.profileImage, 500),
    cidade,
    status: d.status === "suspended" ? "suspended" : "active",
    criadoEm: ms(d.createdAt),
  };
};

/** Termo da busca: texto simples, sem caracteres de controle. */
export const parseTermo = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const limpo = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return limpo.length >= TERMO_MIN && limpo.length <= TERMO_MAX ? limpo : null;
};

export type TipoDeBusca = "email" | "uid" | "texto";
export const tipoDeBusca = (termo: string): TipoDeBusca => {
  if (EMAIL_RE.test(termo)) return "email";
  // uids do Firebase têm 28 caracteres; nomes e @ quase nunca chegam a 20 sem espaço.
  if (termo.length >= 20 && isSafeUid(termo)) return "uid";
  return "texto";
};

async function registrarAcesso(db: Firestore, adminUid: string, alvoId: string, tipo: "ficha" | "busca-email"): Promise<void> {
  await db.collection(ACESSOS).add({ adminUid, alvoId, tipo, em: FieldValue.serverTimestamp() });
}

async function prefixo(db: Firestore, campo: string, t: string): Promise<Array<[string, Dados]>> {
  const snap = await db.collection("users").where(campo, ">=", t).where(campo, "<", t + "").limit(BUSCA_MAX).get();
  return snap.docs.map((d) => [d.id, d.data() as Dados]);
}

export async function buscar(db: Firestore, auth: Auth, termo: string, adminUid: string): Promise<UsuarioResumo[]> {
  const tipo = tipoDeBusca(termo);
  if (tipo === "email") {
    let conta: UserRecord | null = null;
    try {
      conta = await auth.getUserByEmail(termo.toLowerCase());
    } catch (erro) {
      if ((erro as { code?: string })?.code !== "auth/user-not-found") throw erro;
    }
    // A busca por e-mail mexe com dado pessoal: fica registrada mesmo sem resultado (sem guardar o e-mail digitado).
    await registrarAcesso(db, adminUid, conta?.uid ?? "", "busca-email");
    if (!conta) return [];
    const snap = await db.doc(`users/${conta.uid}`).get();
    return [resumo(conta.uid, snap.exists ? ((snap.data() ?? {}) as Dados) : { name: conta.displayName ?? "" })];
  }
  const vistos = new Map<string, UsuarioResumo>();
  // Identificador exato: perfil ou, se não houver perfil (cadastro incompleto), a conta no Auth.
  if (isSafeUid(termo)) {
    const exato = await porIdentificador(db, auth, termo);
    if (exato) vistos.set(exato.uid, exato);
    if (exato && tipo === "uid") return [exato];
  }
  const t = termo.replace(/^@/, "").toLowerCase();
  if (t.length < TERMO_MIN) return [...vistos.values()];
  // O cadastro grava `name_lower` sem acentos; edições antigas gravavam só em minúsculas: procura das duas formas.
  const semAcento = semAcentos(t);
  const consultas = [prefixo(db, "userName_lower", t), prefixo(db, "name_lower", semAcento)];
  if (semAcento !== t) consultas.push(prefixo(db, "name_lower", t), prefixo(db, "userName_lower", semAcento));
  for (const lista of await Promise.all(consultas)) {
    for (const [uid, d] of lista) if (!vistos.has(uid)) vistos.set(uid, resumo(uid, d));
  }
  return [...vistos.values()].slice(0, BUSCA_MAX);
}

/** Mesma normalização do app (`normalizeText`): minúsculas e sem acentos. */
export const semAcentos = (v: string): string => v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function porIdentificador(db: Firestore, auth: Auth, uid: string): Promise<UsuarioResumo | null> {
  const snap = await db.doc(`users/${uid}`).get();
  if (snap.exists) return resumo(uid, (snap.data() ?? {}) as Dados);
  try {
    const conta = await auth.getUser(uid);
    return resumo(uid, { name: conta.displayName ?? "", status: conta.disabled ? "suspended" : "active" });
  } catch (erro) {
    if ((erro as { code?: string })?.code === "auth/user-not-found") return null;
    throw erro;
  }
}

// ───────────────────────────── ficha ─────────────────────────────

export interface FichaDoUsuario {
  perfil: UsuarioResumo & { existe: boolean; publico: boolean };
  /** null: não há conta no Auth (excluída). */
  conta: {
    email: string;
    emailVerificado: boolean;
    provedores: string[];
    criadaEm: number;
    ultimoLogin: number;
    /** Última vez que o app renovou a sessão (o mais perto de "último acesso" que existe). */
    ultimaAtividade: number;
    desativada: boolean;
  } | null;
  turmas: Array<{ id: string; nome: string; organizador: boolean; situacao: "ativa" | "encerrada"; modalidade: string }>;
  /** Há mais turmas/times do que o limite mostrado. */
  turmasAlemDoLimite: boolean;
  timesAlemDoLimite: boolean;
  times: Array<{ id: string; nome: string; dono: boolean }>;
  revisao: { status: string; em: number } | null;
  moderacao: EstadoDoAlvo;
}

export async function ficha(db: Firestore, auth: Auth, uid: string, adminUid: string): Promise<FichaDoUsuario> {
  const [perfilSnap, conta, turmasSnap, timesSnap, revisaoSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    auth.getUser(uid).catch((erro: unknown) => {
      if ((erro as { code?: string })?.code === "auth/user-not-found") return null;
      throw erro;
    }),
    db.collection("turmas").where("participantes", "array-contains", uid).limit(TURMAS_MAX + 1).get(),
    db.collection("times").where("membros", "array-contains", uid).limit(TIMES_MAX + 1).get(),
    db.doc(`revisoes/${uid}`).get(),
  ]);
  if (!perfilSnap.exists && !conta) throw new Recusa(404, "Usuário não encontrado.");

  const d = (perfilSnap.exists ? perfilSnap.data() ?? {} : {}) as Dados;
  const moderacao = await consultar(db, "user", uid, true);
  await registrarAcesso(db, adminUid, uid, "ficha");

  const rev = revisaoSnap.exists ? ((revisaoSnap.data() ?? {}) as Dados) : null;
  return {
    perfil: { ...resumo(uid, perfilSnap.exists ? d : { name: conta?.displayName ?? "" }), existe: perfilSnap.exists, publico: d.isPublic !== false },
    conta: conta
      ? {
          email: txt(conta.email, 200),
          emailVerificado: conta.emailVerified === true,
          provedores: (conta.providerData ?? []).map((p) => txt(p.providerId, 40)).filter(Boolean),
          criadaEm: dataDoAuth(conta.metadata?.creationTime),
          ultimoLogin: dataDoAuth(conta.metadata?.lastSignInTime),
          ultimaAtividade: dataDoAuth(conta.metadata?.lastRefreshTime) || dataDoAuth(conta.metadata?.lastSignInTime),
          desativada: conta.disabled === true,
        }
      : null,
    turmasAlemDoLimite: turmasSnap.docs.length > TURMAS_MAX,
    timesAlemDoLimite: timesSnap.docs.length > TIMES_MAX,
    turmas: turmasSnap.docs.slice(0, TURMAS_MAX).map((t) => {
      const td = t.data() as Dados;
      return {
        id: t.id,
        nome: txt(td.nome),
        organizador: td.creatorId === uid,
        situacao: td.status === "encerrada" || td.ativo === false ? "encerrada" : "ativa",
        modalidade: td.modalidade === "futsal" ? "futsal" : "futebol",
      };
    }),
    times: timesSnap.docs.slice(0, TIMES_MAX).map((t) => {
      const td = t.data() as Dados;
      return { id: t.id, nome: txt(td.nome), dono: td.donoId === uid };
    }),
    revisao: rev ? { status: txt(rev.status, 20), em: ms(rev.criadoEm) } : null,
    moderacao,
  };
}

// ───────────────────────────── estatísticas ─────────────────────────────

export interface Estatisticas {
  geradoEm: number;
  /** A última atualização falhou: estes são os números do cálculo anterior. */
  desatualizado?: boolean;
  /** Contas no Auth. `completo: false` quando passou do limite de leitura (os números de contas são parciais). */
  contas: { total: number; completo: boolean };
  /** Pela última renovação da sessão (lastRefreshTime) ou último login: dia = últimas 24 h, semana = 7 × 24 h, mês = 30 × 24 h. */
  ativos: { dia: number; semana: number; mes: number };
  /** Datas civis de Brasília: semana = os últimos 7 dias do gráfico (com hoje), mês = os 30. */
  cadastros: { semana: number; mes: number; porDia: Array<{ dia: string; total: number }> };
  /** Contagens do Firestore: null quando a contagem falhou (o resto continua). */
  perfis: { total: number | null; suspensos: number | null };
  turmas: { total: number | null; ativas: number | null; comAtividade30d: number | null };
  times: number | null;
  partidas: number | null;
  desafios: number | null;
  moderacao: { denunciasAbertas: number | null; revisoesAbertas: number | null };
  /** Retenção por semana de cadastro (as mais recentes primeiro). */
  retencao: CoorteRetencao[];
  /** Funil de ativação dos cadastros recentes; null quando a leitura falhou. */
  funil: Funil | null;
}

/** Voltou depois de N dias: quantos podiam ter voltado (conta com N dias ou mais) e quantos voltaram. null = ninguém ainda pode. */
export type MarcoRetencao = { elegiveis: number; voltaram: number } | null;

export interface CoorteRetencao {
  /** Segunda-feira da semana de cadastro (AAAA-MM-DD, Brasília). */
  semana: string;
  cadastros: number;
  d1: MarcoRetencao;
  d7: MarcoRetencao;
  d30: MarcoRetencao;
}

export interface Funil {
  /** Janela dos cadastros considerados: de `desdeDias` até `ateDias` dias atrás (a folga dá tempo de a pessoa começar). */
  desdeDias: number;
  ateDias: number;
  contas: number;
  perfil: number;
  turma: number;
  jogou: number;
  /** Passou do limite de leitura: só as contas mais recentes entraram. */
  parcial: boolean;
}

const diaNoFuso = (() => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });
  return (msDia: number): string => f.format(new Date(msDia));
})();

/** Os 30 dias (no fuso de Brasília) que terminam hoje, do mais antigo para hoje. */
export const ultimos30Dias = (agora: number): string[] => {
  const dias: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const dia = diaNoFuso(agora - i * DIA_MS);
    if (dias[dias.length - 1] !== dia) dias.push(dia);
  }
  return dias;
};

/** Junta as contas do Auth (criação e último uso) em totais. Pura: testada sem Auth. */
export function resumirContas(
  contas: Iterable<{ criadaEm: number; ultimoUso: number }>,
  agora: number,
): Pick<Estatisticas, "ativos" | "cadastros"> & { total: number } {
  const dias = ultimos30Dias(agora);
  const porDia = new Map(dias.map((dia) => [dia, 0]));
  const ativos = { dia: 0, semana: 0, mes: 0 };
  let total = 0;
  for (const c of contas) {
    total++;
    const idadeUso = agora - c.ultimoUso;
    if (c.ultimoUso > 0 && idadeUso <= DIA_MS) ativos.dia++;
    if (c.ultimoUso > 0 && idadeUso <= 7 * DIA_MS) ativos.semana++;
    if (c.ultimoUso > 0 && idadeUso <= 30 * DIA_MS) ativos.mes++;
    if (c.criadaEm > 0) {
      const dia = diaNoFuso(c.criadaEm);
      if (porDia.has(dia)) porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
    }
  }
  const serie = dias.map((dia) => ({ dia, total: porDia.get(dia) ?? 0 }));
  const soma = (pontos: typeof serie) => pontos.reduce((s, p) => s + p.total, 0);
  // Mesmas datas civis (Brasília) do gráfico: o cartão e a soma das barras batem.
  return { total, ativos, cadastros: { semana: soma(serie.slice(-7)), mes: soma(serie), porDia: serie } };
}

export const SEMANAS_RETENCAO = 12;
const MARCOS = [1, 7, 30] as const;

/** Segunda-feira (AAAA-MM-DD) da semana de um dia civil "AAAA-MM-DD". */
export const segundaDaSemana = (dia: string): string => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Retenção por semana de cadastro, a partir do Auth (criação e último uso). "Voltou depois de N dias" = o último uso é pelo menos
 * N dias depois da criação: a pessoa usou o app em algum momento depois desse prazo (só temos o ÚLTIMO uso, não cada abertura).
 * Só conta como elegível quem já tem N dias de conta. Pura: testada sem Auth.
 */
export function retencaoPorCoorte(contas: Iterable<{ criadaEm: number; ultimoUso: number }>, agora: number, semanas = SEMANAS_RETENCAO): CoorteRetencao[] {
  const atual = segundaDaSemana(diaNoFuso(agora));
  const chaves: string[] = [];
  for (let i = 0; i < semanas; i++) {
    const d = new Date(`${atual}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    chaves.push(d.toISOString().slice(0, 10));
  }
  type Acc = { cadastros: number; marcos: Record<number, { elegiveis: number; voltaram: number }> };
  const mapa = new Map<string, Acc>(chaves.map((k) => [k, { cadastros: 0, marcos: { 1: { elegiveis: 0, voltaram: 0 }, 7: { elegiveis: 0, voltaram: 0 }, 30: { elegiveis: 0, voltaram: 0 } } }]));
  for (const c of contas) {
    if (!(c.criadaEm > 0) || c.criadaEm > agora) continue;
    const acc = mapa.get(segundaDaSemana(diaNoFuso(c.criadaEm)));
    if (!acc) continue;
    acc.cadastros++;
    for (const n of MARCOS) {
      if (agora - c.criadaEm < n * DIA_MS) continue;
      acc.marcos[n].elegiveis++;
      if (c.ultimoUso - c.criadaEm >= n * DIA_MS) acc.marcos[n].voltaram++;
    }
  }
  const marco = (m: { elegiveis: number; voltaram: number }): MarcoRetencao => (m.elegiveis > 0 ? { ...m } : null);
  return chaves.map((semana) => {
    const a = mapa.get(semana)!;
    return { semana, cadastros: a.cadastros, d1: marco(a.marcos[1]), d7: marco(a.marcos[7]), d30: marco(a.marcos[30]) };
  });
}

export const FUNIL_DESDE_DIAS = 90;
export const FUNIL_ATE_DIAS = 7;
const FUNIL_MAX_CONTAS = 5000;

/** Contas criadas na janela do funil (as mais recentes primeiro, até o limite). Pura. */
export function contasDoFunil(contas: Array<{ uid: string; criadaEm: number }>, agora: number): { uids: string[]; parcial: boolean } {
  const desde = agora - FUNIL_DESDE_DIAS * DIA_MS, ate = agora - FUNIL_ATE_DIAS * DIA_MS;
  const naJanela = contas.filter((c) => c.criadaEm >= desde && c.criadaEm <= ate).sort((a, b) => b.criadaEm - a.criadaEm);
  return { uids: naJanela.slice(0, FUNIL_MAX_CONTAS).map((c) => c.uid), parcial: naJanela.length > FUNIL_MAX_CONTAS };
}

/** Junta as etapas do funil. Pura: cada etapa só conta quem também passou pelas anteriores. */
export function resumirFunil(uids: string[], comPerfil: Set<string>, emTurma: Set<string>, jogaram: Set<string>, parcial: boolean): Funil {
  let perfil = 0, turma = 0, jogou = 0;
  for (const uid of uids) {
    if (!comPerfil.has(uid)) continue;
    perfil++;
    if (!emTurma.has(uid)) continue;
    turma++;
    if (jogaram.has(uid)) jogou++;
  }
  return { desdeDias: FUNIL_DESDE_DIAS, ateDias: FUNIL_ATE_DIAS, contas: uids.length, perfil, turma, jogou, parcial };
}

/** Até 30 valores por array-contains-any (limite do Firestore). */
export const LOTE_TURMAS = 30;
/** Divide os uids em lotes para a consulta de turmas (função pura, testada). */
export function lotesDeUids(uids: string[], tamanho = LOTE_TURMAS): string[][] {
  const lotes: string[][] = [];
  for (let i = 0; i < uids.length; i += tamanho) lotes.push(uids.slice(i, i + tamanho));
  return lotes;
}

/**
 * Lê o que o funil precisa: perfis (só o campo de jogos) e as turmas DESSAS contas.
 * As turmas vêm por array-contains-any em lotes de 30 (índice de participantes que o app já usa): só são lidas turmas
 * que têm alguma conta da janela, nunca a coleção inteira. NÃO há teto fixo de leituras: cada turma devolvida em cada
 * lote conta como leitura, uma turma com contas em vários lotes volta várias vezes e uma conta pode estar em várias
 * turmas. O custo depende desses vínculos e pode passar do número de contas; o log admin_funil_leituras mede o real.
 * `amostraParcial` = a leitura do Auth parou no limite: o funil sai marcado como parcial.
 */
async function calcularFunil(db: Firestore, contas: Array<{ uid: string; criadaEm: number }>, agora: number, amostraParcial = false): Promise<Funil | null> {
  try {
    const janela = contasDoFunil(contas, agora);
    const uids = janela.uids;
    const parcial = janela.parcial || amostraParcial;
    const comPerfil = new Set<string>(), jogaram = new Set<string>(), emTurma = new Set<string>();
    const alvo = new Set(uids);
    for (let i = 0; i < uids.length; i += 100) {
      const refs = uids.slice(i, i + 100).map((uid) => db.doc(`users/${uid}`));
      const snaps = await db.getAll(...refs, { fieldMask: ["estatisticas.jogos"] });
      for (const snap of snaps) {
        if (!snap.exists) continue;
        comPerfil.add(snap.id);
        const jogos = (snap.get("estatisticas.jogos") as unknown);
        if (typeof jogos === "number" && jogos > 0) jogaram.add(snap.id);
      }
    }
    // Só as contas que passaram da etapa do perfil interessam para "em turma".
    const lotes = lotesDeUids(uids.filter((uid) => comPerfil.has(uid)));
    let leiturasTurmas = 0;
    for (let i = 0; i < lotes.length; i += 10) {
      const respostas = await Promise.all(lotes.slice(i, i + 10).map((lote) => db.collection("turmas").where("participantes", "array-contains-any", lote).select("participantes").get()));
      for (const r of respostas) for (const t of r.docs) {
        leiturasTurmas++;
        const lista = t.get("participantes") as unknown;
        if (Array.isArray(lista)) for (const uid of lista) if (typeof uid === "string" && alvo.has(uid)) emTurma.add(uid);
      }
    }
    // Só números, para acompanhar o custo do funil conforme a base cresce.
    console.info(JSON.stringify({ evt: "admin_funil_leituras", perfis: uids.length, lotesTurmas: lotes.length, turmas: leiturasTurmas }));
    return resumirFunil(uids, comPerfil, emTurma, jogaram, parcial);
  } catch (erro) {
    console.error(JSON.stringify({ evt: "admin_funil_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return null;
  }
}

async function* lerContas(auth: Auth): AsyncGenerator<{ uid: string; criadaEm: number; ultimoUso: number } | "limite"> {
  let pagina: string | undefined;
  for (let i = 0; i < AUTH_PAGINAS_MAX; i++) {
    const r = await auth.listUsers(AUTH_PAGINA, pagina);
    for (const u of r.users) {
      yield {
        uid: u.uid,
        criadaEm: dataDoAuth(u.metadata?.creationTime),
        ultimoUso: dataDoAuth(u.metadata?.lastRefreshTime) || dataDoAuth(u.metadata?.lastSignInTime),
      };
    }
    pagina = r.pageToken;
    if (!pagina) return;
  }
  yield "limite";
}

async function contar(q: Query): Promise<number | null> {
  try {
    const snap = await q.count().get();
    const n = snap.data().count;
    return typeof n === "number" ? n : null;
  } catch (erro) {
    console.error(JSON.stringify({ evt: "admin_contagem_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return null;
  }
}

export async function calcularEstatisticas(db: Firestore, auth: Auth, agora = Date.now()): Promise<Estatisticas> {
  const desde30 = new Date(agora - 30 * DIA_MS);
  const contagens = Promise.all([
    contar(db.collection("users")),
    contar(db.collection("users").where("status", "==", "suspended")),
    contar(db.collection("turmas")),
    contar(db.collection("turmas").where("status", "==", "encerrada")),
    contar(db.collection("turmas").where("ativo", "==", false)),
    contar(db.collection("turmas").where("status", "==", "encerrada").where("ativo", "==", false)),
    contar(db.collection("turmas").where("ultimaAtividade", ">=", desde30)),
    contar(db.collection("times")),
    contar(db.collectionGroup("partidas")),
    contar(db.collection("desafios")),
    contar(db.collection("reports").where("status", "==", "open")),
    contar(db.collection("revisoes").where("status", "==", "aberta")),
  ]);

  let completo = true;
  const lidas: Array<{ uid: string; criadaEm: number; ultimoUso: number }> = [];
  for await (const c of lerContas(auth)) {
    if (c === "limite") completo = false;
    else lidas.push(c);
  }
  const contas = resumirContas(lidas, agora);
  const retencao = retencaoPorCoorte(lidas, agora);
  // Leitura do Auth parou no limite: retenção e funil ficam sobre uma amostra (o painel avisa por contas.completo).
  const funil = await calcularFunil(db, lidas, agora, !completo);
  const [perfis, suspensos, turmas, encerradas, inativas, ambas, comAtividade, times, partidas, desafios, denuncias, revisoes] = await contagens;
  // Ativa = nem status "encerrada" nem ativo false (documentos antigos sem status contam como ativos, como no app).
  const ativas = turmas === null || encerradas === null || inativas === null || ambas === null ? null : Math.max(0, turmas - encerradas - inativas + ambas);

  return {
    geradoEm: agora,
    contas: { total: contas.total, completo },
    ativos: contas.ativos,
    cadastros: contas.cadastros,
    perfis: { total: perfis, suspensos },
    turmas: { total: turmas, ativas, comAtividade30d: comAtividade },
    times,
    partidas,
    desafios,
    moderacao: { denunciasAbertas: denuncias, revisoesAbertas: revisoes },
    retencao,
    funil,
  };
}

/** Cálculo em andamento: pedidos que chegam juntos esperam o mesmo (uma varredura do Auth por vez nesta instância). */
let emAndamento: Promise<Estatisticas> | null = null;
/** Só para os testes. */
export const limparEstatisticasGuardadas = (): void => {
  emAndamento = null;
};

/** As últimas estatísticas salvas (null = nunca calculadas ou documento inválido). */
async function lerSalvas(db: Firestore): Promise<Estatisticas | null> {
  const snap = await db.doc(DOC_ESTATISTICAS).get();
  if (!snap.exists) return null;
  const { salvoEm: _salvoEm, desatualizado: _desatualizado, ...d } = (snap.data() ?? {}) as Dados;
  const cad = d.cadastros as Dados | undefined;
  return typeof d.geradoEm === "number" && typeof d.contas === "object" && d.contas !== null && typeof d.ativos === "object" && d.ativos !== null && Array.isArray(cad?.porDia)
    ? (d as unknown as Estatisticas)
    : null;
}

async function estatisticas(db: Firestore, auth: Auth, atualizar: boolean): Promise<Estatisticas> {
  const salvas = await lerSalvas(db);
  // Abrir a tela: os números salvos (1 leitura). Atualizar logo depois de um cálculo também não refaz.
  if (salvas && (!atualizar || Date.now() - salvas.geradoEm < ATUALIZAR_MIN_MS)) return salvas;
  if (!emAndamento) {
    emAndamento = calcularEstatisticas(db, auth, Date.now())
      .then(async (novas) => {
        try {
          await db.doc(DOC_ESTATISTICAS).set({ ...novas, salvoEm: FieldValue.serverTimestamp() });
        } catch (erro) {
          // Os números valem mesmo sem salvar; a próxima abertura mostra os anteriores.
          console.error(JSON.stringify({ evt: "admin_estatisticas_nao_salvas", message: (erro as Error)?.message ?? String(erro) }));
        }
        return novas;
      })
      .finally(() => {
        emAndamento = null;
      });
  }
  try {
    return await emAndamento;
  } catch (erro) {
    if (!salvas) throw erro;
    console.error(JSON.stringify({ evt: "admin_estatisticas_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return { ...salvas, desatualizado: true };
  }
}

// ───────────────────────────── rota ─────────────────────────────

export async function handleAdminUsuarios(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "moderacao");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Apenas administradores podem consultar usuários." });
  if (!(await dentroDoLimite(user.uid, "admin-usuarios", 60, 60))) return res.status(429).json({ error: "Muitas consultas seguidas. Aguarde um minuto." });

  const body = req.body ?? {};
  try {
    const app = getFirebaseApp();
    const db = getFirestore(app);
    const auth = getAuth(app);
    if (body.action === "buscar") {
      const termo = parseTermo(body.termo);
      if (!termo) return res.status(400).json({ error: `Digite de ${TERMO_MIN} a ${TERMO_MAX} caracteres.` });
      return res.status(200).json({ usuarios: await buscar(db, auth, termo, user.uid) });
    }
    if (body.action === "ficha") {
      if (!isSafeUid(body.id)) return res.status(400).json({ error: "Identificador inválido." });
      return res.status(200).json(await ficha(db, auth, body.id, user.uid));
    }
    if (body.action === "mapa") return res.status(200).json({ mapa: await lerMapa(db) });
    if (body.action === "gerar-mapa") {
      const r = await gerarMapa(db, user.uid, { podeIniciar: () => dentroDoLimite(user.uid, "admin-mapa", 3, 3600) });
      if (r.tipo === "andamento") return res.status(200).json({ mapa: r.mapa, andamento: { lidos: r.lidos } });
      return res.status(200).json({ mapa: r.mapa, ...(r.tipo === "recente" ? { recente: true } : {}) });
    }
    if (body.action === "estatisticas") {
      const atualizar = body.atualizar === true;
      if (atualizar && !(await dentroDoLimite(user.uid, "admin-estatisticas", 20, 3600))) {
        return res.status(429).json({ error: "As estatísticas já foram atualizadas 20 vezes na última hora. Os números salvos continuam na tela." });
      }
      return res.status(200).json(await estatisticas(db, auth, atualizar));
    }
    return res.status(400).json({ error: "Ação inválida." });
  } catch (erro) {
    if (erro instanceof Recusa || erro instanceof RecusaMapa) return res.status(erro.status).json({ error: erro.message });
    console.error(JSON.stringify({ evt: "admin_usuarios_falhou", acao: String(body.action).slice(0, 20), message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível concluir. Tente novamente." });
  }
}
