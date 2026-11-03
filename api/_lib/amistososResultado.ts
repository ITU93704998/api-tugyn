import { Timestamp } from "firebase-admin/firestore";

/**
 * Resultado dos amistosos (regras puras, testadas). Fluxo:
 *  1. Depois do horário do jogo, o dono de um dos times informa o placar: o outro tem `PRAZO_PLACAR_MS` para confirmar.
 *  2. O outro pode não concordar UMA vez, informando outro placar: abre mais `PRAZO_PLACAR_MS` para o primeiro.
 *  3. Se o primeiro também não concordar, o jogo fica "sem acordo" e os dois times não podem mais se enfrentar.
 *  4. Sem resposta dentro do prazo, o placar enviado vale (quem ficou calado aceitou).
 *  5. Confirmado ("finalizado"), cada dono marca quem fez os gols do próprio time por `PRAZO_ARTILHEIROS_MS` (pode corrigir).
 * Jogo confirmado que ninguém finaliza em `PRAZO_FINALIZAR_MS` vira "sem placar" (não conta no resumo; libera outro amistoso).
 * Os prazos valem pela hora de agora (`efetivo`): a API aplica quando alguém age ou pede a apuração.
 */

export const PRAZO_PLACAR_MS = 3600_000;
export const PRAZO_FINALIZAR_MS = 3 * 24 * 3600_000;
export const PRAZO_ARTILHEIROS_MS = 7 * 24 * 3600_000;
export const MAX_GOLS = 99;

export type StatusAmistoso = "pendente" | "aceito" | "recusado" | "cancelado" | "placar" | "finalizado" | "sem_acordo" | "sem_placar";

type Doc = Record<string, unknown>;
type Negado = { ok: false; status: number; code: string; error: string };
const negar = (status: number, code: string, error: string): Negado => ({ ok: false, status, code, error });

export const millis = (v: unknown): number =>
  v instanceof Timestamp ? v.toMillis() : typeof (v as { toMillis?: unknown })?.toMillis === "function" ? (v as Timestamp).toMillis() : 0;

export interface Proposta {
  porTimeId: string;
  golsDe: number;
  golsPara: number;
  /** 1 = primeiro placar; 2 = o outro time não concordou e mandou o dele. */
  rodada: 1 | 2;
  venceEm: number;
}

export const propostaDe = (a: Doc): Proposta | null => {
  const p = a.proposta as Doc | undefined;
  if (!p || typeof p.porTimeId !== "string") return null;
  const gols = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_GOLS ? (v as number) : null);
  const golsDe = gols(p.golsDe);
  const golsPara = gols(p.golsPara);
  if (golsDe === null || golsPara === null) return null;
  return { porTimeId: p.porTimeId, golsDe, golsPara, rodada: p.rodada === 2 ? 2 : 1, venceEm: millis(p.venceEm) };
};

export interface Efetivo {
  status: StatusAmistoso;
  /** Só quando o prazo decidiu: o placar que passou a valer (`finalizado`). */
  resultado?: { golsDe: number; golsPara: number };
}

/** A situação do amistoso com os prazos vencidos aplicados (o documento pode estar atrasado). */
export const efetivo = (a: Doc, agora: number): Efetivo => {
  const status = String(a.status) as StatusAmistoso;
  if (status === "placar") {
    const p = propostaDe(a);
    if (p && p.venceEm <= agora) return { status: "finalizado", resultado: { golsDe: p.golsDe, golsPara: p.golsPara } };
  }
  if (status === "aceito" && millis(a.quando) + PRAZO_FINALIZAR_MS <= agora) return { status: "sem_placar" };
  return { status };
};

/** Ainda em andamento entre os dois times (impede marcar outro amistoso entre eles). */
export const emAndamento = (a: Doc, agora: number): boolean => {
  const { status } = efetivo(a, agora);
  return status === "aceito" || status === "placar" || (status === "pendente" && millis(a.quando) > agora);
};

const ladoId = (a: Doc, lado: "de" | "para"): string => String((a[lado] as Doc | undefined)?.timeId ?? "");

/** Os dois times deste amistoso, pela chave do lado. */
export const envolve = (a: Doc, timeId: string): boolean => ladoId(a, "de") === timeId || ladoId(a, "para") === timeId;

const golsValidos = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_GOLS;

/** Placar informado do ponto de vista de quem informa → { golsDe, golsPara } do documento. */
export const placarDoDocumento = (a: Doc, meuId: string, golsMeu: number, golsOutro: number) =>
  ladoId(a, "de") === meuId ? { golsDe: golsMeu, golsPara: golsOutro } : { golsDe: golsOutro, golsPara: golsMeu };

const ehDono = (uid: string, meu: Doc | null): boolean => Boolean(meu && meu.donoId === uid);

/** Informar o placar (finalizar a partida) ou, na 1ª rodada do outro time, não concordar mandando outro placar. */
export const motivoParaNaoInformarPlacar = (
  uid: string,
  agora: number,
  meuId: string,
  meu: Doc | null,
  a: Doc | null,
  golsMeu: unknown,
  golsOutro: unknown,
): Negado | null => {
  if (!ehDono(uid, meu)) return negar(403, "nao-dono", "Só o dono do time informa o placar.");
  if (!a || !envolve(a, meuId)) return negar(404, "inexistente", "Este amistoso não existe mais.");
  if (!golsValidos(golsMeu) || !golsValidos(golsOutro)) return negar(400, "placar-invalido", `Placar inválido (de 0 a ${MAX_GOLS} gols).`);
  const { status } = efetivo(a, agora);
  if (status === "aceito") {
    if (millis(a.quando) > agora) return negar(409, "cedo", "O placar só pode ser informado depois do horário do jogo.");
    return null;
  }
  if (status === "placar") {
    const p = propostaDe(a);
    if (!p) return negar(409, "estado", "Não foi possível ler o placar enviado. Tente de novo.");
    if (p.porTimeId === meuId) return negar(409, "aguardando", "Você já informou o placar. Espere o outro time confirmar.");
    if (p.rodada === 2) return negar(409, "segunda-rodada", "O outro time já mandou outro placar: agora é confirmar ou não concordar.");
    return null;
  }
  if (status === "finalizado") return negar(409, "finalizado", "O placar deste amistoso já foi confirmado.");
  if (status === "sem_acordo") return negar(409, "sem-acordo", "Este amistoso terminou sem acordo no placar.");
  if (status === "sem_placar") return negar(409, "sem-placar", "O prazo para informar o placar deste amistoso acabou.");
  return negar(409, "nao-confirmado", "Só amistosos confirmados recebem placar.");
};

/** Confirmar o placar que o OUTRO time informou. */
export const motivoParaNaoConfirmarPlacar = (uid: string, agora: number, meuId: string, meu: Doc | null, a: Doc | null): Negado | null => {
  if (!ehDono(uid, meu)) return negar(403, "nao-dono", "Só o dono do time confirma o placar.");
  if (!a || !envolve(a, meuId)) return negar(404, "inexistente", "Este amistoso não existe mais.");
  const { status } = efetivo(a, agora);
  if (status === "finalizado") return negar(409, "finalizado", "O placar deste amistoso já foi confirmado.");
  if (status !== "placar") return negar(409, "sem-placar-enviado", "Não há placar esperando confirmação.");
  if (propostaDe(a)?.porTimeId === meuId) return negar(409, "proprio", "Quem confirma é o outro time.");
  return null;
};

/** Não concordar de novo (2ª rodada): o jogo fica sem acordo. Na 1ª rodada, quem não concorda manda outro placar. */
export const motivoParaNaoRecusarPlacar = (uid: string, agora: number, meuId: string, meu: Doc | null, a: Doc | null): Negado | null => {
  const negado = motivoParaNaoConfirmarPlacar(uid, agora, meuId, meu, a);
  if (negado) return negado;
  if (propostaDe(a as Doc)?.rodada !== 2) return negar(409, "primeira-rodada", "Se não concorda, informe o placar certo.");
  return null;
};

/** Gols do meu time no resultado final. */
export const golsDoTime = (a: Doc, timeId: string): number | null => {
  const r = a.resultado as Doc | undefined;
  if (!r) return null;
  const gols = ladoId(a, "de") === timeId ? r.golsDe : r.golsPara;
  return golsValidos(gols) ? gols : null;
};

/** Quem fez os gols do MEU time: membros atuais, 1 a 99 gols cada, soma até o placar do time, dentro do prazo. */
export const motivoParaNaoMarcarArtilheiros = (
  uid: string,
  agora: number,
  meuId: string,
  meu: Doc | null,
  a: Doc | null,
  gols: Record<string, number>,
): Negado | null => {
  if (!ehDono(uid, meu)) return negar(403, "nao-dono", "Só o dono do time marca quem fez os gols.");
  if (!a || !envolve(a, meuId)) return negar(404, "inexistente", "Este amistoso não existe mais.");
  if (String(a.status) !== "finalizado") return negar(409, "nao-finalizado", "Só depois de o placar ser confirmado.");
  if (millis(a.finalizadoEm) + PRAZO_ARTILHEIROS_MS < agora) return negar(409, "prazo", "O prazo para marcar quem fez os gols (7 dias) acabou.");
  const membros = Array.isArray(meu?.membros) ? (meu?.membros as unknown[]) : [];
  // Quem já tinha gols marcados e saiu do time continua podendo ser corrigido (ou zerado).
  const jaMarcados = a.artilheiros && typeof a.artilheiros === "object" ? Object.keys(a.artilheiros as Doc) : [];
  const entradas = Object.entries(gols);
  if (entradas.some(([u, n]) => (!membros.includes(u) && !jaMarcados.includes(u)) || !Number.isInteger(n) || n < 1 || n > MAX_GOLS)) {
    return negar(400, "jogador", "Escolha só jogadores do elenco, com pelo menos 1 gol cada.");
  }
  const total = entradas.reduce((s, [, n]) => s + n, 0);
  const doTime = golsDoTime(a, meuId) ?? 0;
  if (total > doTime) return negar(400, "soma", `A soma dos gols (${total}) passa do placar do seu time (${doTime}).`);
  return null;
};

/** O que muda no resumo de UM time com este resultado (incrementos). */
export const resumoDoResultado = (golsPro: number, golsContra: number) => ({
  jogos: 1,
  vitorias: golsPro > golsContra ? 1 : 0,
  empates: golsPro === golsContra ? 1 : 0,
  derrotas: golsPro < golsContra ? 1 : 0,
  golsPro,
  golsContra,
});

/** Diferença de gols por jogador entre a marcação anterior e a nova (para somar no resumo). */
export const diferencaDeGols = (antes: Record<string, number>, depois: Record<string, number>): Record<string, number> => {
  const dif: Record<string, number> = {};
  for (const u of new Set([...Object.keys(antes), ...Object.keys(depois)])) {
    const d = (depois[u] ?? 0) - (antes[u] ?? 0);
    if (d !== 0) dif[u] = d;
  }
  return dif;
};

/** "Os Brabos 3 x 2 Rivais". */
export const placarTexto = (a: Doc, golsDe: number, golsPara: number): string =>
  `${String((a.de as Doc | undefined)?.nome ?? "Time")} ${golsDe} x ${golsPara} ${String((a.para as Doc | undefined)?.nome ?? "Time")}`;
