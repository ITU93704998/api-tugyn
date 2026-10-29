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
 */

export const MAX_DESAFIOS_ATIVOS = 10;
export const MAX_APURAR_POR_PEDIDO = 10;
export const DIAS_MINIMOS_TEMPORADA_ATUAL = 7;
export const DIAS_APURACAO = 3;
const DIA_MS = 24 * 3600_000;
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

/** Id fixo por temporada e dupla (em ordem): o mesmo par não tem dois desafios na mesma temporada. */
export const idDoDesafio = (chave: string, a: string, b: string): string => {
  const [x, y] = [a, b].sort();
  return `${chave}__${x}__${y}`;
};

// ─── Corpo da requisição ──────────────────────────────────────────────────────

export type DesafioRequest =
  | { action: "criar"; desafiadoId: string; turmaId: string; temporada: "atual" | "proxima" }
  | { action: "responder"; desafioId: string; aceitar: boolean }
  | { action: "cancelar"; desafioId: string }
  | { action: "apurar"; desafioIds: string[] };

const ID_DESAFIO = /^t\d{4}_[1-6]__[A-Za-z0-9_-]{1,128}__[A-Za-z0-9_-]{1,128}$/;
export const isDesafioId = (valor: unknown): valor is string => typeof valor === "string" && valor.length <= 280 && ID_DESAFIO.test(valor);
const ID_TURMA = /^[A-Za-z0-9_-]{1,128}$/;
export const isTurmaId = (valor: unknown): valor is string => typeof valor === "string" && ID_TURMA.test(valor);

export const parseDesafioBody = (body: unknown): { ok: true; value: DesafioRequest } | { ok: false; error: string } => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  if (b.action === "criar") {
    if (!isSafeUid(b.desafiadoId)) return { ok: false, error: "Atleta inválido." };
    if (!isTurmaId(b.turmaId)) return { ok: false, error: "Turma inválida." };
    if (b.temporada !== "atual" && b.temporada !== "proxima") return { ok: false, error: "Temporada inválida." };
    return { ok: true, value: { action: "criar", desafiadoId: b.desafiadoId, turmaId: b.turmaId, temporada: b.temporada } };
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

export interface ContextoCriacao {
  uid: string;
  desafiadoId: string;
  temporada: "atual" | "proxima";
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

export type Criacao = { ok: true; id: string; temporada: TemporadaInfo; dados: Record<string, unknown>; draft: PushDraft } | Negado;

/** Pode criar? Devolve o documento (sem os carimbos de data do servidor) e o aviso para o desafiado. */
export const autorizarCriacao = (c: ContextoCriacao): Criacao => {
  if (c.uid === c.desafiadoId) return negar(409, "mesmo_atleta", "Você não pode desafiar a si mesmo.");
  if (!c.perfilDesafiado || c.perfilDesafiado.status === "suspended") {
    return negar(404, "atleta_nao_encontrado", "Este atleta não está disponível.");
  }
  if (c.bloqueio) return negar(403, "bloqueado", "Não é possível desafiar este atleta.");
  if (!c.turma) {
    return negar(409, "sem_turma_em_comum", "Vocês dois precisam estar nesta turma, e ela precisa estar ativa.");
  }

  const temporada = temporadaInfo(c.agoraMs, c.temporada === "atual" ? 0 : 1);
  if (c.temporada === "atual" && temporada.fimMs - c.agoraMs < DIAS_MINIMOS_TEMPORADA_ATUAL * DIA_MS) {
    return negar(409, "temporada_acabando", `A temporada atual termina em menos de ${DIAS_MINIMOS_TEMPORADA_ATUAL} dias. Desafie para a próxima.`);
  }

  if (c.existente) {
    const status = c.existente.status;
    if (status === "recusado") return negar(409, "ja_recusado", "Este atleta já recusou um desafio seu nesta temporada.");
    if (status !== "cancelado") return negar(409, "ja_existe", "Vocês já têm um desafio nesta temporada.");
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
    id: idDoDesafio(temporada.chave, c.uid, c.desafiadoId),
    temporada,
    dados: {
      participantes: [c.uid, c.desafiadoId],
      desafianteId: c.uid,
      desafiadoId: c.desafiadoId,
      desafiante: { nome: desafiante.nome, foto: desafiante.foto },
      desafiado: { nome: desafiado.nome, foto: desafiado.foto },
      temporada: temporada.chave,
      temporadaRotulo: temporada.rotulo,
      inicioEm: new Date(temporada.inicioMs),
      fimEm: new Date(temporada.fimMs),
      turmas: [c.turma],
      status: "pendente",
    },
    draft: {
      title: "Você foi desafiado!",
      body: `${sanitizeText(desafiante.nome, NOME_MAX, "Um atleta")} desafiou você na turma ${sanitizeText(c.turma.nome, NOME_MAX, "de vocês")}, temporada ${temporada.rotulo}. Toque para responder.`,
      data: { tipo: "desafio", turmaId: "" },
    },
  };
};

const fimDe = (desafio: Dados): number => {
  const fim = desafio?.fimEm as { toMillis?: () => number } | undefined;
  return typeof fim?.toMillis === "function" ? fim.toMillis() : 0;
};

export type Resposta = { ok: true; draft: PushDraft | null } | Negado;

/** Só o desafiado responde, só enquanto está pendente e a temporada não acabou. */
export const autorizarResposta = (uid: string, desafio: Dados, aceitar: boolean, agoraMs: number): Resposta => {
  if (!desafio) return negar(404, "desafio_nao_encontrado", "Desafio não encontrado.");
  if (desafio.desafiadoId !== uid) return negar(403, "nao_desafiado", "Só quem foi desafiado pode responder.");
  if (desafio.status !== "pendente") return negar(409, "nao_pendente", "Este desafio já foi respondido.");
  if (agoraMs >= fimDe(desafio)) return negar(409, "temporada_encerrada", "A temporada deste desafio já terminou.");
  if (!aceitar) return { ok: true, draft: null };
  const nome = sanitizeText((desafio.desafiado as Dados)?.nome, NOME_MAX, "O atleta");
  return {
    ok: true,
    draft: {
      title: "Desafio aceito!",
      body: `${nome} aceitou o seu desafio da temporada ${sanitizeText(desafio.temporadaRotulo, 20, "")}. Que vença o melhor!`,
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
 * O que fazer com o desafio agora: aceito e com a apuração liberada (fim + `DIAS_APURACAO`) → finalizar; pendente depois do fim
 * da temporada → expirar; qualquer outro caso → nada (pedir cedo não é erro: o app pergunta ao abrir a tela).
 */
export const decidirApuracao = (uid: string, desafio: Dados, agoraMs: number): Apuracao => {
  if (!desafio) return negar(404, "desafio_nao_encontrado", "Desafio não encontrado.");
  if (!listaDe(desafio.participantes).includes(uid)) return negar(403, "nao_participante", "Você não participa deste desafio.");
  const fim = fimDe(desafio);
  if (desafio.status === "pendente" && agoraMs >= fim) return { ok: true, acao: "expirar" };
  if (desafio.status === "aceito" && agoraMs >= fim + DIAS_APURACAO * DIA_MS) return { ok: true, acao: "finalizar" };
  return { ok: true, acao: "nada" };
};

export const avisoDeResultado = (vencedorNome: string | null, rotulo: string): PushDraft => ({
  title: "Resultado do desafio",
  body: vencedorNome
    ? `${sanitizeText(vencedorNome, NOME_MAX, "Um atleta")} venceu o desafio da temporada ${sanitizeText(rotulo, 20, "")}. Toque para ver o placar.`
    : `O desafio da temporada ${sanitizeText(rotulo, 20, "")} terminou empatado. Toque para ver o placar.`,
  data: { tipo: "desafio", turmaId: "" },
});
