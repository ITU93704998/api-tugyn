import { isSafeUid } from "./validation";

/**
 * Resumo geral de cada jogador (`users/{uid}.estatisticas`): a soma dos números dele em TODAS as turmas de que participa hoje,
 * o mesmo que ele vê no próprio perfil. Assim todo visitante vê a mesma nota (antes cada um via só as turmas em comum).
 *
 * É RECALCULADO a partir dos participantes de cada turma (nunca somado partida a partida): correções, reenvios, saídas e turmas
 * excluídas se ajustam sozinhos no próximo cálculo. Só o servidor grava (as regras não deixam o app mexer em `estatisticas`).
 * Este arquivo é a parte PURA (somar e decidir quem pode pedir o quê); quem lê e grava é a rota `api/turma-gestao.ts`.
 */

/** Jogadores de uma partida (com folga para reenvios que tiram gente). */
export const MAX_JOGADORES_RECALCULO = 60;

export interface Estatisticas {
  gols: number;
  assistencias: number;
  jogos: number;
  vitorias: number;
  /** Turmas de que participa (ativas e encerradas). */
  turmas: number;
  /** Só as ativas: é o número que o card mostra. */
  turmasAtivas: number;
  /** Soma da temporada atual (`participantes/{uid}.temporadas[chave]`, gravado pelo app ao enviar a partida). */
  temporada: { chave: string; gols: number; assistencias: number; jogos: number };
}

/** Meses de cada temporada: o MESMO valor do app (`MESES_POR_TEMPORADA` em `partidasFiltro.ts`). */
export const MESES_POR_TEMPORADA = 2;

/**
 * Campo da temporada que contém `data` ("t2026_5" = 5ª temporada de 2026), no fuso de Brasília. Mesma regra do app
 * (`campoDaTemporada` em `partidasFiltro.ts`): mudou lá, mude aqui.
 */
export const campoDaTemporada = (data: Date = new Date()): string => {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "numeric" })
    .formatToParts(data);
  const ano = Number(partes.find((p) => p.type === "year")?.value);
  const mes = Number(partes.find((p) => p.type === "month")?.value) - 1;
  return `t${ano}_${Math.floor(mes / MESES_POR_TEMPORADA) + 1}`;
};

type Dados = Record<string, unknown> | null | undefined;

/** Inteiro >= 0 (dado estranho no documento não estraga a soma). */
const numero = (valor: unknown): number =>
  typeof valor === "number" && Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : 0;

/** Mesma regra do app (`isTurmaAtiva`): `status: "encerrada"` ou o legado `ativo: false` = encerrada. */
export const turmaAtiva = (turma: Dados): boolean => turma?.status !== "encerrada" && turma?.ativo !== false;

/**
 * Soma os números do jogador. `turmas`: as turmas em que ele está; `participantes`: o documento dele em cada uma (mesma ordem;
 * null se não existir). Participante que não é "aprovado" (pedido pendente) não conta.
 */
export const somarEstatisticas = (turmas: Dados[], participantes: Dados[], agora: Date = new Date()): Estatisticas => {
  const chave = campoDaTemporada(agora);
  const total: Estatisticas = {
    gols: 0,
    assistencias: 0,
    jogos: 0,
    vitorias: 0,
    turmas: 0,
    turmasAtivas: 0,
    temporada: { chave, gols: 0, assistencias: 0, jogos: 0 },
  };
  turmas.forEach((turma, i) => {
    const p = participantes[i];
    if (!p || p.status !== "aprovado") return;
    total.turmas += 1;
    if (turmaAtiva(turma)) total.turmasAtivas += 1;
    total.gols += numero(p.gols);
    total.assistencias += numero(p.assistencias);
    total.jogos += numero(p.jogos);
    total.vitorias += numero(p.vitorias);
    const temporadas = p.temporadas as Record<string, Dados> | undefined;
    const t = temporadas && typeof temporadas === "object" ? temporadas[chave] : null;
    total.temporada.gols += numero(t?.gols);
    total.temporada.assistencias += numero(t?.assistencias);
    total.temporada.jogos += numero(t?.jogos);
  });
  return total;
};

export type RecalculoNegado = { ok: false; status: 403 | 404; code: string; error: string };

/** Prazo do organizador temporário da turma (o mesmo das regras do Firestore e do app). */
export const DURACAO_ORGANIZADOR_TEMPORARIO_MS = 24 * 60 * 60 * 1000;

/**
 * Organizador temporário no prazo: escolhido pelo organizador, ainda membro, há menos de 24 h (`desde`, hora do servidor) e
 * turma não encerrada pela moderação. Ele só registra partidas; aqui, só pede o recálculo de quem jogou.
 */
export const ehOrganizadorTemporario = (uid: string, turma: Dados, agora = Date.now(), participante: Dados = null): boolean => {
  const o = turma?.organizadorTemporario as { uid?: unknown; desde?: { toMillis?: () => number } } | null | undefined;
  if (!o || typeof o.uid !== "string" || o.uid !== uid) return false;
  if (!Array.isArray(turma?.participantes) || !turma.participantes.includes(uid)) return false;
  if (turma?.encerradaPor === "moderacao") return false;
  const desde = typeof o.desde?.toMillis === "function" ? o.desde.toMillis() : NaN;
  if (!Number.isFinite(desde) || agora >= desde + DURACAO_ORGANIZADOR_TEMPORARIO_MS) return false;
  // Saiu (ou foi removido) e foi aprovado de novo DEPOIS da escolha: o papel antigo não volta (precisa de nova escolha).
  const aprovadoEm = (participante?.aprovadoEm as { toMillis?: () => number } | undefined)?.toMillis?.();
  return !(typeof aprovadoEm === "number" && aprovadoEm > desde);
};

/**
 * Depois de enviar uma partida, quem a enviou pede o recálculo de quem teve números alterados. Só o organizador da turma (ou o
 * organizador temporário no prazo), e só para quem é membro dela (o pedido nunca escolhe números: o servidor só refaz a soma do
 * que já está gravado).
 */
export const jogadoresParaRecalcular = (
  uid: string,
  turma: Dados,
  pedidos: string[],
  agora = Date.now(),
  participante: Dados = null,
): { ok: true; jogadores: string[] } | RecalculoNegado => {
  if (!turma) return { ok: false, status: 404, code: "turma_nao_encontrada", error: "Turma não encontrada." };
  if (turma.creatorId !== uid && !ehOrganizadorTemporario(uid, turma, agora, participante)) {
    return { ok: false, status: 403, code: "nao_organizador", error: "Só o organizador pode fazer isso." };
  }
  const membros = new Set(Array.isArray(turma.participantes) ? turma.participantes.filter((v) => typeof v === "string") : []);
  return { ok: true, jogadores: [...new Set(pedidos)].filter((id) => membros.has(id)) };
};

/** Lista de uids do corpo da requisição: só ids seguros, sem repetição, até o limite. null = inválida. */
export const parseJogadores = (valor: unknown): string[] | null => {
  if (!Array.isArray(valor) || valor.length === 0 || valor.length > MAX_JOGADORES_RECALCULO) return null;
  if (!valor.every(isSafeUid)) return null;
  return [...new Set(valor as string[])];
};
