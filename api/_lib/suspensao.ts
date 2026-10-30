/**
 * Política ÚNICA de conta suspensa (parte pura; quem aplica é `requireUser`, em `auth.ts`).
 *
 * Suspender (script `scripts/moderar-conta.cjs suspender <uid>`) faz tudo junto:
 *  1. `users/{uid}.status = "suspended"`: a API passa a recusar na hora as ações abaixo (o status é lido a cada pedido);
 *  2. desativa a conta no Firebase Auth e revoga as sessões: o token atual deixa de valer na API (`checkRevoked`) e o
 *     app é desconectado quando o token vence (até 1 h; é o tempo em que as regras do Firestore ainda aceitam o token
 *     antigo, porque elas não consultam revogação);
 *  3. apaga os tokens de notificação da conta.
 *
 * Cada rota da API declara a AÇÃO que faz (parâmetro obrigatório de `requireUser`): nenhuma rota nova fica sem política.
 */
export const ACOES_DA_API = [
  "avaliar",
  "desafiar",
  "push",
  "turma-gestao",
  "upload",
  "apagar-midia",
  "contratos-admin",
  "contatos-admin",
  "excluir-conta",
] as const;
export type AcaoDaApi = (typeof ACOES_DA_API)[number];

/**
 * O que uma conta suspensa AINDA pode fazer: excluir a conta (direito do titular) e apagar as próprias imagens.
 * Suporte não depende de login (e-mail e página de suporte do site).
 */
export const PERMITIDAS_A_SUSPENSOS: ReadonlySet<AcaoDaApi> = new Set<AcaoDaApi>(["excluir-conta", "apagar-midia"]);

type PerfilLido = { status?: unknown; excluindoEm?: unknown } | null | undefined;

export const contaSuspensa = (perfil: PerfilLido): boolean => perfil?.status === "suspended";

/**
 * Exclusão em andamento: `excluirConta` grava `users/{uid}.excluindoEm` ANTES de apagar qualquer coisa. Quem grava algo que
 * aponta para a conta (avaliação, desafio) lê o perfil dentro da transação e recusa: nada novo nasce depois da limpeza.
 */
export const contaEmExclusao = (perfil: PerfilLido): boolean => perfil?.excluindoEm != null;

/** O perfil existe, não está suspenso e não está sendo excluído. */
export const perfilDisponivel = (perfil: PerfilLido): boolean =>
  perfil != null && !contaSuspensa(perfil) && !contaEmExclusao(perfil);

/** `true` = a ação pode seguir. Conta em exclusão segue a mesma lista (pode tentar excluir de novo, se a 1ª parou). */
export const acaoPermitida = (perfil: PerfilLido, acao: AcaoDaApi): boolean =>
  (!contaSuspensa(perfil) && !contaEmExclusao(perfil)) || PERMITIDAS_A_SUSPENSOS.has(acao);

export const RESPOSTA_SUSPENSA = {
  code: "conta_suspensa",
  error: "Sua conta está suspensa por violar os Termos de Uso. Se você acredita que foi um engano, fale com o suporte.",
} as const;
