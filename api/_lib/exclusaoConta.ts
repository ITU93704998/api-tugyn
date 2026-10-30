/**
 * Job durável da exclusão de conta (parte PURA; quem lê e grava é `exclusaoContaJob.ts`).
 *
 * `exclusoesConta/{uid}` é criado ANTES de qualquer remoção e funciona como lápide: enquanto existir, a exclusão não terminou.
 * Guarda só o necessário para terminar sem o perfil (os pares dos desafios, a escolha de encerrar turmas e o estado de cada
 * etapa) e é APAGADO quando a verificação final passa.
 *
 * Etapas:
 *  - "excluindo": o fluxo principal (`accountDeletion.excluirConta`), idempotente: turmas, perfil, coleções extras e, por
 *    último, a conta do Auth. Parou no meio? A pessoa tenta de novo ou a rotina diária retoma depois de `RETOMAR_APOS_MS`.
 *  - "pos_exclusao": etapas que dependem de a conta já ter saído, cada uma com estado e tentativas próprios:
 *      avaliacoesDadas  → cada avaliação que ela DEU sai do resumo do avaliado e é apagada;
 *      vagasAdversarios → a vaga que cada desafio dela ocupava no adversário é liberada;
 *      imagens          → todas as imagens dela em TODAS as contas do Cloudinary (conta sem credencial = pendente).
 *  - verificação final: confere que nada ficou; o que achar volta a ser pendente (ou refaz o fluxo principal).
 *
 * O que é APAGADO: perfil e subcoleções, usernames, tokens/avisos de push, desafios dela (os dois lados), avaliações
 * recebidas e dadas, vagas de desafio, reservas de imagem, turmas só dela e todas as imagens.
 * O que é ANONIMIZADO (é histórico de outras pessoas): o nome dela em partidas, o documento de participante das turmas que
 * continuam ("Usuário removido", sem foto) e o organizador das turmas encerradas.
 */

export type EtapaPosExclusao = "avaliacoesDadas" | "vagasAdversarios" | "imagens";
export const ETAPAS_POS_EXCLUSAO: readonly EtapaPosExclusao[] = ["avaliacoesDadas", "vagasAdversarios", "imagens"];

export interface EstadoDaEtapa {
  ok: boolean;
  tentativas: number;
  /** O que ainda falta (ex.: `bucket_turmas_sem_credenciais`). */
  pendencias?: string[];
  erro?: string;
}

/** A partir de quantas rodadas sem concluir o log passa a alertar como travada. */
export const ALERTA_TENTATIVAS = 3;
/** Exclusão parada em "excluindo" há este tempo: a pessoa desistiu ou a função morreu; a rotina retoma. */
export const RETOMAR_APOS_MS = 60 * 60_000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `{ desafioId: adversário }` a partir dos ids `chave__desafiante__desafiado` em que `uid` aparece. */
export const paresDosDesafios = (uid: string, ids: Iterable<string>): Record<string, string> => {
  const pares: Record<string, string> = {};
  for (const id of ids) {
    const [, a, b] = id.split("__");
    const outro = a === uid ? b : b === uid ? a : null;
    if (outro && outro !== uid && SAFE_ID.test(outro)) pares[id] = outro;
  }
  return pares;
};

export const etapasPendentes = (etapas: Partial<Record<EtapaPosExclusao, EstadoDaEtapa>> | undefined): EtapaPosExclusao[] =>
  ETAPAS_POS_EXCLUSAO.filter((e) => etapas?.[e]?.ok !== true);

/** A rotina diária processa este job agora? */
export const deveProcessar = (job: { estado?: unknown; atualizadaEmMs?: number | null }, agoraMs: number): boolean =>
  job.estado === "pos_exclusao" ||
  (job.estado === "excluindo" && agoraMs - (job.atualizadaEmMs ?? 0) >= RETOMAR_APOS_MS);

export interface Restos {
  perfil: boolean;
  contaAuth: boolean;
  usernames: number;
  avaliacoesDadas: number;
  avaliacoesRecebidas: number;
  desafios: number;
  vagas: boolean;
  vagasDeAdversarios: number;
  pushTokens: number;
  reservas: number;
}

/** Verificação final: o que ficou, se o fluxo principal precisa rodar de novo e quais etapas voltam a ser pendentes. */
export const avaliarRestos = (r: Restos): { pendencias: string[]; refazerExclusao: boolean; refazerEtapas: EtapaPosExclusao[] } => {
  const principais: [string, boolean][] = [
    ["perfil", r.perfil],
    ["conta_auth", r.contaAuth],
    ["usernames", r.usernames > 0],
    ["avaliacoes_recebidas", r.avaliacoesRecebidas > 0],
    ["desafios", r.desafios > 0],
    ["vagas", r.vagas],
    ["push_tokens", r.pushTokens > 0],
    ["reservas_de_imagem", r.reservas > 0],
  ];
  const refazerEtapas: EtapaPosExclusao[] = [
    ...(r.avaliacoesDadas > 0 ? (["avaliacoesDadas"] as const) : []),
    ...(r.vagasDeAdversarios > 0 ? (["vagasAdversarios"] as const) : []),
  ];
  const pendencias = [...principais.filter(([, sobrou]) => sobrou).map(([nome]) => nome), ...refazerEtapas];
  return { pendencias, refazerExclusao: principais.some(([, sobrou]) => sobrou), refazerEtapas };
};
