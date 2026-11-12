// CÓPIA de tugyn/src/screens/Campeonatos/utils/classificacao.ts (lógica pura do app). Mantenha igual ao app: o servidor confere o campeonato com ela.
import type { Campeonato, JogoCampeonato, OrigemVaga, StatusCampeonato } from "./types";
import { ID_FINAL, MAX_GOLS } from "./tabela";

/**
 * Classificação, avanço da chave, campeão e artilharia (funções puras). Os dados gravados são só os placares; todo o resto é
 * recalculado daqui, então corrigir um placar antigo arruma a tabela inteira.
 */

type Jogos = Record<string, JogoCampeonato>;

/** Jogo de pontos corridos (rodadas "r1", "r2"…); o resto é eliminatório (mata-mata ou a final entre os dois primeiros). */
export const ehRodada = (j: Pick<JogoCampeonato, "fase">): boolean => /^r\d+$/.test(j.fase);

export const temResultado = (j: JogoCampeonato): boolean => j.golsCasa !== null && j.golsFora !== null;

/** Jogos em ordem de tela. */
export const jogosEmOrdem = (jogos: Jogos): [string, JogoCampeonato][] => Object.entries(jogos).sort((a, b) => a[1].ordem - b[1].ordem);

export const rotuloFase = (fase: string): string => {
  const rodada = /^r(\d+)$/.exec(fase);
  if (rodada) return `${rodada[1]}ª rodada`;
  return { final: "Final", semi: "Semifinal", quartas: "Quartas de final", oitavas: "Oitavas de final" }[fase] ?? "Fase eliminatória";
};

/** Jogos agrupados por fase, na ordem da tabela. */
export const agruparPorFase = (jogos: Jogos): { fase: string; rotulo: string; jogos: [string, JogoCampeonato][] }[] => {
  const grupos: { fase: string; rotulo: string; jogos: [string, JogoCampeonato][] }[] = [];
  for (const par of jogosEmOrdem(jogos)) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo?.fase === par[1].fase) ultimo.jogos.push(par);
    else grupos.push({ fase: par[1].fase, rotulo: rotuloFase(par[1].fase), jogos: [par] });
  }
  return grupos;
};

// ─── Confrontos eliminatórios ────────────────────────────────────────────────

const pernasDe = (jogos: Jogos, confronto: string): JogoCampeonato[] =>
  Object.values(jogos).filter((j) => j.confronto === confronto).sort((a, b) => a.perna - b.perna);

/** Gols de cada time somando os jogos do confronto (null se falta algum placar ou algum time). */
const agregado = (pernas: JogoCampeonato[]): Map<string, number> | null => {
  const soma = new Map<string, number>();
  for (const j of pernas) {
    if (!j.casa || !j.fora || !temResultado(j)) return null;
    soma.set(j.casa, (soma.get(j.casa) ?? 0) + (j.golsCasa as number));
    soma.set(j.fora, (soma.get(j.fora) ?? 0) + (j.golsFora as number));
  }
  return soma.size === 2 ? soma : null;
};

/** Quem passou no confronto eliminatório: mais gols no agregado; empatado, quem ganhou nos pênaltis do último jogo. */
export const vencedorDoConfronto = (jogos: Jogos, confronto: string): string | null => {
  const pernas = pernasDe(jogos, confronto);
  if (!pernas.length) return null;
  const soma = agregado(pernas);
  if (!soma) return null;
  const [[a, ga], [b, gb]] = [...soma.entries()];
  if (ga !== gb) return ga > gb ? a : b;
  const ultimo = pernas[pernas.length - 1];
  if (!ultimo.penaltis || ultimo.penaltis[0] === ultimo.penaltis[1]) return null;
  return ultimo.penaltis[0] > ultimo.penaltis[1] ? (ultimo.casa as string) : (ultimo.fora as string);
};

/**
 * Este placar deixa o confronto empatado e é o último jogo dele? Então precisa dos pênaltis. Vale para o mata-mata e para a
 * final entre os dois primeiros; nunca para as rodadas.
 */
export const precisaPenaltis = (jogos: Jogos, jogoId: string, golsCasa: number, golsFora: number): boolean => {
  const jogo = jogos[jogoId];
  if (!jogo || ehRodada(jogo)) return false;
  const pernas = pernasDe(jogos, jogo.confronto);
  if (pernas[pernas.length - 1] !== jogo) return false;
  const simulado = pernas.map((j) => (j === jogo ? { ...j, golsCasa, golsFora } : j));
  const soma = agregado(simulado);
  if (!soma) return false;
  const [x, y] = [...soma.values()];
  return x === y;
};

// ─── Classificação dos pontos corridos ───────────────────────────────────────

export interface LinhaClassificacao {
  timeId: string;
  pontos: number;
  jogos: number;
  vitorias: number;
  empates: number;
  derrotas: number;
  golsPro: number;
  golsContra: number;
  saldo: number;
}

const linhaVazia = (timeId: string): LinhaClassificacao => ({ timeId, pontos: 0, jogos: 0, vitorias: 0, empates: 0, derrotas: 0, golsPro: 0, golsContra: 0, saldo: 0 });

const somar = (timeIds: readonly string[], jogos: JogoCampeonato[], vitoria: number, empate: number): Map<string, LinhaClassificacao> => {
  const linhas = new Map(timeIds.map((id) => [id, linhaVazia(id)]));
  for (const j of jogos) {
    if (!j.casa || !j.fora || !temResultado(j)) continue;
    const c = linhas.get(j.casa), f = linhas.get(j.fora);
    if (!c || !f) continue;
    const gc = j.golsCasa as number, gf = j.golsFora as number;
    for (const [l, pro, contra] of [[c, gc, gf], [f, gf, gc]] as const) {
      l.jogos += 1;
      l.golsPro += pro;
      l.golsContra += contra;
      l.saldo = l.golsPro - l.golsContra;
      if (pro > contra) { l.vitorias += 1; l.pontos += vitoria; }
      else if (pro === contra) { l.empates += 1; l.pontos += empate; }
      else l.derrotas += 1;
    }
  }
  return linhas;
};

/**
 * Tabela dos pontos corridos. Desempate: pontos, vitórias, saldo, gols pró, confronto direto (pontos, saldo e gols só nos
 * jogos entre os empatados) e, por fim, o sorteio gravado na criação.
 */
export const calcularClassificacao = (c: Pick<Campeonato, "times" | "jogos" | "regras" | "sorteio">): LinhaClassificacao[] => {
  const { pontosVitoria, pontosEmpate } = c.regras;
  const rodadas = Object.values(c.jogos).filter(ehRodada);
  const timeIds = Object.keys(c.times);
  const geral = [...somar(timeIds, rodadas, pontosVitoria, pontosEmpate).values()];
  const posSorteio = (id: string) => {
    const i = c.sorteio.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const chave = (l: LinhaClassificacao) => [l.pontos, l.vitorias, l.saldo, l.golsPro];
  const comparar = (x: number[], y: number[]) => {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  };
  geral.sort((a, b) => comparar(chave(a), chave(b)) || posSorteio(a.timeId) - posSorteio(b.timeId));
  // Confronto direto dentro de cada grupo empatado nos quatro primeiros critérios.
  const final: LinhaClassificacao[] = [];
  for (let i = 0; i < geral.length; ) {
    let fim = i + 1;
    while (fim < geral.length && comparar(chave(geral[i]), chave(geral[fim])) === 0) fim++;
    const grupo = geral.slice(i, fim);
    if (grupo.length > 1) {
      const ids = grupo.map((l) => l.timeId);
      const entreEles = rodadas.filter((j) => j.casa && j.fora && ids.includes(j.casa) && ids.includes(j.fora));
      const mini = somar(ids, entreEles, pontosVitoria, pontosEmpate);
      const k = (l: LinhaClassificacao) => {
        const m = mini.get(l.timeId) as LinhaClassificacao;
        return [m.pontos, m.saldo, m.golsPro];
      };
      grupo.sort((a, b) => comparar(k(a), k(b)) || posSorteio(a.timeId) - posSorteio(b.timeId));
    }
    final.push(...grupo);
    i = fim;
  }
  return final;
};

export const rodadasEncerradas = (jogos: Jogos): boolean => {
  const rodadas = Object.values(jogos).filter(ehRodada);
  return rodadas.length > 0 && rodadas.every(temResultado);
};

// ─── Avanço da chave e campeão ───────────────────────────────────────────────

/** Apaga o placar e tudo do ao vivo (cronômetro, gols, cartões): o jogo volta a não ter sido jogado. */
export const limparResultado = (j: JogoCampeonato): JogoCampeonato => ({ ...j, golsCasa: null, golsFora: null, penaltis: null, gols: {}, assistencias: {}, aoVivo: null, eventos: [] });

/**
 * Preenche os times dos jogos que dependem de outros (vencedor de confronto ou posição na classificação), na ordem da tabela
 * para a chave andar em cascata. Se um placar antigo foi corrigido e o time de um jogo seguinte mudou, o placar desse jogo
 * é apagado (era de outro confronto).
 */
export const resolverJogos = (c: Pick<Campeonato, "times" | "jogos" | "regras" | "sorteio">): Jogos => {
  const jogos: Jogos = { ...c.jogos };
  let classificacao: LinhaClassificacao[] | null = null;
  const vaga = (o: OrigemVaga | null, atual: string | null): string | null => {
    if (!o) return atual;
    if ("vencedor" in o) return vencedorDoConfronto(jogos, o.vencedor);
    if (!rodadasEncerradas(jogos)) return null;
    classificacao ??= calcularClassificacao({ ...c, jogos });
    return classificacao[o.posicao - 1]?.timeId ?? null;
  };
  for (const [id, j] of jogosEmOrdem(jogos)) {
    if (!j.origem) continue;
    const casa = vaga(j.origem.casa, j.casa), fora = vaga(j.origem.fora, j.fora);
    if (casa === j.casa && fora === j.fora) continue;
    jogos[id] = limparResultado({ ...j, casa, fora });
  }
  return jogos;
};

/** Campeão: o vencedor da final ou, nos pontos corridos sem final, o 1º quando todas as rodadas têm placar. */
export const campeaoDe = (c: Pick<Campeonato, "times" | "jogos" | "regras" | "sorteio">): string | null => {
  if (c.jogos[ID_FINAL]) return vencedorDoConfronto(c.jogos, ID_FINAL);
  if (!rodadasEncerradas(c.jogos)) return null;
  return calcularClassificacao(c)[0]?.timeId ?? null;
};

/** O próximo jogo a lançar: o primeiro, na ordem da tabela, com os dois times e sem placar. */
export const proximoJogo = (jogos: Jogos): string | null =>
  jogosEmOrdem(jogos).find(([, j]) => j.casa && j.fora && !temResultado(j))?.[0] ?? null;

// ─── Lançar resultado ────────────────────────────────────────────────────────

export interface ResultadoJogo {
  golsCasa: number;
  golsFora: number;
  penaltis: [number, number] | null;
  gols: Record<string, number>;
  /** Só o ao vivo informa. */
  assistencias?: Record<string, number>;
}

const golsValidos = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_GOLS;

/** Problema no resultado (mensagem para a tela) ou null. */
export const validarResultado = (c: Pick<Campeonato, "times" | "jogos">, jogoId: string, r: ResultadoJogo): string | null => {
  const jogo = c.jogos[jogoId];
  if (!jogo) return "Este jogo não existe mais.";
  if (!jogo.casa || !jogo.fora) return "Os times deste jogo ainda não foram definidos.";
  if (!golsValidos(r.golsCasa) || !golsValidos(r.golsFora)) return `O placar vai de 0 a ${MAX_GOLS}.`;
  if (precisaPenaltis(c.jogos, jogoId, r.golsCasa, r.golsFora)) {
    if (!r.penaltis || !golsValidos(r.penaltis[0]) || !golsValidos(r.penaltis[1])) return "O confronto empatou: informe os pênaltis.";
    if (r.penaltis[0] === r.penaltis[1]) return "Os pênaltis precisam ter um vencedor.";
  }
  for (const [lado, timeId, total] of [["casa", jogo.casa, r.golsCasa], ["fora", jogo.fora, r.golsFora]] as const) {
    const elenco = new Set((c.times[timeId]?.elenco ?? []).map((j) => j.id));
    let soma = 0;
    for (const [jogador, g] of Object.entries(r.gols)) {
      if (!elenco.has(jogador)) continue;
      if (!golsValidos(g) || g === 0) return "Número de gols inválido.";
      soma += g;
    }
    if (soma > total) return `Os gols marcados pelos jogadores do ${c.times[timeId]?.nome ?? lado} passam do placar.`;
  }
  for (const [jogador, n] of Object.entries(r.assistencias ?? {})) if (!golsValidos(n)) return `Número de assistências inválido (${jogador}).`;
  const doJogo = new Set([...(c.times[jogo.casa]?.elenco ?? []), ...(c.times[jogo.fora]?.elenco ?? [])].map((j) => j.id));
  if (Object.keys(r.gols).some((id) => !doJogo.has(id))) return "Um dos artilheiros não é de nenhum dos dois times.";
  return null;
};

/**
 * Aplica (ou apaga, com null) o placar de um jogo e devolve o que gravar: os jogos com a chave atualizada, o campeão e o
 * status. Lança Error com a mensagem se o resultado for inválido.
 */
export const aplicarResultado = (
  c: Pick<Campeonato, "times" | "jogos" | "regras" | "sorteio">,
  jogoId: string,
  r: ResultadoJogo | null,
): { jogos: Jogos; campeao: string | null; status: StatusCampeonato } => {
  const jogo = c.jogos[jogoId];
  if (!jogo) throw new Error("Este jogo não existe mais.");
  let atualizado: JogoCampeonato;
  if (r) {
    const erro = validarResultado(c, jogoId, r);
    if (erro) throw new Error(erro);
    const penaltis = precisaPenaltis(c.jogos, jogoId, r.golsCasa, r.golsFora) ? r.penaltis : null;
    const gols = Object.fromEntries(Object.entries(r.gols).filter(([, g]) => g > 0));
    const assistencias = Object.fromEntries(Object.entries(r.assistencias ?? {}).filter(([, g]) => g > 0));
    atualizado = { ...jogo, golsCasa: r.golsCasa, golsFora: r.golsFora, penaltis, gols, assistencias };
  } else {
    atualizado = limparResultado(jogo);
  }
  return aplicarJogo(c, jogoId, atualizado);
};

/** Troca um jogo inteiro e recalcula a chave, o campeão e o status (o que gravar). */
export const aplicarJogo = (
  c: Pick<Campeonato, "times" | "jogos" | "regras" | "sorteio">,
  jogoId: string,
  jogo: JogoCampeonato,
): { jogos: Jogos; campeao: string | null; status: StatusCampeonato } => {
  const base = { ...c, jogos: { ...c.jogos, [jogoId]: jogo } };
  const jogos = resolverJogos(base);
  const campeao = campeaoDe({ ...base, jogos });
  return { jogos, campeao, status: campeao ? "encerrado" : "andamento" };
};

// ─── Artilharia ──────────────────────────────────────────────────────────────

export interface Artilheiro {
  id: string;
  nome: string;
  timeId: string;
  gols: number;
}

const somaPorJogador = (c: Pick<Campeonato, "times" | "jogos">, campo: (j: JogoCampeonato) => Record<string, number>): Artilheiro[] => {
  const donos = new Map<string, { nome: string; timeId: string }>();
  for (const [timeId, t] of Object.entries(c.times)) for (const j of t.elenco) donos.set(j.id, { nome: j.nome, timeId });
  const soma = new Map<string, number>();
  for (const j of Object.values(c.jogos)) {
    if (!temResultado(j)) continue;
    for (const [id, g] of Object.entries(campo(j))) if (donos.has(id)) soma.set(id, (soma.get(id) ?? 0) + g);
  }
  return [...soma.entries()]
    .filter(([, g]) => g > 0)
    .map(([id, gols]) => ({ id, gols, ...(donos.get(id) as { nome: string; timeId: string }) }))
    .sort((a, b) => b.gols - a.gols || a.nome.localeCompare(b.nome, "pt-BR"));
};

/** Garçons: assistências dos jogos encerrados (campo `gols` do item = assistências). */
export const garcons = (c: Pick<Campeonato, "times" | "jogos">): Artilheiro[] => somaPorJogador(c, (j) => j.assistencias);

export interface CartoesJogador {
  id: string;
  nome: string;
  timeId: string;
  amarelos: number;
  vermelhos: number;
}

/** Cartões de todos os jogos (inclusive o que está ao vivo), de quem tem mais vermelhos e amarelos. */
export const cartoes = (c: Pick<Campeonato, "times" | "jogos">): CartoesJogador[] => {
  const donos = new Map<string, { nome: string; timeId: string }>();
  for (const [timeId, t] of Object.entries(c.times)) for (const j of t.elenco) donos.set(j.id, { nome: j.nome, timeId });
  const soma = new Map<string, CartoesJogador>();
  for (const j of Object.values(c.jogos)) {
    for (const e of j.eventos) {
      if (e.tipo === "gol" || !e.jogador || !donos.has(e.jogador)) continue;
      const atual = soma.get(e.jogador) ?? { id: e.jogador, ...(donos.get(e.jogador) as { nome: string; timeId: string }), amarelos: 0, vermelhos: 0 };
      if (e.tipo === "amarelo") atual.amarelos += 1;
      else atual.vermelhos += 1;
      soma.set(e.jogador, atual);
    }
  }
  return [...soma.values()].sort((a, b) => b.vermelhos - a.vermelhos || b.amarelos - a.amarelos || a.nome.localeCompare(b.nome, "pt-BR"));
};

export const artilharia = (c: Pick<Campeonato, "times" | "jogos">): Artilheiro[] => somaPorJogador(c, (j) => j.gols);
