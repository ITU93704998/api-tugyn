// CÓPIA de tugyn/src/screens/Campeonatos/types.ts (lógica pura do app). Mantenha igual ao app: o servidor confere o campeonato com ela.
/**
 * Campeonatos da turma (`turmas/{turmaId}/campeonatos/{id}`): o organizador cria os times, a tabela é gerada no app e ele
 * mesmo lança os placares. Tudo fica num documento só (times + jogos), então lançar um placar e avançar a chave é uma
 * gravação. Não conta no ranking da temporada: o campeonato tem classificação e artilharia próprias.
 */

/** "pontos" = pontos corridos (triangular e quadrangular são pontos corridos com 3 ou 4 times). */
export type FormatoCampeonato = "pontos" | "mata";

export type StatusCampeonato = "andamento" | "encerrado";

export interface RegrasCampeonato {
  /** Pontos corridos: segundo turno com o mando invertido. */
  returno: boolean;
  /** Mata-mata: ida e volta em todas as fases, menos a final (jogo único). */
  idaVolta: boolean;
  pontosVitoria: number;
  pontosEmpate: number;
  /** Pontos corridos: no fim, final em jogo único entre o 1º e o 2º. */
  finalEntreDois: boolean;
  /** Jogo ao vivo: 1 ou 2 tempos. */
  tempos: 1 | 2;
  /** Duração de cada tempo (o cronômetro passa disso nos acréscimos). */
  minutosPorTempo: number;
}

export interface JogadorCampeonato {
  /** id do participante na turma. */
  id: string;
  nome: string;
}

export interface TimeCampeonato {
  nome: string;
  /** Cor do time (hex). */
  cor: string;
  /** Opcional: sem elenco, o campeonato não tem artilharia. */
  elenco: JogadorCampeonato[];
}

/** De onde vem um time de um jogo que depende de outro: o vencedor de um confronto ou uma posição da classificação. */
export type OrigemVaga = { vencedor: string } | { posicao: number };

/** Momento do jogo ao vivo. "fim" = encerrado pelo ao vivo (o placar é o dos eventos). */
export type PeriodoAoVivo = "t1" | "intervalo" | "t2" | "fim";

/** Cronômetro do jogo ao vivo (relógio do aparelho de quem controla). */
export interface CronometroJogo {
  periodo: PeriodoAoVivo;
  rodando: boolean;
  /** Quando o trecho atual começou a rodar (ms). */
  inicioMs: number;
  /** Tempo já corrido em cada tempo, sem o trecho atual: [1º, 2º]. */
  acumuladoMs: [number, number];
}

export type TipoEvento = "gol" | "amarelo" | "vermelho";

export interface EventoJogo {
  id: string;
  tipo: TipoEvento;
  /** Gol: o time que ganha o gol. Cartão: o time do jogador. */
  time: string;
  /** participanteId (null = não identificado). Gol contra: jogador do outro time. */
  jogador: string | null;
  /** Só gol: quem deu o passe (mesmo time, nunca no gol contra). */
  assistencia: string | null;
  contra: boolean;
  tempo: 1 | 2;
  /** Quanto o cronômetro marcava no tempo (ms). */
  ms: number;
}

export interface JogoCampeonato {
  /** "r1", "r2"… (rodadas dos pontos corridos) ou "oitavas", "quartas", "semi", "final"… */
  fase: string;
  /** Ordem na tela (rodada/fase e posição). */
  ordem: number;
  /** Mata-mata: id do confronto (os dois jogos da ida e volta têm o mesmo). Pontos corridos: o próprio id do jogo. */
  confronto: string;
  /** 1 = ida (ou jogo único), 2 = volta. */
  perna: 1 | 2;
  /** timeId; null = ainda depende de outro jogo. */
  casa: string | null;
  fora: string | null;
  /** null no lado que já tem time definido (ex.: quem passou direto na 1ª fase). */
  origem: { casa: OrigemVaga | null; fora: OrigemVaga | null } | null;
  golsCasa: number | null;
  golsFora: number | null;
  /** Pênaltis [casa, fora]: só no jogo que decide um confronto de mata-mata empatado. */
  penaltis: [number, number] | null;
  /** participanteId → gols neste jogo. */
  gols: Record<string, number>;
  /** participanteId → assistências neste jogo (só pelo ao vivo). */
  assistencias: Record<string, number>;
  /** null = o jogo não foi controlado ao vivo. */
  aoVivo: CronometroJogo | null;
  /** Gols e cartões do ao vivo, na ordem em que aconteceram. */
  eventos: EventoJogo[];
}

export interface Campeonato {
  id: string;
  nome: string;
  formato: FormatoCampeonato;
  regras: RegrasCampeonato;
  status: StatusCampeonato;
  times: Record<string, TimeCampeonato>;
  jogos: Record<string, JogoCampeonato>;
  /** Ordem sorteada na criação: último critério de desempate (fica gravada, então a tabela nunca "muda sozinha"). */
  sorteio: string[];
  campeao: string | null;
  criadoPor: string;
  criadoEmMs: number;
  atualizadoEmMs: number;
}
