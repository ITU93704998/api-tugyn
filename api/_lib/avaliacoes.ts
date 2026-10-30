import { perfilDisponivel } from "./suspensao";
import { isSafeUid } from "./validation";

/**
 * Avaliação de atletas (parte PURA). Quem lê e grava é a rota `api/avaliacoes.ts`.
 *
 * Regras:
 *  - Só avalia quem está junto numa turma ATIVA (a turma vem no pedido e o servidor confere os dois na lista de membros).
 *  - Uma avaliação por dupla (quem avalia → quem é avaliado). Ela pode ser editada, mas cada envio (criar ou editar) só
 *    é aceito `DIAS_ENTRE_ENVIOS` dias depois do anterior: ninguém fica mudando a nota toda hora.
 *  - Três critérios de 1 a 5 estrelas (convivência, comprometimento, fair play). A nota final é a média dos três.
 *  - ANÔNIMA: o documento `avaliacoes/{avaliador}__{avaliado}` só é lido por quem avaliou. O avaliado só vê o resumo em
 *    `users/{uid}/restrito/perfil.avaliacao` (somas e quantidade, sem nomes nem datas), que só o servidor grava. Perfil
 *    privado: as regras do Firestore só deixam o dono ler esse documento.
 */

export const DIAS_ENTRE_ENVIOS = 7;
const DIA_MS = 24 * 3600_000;

export const CRITERIOS = ["convivencia", "comprometimento", "fairPlay"] as const;
export type Criterio = (typeof CRITERIOS)[number];
export type Notas = Record<Criterio, number>;

/** Resumo gravado no perfil do avaliado: somas de cada critério e quantas avaliações entraram. */
export type Resumo = Notas & { total: number };

const ID_TURMA = /^[A-Za-z0-9_-]{1,128}$/;

export const idDaAvaliacao = (avaliadorId: string, avaliadoId: string): string => `${avaliadorId}__${avaliadoId}`;

export type AvaliacaoRequest = { avaliadoId: string; turmaId: string; notas: Notas };

const notaValida = (valor: unknown): valor is number => Number.isInteger(valor) && (valor as number) >= 1 && (valor as number) <= 5;

export const parseAvaliacaoBody = (body: unknown): { ok: true; value: AvaliacaoRequest } | { ok: false; error: string } => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  if (!isSafeUid(b.avaliadoId)) return { ok: false, error: "Atleta inválido." };
  if (typeof b.turmaId !== "string" || !ID_TURMA.test(b.turmaId)) return { ok: false, error: "Turma inválida." };
  const n = b.notas as Record<string, unknown> | null | undefined;
  if (typeof n !== "object" || n === null || Object.keys(n).length !== CRITERIOS.length) return { ok: false, error: "Notas inválidas." };
  if (!CRITERIOS.every((c) => notaValida(n[c]))) return { ok: false, error: "Cada nota precisa ser de 1 a 5 estrelas." };
  const notas = { convivencia: n.convivencia as number, comprometimento: n.comprometimento as number, fairPlay: n.fairPlay as number };
  return { ok: true, value: { avaliadoId: b.avaliadoId, turmaId: b.turmaId, notas } };
};

type Dados = Record<string, unknown> | null | undefined;
export type Negado = { ok: false; status: 403 | 404 | 409 | 429; code: string; error: string; proximaEm?: number };
const negar = (status: Negado["status"], code: string, error: string, proximaEm?: number): Negado => ({
  ok: false, status, code, error, ...(proximaEm ? { proximaEm } : {}),
});

const listaDe = (valor: unknown): string[] => (Array.isArray(valor) ? valor.filter((v): v is string => typeof v === "string") : []);
const turmaAtiva = (turma: Dados): boolean => !!turma && turma.status !== "encerrada" && turma.ativo !== false;
const millisDe = (valor: unknown): number => {
  const t = valor as { toMillis?: () => number } | undefined;
  return typeof t?.toMillis === "function" ? t.toMillis() : 0;
};

/** Notas guardadas numa avaliação anterior (null se não existe ou está estragada). */
export const notasDe = (avaliacao: Dados): Notas | null => {
  if (!avaliacao) return null;
  const n = avaliacao.notas as Record<string, unknown> | undefined;
  if (!n || !CRITERIOS.every((c) => notaValida(n[c]))) return null;
  return { convivencia: n.convivencia as number, comprometimento: n.comprometimento as number, fairPlay: n.fairPlay as number };
};

export interface ContextoAvaliacao {
  uid: string;
  avaliadoId: string;
  agoraMs: number;
  turma: Dados;
  perfilAvaliado: Dados;
  /** Um bloqueou o outro (qualquer lado). */
  bloqueio: boolean;
  /** A avaliação que este usuário já deu a este atleta (se existe). */
  anterior: Dados;
}

export type Autorizacao = { ok: true; anteriores: Notas | null } | Negado;

export const autorizarAvaliacao = (c: ContextoAvaliacao): Autorizacao => {
  if (c.uid === c.avaliadoId) return negar(409, "mesmo_atleta", "Você não pode avaliar a si mesmo.");
  // Sem perfil, suspenso ou excluindo a conta (`excluindoEm`): o resumo não pode nascer para quem está saindo.
  if (!perfilDisponivel(c.perfilAvaliado)) {
    return negar(404, "atleta_nao_encontrado", "Este atleta não está disponível.");
  }
  if (c.bloqueio) return negar(403, "bloqueado", "Não é possível avaliar este atleta.");
  const membros = listaDe(c.turma?.participantes);
  if (!turmaAtiva(c.turma) || !membros.includes(c.uid) || !membros.includes(c.avaliadoId)) {
    return negar(403, "sem_turma_em_comum", "Só dá para avaliar quem está com você numa turma ativa.");
  }
  const ultimaMs = millisDe(c.anterior?.atualizadoEm);
  const proximaEm = ultimaMs + DIAS_ENTRE_ENVIOS * DIA_MS;
  if (ultimaMs && c.agoraMs < proximaEm) {
    return negar(429, "aguarde_semana", "Você já avaliou este atleta nesta semana. Poderá editar a avaliação depois de 7 dias.", proximaEm);
  }
  return { ok: true, anteriores: notasDe(c.anterior) };
};

/** Quanto somar no resumo do avaliado: nova avaliação conta +1; edição só troca a diferença das notas. */
export const deltaDoResumo = (novas: Notas, anteriores: Notas | null): Resumo => ({
  convivencia: novas.convivencia - (anteriores?.convivencia ?? 0),
  comprometimento: novas.comprometimento - (anteriores?.comprometimento ?? 0),
  fairPlay: novas.fairPlay - (anteriores?.fairPlay ?? 0),
  total: anteriores ? 0 : 1,
});

/** Para tirar uma avaliação do resumo (conta de quem avaliou excluída). */
export const deltaDeRemocao = (anteriores: Notas): Resumo => ({
  convivencia: -anteriores.convivencia,
  comprometimento: -anteriores.comprometimento,
  fairPlay: -anteriores.fairPlay,
  total: -1,
});
