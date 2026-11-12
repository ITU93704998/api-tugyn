// CÓPIA de tugyn/src/screens/Campeonatos/utils/tabela.ts (lógica pura do app). Mantenha igual ao app: o servidor confere o campeonato com ela.
import type { FormatoCampeonato, JogoCampeonato, OrigemVaga, RegrasCampeonato, TimeCampeonato } from "./types";

/**
 * Geração da tabela do campeonato (funções puras, sem Firebase): pontos corridos pelo método do rodízio e mata-mata com
 * chave cabeça de chave (quem passa direto quando o número de times não é potência de 2).
 */

export const MIN_TIMES = 3;
export const MAX_TIMES = 16;
export const NOME_CAMPEONATO_MAX = 50;
export const NOME_TIME_MAX = 24;
export const MAX_ELENCO = 30;
export const MAX_GOLS = 99;
/** Campeonatos em andamento ao mesmo tempo, por turma. */
export const MAX_EM_ANDAMENTO = 3;
export const CORES_TIMES = ["#FE7552", "#3B82F6", "#22C55E", "#EAB308", "#A855F7", "#EF4444", "#14B8A6", "#F97316", "#EC4899", "#64748B", "#84CC16", "#06B6D4", "#8B5CF6", "#F43F5E", "#10B981", "#FFFFFF"];

export const MAX_MINUTOS_TEMPO = 90;
export const REGRAS_PADRAO: RegrasCampeonato = { returno: false, idaVolta: false, pontosVitoria: 3, pontosEmpate: 1, finalEntreDois: false, tempos: 2, minutosPorTempo: 10 };

/** Ids dos jogos fixos. */
export const ID_FINAL = "final";

const jogoVazio = (j: Pick<JogoCampeonato, "fase" | "ordem" | "confronto" | "perna" | "casa" | "fora" | "origem">): JogoCampeonato => ({
  ...j,
  golsCasa: null,
  golsFora: null,
  penaltis: null,
  gols: {},
  assistencias: {},
  aoVivo: null,
  eventos: [],
});

/** Embaralha (Fisher–Yates). `aleatorio` só para os testes. */
export const sortear = <T>(lista: readonly T[], aleatorio: () => number = Math.random): T[] => {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
};

// ─── Pontos corridos ─────────────────────────────────────────────────────────

/**
 * Rodízio: com N par são N−1 rodadas de N/2 jogos; com N ímpar entra uma "folga" (quem pega a folga não joga na rodada).
 * O returno repete as rodadas com o mando invertido. `finalEntreDois` acrescenta a final entre o 1º e o 2º.
 */
export const gerarPontosCorridos = (timeIds: readonly string[], returno: boolean, finalEntreDois: boolean): Record<string, JogoCampeonato> => {
  let lista: (string | null)[] = [...timeIds];
  if (lista.length % 2) lista.push(null);
  const n = lista.length;
  const turno: { rodada: number; k: number; casa: string; fora: string }[] = [];
  for (let r = 0; r < n - 1; r++) {
    let k = 0;
    for (let i = 0; i < n / 2; i++) {
      const a = lista[i], b = lista[n - 1 - i];
      if (!a || !b) continue;
      // O time fixo do rodízio alterna o mando a cada rodada.
      const [casa, fora] = i === 0 && r % 2 === 1 ? [b, a] : [a, b];
      turno.push({ rodada: r + 1, k: k++, casa, fora });
    }
    lista = [lista[0], lista[n - 1], ...lista.slice(1, n - 1)];
  }
  const jogos: Record<string, JogoCampeonato> = {};
  const add = (rodada: number, k: number, casa: string, fora: string) => {
    const id = `r${rodada}j${k + 1}`;
    jogos[id] = jogoVazio({ fase: `r${rodada}`, ordem: rodada * 100 + k, confronto: id, perna: 1, casa, fora, origem: null });
  };
  turno.forEach((j) => add(j.rodada, j.k, j.casa, j.fora));
  if (returno) turno.forEach((j) => add(j.rodada + n - 1, j.k, j.fora, j.casa));
  if (finalEntreDois) {
    jogos[ID_FINAL] = jogoVazio({ fase: "final", ordem: 99_000, confronto: ID_FINAL, perna: 1, casa: null, fora: null, origem: { casa: { posicao: 1 }, fora: { posicao: 2 } } });
  }
  return jogos;
};

// ─── Mata-mata ───────────────────────────────────────────────────────────────

/** Nome da fase pelo número de times que entram nela. */
export const faseDoMataMata = (timesNaFase: number): string =>
  timesNaFase === 2 ? "final" : timesNaFase === 4 ? "semi" : timesNaFase === 8 ? "quartas" : timesNaFase === 16 ? "oitavas" : `fase${timesNaFase}`;

/** Ordem cabeça de chave para P vagas: 8 → [1, 8, 4, 5, 2, 7, 3, 6] (o 1º e o 2º só se cruzam na final). */
export const ordemDaChave = (vagas: number): number[] => {
  let ordem = [1, 2];
  while (ordem.length < vagas) {
    const m = ordem.length * 2;
    ordem = ordem.flatMap((s) => [s, m + 1 - s]);
  }
  return ordem.slice(0, vagas);
};

type Vaga = { time: string } | OrigemVaga;

/**
 * Chave do mata-mata na ordem recebida (a 1ª posição é o cabeça de chave 1; a tela sorteia antes, se o organizador quiser).
 * Sem potência de 2, os primeiros passam direto para a 2ª fase. Com `idaVolta`, cada confronto tem dois jogos (o segundo com o
 * mando invertido), menos a final, que é sempre jogo único.
 */
export const gerarMataMata = (timeIds: readonly string[], idaVolta: boolean): Record<string, JogoCampeonato> => {
  const n = timeIds.length;
  let vagasTotais = 2;
  while (vagasTotais < n) vagasTotais *= 2;
  let vagas: (Vaga | null)[] = ordemDaChave(vagasTotais).map((semente) => (semente <= n ? { time: timeIds[semente - 1] } : null));
  const jogos: Record<string, JogoCampeonato> = {};
  for (let r = 0, naFase = vagasTotais; naFase >= 2; r++, naFase /= 2) {
    const fase = faseDoMataMata(naFase);
    const final = naFase === 2;
    const proximas: Vaga[] = [];
    for (let k = 0; k < vagas.length; k += 2) {
      const a = vagas[k], b = vagas[k + 1];
      // Só na 1ª fase: o cabeça de chave sem adversário passa direto.
      if (!a || !b) {
        proximas.push((a ?? b) as Vaga);
        continue;
      }
      const confronto = final ? ID_FINAL : `${fase}${k / 2 + 1}`;
      const lado = (v: Vaga) => ("time" in v ? { time: v.time, origem: null } : { time: null, origem: v });
      const A = lado(a), B = lado(b);
      const temOrigem = A.origem || B.origem;
      const pernas: (1 | 2)[] = idaVolta && !final ? [1, 2] : [1];
      for (const perna of pernas) {
        const [c, f] = perna === 1 ? [A, B] : [B, A];
        const id = pernas.length === 2 ? `${confronto}${perna === 1 ? "a" : "b"}` : confronto;
        jogos[id] = jogoVazio({
          fase,
          ordem: (r + 1) * 1000 + (k / 2) * 2 + perna,
          confronto,
          perna,
          casa: c.time,
          fora: f.time,
          origem: temOrigem ? { casa: c.origem, fora: f.origem } : null,
        });
      }
      proximas.push({ vencedor: confronto });
    }
    vagas = proximas;
  }
  return jogos;
};

// ─── Criação ─────────────────────────────────────────────────────────────────

export const gerarTabela = (formato: FormatoCampeonato, timeIds: readonly string[], regras: RegrasCampeonato): Record<string, JogoCampeonato> =>
  formato === "mata" ? gerarMataMata(timeIds, regras.idaVolta) : gerarPontosCorridos(timeIds, regras.returno, regras.finalEntreDois);

/** Quantos jogos a tabela vai ter (para a revisão antes de criar). */
export const totalDeJogos = (formato: FormatoCampeonato, n: number, regras: RegrasCampeonato): number => {
  if (n < 2) return 0;
  if (formato === "pontos") return ((n * (n - 1)) / 2) * (regras.returno ? 2 : 1) + (regras.finalEntreDois ? 1 : 0);
  // Mata-mata: n − 1 confrontos; com ida e volta, todos menos a final têm dois jogos.
  return regras.idaVolta ? 2 * (n - 1) - 1 : n - 1;
};

/** Nome do formato para a tela: 3 e 4 times em pontos corridos viram triangular e quadrangular. */
export const nomeDoFormato = (formato: FormatoCampeonato, n: number): string =>
  formato === "mata" ? "Mata-mata" : n === 3 ? "Triangular" : n === 4 ? "Quadrangular" : "Pontos corridos";

export interface NovoCampeonato {
  nome: string;
  formato: FormatoCampeonato;
  regras: RegrasCampeonato;
  times: TimeCampeonato[];
}

/** Problema que impede criar (mensagem para a tela) ou null. */
export const validarNovoCampeonato = (c: NovoCampeonato): string | null => {
  const nome = c.nome.trim();
  if (!nome) return "Dê um nome ao campeonato.";
  if (nome.length > NOME_CAMPEONATO_MAX) return `O nome pode ter até ${NOME_CAMPEONATO_MAX} caracteres.`;
  if (c.formato !== "pontos" && c.formato !== "mata") return "Escolha o formato.";
  if (c.times.length < MIN_TIMES) return `Cadastre pelo menos ${MIN_TIMES} times.`;
  if (c.times.length > MAX_TIMES) return `O campeonato pode ter até ${MAX_TIMES} times.`;
  const nomes = new Set<string>();
  for (const t of c.times) {
    const n = t.nome.trim();
    if (!n) return "Todo time precisa de um nome.";
    if (n.length > NOME_TIME_MAX) return `O nome do time pode ter até ${NOME_TIME_MAX} caracteres.`;
    const chave = n.toLocaleLowerCase("pt-BR");
    if (nomes.has(chave)) return `Há dois times chamados "${n}".`;
    nomes.add(chave);
    if (t.elenco.length > MAX_ELENCO) return `O ${n} pode ter até ${MAX_ELENCO} jogadores.`;
  }
  const jogadores = c.times.flatMap((t) => t.elenco.map((j) => j.id));
  if (new Set(jogadores).size !== jogadores.length) return "Um jogador está em mais de um time.";
  const { pontosVitoria, pontosEmpate } = c.regras;
  if (![2, 3].includes(pontosVitoria) || ![0, 1].includes(pontosEmpate)) return "Pontuação inválida.";
  if (c.regras.tempos !== 1 && c.regras.tempos !== 2) return "Escolha 1 ou 2 tempos.";
  if (!Number.isInteger(c.regras.minutosPorTempo) || c.regras.minutosPorTempo < 1 || c.regras.minutosPorTempo > MAX_MINUTOS_TEMPO) return `Cada tempo pode ter de 1 a ${MAX_MINUTOS_TEMPO} minutos.`;
  if (c.formato === "pontos" && c.regras.finalEntreDois && c.times.length < 3) return "A final entre os dois primeiros precisa de 3 times ou mais.";
  return null;
};
