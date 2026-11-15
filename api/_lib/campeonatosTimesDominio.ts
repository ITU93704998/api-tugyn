import { gerarTabela, REGRAS_PADRAO } from "./campeonato/tabela";
import { aplicarResultado, calcularClassificacao, campeaoDe, resolverJogos, temResultado } from "./campeonato/classificacao";
import type { Campeonato, JogoCampeonato, TimeCampeonato } from "./campeonato/types";

export type Dados = Record<string, unknown>;
export type FormatoCT = "triangular" | "quadrangular" | "mata" | "grupos_mata";
export type StatusCT = "inscricoes" | "em_andamento" | "encerrado" | "cancelado";
export const COLECAO_CT = "campeonatosTimes";
export const MAX_ATIVOS_CT = 3;
export const ID_CT = /^ct_[a-f0-9]{24}$/;
export const ID_TIME_CT = /^[A-Za-z0-9_-]{1,128}_[12]$/;
export const ID_PESSOA_CT = /^[A-Za-z0-9_-]{1,128}$/;
export const ID_JOGO_CT = /^[A-Za-z0-9_-]{1,60}$/;
export class RecusaCT extends Error {
  constructor(readonly status: number, message: string, readonly code = "campeonato_invalido") { super(message); }
}
export function exigirCT(condicao: unknown, mensagem: string, status = 400): asserts condicao {
  if (!condicao) throw new RecusaCT(status, mensagem);
}
export const objetoCT = (v: unknown): Dados => v && typeof v === "object" && !Array.isArray(v) ? v as Dados : {};
export function textoCT(v: unknown, max: number, nome: string, obrigatorio = false): string {
  exigirCT(v === undefined || v === null || typeof v === "string", `${nome} inválido.`);
  const t = typeof v === "string" ? v.trim() : "";
  exigirCT(t.length <= max && (!obrigatorio || t.length > 0), `${nome}: ${obrigatorio ? "preencha e use " : "use "}até ${max} caracteres.`);
  return t;
}
export const numeroCT = (v: unknown, min: number, max: number, nome: string): number => {
  exigirCT(typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max, `${nome} inválido.`);
  return v;
};
export interface NovoCT {
  nome: string; descricao: string; modalidade: string; formato: FormatoCT; maxTimes: number;
  inscricoesAte: number; dataInicio: number | null; locais: { nome: string; endereco: string }[];
  inscricaoCentavos: number; premiacao: { valorCentavos: number; trofeus: boolean; medalhas: boolean; texto: string };
  regrasTexto: string; genero: string; faixaEtaria: string; minJogadores: number; maxJogadores: number;
}
export function novoCT(body: Dados, agora: number, gruposLiberado: boolean): NovoCT {
  const formato = body.formato as FormatoCT;
  exigirCT(["triangular", "quadrangular", "mata", "grupos_mata"].includes(formato), "Escolha um formato válido.");
  exigirCT(formato !== "grupos_mata" || gruposLiberado, "Fase de grupos + mata-mata precisa de liberação. A compra por campeonato ainda não está disponível.", 403);
  const maxTimes = numeroCT(body.maxTimes, 3, 16, "Número de equipes");
  exigirCT(formato === "triangular" ? maxTimes === 3 : formato === "quadrangular" ? maxTimes === 4 : formato === "mata" ? [4, 8, 16].includes(maxTimes) : [8, 16].includes(maxTimes), "Número de equipes incompatível com o formato.");
  const modalidade = body.modalidade;
  exigirCT(typeof modalidade === "string" && ["campo", "society", "futsal"].includes(modalidade), "Modalidade inválida.");
  const genero = body.genero ?? "livre", faixaEtaria = body.faixaEtaria ?? "livre";
  exigirCT(["livre", "masculino", "feminino", "misto"].includes(String(genero)), "Categoria de gênero inválida.");
  exigirCT(["livre", "veterano"].includes(String(faixaEtaria)), "Faixa etária inválida.");
  const inscricoesAte = numeroCT(body.inscricoesAte, agora + 60_000, agora + 180 * 86_400_000, "Prazo de inscrição");
  const dataInicio = body.dataInicio == null ? null : numeroCT(body.dataInicio, inscricoesAte, agora + 365 * 86_400_000, "Início do campeonato");
  const minJogadores = numeroCT(body.minJogadores ?? (modalidade === "futsal" ? 5 : modalidade === "society" ? 7 : 11), 1, 30, "Mínimo de jogadores");
  const maxJogadores = numeroCT(body.maxJogadores ?? 30, minJogadores, 30, "Máximo de jogadores");
  exigirCT(Array.isArray(body.locais) && body.locais.length >= 1 && body.locais.length <= 5, "Informe entre um e cinco locais de jogos.");
  const locais = body.locais.map((v) => { const l = objetoCT(v); return { nome: textoCT(l.nome, 80, "Local", true), endereco: textoCT(l.endereco, 200, "Endereço") }; });
  const p = objetoCT(body.premiacao);
  exigirCT((p.trofeus === undefined || typeof p.trofeus === "boolean") && (p.medalhas === undefined || typeof p.medalhas === "boolean"), "Premiação inválida.");
  return { nome: textoCT(body.nome, 60, "Nome", true), descricao: textoCT(body.descricao, 2000, "Descrição"), modalidade,
    formato, maxTimes, inscricoesAte, dataInicio, locais, inscricaoCentavos: numeroCT(body.inscricaoCentavos ?? 0, 0, 10_000_000, "Valor da inscrição"),
    premiacao: { valorCentavos: numeroCT(p.valorCentavos ?? 0, 0, 100_000_000, "Prêmio em dinheiro"), trofeus: p.trofeus === true, medalhas: p.medalhas === true, texto: textoCT(p.texto, 1000, "Premiação") },
    regrasTexto: textoCT(body.regrasTexto, 5000, "Regulamento"), genero: String(genero), faixaEtaria: String(faixaEtaria), minJogadores, maxJogadores };
}
/** URL da foto existente: não recebe arquivo/base64 nem provoca upload no campeonato. */
export function fotoAtletaCT(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length > 1000) return null;
  try {
    const u = new URL(valor);
    return u.protocol === "https:" && u.hostname === "res.cloudinary.com" && !u.username && !u.password && !u.port
      && /^\/[A-Za-z0-9_-]+\/image\/upload\//.test(u.pathname) ? u.href : null;
  } catch { return null; }
}
export interface AtletaCT { id: string; nome: string; numero: number | null; posicao: string | null; foto?: string | null }
export interface InscricaoCT {
  timeId: string; donoId: string; timeNome: string; escudoUrl: string | null; cor: string | null;
  jogadores: AtletaCT[]; status: "pendente" | "aprovada" | "recusada" | "cancelada";
  pago: boolean; motivo: string | null; criadoEm: number; atualizadoEm: number;
  /** Tentativa do formulário que gravou este pedido (interna; não vai para a tela). */
  tentativaId?: string | null;
  tentativasTotal?: number;
}
/** ID da tentativa de inscrição: gerado ao abrir o formulário e repetido nos retries. */
export function tentativaCT(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  exigirCT(typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v), "Tentativa de inscrição inválida.");
  return v;
}
export function elencoCT(time: Dados, camp: Dados, quem: string, ids: unknown): AtletaCT[] {
  exigirCT(time.donoId === quem, "Somente o dono pode inscrever este time.", 403);
  exigirCT(time.modalidade === camp.modalidade, "O time precisa ter a mesma modalidade do campeonato.");
  exigirCT(camp.genero === "livre" || time.genero === camp.genero, "O time não corresponde à categoria deste campeonato.");
  exigirCT(camp.faixaEtaria !== "veterano" || time.faixaEtaria === "veterano", "Este campeonato é da categoria veterano.");
  exigirCT(Array.isArray(ids) && ids.length >= Number(camp.minJogadores) && ids.length <= Number(camp.maxJogadores), `Selecione entre ${camp.minJogadores} e ${camp.maxJogadores} atletas.`);
  exigirCT(ids.every((id) => typeof id === "string" && ID_PESSOA_CT.test(id)) && new Set(ids).size === ids.length, "Seleção de jogadores inválida ou repetida.");
  const membros = Array.isArray(time.membros) ? time.membros : [], jogadores = objetoCT(time.jogadores), camisas = objetoCT(time.camisas);
  return ids.map((id) => {
    exigirCT(membros.includes(id) && Object.prototype.hasOwnProperty.call(jogadores, id), "Selecione apenas jogadores que já fazem parte do elenco do time.");
    const jogador = objetoCT(jogadores[id]), camisa = objetoCT(camisas[id]);
    exigirCT(camisa.posicao !== "treinador", "Treinador não conta como atleta inscrito.");
    return { id, nome: textoCT(jogador.nome, 80, "Nome do jogador", true), foto: fotoAtletaCT(jogador.foto),
      numero: typeof camisa.numero === "number" && Number.isInteger(camisa.numero) && camisa.numero >= 0 && camisa.numero <= 99 ? camisa.numero : null,
      posicao: typeof camisa.posicao === "string" ? camisa.posicao.slice(0, 30) : null };
  });
}
export interface JogoCT extends JogoCampeonato {
  id: string; grupo: string | null; quando: number | null; local: string | null; status: "pendente" | "finalizado";
  /** Revisão do jogo: sobe a cada mudança de placar ou de adversários. O formulário envia a que viu (`versaoEsperada`). */
  versao?: number;
}
/** Código da recusa quando o formulário foi aberto sobre outra versão do jogo (a tela atualiza e pede nova confirmação). */
export const JOGO_DESATUALIZADO_CT = "jogo_desatualizado";
export interface LinhaCT { timeId: string; pontos: number; jogos: number; vitorias: number; empates: number; derrotas: number; golsPro: number; golsContra: number; saldo: number; grupo: string | null }
const timesDa = (inscricoes: InscricaoCT[]): Record<string, TimeCampeonato> => Object.fromEntries(inscricoes.map((i) => [i.timeId, { nome: i.timeNome, cor: i.cor ?? "#FE7552", elenco: i.jogadores.map((j) => ({ id: j.id, nome: j.nome })) }]));
const baseDo = (inscricoes: InscricaoCT[], jogos: Record<string, JogoCampeonato>, sorteio: string[]) => ({ times: timesDa(inscricoes), jogos, sorteio, regras: { ...REGRAS_PADRAO } });
const comId = (base: Record<string, JogoCampeonato>, grupo: string | null = null): Record<string, JogoCT> => Object.fromEntries(Object.entries(base).map(([id, j]) => [id, { ...j, id, grupo, quando: null, local: null, status: "pendente" as const }]));
export function gerarJogosCT(formato: FormatoCT, ordem: string[]): { jogos: Record<string, JogoCT>; grupos: Record<string, string[]> } {
  if (formato !== "grupos_mata") return { jogos: comId(gerarTabela(formato === "mata" ? "mata" : "pontos", ordem, REGRAS_PADRAO)), grupos: {} };
  const grupos: Record<string, string[]> = {}, jogos: Record<string, JogoCT> = {};
  for (let i = 0; i < ordem.length; i += 4) {
    const grupo = String.fromCharCode(65 + i / 4), ids = ordem.slice(i, i + 4);
    grupos[grupo] = ids;
    for (const [id, j] of Object.entries(gerarTabela("pontos", ids, REGRAS_PADRAO))) {
      const chave = `g${grupo}_${id}`;
      jogos[chave] = { ...j, id: chave, confronto: chave, grupo, quando: null, local: null, status: "pendente" };
    }
  }
  return { jogos, grupos };
}
export function tabelaCT(inscricoes: InscricaoCT[], jogos: Record<string, JogoCT>, sorteio: string[], grupos: Record<string, string[]>): LinhaCT[] {
  const entradas = Object.entries(grupos);
  if (!entradas.length && !Object.values(jogos).some((j) => /^r\d+$/.test(j.fase))) return [];
  if (!entradas.length) return calcularClassificacao(baseDo(inscricoes, jogos, sorteio)).map((l) => ({ ...l, grupo: null }));
  return entradas.flatMap(([grupo, ids]) => calcularClassificacao(baseDo(inscricoes.filter((i) => ids.includes(i.timeId)), Object.fromEntries(Object.entries(jogos).filter(([, j]) => j.grupo === grupo)), sorteio)).map((l) => ({ ...l, grupo })));
}
export function registrarResultadoCT(camp: Dados, inscricoes: InscricaoCT[], jogosAntes: Record<string, JogoCT>, jogoId: string, body: Dados): { jogos: Record<string, JogoCT>; campeaoTimeId: string | null; classificacao: LinhaCT[] } {
  const j = jogosAntes[jogoId];
  exigirCT(j && j.casa && j.fora, "Os adversários deste jogo ainda não estão definidos.", 409);
  // O formulário diz quais adversários viu: se a chave mudou (outro aparelho corrigiu um placar anterior), o placar não
  // pode ir para outro confronto.
  if (body.casaEsperada !== j.casa || body.foraEsperada !== j.fora) throw new RecusaCT(409, "Os adversários deste jogo mudaram. Atualize o campeonato e confira antes de salvar.", JOGO_DESATUALIZADO_CT);
  const golsCasa = numeroCT(body.golsCasa, 0, 99, "Gols da casa"), golsFora = numeroCT(body.golsFora, 0, 99, "Gols do visitante");
  let penaltis: [number, number] | null = null;
  if (body.penaltis != null) {
    exigirCT(Array.isArray(body.penaltis) && body.penaltis.length === 2, "Pênaltis inválidos.");
    penaltis = [numeroCT(body.penaltis[0], 0, 99, "Pênaltis"), numeroCT(body.penaltis[1], 0, 99, "Pênaltis")];
  }
  const gols = { ...objetoCT(body.gols) }, assistencias = { ...objetoCT(body.assistencias) };
  const permitidos = new Set(inscricoes.filter((i) => i.timeId === j.casa || i.timeId === j.fora).flatMap((i) => i.jogadores.map((a) => a.id)));
  for (const mapa of [gols, assistencias]) {
    exigirCT(Object.keys(mapa).length <= 60, "Muitos jogadores no resultado.");
    for (const [uid, n] of Object.entries(mapa)) { exigirCT(permitidos.has(uid), "O atleta não está inscrito neste confronto."); numeroCT(n, 0, 99, "Estatística do jogador"); if (n === 0) delete mapa[uid]; }
  }
  for (const [timeId, total] of [[j.casa, golsCasa], [j.fora, golsFora]] as const) {
    const elenco = inscricoes.find((i) => i.timeId === timeId)?.jogadores ?? [];
    exigirCT(elenco.reduce((s, a) => s + Number(gols[a.id] ?? 0), 0) <= total && elenco.reduce((s, a) => s + Number(assistencias[a.id] ?? 0), 0) <= total, "Gols ou assistências dos atletas ultrapassam o placar do time.");
  }
  const sorteio = camp.ordem as string[], grupos = objetoCT(camp.grupos) as Record<string, string[]>;
  const mesmoMapa = (a: unknown, b: unknown) => JSON.stringify(Object.entries(objetoCT(a)).filter(([, n]) => n !== 0).sort()) === JSON.stringify(Object.entries(objetoCT(b)).filter(([, n]) => n !== 0).sort());
  // Resposta perdida não transforma o retry de um resultado já salvo em erro de fase fechada.
  if (j.golsCasa === golsCasa && j.golsFora === golsFora && JSON.stringify(j.penaltis) === JSON.stringify(penaltis) && mesmoMapa(j.gols, gols) && mesmoMapa(j.assistencias, assistencias)) {
    return { jogos: jogosAntes, campeaoTimeId: typeof camp.campeaoTimeId === "string" ? camp.campeaoTimeId : null, classificacao: tabelaCT(inscricoes, jogosAntes, sorteio, grupos) };
  }
  // Formulário aberto sobre outra versão do jogo (placar salvo ou corrigido em outro aparelho): não sobrescreve sem ver.
  exigirCT(typeof body.versaoEsperada === "number" && Number.isSafeInteger(body.versaoEsperada), "Versão do jogo inválida.");
  if (body.versaoEsperada !== Number(j.versao ?? 0)) throw new RecusaCT(409, "Este jogo foi alterado em outro aparelho. Atualize o campeonato e confira antes de salvar.", JOGO_DESATUALIZADO_CT);
  // Depois que um jogo que recebe o vencedor deste confronto tem resultado, não se troca o classificado por trás dele.
  exigirCT(resultadoEditavelCT(j, jogosAntes), "Este placar já decidiu um jogo seguinte que tem resultado e está fechado.", 409);
  const base = baseDo(inscricoes, jogosAntes, sorteio);
  const alterado = aplicarResultado(base, jogoId, { golsCasa, golsFora, penaltis, gols: gols as Record<string, number>, assistencias: assistencias as Record<string, number> });
  let jogos = Object.fromEntries(Object.entries(alterado.jogos).map(([id, x]) => [id, { ...jogosAntes[id], ...x, status: temResultado(x) ? "finalizado" as const : "pendente" as const }])) as Record<string, JogoCT>;
  const classificacao = tabelaCT(inscricoes, jogos, sorteio, grupos);
  if (camp.formato === "grupos_mata" && !jogos.final && Object.values(jogos).every(temResultado)) {
    // Cruzamento A1 x B2, B1 x A2 (e C/D). A ordem de sementes evita reencontro antes da final.
    const nomes = Object.keys(grupos).sort();
    const top = nomes.map((nome) => classificacao.filter((l) => l.grupo === nome));
    const pares = nomes.length === 2
      ? [top[0][0].timeId, top[1][1].timeId, top[1][0].timeId, top[0][1].timeId]
      : [top[0][0].timeId, top[1][1].timeId, top[2][0].timeId, top[3][1].timeId, top[1][0].timeId, top[0][1].timeId, top[3][0].timeId, top[2][1].timeId];
    // O gerador recebe sementes; ajusta para preservar os pares de cruzamento definidos acima.
    const mata = comId(gerarTabela("mata", pares, REGRAS_PADRAO));
    const primeiraOrdem = Math.min(...Object.values(mata).map((x) => x.ordem));
    Object.values(mata).filter((x) => x.ordem === primeiraOrdem || Math.floor(x.ordem / 1000) === Math.floor(primeiraOrdem / 1000)).sort((a, b) => a.ordem - b.ordem).forEach((x, i) => { x.casa = pares[i * 2]; x.fora = pares[i * 2 + 1]; });
    jogos = { ...jogos, ...Object.fromEntries(Object.entries(mata).map(([id, x]) => [id, { ...x, ordem: 10000 + x.ordem }])) };
  }
  // Os jogos dos grupos têm fase rN para a classificação, porém a final do mata-mata define o campeão.
  const campeaoTimeId = camp.formato === "grupos_mata" ? (jogos.final ? campeaoDe(baseDo(inscricoes, jogos, sorteio)) : null) : alterado.campeao;
  return { jogos: comVersoes(jogosAntes, jogos), campeaoTimeId, classificacao };
}

/** Sobe a versão de cada jogo que mudou (placar, adversários, vaga); jogos novos (mata-mata gerado) começam na 0. */
function comVersoes(antes: Record<string, JogoCT>, depois: Record<string, JogoCT>): Record<string, JogoCT> {
  const semVersao = (x: JogoCT) => JSON.stringify({ ...x, versao: undefined });
  return Object.fromEntries(Object.entries(depois).map(([id, x]) => {
    const a = antes[id];
    if (!a) return [id, { ...x, versao: 0 }];
    return [id, semVersao(a) === semVersao(x) ? x : { ...x, versao: Number(a.versao ?? 0) + 1 }];
  }));
}

/** O jogo `o` recebe o vencedor do confronto `confronto`? */
const recebeVencedorDe = (o: JogoCT, confronto: string) =>
  [o.origem?.casa, o.origem?.fora].some((v) => v != null && typeof v === "object" && "vencedor" in v && v.vencedor === confronto);

export function resultadoEditavelCT(j: JogoCT, jogos: Record<string, JogoCT>): boolean {
  if (!temResultado(j)) return true;
  if (j.grupo && jogos.final) return false;
  if (/^r\d+$/.test(j.fase)) return true;
  // Eliminatória: só fecha quando o jogo que recebe o vencedor deste confronto já tem resultado. Outro jogo da mesma fase
  // (a outra semifinal) não fecha este.
  return !Object.values(jogos).some((o) => o.id !== j.id && temResultado(o) && recebeVencedorDe(o, j.confronto));
}
