/**
 * Galeria de troféus (parte PURA): a partir do campeonato gravado no Firestore (nunca do que o app diz), quem ganhou o quê.
 *  - campeão:    todos os jogadores do elenco do time campeão;
 *  - artilheiro: quem fez mais gols nos jogos encerrados (empatados no topo, todos levam);
 *  - garçom:     quem deu mais assistências nos jogos encerrados (idem).
 *
 * O documento do campeonato é gravado pelo app do organizador, então o servidor NÃO confia nele: antes de dar qualquer troféu,
 * confere a competição inteira (`validarCampeonato`) com a mesma lógica do app (`./campeonato/*`): placares inteiros de 0 a
 * 99, gols/assistências que cabem no placar e são de jogadores dos dois times, tabela completa e coerente com o formato,
 * chave/classificação resolvidas e o campeão RECALCULADO igual ao gravado. Qualquer coisa estranha: ninguém recebe nada.
 * Só recebe quem é (ou já foi reconhecido como) membro da turma: um uid de fora colocado no elenco é ignorado.
 *
 * Onde fica: `users/{uid}/restrito/trofeus` → `{ itens: { "<turmaId>_<campeonatoId>": Trofeu }, atualizadoEm }`, com as
 * mesmas regras de leitura da parte restrita do perfil (perfil privado: só o dono). O registro de quem recebeu cada
 * campeonato (`trofeusCampeonatos/<turmaId>_<campeonatoId>` → `{ uids, assinatura }`) só o servidor lê. Quem grava é
 * `./trofeusSync.ts` (gatilho das Functions a cada mudança do campeonato).
 */
import type { Campeonato, JogoCampeonato, OrigemVaga, RegrasCampeonato, TimeCampeonato } from "./campeonato/types";
import { MAX_ELENCO, MAX_GOLS, MAX_TIMES, MIN_TIMES, gerarTabela } from "./campeonato/tabela";
import { campeaoDe, resolverJogos, temResultado } from "./campeonato/classificacao";

export type TipoTrofeu = "campeao" | "artilheiro" | "garcom";

export interface Trofeu {
  turmaId: string;
  campeonatoId: string;
  campeonato: string;
  turma: string;
  /** Time da pessoa no campeonato. */
  time: string;
  cor: string;
  titulos: TipoTrofeu[];
  /** Gols e assistências da pessoa no campeonato (para "Artilheiro · 7 gols"). */
  gols: number;
  assistencias: number;
}

type Dados = Record<string, unknown> | null | undefined;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const ehObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const texto = (v: unknown, max: number, padrao = ""): string => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : padrao);
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const ID_LOCAL = /^[A-Za-z0-9_-]{1,40}$/;
const golValido = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_GOLS;
const contagemValida = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_GOLS;

export const chaveDoTrofeu = (turmaId: string, campeonatoId: string): string => `${turmaId}_${campeonatoId}`;

class Invalido extends Error {}
const exigir = (condicao: unknown, motivo: string): void => {
  if (!condicao) throw new Invalido(motivo);
};

const origemDe = (v: unknown): OrigemVaga | null => {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  if (typeof o.vencedor === "string" && ID_LOCAL.test(o.vencedor)) return { vencedor: o.vencedor };
  if (typeof o.posicao === "number" && Number.isInteger(o.posicao) && o.posicao >= 1 && o.posicao <= MAX_TIMES) return { posicao: o.posicao };
  throw new Invalido("origem");
};

const contagemDe = (v: unknown, jogadores: Set<string>, motivo: string): Record<string, number> => {
  if (v === undefined || v === null) return {};
  exigir(ehObj(v), motivo);
  const saida: Record<string, number> = {};
  for (const [id, n] of Object.entries(v as Record<string, unknown>)) {
    exigir(jogadores.has(id) && contagemValida(n), motivo);
    saida[id] = n as number;
  }
  return saida;
};

/**
 * Lê e confere o campeonato gravado (forma e coerência da competição). Devolve o campeonato tipado para os cálculos, ou
 * lança `Invalido`. Não olha cronômetro nem lances ao vivo (os placares, gols e assistências encerrados é que valem).
 */
export const validarCampeonato = (id: string, d: Record<string, unknown>): Campeonato => {
  exigir(d.status === "encerrado", "status");
  exigir(d.formato === "pontos" || d.formato === "mata", "formato");
  const formato = d.formato as Campeonato["formato"];
  const r = obj(d.regras);
  exigir([2, 3].includes(r.pontosVitoria as number) && [0, 1].includes(r.pontosEmpate as number), "regras");
  const regras: RegrasCampeonato = {
    returno: r.returno === true,
    idaVolta: r.idaVolta === true,
    pontosVitoria: r.pontosVitoria as number,
    pontosEmpate: r.pontosEmpate as number,
    finalEntreDois: r.finalEntreDois === true,
    tempos: r.tempos === 1 ? 1 : 2,
    minutosPorTempo: 10,
  };

  // Times e elencos: ids locais, 3 a 16 times, até 30 jogadores, ninguém em dois times.
  exigir(ehObj(d.times), "times");
  const timesBrutos = Object.entries(d.times as Record<string, unknown>);
  exigir(timesBrutos.length >= MIN_TIMES && timesBrutos.length <= MAX_TIMES, "quantidade de times");
  const times: Record<string, TimeCampeonato> = {};
  const timeDoJogador = new Map<string, string>();
  for (const [timeId, bruto] of timesBrutos) {
    exigir(ID_LOCAL.test(timeId) && ehObj(bruto), "time");
    const t = bruto as Record<string, unknown>;
    const elenco = t.elenco === undefined ? [] : t.elenco;
    exigir(Array.isArray(elenco) && elenco.length <= MAX_ELENCO, "elenco");
    const jogadores = (elenco as unknown[]).map((e) => {
      const j = obj(e);
      exigir(typeof j.id === "string" && UID.test(j.id) && !timeDoJogador.has(j.id), "jogador");
      timeDoJogador.set(j.id as string, timeId);
      return { id: j.id as string, nome: texto(j.nome, 60, "Jogador") };
    });
    times[timeId] = { nome: texto(t.nome, 40, "Time"), cor: typeof t.cor === "string" ? t.cor : "", elenco: jogadores };
  }
  const nTimes = timesBrutos.length;
  const timeExiste = (v: unknown): v is string => typeof v === "string" && v in times;
  const elencoDe = (timeId: string | null) => (timeId ? times[timeId].elenco.map((j) => j.id) : []);

  // Jogos: quantidade do formato, placares válidos (os dois ou nenhum), gols/assistências que cabem no placar.
  exigir(ehObj(d.jogos), "jogos");
  const jogosBrutos = Object.entries(d.jogos as Record<string, unknown>);
  const jogos: Record<string, JogoCampeonato> = {};
  for (const [jogoId, bruto] of jogosBrutos) {
    exigir(ID_LOCAL.test(jogoId) && ehObj(bruto), "jogo");
    const j = bruto as Record<string, unknown>;
    const casa = j.casa === null || j.casa === undefined ? null : j.casa;
    const fora = j.fora === null || j.fora === undefined ? null : j.fora;
    exigir((casa === null || timeExiste(casa)) && (fora === null || timeExiste(fora)) && (casa === null || casa !== fora), "times do jogo");
    const semPlacar = (j.golsCasa === null || j.golsCasa === undefined) && (j.golsFora === null || j.golsFora === undefined);
    exigir(semPlacar || (golValido(j.golsCasa) && golValido(j.golsFora) && casa !== null && fora !== null), "placar");
    let penaltis: [number, number] | null = null;
    if (j.penaltis !== null && j.penaltis !== undefined) {
      exigir(!semPlacar && Array.isArray(j.penaltis) && j.penaltis.length === 2 && golValido(j.penaltis[0]) && golValido(j.penaltis[1]), "pênaltis");
      const p = j.penaltis as number[];
      penaltis = [p[0], p[1]];
    }
    const doJogo = new Set([...elencoDe(casa as string | null), ...elencoDe(fora as string | null)]);
    const gols = semPlacar ? {} : contagemDe(j.gols, doJogo, "gols");
    const assistencias = semPlacar ? {} : contagemDe(j.assistencias, doJogo, "assistências");
    // Por TIME: os gols dos jogadores de um time e as assistências deles não passam dos gols que aquele time fez (gol contra
    // não entra na conta de ninguém, então só diminui o que sobra para os jogadores).
    if (!semPlacar) {
      const somaDo = (m: Record<string, number>, elenco: string[]) => elenco.reduce((a, id) => a + (m[id] ?? 0), 0);
      for (const [timeId, golsDoTime] of [[casa, j.golsCasa], [fora, j.golsFora]] as [string, number][]) {
        const elenco = elencoDe(timeId);
        exigir(somaDo(gols, elenco) <= golsDoTime && somaDo(assistencias, elenco) <= golsDoTime, "gols ou assistências além do placar do time");
      }
    }
    const origem = j.origem === null || j.origem === undefined ? null : { casa: origemDe(obj(j.origem).casa), fora: origemDe(obj(j.origem).fora) };
    exigir(typeof j.fase === "string" && typeof j.ordem === "number" && Number.isFinite(j.ordem), "fase");
    jogos[jogoId] = {
      fase: j.fase as string,
      ordem: j.ordem as number,
      confronto: typeof j.confronto === "string" ? j.confronto : jogoId,
      perna: j.perna === 2 ? 2 : 1,
      casa: casa as string | null,
      fora: fora as string | null,
      origem,
      golsCasa: semPlacar ? null : (j.golsCasa as number),
      golsFora: semPlacar ? null : (j.golsFora as number),
      penaltis,
      gols,
      assistencias,
      aoVivo: null,
      eventos: [],
    };
  }

  // Tabela IGUAL à que o app gera para este formato e estas regras (mesmos jogos, fases, ordem, confrontos, pernas e origens,
  // inclusive a final quando configurada). Os times podem estar em qualquer ordem (o mata-mata sorteia a chave), mas cada
  // lugar fixo do modelo corresponde sempre ao mesmo time, e cada time a um lugar só. Os lugares que vêm de "vencedor de" ou
  // "posição" são conferidos depois, pela chave resolvida.
  const ids = Object.keys(times);
  const modelo = gerarTabela(formato, ids, regras);
  exigir(jogosBrutos.length === Object.keys(modelo).length, "quantidade de jogos");
  const timeDoLugar = new Map<string, string>();
  const lugarOcupado = new Set<string>();
  const casar = (lugar: string | null, real: string | null) => {
    if (lugar === null) return;
    exigir(real !== null, "time da tabela");
    const ja = timeDoLugar.get(lugar);
    if (ja === undefined) {
      exigir(!lugarOcupado.has(real as string), "time repetido na tabela");
      timeDoLugar.set(lugar, real as string);
      lugarOcupado.add(real as string);
    } else exigir(ja === real, "time da tabela");
  };
  for (const [jogoId, m] of Object.entries(modelo)) {
    const j = jogos[jogoId];
    exigir(j, "jogo da tabela");
    exigir(
      j.fase === m.fase && j.ordem === m.ordem && j.confronto === m.confronto && j.perna === m.perna && JSON.stringify(j.origem) === JSON.stringify(m.origem),
      "estrutura do jogo",
    );
    casar(m.casa, j.casa);
    casar(m.fora, j.fora);
  }
  exigir(timeDoLugar.size === nTimes, "todos os times na tabela");

  const sorteio = Array.isArray(d.sorteio) ? d.sorteio.filter((x): x is string => typeof x === "string" && x in times) : [];
  const c: Campeonato = {
    id,
    nome: texto(d.nome, 60, "Campeonato"),
    formato,
    regras,
    status: "encerrado",
    times,
    jogos,
    sorteio,
    campeao: typeof d.campeao === "string" ? d.campeao : null,
    criadoPor: "",
    criadoEmMs: 0,
    atualizadoEmMs: 0,
  };
  // Os times dos jogos seguintes têm de ser os que a chave/classificação dão, e o campeão, o recalculado.
  const resolvidos = resolverJogos(c);
  for (const [jogoId, j] of Object.entries(jogos)) exigir(resolvidos[jogoId].casa === j.casa && resolvidos[jogoId].fora === j.fora, "chave resolvida");
  const campeao = campeaoDe(c);
  exigir(campeao !== null && campeao === c.campeao, "campeão");
  return c;
};

/** O campeonato passa na conferência do servidor? (para registro/testes). */
export const motivoInvalido = (id: string, d: Dados): string | null => {
  try {
    validarCampeonato(id, obj(d));
    return null;
  } catch (e) {
    if (e instanceof Invalido) return e.message;
    throw e;
  }
};

/**
 * Troféus de cada uid neste campeonato (vazio se não estiver encerrado, se não passar na conferência, se a turma foi moderada
 * ou se não existe mais). `podeReceber`: uids aceitos (membros da turma e quem já tinha recebido antes).
 */
export const calcularTrofeus = (
  turmaId: string,
  campeonatoId: string,
  turma: Dados,
  campeonato: Dados,
  podeReceber: (uid: string) => boolean = () => true,
): Map<string, Trofeu> => {
  const resultado = new Map<string, Trofeu>();
  if (!turma || !campeonato || turma.encerradaPor === "moderacao") return resultado;
  let c: Campeonato;
  try {
    c = validarCampeonato(campeonatoId, campeonato);
  } catch (e) {
    if (e instanceof Invalido) return resultado;
    throw e;
  }

  const timeDe = new Map<string, string>();
  for (const [timeId, t] of Object.entries(c.times)) for (const j of t.elenco) if (podeReceber(j.id)) timeDe.set(j.id, timeId);

  const gols = new Map<string, number>();
  const assistencias = new Map<string, number>();
  for (const jogo of Object.values(c.jogos)) {
    if (!temResultado(jogo)) continue; // só jogos encerrados
    for (const [id, n] of Object.entries(jogo.gols)) if (timeDe.has(id)) gols.set(id, (gols.get(id) ?? 0) + n);
    for (const [id, n] of Object.entries(jogo.assistencias)) if (timeDe.has(id)) assistencias.set(id, (assistencias.get(id) ?? 0) + n);
  }
  const lideres = (m: Map<string, number>): Set<string> => {
    const maior = Math.max(0, ...m.values());
    return new Set(maior > 0 ? [...m.entries()].filter(([, n]) => n === maior).map(([id]) => id) : []);
  };
  const artilheiros = lideres(gols);
  const garcons = lideres(assistencias);

  const base = { turmaId, campeonatoId, campeonato: c.nome, turma: texto(turma.nome, 60, "Turma") };
  for (const [uid, timeId] of timeDe) {
    const titulos: TipoTrofeu[] = [];
    if (timeId === c.campeao) titulos.push("campeao");
    if (artilheiros.has(uid)) titulos.push("artilheiro");
    if (garcons.has(uid)) titulos.push("garcom");
    if (!titulos.length) continue;
    const t = c.times[timeId];
    resultado.set(uid, {
      ...base,
      time: t.nome,
      cor: /^#[0-9A-Fa-f]{6}$/.test(t.cor) ? t.cor : "#FE7552",
      titulos,
      gols: gols.get(uid) ?? 0,
      assistencias: assistencias.get(uid) ?? 0,
    });
  }
  return resultado;
};

/** Os uids válidos de uma lista gravada (registro anterior). */
export const uidsDe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && UID.test(u)) : []);

/** O que gravar e o que tirar, comparando com quem recebeu da última vez. */
export const planoDosTrofeus = (anteriores: unknown, atuais: Map<string, Trofeu>): { gravar: [string, Trofeu][]; remover: string[] } => ({
  gravar: [...atuais.entries()],
  remover: uidsDe(anteriores).filter((u) => !atuais.has(u)),
});

/** O troféu gravado é igual ao novo (sem contar a data)? Então não regrava e a data da conquista fica a original. */
export const mesmoTrofeu = (gravado: unknown, novo: Trofeu): boolean => {
  const g = obj(gravado);
  return (Object.keys(novo) as (keyof Trofeu)[]).every((k) => JSON.stringify(g[k]) === JSON.stringify(novo[k]));
};
