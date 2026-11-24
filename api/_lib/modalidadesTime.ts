/**
 * Um time pode jogar até 3 modalidades. `modalidade` é a principal (aparece primeiro e é a que as versões antigas do app
 * leem); `modalidades` tem todas (times antigos não têm o campo: valem só pela principal).
 * Cada jogador tem uma posição por modalidade (`camisas.<uid>.posicoes`); `camisas.<uid>.posicao` é a da principal
 * (ou "treinador", que vale para todas).
 */

export const MODALIDADES_TIME = ["campo", "society", "futsal"] as const;
export type ModalidadeTime = (typeof MODALIDADES_TIME)[number];

const ehModalidade = (v: unknown): v is ModalidadeTime => (MODALIDADES_TIME as readonly unknown[]).includes(v);

export const NOME_MODALIDADE: Record<ModalidadeTime, string> = { campo: "Campo", society: "Society", futsal: "Futsal" };

const POSICOES_FUTSAL = ["goleiro", "fixo", "ala", "pivo"];
const POSICOES_FUTEBOL = ["goleiro", "zagueiro", "lateral", "volante", "meia", "atacante"];
export const posicoesDaModalidade = (m: ModalidadeTime): string[] => (m === "futsal" ? POSICOES_FUTSAL : POSICOES_FUTEBOL);

/** A principal do time (padrão "society", como no app). */
export const modalidadePrincipal = (d: Record<string, unknown>): ModalidadeTime => (ehModalidade(d.modalidade) ? d.modalidade : "society");

/** Todas as modalidades do time, a principal primeiro, sem repetir. */
export const modalidadesDoTime = (d: Record<string, unknown>): ModalidadeTime[] => {
  const principal = modalidadePrincipal(d);
  const lista = Array.isArray(d.modalidades) ? d.modalidades.filter(ehModalidade) : [];
  return [principal, ...lista.filter((m) => m !== principal)].filter((m, i, a) => a.indexOf(m) === i).slice(0, 3);
};

export const jogaModalidade = (d: Record<string, unknown>, m: unknown): boolean => ehModalidade(m) && modalidadesDoTime(d).includes(m);

/** Modalidades que os dois times têm, na ordem do primeiro. */
export const modalidadesEmComum = (a: Record<string, unknown>, b: Record<string, unknown>): ModalidadeTime[] => {
  const deB = modalidadesDoTime(b);
  return modalidadesDoTime(a).filter((m) => deB.includes(m));
};

/** "Society · Futsal" (a principal primeiro). */
export const rotuloModalidades = (d: Record<string, unknown>): string => modalidadesDoTime(d).map((m) => NOME_MODALIDADE[m]).join(" · ");

/**
 * Posição do jogador numa modalidade ("treinador" vale para todas). Com o mapa `posicoes`, vale só ele: sem posição ali, a
 * pessoa desmarcou (ou ainda não escolheu). Sem o mapa (jogador de antes das várias modalidades), vale a posição antiga
 * quando ela existe na modalidade (society e campo têm as mesmas; goleiro existe em todas).
 */
export const posicaoNaModalidade = (camisa: unknown, m: ModalidadeTime): string => {
  const c = camisa && typeof camisa === "object" ? (camisa as Record<string, unknown>) : {};
  if (c.posicao === "treinador") return "treinador";
  const validas = posicoesDaModalidade(m);
  if (c.posicoes && typeof c.posicoes === "object" && !Array.isArray(c.posicoes)) {
    const propria = (c.posicoes as Record<string, unknown>)[m];
    return typeof propria === "string" && validas.includes(propria) ? propria : "";
  }
  return typeof c.posicao === "string" && validas.includes(c.posicao) ? c.posicao : "";
};
