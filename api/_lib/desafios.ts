import { MESES_POR_TEMPORADA } from "./estatisticas";
import { sanitizeText, type PushDraft } from "./push";
import { isSafeUid } from "./validation";

/**
 * Desafios entre atletas (parte PURA: validar o corpo, decidir quem pode o quê e apurar o resultado). Quem lê e grava é a rota
 * `api/desafios.ts`; o app só LÊ `desafios/{id}` (as regras não deixam o app gravar nada ali).
 *
 * Regras do desafio:
 *  - Vale para a temporada atual (com pelo menos `DIAS_MINIMOS_TEMPORADA_ATUAL` dias pela frente) ou para a próxima.
 *  - Vale para UMA turma, escolhida por quem desafia: precisa estar ativa e ter os dois como membros. Só os números dela
 *    contam (ela fica gravada em `turmas`, lista de um item, no desafio).
 *  - Pontos = 3 por gol + 1 por assistência (mesma regra do ranking da temporada). Empate nos pontos: mais gols vence;
 *    empate também nos gols = empate.
 *  - O resultado sai `DIAS_APURACAO` dias depois do fim da temporada (partidas enviadas com atraso ainda entram).
 *
 * Desafio da PARTIDA DO DIA (`tipo: "dia"`): só no dia de jogo da turma escolhida, até `MINUTOS_ANTES_DA_PARTIDA` antes do
 * horário dela. Vale só para as partidas da turma daquele dia (data da partida = o dia, em Brasília). Precisa ser aceito antes
 * do horário da partida; o resultado sai `HORAS_APURACAO_DIA` horas depois do fim do dia (dá tempo de o organizador enviar).
 */

export const MAX_DESAFIOS_ATIVOS = 10;
export const MAX_APURAR_POR_PEDIDO = 10;
export const DIAS_MINIMOS_TEMPORADA_ATUAL = 7;
export const DIAS_APURACAO = 3;
export const MINUTOS_ANTES_DA_PARTIDA = 30;
export const HORAS_APURACAO_DIA = 12;
export const MAX_PARTIDAS_DO_DIA = 100;
const DIA_MS = 24 * 3600_000;
/** Desafio aceito que ninguém apurou continua ocupando vaga até este tempo depois de o resultado ser liberado. */
const FOLGA_VAGA_ACEITO_MS = 7 * DIA_MS;
/** Brasília (UTC−3, sem horário de verão desde 2019): o mesmo fuso que `diaDeBrasilia` usa. */
const FUSO_MS = 3 * 3600_000;
const MESES_CURTOS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const NOME_MAX = 40;

export interface TemporadaInfo {
  /** "t2026_6": a mesma chave de `participantes/{uid}.temporadas` (ver `campoDaTemporada`). */
  chave: string;
  /** "Nov–Dez 2026" */
  rotulo: string;
  inicioMs: number;
  fimMs: number;
}

/** Temporada que contém `agoraMs` (deslocamento 1 = a próxima), no fuso de Brasília. */
export const temporadaInfo = (agoraMs: number, deslocamento = 0): TemporadaInfo => {
  const local = new Date(agoraMs - FUSO_MS);
  const indice = Math.floor(local.getUTCMonth() / MESES_POR_TEMPORADA) + deslocamento;
  const inicio = new Date(Date.UTC(local.getUTCFullYear(), indice * MESES_POR_TEMPORADA, 1));
  const fim = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + MESES_POR_TEMPORADA, 1));
  const ultimoMes = (inicio.getUTCMonth() + MESES_POR_TEMPORADA - 1) % 12;
  const ano = inicio.getUTCFullYear();
  return {
    chave: `t${ano}_${Math.floor(inicio.getUTCMonth() / MESES_POR_TEMPORADA) + 1}`,
    rotulo: `${MESES_CURTOS[inicio.getUTCMonth()]}–${MESES_CURTOS[ultimoMes]} ${ano}`,
    inicioMs: inicio.getTime() + FUSO_MS,
    fimMs: fim.getTime() + FUSO_MS,
  };
};

/**
 * Id fixo por período e dupla (em ordem): o mesmo par não tem dois desafios na mesma temporada (`t2026_6`) nem no mesmo
 * dia (`d20261029`).
 */
export const idDoDesafio = (chave: string, a: string, b: string): string => {
  const [x, y] = [a, b].sort();
  return `${chave}__${x}__${y}`;
};

// ─── Partida do dia ───────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2026-10-29": o dia em Brasília (o mesmo `diaDeHoje` do app). */
export const diaDeBrasiliaDe = (ms: number): string => {
  const d = new Date(ms - FUSO_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Meia-noite (início) do dia "AAAA-MM-DD" de Brasília, em ms reais. */
export const inicioDoDia = (dia: string): number => {
  const [a, m, d] = dia.split("-").map(Number);
  return Date.UTC(a, m - 1, d) + FUSO_MS;
};

/** `diasSemana` da turma ("monday", "segunda-feira", "seg"...) → dias 0 (domingo) a 6 (o mesmo do app). */
const DIAS: Record<string, number> = {
  sunday: 0, sun: 0, domingo: 0, dom: 0,
  monday: 1, mon: 1, segunda: 1, "segunda-feira": 1, "segunda feira": 1, seg: 1,
  tuesday: 2, tue: 2, terca: 2, "terca-feira": 2, "terca feira": 2, ter: 2,
  wednesday: 3, wed: 3, quarta: 3, "quarta-feira": 3, "quarta feira": 3, qua: 3,
  thursday: 4, thu: 4, quinta: 4, "quinta-feira": 4, "quinta feira": 4, qui: 4,
  friday: 5, fri: 5, sexta: 5, "sexta-feira": 5, "sexta feira": 5, sex: 5,
  saturday: 6, sat: 6, sabado: 6, sab: 6,
};
const diasDaTurma = (valor: unknown): Set<number> => {
  const dias = new Set<number>();
  if (!Array.isArray(valor)) return dias;
  for (const item of valor) {
    if (typeof item !== "string") continue;
    const chave = item.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (DIAS[chave] !== undefined) dias.add(DIAS[chave]);
  }
  return dias;
};

export interface DiaInfo {
  /** "d20261029": a parte do id do desafio. */
  chave: string;
  /** "2026-10-29" */
  dia: string;
  /** "29/10 às 21:00" */
  rotulo: string;
  horario: string;
  /** Horário da partida (o desafio precisa ser aceito antes dele). */
  partidaMs: number;
  /** Fim do dia em Brasília. */
  fimMs: number;
}

/** A partida de HOJE da turma (dia de jogo e horário válido), ou null. */
export const partidaDeHoje = (turma: Dados, agoraMs: number): DiaInfo | null => {
  const m = typeof turma?.horario === "string" ? /^(\d{1,2}):(\d{2})$/.exec(turma.horario.trim()) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const local = new Date(agoraMs - FUSO_MS);
  if (!diasDaTurma(turma?.diasSemana).has(local.getUTCDay())) return null;
  const dia = diaDeBrasiliaDe(agoraMs);
  const inicio = inicioDoDia(dia);
  const horario = `${pad(Number(m[1]))}:${m[2]}`;
  return {
    chave: `d${dia.replace(/-/g, "")}`,
    dia,
    rotulo: `${dia.slice(8, 10)}/${dia.slice(5, 7)} às ${horario}`,
    horario,
    partidaMs: inicio + (Number(m[1]) * 60 + Number(m[2])) * 60_000,
    fimMs: inicio + DIA_MS,
  };
};

export interface PartidaSalva {
  /** `data` da partida (ISO, horário em que ela foi criada no aparelho). */
  data?: unknown;
  /** `salvadoEm` em ms (primeiro envio à turma). */
  salvadoEmMs: number;
  jogadores?: unknown;
}

/** A partida é daquele dia? Pela `data` dela (em Brasília); sem data válida, pelo primeiro envio. */
export const partidaEhDoDia = (p: PartidaSalva, dia: string): boolean => {
  const dataMs = typeof p.data === "string" ? Date.parse(p.data) : NaN;
  return diaDeBrasiliaDe(Number.isFinite(dataMs) ? dataMs : p.salvadoEmMs) === dia;
};

/**
 * Soma gols/assistências/jogos do atleta em TODAS as partidas da turma daquele dia (cada partida em que ele aparece = 1 jogo).
 * `corteMs`: partidas enviadas pela primeira vez a partir dele não entram (o mesmo corte para qualquer hora de apuração).
 */
export const somarDoDia = (partidas: PartidaSalva[], dia: string, uid: string, corteMs = Number.POSITIVE_INFINITY): Numeros => {
  const total = { gols: 0, assistencias: 0, jogos: 0, pontos: 0 };
  for (const p of partidas) {
    if (p.salvadoEmMs >= corteMs) continue;
    if (!partidaEhDoDia(p, dia) || !Array.isArray(p.jogadores)) continue;
    const meus = (p.jogadores as Dados[]).filter((j) => j?.participanteId === uid);
    if (meus.length === 0) continue;
    total.jogos += 1;
    for (const j of meus) {
      total.gols += Math.min(99, numero(j?.gols_partida));
      total.assistencias += Math.min(99, numero(j?.assistencias));
    }
  }
  total.pontos = total.gols * 3 + total.assistencias;
  return total;
};

// ─── Corpo da requisição ──────────────────────────────────────────────────────

export type DesafioRequest =
  | { action: "criar"; tipo: "temporada"; desafiadoId: string; turmaId: string; temporada: "atual" | "proxima" }
  | { action: "criar"; tipo: "dia"; desafiadoId: string; turmaId: string }
  | { action: "responder"; desafioId: string; aceitar: boolean }
  | { action: "cancelar"; desafioId: string }
  | { action: "apurar"; desafioIds: string[] };

const ID_DESAFIO = /^(t\d{4}_[1-6]|d\d{8})__[A-Za-z0-9_-]{1,128}__[A-Za-z0-9_-]{1,128}$/;
export const isDesafioId = (valor: unknown): valor is string => typeof valor === "string" && valor.length <= 280 && ID_DESAFIO.test(valor);
const ID_TURMA = /^[A-Za-z0-9_-]{1,128}$/;
export const isTurmaId = (valor: unknown): valor is string => typeof valor === "string" && ID_TURMA.test(valor);

export const parseDesafioBody = (body: unknown): { ok: true; value: DesafioRequest } | { ok: false; error: string } => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  if (b.action === "criar") {
    if (!isSafeUid(b.desafiadoId)) return { ok: false, error: "Atleta inválido." };
    if (!isTurmaId(b.turmaId)) return { ok: false, error: "Turma inválida." };
    if (b.tipo === "dia") return { ok: true, value: { action: "criar", tipo: "dia", desafiadoId: b.desafiadoId, turmaId: b.turmaId } };
    if (b.tipo !== undefined && b.tipo !== "temporada") return { ok: false, error: "Tipo de desafio inválido." };
    if (b.temporada !== "atual" && b.temporada !== "proxima") return { ok: false, error: "Temporada inválida." };
    return { ok: true, value: { action: "criar", tipo: "temporada", desafiadoId: b.desafiadoId, turmaId: b.turmaId, temporada: b.temporada } };
  }
  if (b.action === "responder") {
    if (!isDesafioId(b.desafioId)) return { ok: false, error: "Desafio inválido." };
    if (typeof b.aceitar !== "boolean") return { ok: false, error: "Resposta inválida." };
    return { ok: true, value: { action: "responder", desafioId: b.desafioId, aceitar: b.aceitar } };
  }
  if (b.action === "cancelar") {
    if (!isDesafioId(b.desafioId)) return { ok: false, error: "Desafio inválido." };
    return { ok: true, value: { action: "cancelar", desafioId: b.desafioId } };
  }
  if (b.action === "apurar") {
    if (!Array.isArray(b.desafioIds) || b.desafioIds.length === 0 || b.desafioIds.length > MAX_APURAR_POR_PEDIDO) {
      return { ok: false, error: "Desafios inválidos." };
    }
    if (!b.desafioIds.every(isDesafioId)) return { ok: false, error: "Desafios inválidos." };
    return { ok: true, value: { action: "apurar", desafioIds: [...new Set(b.desafioIds as string[])] } };
  }
  return { ok: false, error: "Ação inválida." };
};

// ─── Autorização ──────────────────────────────────────────────────────────────

type Dados = Record<string, unknown> | null | undefined;
export type Negado = { ok: false; status: 403 | 404 | 409; code: string; error: string };
const negar = (status: 403 | 404 | 409, code: string, error: string): Negado => ({ ok: false, status, code, error });

const listaDe = (valor: unknown): string[] => (Array.isArray(valor) ? valor.filter((v): v is string => typeof v === "string") : []);
const turmaAtiva = (turma: Dados): boolean => turma?.status !== "encerrada" && turma?.ativo !== false;

export interface TurmaComum {
  id: string;
  nome: string;
}

/** A turma escolhida vale se existe, está ATIVA e tem os dois como membros; senão null. */
export const turmaDoDesafio = (turma: { id: string; data: Dados }, uid: string, desafiadoId: string): TurmaComum | null => {
  if (!turma.data || !turmaAtiva(turma.data)) return null;
  const membros = listaDe(turma.data.participantes);
  if (!membros.includes(uid) || !membros.includes(desafiadoId)) return null;
  return { id: turma.id, nome: sanitizeText(turma.data.nome, 60, "Turma") };
};

export interface Atleta {
  uid: string;
  nome: string;
  foto: string;
}

export const atletaDe = (uid: string, perfil: Dados): Atleta => ({
  uid,
  nome: sanitizeText(perfil?.name, 80, "Atleta"),
  foto: typeof perfil?.profileImage === "string" && perfil.profileImage.startsWith("https://") ? perfil.profileImage.slice(0, 500) : "",
});

// ─── Vagas (limite de desafios ativos) ────────────────────────────────────────
//
// `desafiosVagas/{uid}` = { uid, ativos: { [desafioId]: venceEmMs } }. Lido e gravado na MESMA transação que cria o desafio:
// duas criações ao mesmo tempo não passam do limite. Cada vaga tem validade: convite que ninguém respondeu deixa de contar no
// prazo para aceitar, mesmo que ninguém abra o app (a expiração do documento vem depois, pela rotina diária).

/** Vagas ainda válidas (a vaga vence em `venceEm`). */
export const vagasValidas = (ativos: unknown, agoraMs: number): Record<string, number> => {
  const validas: Record<string, number> = {};
  if (typeof ativos !== "object" || ativos === null) return validas;
  for (const [id, venceEm] of Object.entries(ativos as Record<string, unknown>)) {
    if (typeof venceEm === "number" && venceEm > agoraMs && isDesafioId(id)) validas[id] = venceEm;
  }
  return validas;
};

export interface ContextoCriacao {
  uid: string;
  desafiadoId: string;
  /** "temporada" (padrão) ou "dia" (só a partida de hoje da turma). */
  tipo?: "temporada" | "dia";
  /** Só no desafio de temporada. */
  temporada?: "atual" | "proxima";
  /** Documento da turma como está no banco (dia e horário de jogo, para o desafio do dia). */
  turmaDados?: Dados;
  agoraMs: number;
  perfilDesafiante: Dados;
  perfilDesafiado: Dados;
  /** Um bloqueou o outro (qualquer lado). */
  bloqueio: boolean;
  /** A turma escolhida, já conferida por `turmaDoDesafio` (null = não vale). */
  turma: TurmaComum | null;
  /** Desafios pendentes/aceitos de cada um (contagem do servidor). */
  ativosDesafiante: number;
  ativosDesafiado: number;
  /** Desafio que já existe com o mesmo id (mesma dupla e temporada). */
  existente: Dados;
}

export type Criacao = { ok: true; id: string; dados: Record<string, unknown>; draft: PushDraft } | Negado;

/** O período do desafio: temporada (atual com folga mínima, ou a próxima) ou a partida de hoje (até 30 min antes). */
const periodoDoDesafio = (
  c: ContextoCriacao,
):
  | { ok: true; chave: string; campos: Record<string, unknown>; descricao: string; prazoParaAceitarMs: number }
  | Negado => {
  const temporadaAtual = temporadaInfo(c.agoraMs);
  if (c.tipo === "dia") {
    const partida = partidaDeHoje(c.turmaDados, c.agoraMs);
    if (!partida) return negar(409, "sem_partida_hoje", "Esta turma não tem partida hoje.");
    if (c.agoraMs > partida.partidaMs - MINUTOS_ANTES_DA_PARTIDA * 60_000) {
      return negar(409, "partida_muito_proxima", `Só dá para desafiar até ${MINUTOS_ANTES_DA_PARTIDA} minutos antes da partida.`);
    }
    return {
      ok: true,
      chave: partida.chave,
      prazoParaAceitarMs: partida.partidaMs,
      descricao: `na partida de hoje (${partida.horario})`,
      campos: {
        tipo: "dia",
        dia: partida.dia,
        // A chave da temporada fica gravada também (para filtros e para a tela), mas o resultado usa só o dia.
        temporada: temporadaAtual.chave,
        temporadaRotulo: `Partida de ${partida.rotulo}`,
        inicioEm: new Date(partida.partidaMs),
        fimEm: new Date(partida.fimMs),
      },
    };
  }
  const temporada = temporadaInfo(c.agoraMs, c.temporada === "proxima" ? 1 : 0);
  if (c.temporada !== "proxima" && temporada.fimMs - c.agoraMs < DIAS_MINIMOS_TEMPORADA_ATUAL * DIA_MS) {
    return negar(409, "temporada_acabando", `A temporada atual termina em menos de ${DIAS_MINIMOS_TEMPORADA_ATUAL} dias. Desafie para a próxima.`);
  }
  return {
    ok: true,
    chave: temporada.chave,
    prazoParaAceitarMs: temporada.fimMs,
    descricao: `temporada ${temporada.rotulo}`,
    campos: {
      tipo: "temporada",
      temporada: temporada.chave,
      temporadaRotulo: temporada.rotulo,
      inicioEm: new Date(temporada.inicioMs),
      fimEm: new Date(temporada.fimMs),
    },
  };
};

/** Pode criar? Devolve o documento (sem os carimbos de data do servidor) e o aviso para o desafiado. */
export const autorizarCriacao = (c: ContextoCriacao): Criacao => {
  if (c.uid === c.desafiadoId) return negar(409, "mesmo_atleta", "Você não pode desafiar a si mesmo.");
  // O id junta os uids com "__": uid com "__" poderia gerar o mesmo id para duplas diferentes (os do Firebase nunca têm).
  if (c.uid.includes("__") || c.desafiadoId.includes("__")) return negar(409, "atleta_invalido", "Não é possível desafiar este atleta.");
  if (c.perfilDesafiante?.status === "suspended") return negar(403, "conta_suspensa", "Sua conta está suspensa e não pode desafiar.");
  if (!c.perfilDesafiado || c.perfilDesafiado.status === "suspended") {
    return negar(404, "atleta_nao_encontrado", "Este atleta não está disponível.");
  }
  // Política: perfil privado não recebe desafios (o app já esconde o botão; aqui vale para qualquer cliente).
  if (c.perfilDesafiado.isPublic === false) return negar(403, "perfil_privado", "Este atleta tem o perfil privado e não recebe desafios.");
  if (c.bloqueio) return negar(403, "bloqueado", "Não é possível desafiar este atleta.");
  if (!c.turma) {
    return negar(409, "sem_turma_em_comum", "Vocês dois precisam estar nesta turma, e ela precisa estar ativa.");
  }

  const periodo = periodoDoDesafio(c);
  if (!periodo.ok) return periodo;
  const nesse = c.tipo === "dia" ? "hoje" : "nesta temporada";

  if (c.existente) {
    const status = c.existente.status;
    if (status === "recusado") return negar(409, "ja_recusado", `Este atleta já recusou um desafio seu ${nesse}.`);
    if (status !== "cancelado") return negar(409, "ja_existe", `Vocês já têm um desafio ${nesse}.`);
  }
  if (c.ativosDesafiante >= MAX_DESAFIOS_ATIVOS) {
    return negar(409, "limite_desafiante", `Você já tem ${MAX_DESAFIOS_ATIVOS} desafios ativos. Termine ou cancele algum antes.`);
  }
  if (c.ativosDesafiado >= MAX_DESAFIOS_ATIVOS) {
    return negar(409, "limite_desafiado", "Este atleta já tem muitos desafios ativos. Tente mais tarde.");
  }

  const desafiante = atletaDe(c.uid, c.perfilDesafiante);
  const desafiado = atletaDe(c.desafiadoId, c.perfilDesafiado);
  return {
    ok: true,
    id: idDoDesafio(periodo.chave, c.uid, c.desafiadoId),
    dados: {
      participantes: [c.uid, c.desafiadoId],
      desafianteId: c.uid,
      desafiadoId: c.desafiadoId,
      desafiante: { nome: desafiante.nome, foto: desafiante.foto },
      desafiado: { nome: desafiado.nome, foto: desafiado.foto },
      ...periodo.campos,
      turmas: [c.turma],
      status: "pendente",
      // Quando a rotina diária deve olhar este desafio: no pendente, o fim do prazo para aceitar (para expirar).
      apurarEm: new Date(periodo.prazoParaAceitarMs),
    },
    draft: {
      title: "Você foi desafiado!",
      body: `${sanitizeText(desafiante.nome, NOME_MAX, "Um atleta")} desafiou você na turma ${sanitizeText(c.turma.nome, NOME_MAX, "de vocês")}, ${periodo.descricao}. Toque para responder.`,
      data: { tipo: "desafio", turmaId: "" },
    },
  };
};

/** Timestamp lido do Firestore ou Date dos dados ainda não gravados (a vaga é calculada na criação). */
const millis = (valor: unknown): number => {
  if (valor instanceof Date) return valor.getTime();
  const t = valor as { toMillis?: () => number } | undefined;
  return typeof t?.toMillis === "function" ? t.toMillis() : 0;
};
const fimDe = (desafio: Dados): number => millis(desafio?.fimEm);

export const ehDoDia = (desafio: Dados): boolean => desafio?.tipo === "dia";

/** Até quando o desafio pode ser aceito: o horário da partida (do dia) ou o fim da temporada. */
export const prazoParaAceitar = (desafio: Dados): number => (ehDoDia(desafio) ? millis(desafio?.inicioEm) : fimDe(desafio));

/** "da temporada Nov–Dez 2026" / "da partida de 29/10" (textos dos avisos). */
const descricaoDe = (desafio: Dados): string => {
  if (ehDoDia(desafio) && typeof desafio?.dia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(desafio.dia)) {
    return `da partida de ${desafio.dia.slice(8, 10)}/${desafio.dia.slice(5, 7)}`;
  }
  return `da temporada ${sanitizeText(desafio?.temporadaRotulo, 20, "")}`;
};

export type Resposta = { ok: true; draft: PushDraft | null } | Negado;

/** Só o desafiado responde, só enquanto está pendente e antes do prazo (horário da partida do dia / fim da temporada). */
export const autorizarResposta = (uid: string, desafio: Dados, aceitar: boolean, agoraMs: number): Resposta => {
  if (!desafio) return negar(404, "desafio_nao_encontrado", "Desafio não encontrado.");
  if (desafio.desafiadoId !== uid) return negar(403, "nao_desafiado", "Só quem foi desafiado pode responder.");
  if (desafio.status !== "pendente") return negar(409, "nao_pendente", "Este desafio já foi respondido.");
  if (agoraMs >= prazoParaAceitar(desafio)) {
    return ehDoDia(desafio)
      ? negar(409, "partida_comecou", "A partida deste desafio já começou.")
      : negar(409, "temporada_encerrada", "A temporada deste desafio já terminou.");
  }
  if (!aceitar) return { ok: true, draft: null };
  const nome = sanitizeText((desafio.desafiado as Dados)?.nome, NOME_MAX, "O atleta");
  return {
    ok: true,
    draft: {
      title: "Desafio aceito!",
      body: `${nome} aceitou o seu desafio ${descricaoDe(desafio)}. Que vença o melhor!`,
      data: { tipo: "desafio", turmaId: "" },
    },
  };
};

/** Só quem desafiou cancela, e só enquanto ninguém respondeu. */
export const autorizarCancelamento = (uid: string, desafio: Dados): { ok: true } | Negado => {
  if (!desafio) return negar(404, "desafio_nao_encontrado", "Desafio não encontrado.");
  if (desafio.desafianteId !== uid) return negar(403, "nao_desafiante", "Só quem desafiou pode cancelar.");
  if (desafio.status !== "pendente") return negar(409, "nao_pendente", "Este desafio já foi respondido.");
  return { ok: true };
};

// ─── Apuração ─────────────────────────────────────────────────────────────────

const numero = (valor: unknown): number =>
  typeof valor === "number" && Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : 0;

export interface Numeros {
  gols: number;
  assistencias: number;
  jogos: number;
  pontos: number;
}

/** Soma `temporadas[chave]` do atleta nas turmas do desafio (documentos de participante, na mesma ordem das turmas). */
export const somarDoDesafio = (participantes: Dados[], chave: string): Numeros => {
  const total = { gols: 0, assistencias: 0, jogos: 0, pontos: 0 };
  for (const p of participantes) {
    const temporadas = p?.temporadas as Record<string, Dados> | undefined;
    const t = temporadas && typeof temporadas === "object" ? temporadas[chave] : null;
    total.gols += numero(t?.gols);
    total.assistencias += numero(t?.assistencias);
    total.jogos += numero(t?.jogos);
  }
  total.pontos = total.gols * 3 + total.assistencias;
  return total;
};

/** Vencedor: mais pontos; empate nos pontos, mais gols; empate nos dois = null (empate). */
export const vencedorEntre = (a: { uid: string } & Numeros, b: { uid: string } & Numeros): string | null => {
  if (a.pontos !== b.pontos) return a.pontos > b.pontos ? a.uid : b.uid;
  if (a.gols !== b.gols) return a.gols > b.gols ? a.uid : b.uid;
  return null;
};

export type Apuracao =
  | { ok: true; acao: "finalizar" }
  | { ok: true; acao: "expirar" }
  | { ok: true; acao: "nada" }
  | Negado;

/**
 * Quando o resultado pode sair: `HORAS_APURACAO_DIA` depois do fim do dia, ou `DIAS_APURACAO` depois do fim da temporada.
 * No desafio do dia é também o CORTE: partidas enviadas depois disso não entram (o resultado não muda conforme a hora em que
 * a apuração rodou).
 */
export const apuracaoLiberadaEm = (desafio: Dados): number =>
  fimDe(desafio) + (ehDoDia(desafio) ? HORAS_APURACAO_DIA * 3600_000 : DIAS_APURACAO * DIA_MS);

/** Até quando a vaga do desafio conta no limite de ativos (pendente: prazo para aceitar; aceito: resultado + folga). */
export const vagaVenceEm = (desafio: Dados, status: "pendente" | "aceito"): number =>
  status === "pendente" ? prazoParaAceitar(desafio) : apuracaoLiberadaEm(desafio) + FOLGA_VAGA_ACEITO_MS;

/** Ao aceitar: o que ainda precisa valer (o convite pode ter sido criado antes de um bloqueio ou de alguém sair da turma). */
export const motivoParaNaoAceitar = (c: { bloqueio: boolean; turma: Dados; perfilDesafiante: Dados; desafio: Dados }): string | null => {
  if (c.bloqueio) return "Não é possível aceitar este desafio.";
  if (!c.perfilDesafiante || c.perfilDesafiante.status === "suspended") return "Quem desafiou você não está mais disponível.";
  const membros = listaDe(c.turma?.participantes);
  if (!turmaAtiva(c.turma) || !c.turma) return "A turma deste desafio foi encerrada.";
  if (!membros.includes(String(c.desafio?.desafianteId)) || !membros.includes(String(c.desafio?.desafiadoId))) {
    return "Vocês não estão mais juntos na turma deste desafio.";
  }
  return null;
};

/**
 * O que fazer com o desafio agora: aceito e com a apuração liberada → finalizar; pendente depois do prazo para aceitar →
 * expirar; qualquer outro caso → nada (pedir cedo não é erro: o app pergunta ao abrir a tela). `uid` null = rotina do
 * servidor (não precisa participar).
 */
export const decidirApuracao = (uid: string | null, desafio: Dados, agoraMs: number): Apuracao => {
  if (!desafio) return negar(404, "desafio_nao_encontrado", "Desafio não encontrado.");
  if (uid !== null && !listaDe(desafio.participantes).includes(uid)) return negar(403, "nao_participante", "Você não participa deste desafio.");
  if (desafio.status === "pendente" && agoraMs >= prazoParaAceitar(desafio)) return { ok: true, acao: "expirar" };
  if (desafio.status === "aceito" && agoraMs >= apuracaoLiberadaEm(desafio)) return { ok: true, acao: "finalizar" };
  return { ok: true, acao: "nada" };
};

export const avisoDeResultado = (vencedorNome: string | null, desafio: Dados): PushDraft => ({
  title: "Resultado do desafio",
  body: vencedorNome
    ? `${sanitizeText(vencedorNome, NOME_MAX, "Um atleta")} venceu o desafio ${descricaoDe(desafio)}. Toque para ver o placar.`
    : `O desafio ${descricaoDe(desafio)} terminou empatado. Toque para ver o placar.`,
  data: { tipo: "desafio", turmaId: "" },
});
