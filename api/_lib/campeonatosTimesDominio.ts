import { normalizarDesenhoTrofeu } from "./desenhoTrofeu";
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
  /** `detalhes`: dados seguros para a tela (ex.: ids dos atletas em conflito), devolvidos junto com a mensagem. */
  constructor(readonly status: number, message: string, readonly code = "campeonato_invalido", readonly detalhes?: Dados) { super(message); }
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
  /** Titulares exigidos por posição (campeonatos criados antes não têm: só valem mínimo e máximo de atletas). */
  requisitos?: RequisitosCT;
  /** "manual": o organizador sorteia por fora e informa a ordem ao iniciar. Ausente = sorteio automático (padrão). */
  sorteio?: "manual";
  /** Troféu personalizado (peças, ver desenhoTrofeu.ts). Ausente = a taça clássica. */
  trofeuDesenho?: string;
}
// ── Requisitos de elenco por posição ──
/** Titulares mínimos que a inscrição precisa cobrir: jogadores de linha e goleiros. */
export interface RequisitosCT { linha: number; goleiros: number }
/** Padrão por modalidade (o organizador pode mudar): futsal 4+1, society 6+1, campo 10+1. */
export const REQUISITOS_PADRAO_CT: Record<string, RequisitosCT> = { futsal: { linha: 4, goleiros: 1 }, society: { linha: 6, goleiros: 1 }, campo: { linha: 10, goleiros: 1 } };
/** Requisitos gravados no campeonato; ausentes ou inválidos (campeonato antigo) = sem exigência por posição. */
export function requisitosDoCT(camp: Dados): RequisitosCT | null {
  const r = objetoCT(camp.requisitos);
  const ok = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  return ok(r.linha, 1, 20) && ok(r.goleiros, 0, 3) ? { linha: r.linha as number, goleiros: r.goleiros as number } : null;
}
/**
 * Situação de um elenco escolhido frente aos requisitos. Cada atleta tem UMA posição: goleiro é só `posicao == "goleiro"`;
 * os demais (inclusive sem posição cadastrada) contam como linha, então ninguém é contado duas vezes. Treinador não entra.
 */
export function situacaoElencoCT(requisitos: RequisitosCT, posicoes: readonly (string | null | undefined)[]) {
  const atletas = posicoes.filter((p) => p !== "treinador");
  const goleiros = atletas.filter((p) => p === "goleiro").length, linha = atletas.length - goleiros;
  return { linha, goleiros, faltamLinha: Math.max(0, requisitos.linha - linha), faltamGoleiros: Math.max(0, requisitos.goleiros - goleiros) };
}
export function mensagemRequisitosCT(requisitos: RequisitosCT, posicoes: readonly (string | null | undefined)[]): string | null {
  const s = situacaoElencoCT(requisitos, posicoes);
  if (s.faltamGoleiros) return `O elenco inscrito precisa ter pelo menos ${requisitos.goleiros} ${requisitos.goleiros === 1 ? "goleiro" : "goleiros"} (posição Goleiro no elenco do time). Faltam ${s.faltamGoleiros}.`;
  if (s.faltamLinha) return `O elenco inscrito precisa ter pelo menos ${requisitos.linha} jogadores de linha. Faltam ${s.faltamLinha}.`;
  return null;
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
  // Requisitos por posição: opcionais (versões antigas do app não enviam). Os titulares cabem no mínimo de atletas.
  let requisitos: RequisitosCT | null = null;
  if (body.requisitos != null) {
    const q = objetoCT(body.requisitos);
    requisitos = { linha: numeroCT(q.linha, 1, 20, "Jogadores de linha titulares"), goleiros: numeroCT(q.goleiros, 0, 3, "Goleiros titulares") };
    exigirCT(Number.isInteger(requisitos.linha) && Number.isInteger(requisitos.goleiros), "Titulares inválidos.");
    exigirCT(requisitos.linha + requisitos.goleiros <= minJogadores, `O mínimo de atletas por time (${minJogadores}) precisa cobrir os ${requisitos.linha + requisitos.goleiros} titulares.`);
  }
  exigirCT(body.sorteio == null || body.sorteio === "automatico" || body.sorteio === "manual", "Escolha como será o sorteio dos times.");
  const trofeuDesenho = body.trofeu == null ? null : normalizarDesenhoTrofeu(body.trofeu);
  exigirCT(body.trofeu == null || trofeuDesenho, "O troféu escolhido é inválido. Monte-o de novo no editor.");
  exigirCT(Array.isArray(body.locais) && body.locais.length >= 1 && body.locais.length <= 5, "Informe entre um e cinco locais de jogos.");
  const locais = body.locais.map((v) => { const l = objetoCT(v); return { nome: textoCT(l.nome, 80, "Local", true), endereco: textoCT(l.endereco, 200, "Endereço") }; });
  const p = objetoCT(body.premiacao);
  exigirCT((p.trofeus === undefined || typeof p.trofeus === "boolean") && (p.medalhas === undefined || typeof p.medalhas === "boolean"), "Premiação inválida.");
  return { nome: textoCT(body.nome, 60, "Nome", true), descricao: textoCT(body.descricao, 2000, "Descrição"), modalidade,
    formato, maxTimes, inscricoesAte, dataInicio, locais, inscricaoCentavos: numeroCT(body.inscricaoCentavos ?? 0, 0, 10_000_000, "Valor da inscrição"),
    premiacao: { valorCentavos: numeroCT(p.valorCentavos ?? 0, 0, 100_000_000, "Prêmio em dinheiro"), trofeus: p.trofeus === true, medalhas: p.medalhas === true, texto: textoCT(p.texto, 1000, "Premiação") },
    regrasTexto: textoCT(body.regrasTexto, 5000, "Regulamento"), genero: String(genero), faixaEtaria: String(faixaEtaria), minJogadores, maxJogadores,
    // Só presente quando definido: a assinatura de pedidos antigos (criação idempotente) continua a mesma.
    ...(requisitos ? { requisitos } : {}), ...(body.sorteio === "manual" ? { sorteio: "manual" as const } : {}), ...(trofeuDesenho ? { trofeuDesenho } : {}) };
}

/**
 * Sorteio manual: a ordem informada pelo organizador precisa ter cada time aprovado exatamente uma vez.
 * A ordem é a mesma que o sorteio automático produziria: grupos de 4 em sequência (A, B…), sementes do mata-mata e
 * posições do todos contra todos.
 */
export function ordemManualCT(valor: unknown, aprovados: readonly string[]): string[] {
  exigirCT(Array.isArray(valor) && valor.length === aprovados.length, "Informe o sorteio com todos os times aprovados antes de iniciar.", 400);
  const ordem = valor as unknown[];
  exigirCT(ordem.every((v) => typeof v === "string" && aprovados.includes(v)) && new Set(ordem).size === ordem.length, "O sorteio tem um time repetido ou que não está aprovado. Confira e tente de novo.", 400);
  return ordem as string[];
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
  /** Identidade imutável do time inscrito, só o servidor grava. */
  timeLinkId?: string | null;
  /** Criação do time inscrito (ms, `criadoEm` gravado com a hora do servidor e imutável pelas regras). Com o link,
   *  separa um time recriado na mesma vaga (`dono_1`) que tenha reaproveitado o link antigo. Só o servidor grava. */
  timeCriadoEm?: number | null;
  timeId: string; donoId: string; timeNome: string; escudoUrl: string | null; cor: string | null;
  jogadores: AtletaCT[]; status: "pendente" | "aprovada" | "recusada" | "cancelada";
  /** Técnico escolhido pelo dono entre as pessoas do elenco do time (opcional; pode também jogar). */
  treinador?: TreinadorCT | null;
  pago: boolean; motivo: string | null; criadoEm: number; atualizadoEm: number;
  /** WhatsApp do dono (só dígitos, com 55), informado por ele. Só o organizador (e o próprio dono) vê; sai da inscrição
   *  quando o campeonato termina, é cancelado, o pedido é recusado/cancelado ou a conta é excluída. */
  whatsappDono?: string | null;
  /** Quando o dono avisou "Já paguei" (ms). Some quando o organizador marca como pago ou responde "Ainda não". */
  pagamentoAvisadoEm?: number | null;
  /** Tentativa do formulário que gravou este pedido (interna; não vai para a tela). */
  tentativaId?: string | null;
  tentativasTotal?: number;
}
/**
 * WhatsApp do Brasil: só dígitos, sempre com o 55 (aceita com ou sem ele, com máscara). Vazio = sem número (null).
 * DDD de 2 dígitos (sem zero) e número de 8 ou 9 dígitos.
 */
export function whatsappCT(v: unknown, rotulo: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  exigirCT(typeof v === "string" && v.length <= 30, `${rotulo}: número inválido.`);
  let d = (v as string).replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  exigirCT(/^55[1-9]{2}\d{8,9}$/.test(d), `${rotulo}: informe o DDD e o número.`);
  return d;
}
/** ID da tentativa de inscrição: gerado ao abrir o formulário e repetido nos retries. */
export function tentativaCT(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  exigirCT(typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v), "Tentativa de inscrição inválida.");
  return v;
}
export interface TreinadorCT { id: string; nome: string; foto: string | null }
/** Técnico da inscrição: opcional, uma pessoa que já está no elenco do time (pode ser o dono ou um dos atletas). */
export function treinadorCT(time: Dados, id: unknown): TreinadorCT | null {
  if (id === undefined || id === null || id === "") return null;
  exigirCT(typeof id === "string" && ID_PESSOA_CT.test(id), "Técnico inválido.");
  const membros = Array.isArray(time.membros) ? time.membros : [], jogadores = objetoCT(time.jogadores);
  exigirCT(membros.includes(id) && Object.prototype.hasOwnProperty.call(jogadores, id), "Escolha como técnico alguém que faz parte do elenco do time.");
  const jogador = objetoCT(jogadores[id]);
  return { id, nome: textoCT(jogador.nome, 80, "Nome do técnico", true), foto: fotoAtletaCT(jogador.foto) };
}
export function elencoCT(time: Dados, camp: Dados, quem: string, ids: unknown): AtletaCT[] {
  exigirCT(time.donoId === quem, "Somente o dono pode inscrever este time.", 403);
  exigirCT(time.modalidade === camp.modalidade, "O time precisa ter a mesma modalidade do campeonato.");
  exigirCT(camp.genero === "livre" || time.genero === camp.genero, "O time não corresponde à categoria deste campeonato.");
  exigirCT(camp.faixaEtaria !== "veterano" || time.faixaEtaria === "veterano", "Este campeonato é da categoria veterano.");
  exigirCT(Array.isArray(ids) && ids.length >= Number(camp.minJogadores) && ids.length <= Number(camp.maxJogadores), `Selecione entre ${camp.minJogadores} e ${camp.maxJogadores} atletas.`);
  exigirCT(ids.every((id) => typeof id === "string" && ID_PESSOA_CT.test(id)) && new Set(ids).size === ids.length, "Seleção de jogadores inválida ou repetida.");
  const membros = Array.isArray(time.membros) ? time.membros : [], jogadores = objetoCT(time.jogadores), camisas = objetoCT(time.camisas);
  const atletas = ids.map((id) => {
    exigirCT(membros.includes(id) && Object.prototype.hasOwnProperty.call(jogadores, id), "Selecione apenas jogadores que já fazem parte do elenco do time.");
    const jogador = objetoCT(jogadores[id]), camisa = objetoCT(camisas[id]);
    exigirCT(camisa.posicao !== "treinador", "Treinador não conta como atleta inscrito.");
    return { id, nome: textoCT(jogador.nome, 80, "Nome do jogador", true), foto: fotoAtletaCT(jogador.foto),
      numero: typeof camisa.numero === "number" && Number.isInteger(camisa.numero) && camisa.numero >= 0 && camisa.numero <= 99 ? camisa.numero : null,
      posicao: typeof camisa.posicao === "string" ? camisa.posicao.slice(0, 30) : null };
  });
  // Requisitos por posição (campeonatos novos): conferidos na inscrição e de novo na aprovação, com as posições atuais.
  const requisitos = requisitosDoCT(camp);
  if (requisitos) { const erro = mensagemRequisitosCT(requisitos, atletas.map((a) => a.posicao)); exigirCT(!erro, erro ?? ""); }
  return atletas;
}
export interface JogoCT extends JogoCampeonato {
  id: string; grupo: string | null; quando: number | null; local: string | null; status: "pendente" | "finalizado";
  /** Revisão do jogo: sobe a cada mudança de placar ou de adversários. O formulário envia a que viu (`versaoEsperada`). */
  versao?: number;
  /** W.O.: o time vencedor (o outro não compareceu). Placar fixo (PLACAR_WO_CT x 0), sem estatísticas. */
  wo?: string | null;
  /** Cartões do jogo por atleta: amarelos (1 ou 2; 2 no mesmo jogo = expulsão) e vermelhos (1). */
  amarelos?: Record<string, number>;
  vermelhos?: Record<string, number>;
  /** Quando o resultado foi lançado pela primeira vez (conta o prazo de correção do mesário). */
  lancadoEm?: number | null;
  /** Histórico das correções do resultado, da mais antiga à mais recente (no máximo MAX_CORRECOES_CT). */
  correcoes?: CorrecaoCT[];
}
export interface PlacarCorrecaoCT { golsCasa: number; golsFora: number; penaltis: [number, number] | null; wo: string | null }
/** Uma correção de resultado: quem, quando, por quê e o placar antes e depois. `detalhes`: o placar ficou igual, mudaram gols, assistências ou cartões dos atletas. */
export interface CorrecaoCT { em: number; por: string; porNome: string; motivo: string; antes: PlacarCorrecaoCT; depois: PlacarCorrecaoCT; detalhes: boolean }
export const MAX_CORRECOES_CT = 10;
/** Mesário corrige só logo depois do jogo; depois disso, a correção fica com o organizador. */
export const PRAZO_CORRECAO_MESARIO_CT = 24 * 60 * 60 * 1000;
export const MOTIVO_CORRECAO_MIN_CT = 5;
export const MOTIVO_CORRECAO_MAX_CT = 140;
/** Fim do prazo do mesário para corrigir este jogo (null: ainda sem resultado ou lançado antes do registro do horário). */
export const prazoCorrecaoMesarioCT = (j: Pick<JogoCT, "lancadoEm">): number | null =>
  typeof j.lancadoEm === "number" && Number.isFinite(j.lancadoEm) ? j.lancadoEm + PRAZO_CORRECAO_MESARIO_CT : null;
/** O mesário ainda pode mexer neste resultado? Sem resultado, sempre (é o lançamento); com resultado, só dentro do prazo. */
export function mesarioPodeCorrigirCT(j: JogoCT, agora: number): boolean {
  if (!temResultado(j)) return true;
  const ate = prazoCorrecaoMesarioCT(j);
  return ate !== null && agora <= ate;
}
/** Motivo obrigatório da correção: uma linha curta, sem espaços repetidos. */
export function motivoCorrecaoCT(v: unknown): string {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  exigirCT(t.length >= MOTIVO_CORRECAO_MIN_CT, "Conte em uma frase por que o resultado está sendo corrigido.", 400);
  exigirCT(t.length <= MOTIVO_CORRECAO_MAX_CT, `Motivo da correção: use até ${MOTIVO_CORRECAO_MAX_CT} caracteres.`, 400);
  return t;
}
const placarCorrecao = (j: JogoCT): PlacarCorrecaoCT => ({ golsCasa: Number(j.golsCasa ?? 0), golsFora: Number(j.golsFora ?? 0), penaltis: Array.isArray(j.penaltis) ? [Number(j.penaltis[0]), Number(j.penaltis[1])] : null, wo: j.wo ?? null });
/** Registra a correção no jogo novo (mantém só as últimas MAX_CORRECOES_CT). */
export function comCorrecaoCT(antes: JogoCT, depois: JogoCT, autor: { uid: string; nome: string }, motivo: string, agora: number): JogoCT {
  const a = placarCorrecao(antes), d = placarCorrecao(depois);
  const correcao: CorrecaoCT = { em: agora, por: autor.uid, porNome: autor.nome, motivo, antes: a, depois: d, detalhes: JSON.stringify(a) === JSON.stringify(d) };
  return { ...depois, correcoes: [...(Array.isArray(antes.correcoes) ? antes.correcoes : []), correcao].slice(-MAX_CORRECOES_CT) };
}
/** Placar do W.O. (padrão da várzea): o time presente vence por 3 x 0. */
export const PLACAR_WO_CT = 3;
/** Amarelos acumulados que suspendem o atleta no próximo jogo do time. */
export const AMARELOS_SUSPENSAO_CT = 3;
export const MAX_MESARIOS_CT = 3;
export interface MesarioCT { uid: string; nome: string; userName: string }
/** Mesários: pessoas convidadas pelo organizador para lançar placares e marcar jogos (não aprovam times nem finalizam). */
export const mesariosDoCT = (camp: Dados): MesarioCT[] =>
  (Array.isArray(camp.mesarios) ? camp.mesarios : []).flatMap((m) => {
    const x = objetoCT(m);
    return typeof x.uid === "string" && ID_PESSOA_CT.test(x.uid) ? [{ uid: x.uid, nome: textoCT(x.nome, 80, "Nome") || "Mesário", userName: textoCT(x.userName, 30, "Usuário") }] : [];
  }).slice(0, MAX_MESARIOS_CT);
/** Organizador ou mesário: pode lançar placar e marcar jogo. */
export const podeLancarCT = (camp: Dados, uid: string): boolean => camp.organizadorId === uid || mesariosDoCT(camp).some((m) => m.uid === uid);

export interface SuspensaoCT { jogoId: string; atletaId: string; timeId: string; motivo: "vermelho" | "amarelos" }
/**
 * Suspensões automáticas, calculadas dos jogos (nada gravado): cartão vermelho, ou 2 amarelos no mesmo jogo, suspende no
 * próximo jogo do time; a cada 3 amarelos acumulados (em jogos diferentes), também. Cumpre-se no próximo jogo do time,
 * já com resultado ou não; o jogo pendente seguinte é o da suspensão. Time eliminado: não há o que cumprir.
 */
export function suspensoesCT(inscricoes: Pick<InscricaoCT, "timeId" | "jogadores">[], jogos: Record<string, JogoCT>): SuspensaoCT[] {
  const lista = Object.values(jogos).sort((a, b) => a.ordem - b.ordem);
  const saida: SuspensaoCT[] = [];
  for (const i of inscricoes) {
    const doTime = lista.filter((g) => g.casa === i.timeId || g.fora === i.timeId);
    for (const atleta of i.jogadores) {
      let acumulados = 0, pendente: SuspensaoCT["motivo"] | null = null;
      for (const g of doTime) {
        if (g.status !== "finalizado") { if (pendente) saida.push({ jogoId: g.id, atletaId: atleta.id, timeId: i.timeId, motivo: pendente }); break; }
        if (pendente) { pendente = null; continue; }
        const am = Number(objetoCT(g.amarelos)[atleta.id] ?? 0), vm = Number(objetoCT(g.vermelhos)[atleta.id] ?? 0);
        if (vm > 0 || am >= 2) pendente = "vermelho";
        else { acumulados += am; if (acumulados >= AMARELOS_SUSPENSAO_CT) { pendente = "amarelos"; acumulados -= AMARELOS_SUSPENSAO_CT; } }
      }
    }
  }
  return saida;
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
  // W.O.: `wo` = o time que venceu (compareceu). Placar fixo, sem gols, assistências, cartões nem pênaltis.
  exigirCT(body.wo == null || body.wo === j.casa || body.wo === j.fora, "W.O. inválido.");
  const wo = (body.wo ?? null) as string | null;
  const golsCasa = wo ? (wo === j.casa ? PLACAR_WO_CT : 0) : numeroCT(body.golsCasa, 0, 99, "Gols da casa");
  const golsFora = wo ? (wo === j.fora ? PLACAR_WO_CT : 0) : numeroCT(body.golsFora, 0, 99, "Gols do visitante");
  let penaltis: [number, number] | null = null;
  if (body.penaltis != null && !wo) {
    exigirCT(Array.isArray(body.penaltis) && body.penaltis.length === 2, "Pênaltis inválidos.");
    penaltis = [numeroCT(body.penaltis[0], 0, 99, "Pênaltis"), numeroCT(body.penaltis[1], 0, 99, "Pênaltis")];
  }
  const gols = wo ? {} : { ...objetoCT(body.gols) }, assistencias = wo ? {} : { ...objetoCT(body.assistencias) };
  const amarelos = wo ? {} : { ...objetoCT(body.amarelos) }, vermelhos = wo ? {} : { ...objetoCT(body.vermelhos) };
  const permitidos = new Set(inscricoes.filter((i) => i.timeId === j.casa || i.timeId === j.fora).flatMap((i) => i.jogadores.map((a) => a.id)));
  for (const [mapa, max] of [[gols, 99], [assistencias, 99], [amarelos, 2], [vermelhos, 1]] as const) {
    exigirCT(Object.keys(mapa).length <= 60, "Muitos jogadores no resultado.");
    for (const [uid, n] of Object.entries(mapa)) { exigirCT(permitidos.has(uid), "O atleta não está inscrito neste confronto."); numeroCT(n, 0, max, "Estatística do jogador"); if (n === 0) delete (mapa as Record<string, unknown>)[uid]; }
  }
  // Atleta suspenso neste jogo não marca gol, não dá assistência nem recebe cartão (ele não pôde jogar).
  const suspensosAqui = suspensoesCT(inscricoes, jogosAntes).filter((s) => s.jogoId === jogoId);
  const comSuspenso = suspensosAqui.find((s) => [gols, assistencias, amarelos, vermelhos].some((m) => (m as Record<string, unknown>)[s.atletaId] != null));
  if (comSuspenso) {
    const nome = inscricoes.flatMap((i) => i.jogadores).find((a) => a.id === comSuspenso.atletaId)?.nome ?? "Um atleta";
    throw new RecusaCT(409, `${nome} está suspenso neste jogo e não pode ter gols, assistências ou cartões.`, "atleta_suspenso");
  }
  for (const [timeId, total] of [[j.casa, golsCasa], [j.fora, golsFora]] as const) {
    const elenco = inscricoes.find((i) => i.timeId === timeId)?.jogadores ?? [];
    exigirCT(elenco.reduce((s, a) => s + Number(gols[a.id] ?? 0), 0) <= total && elenco.reduce((s, a) => s + Number(assistencias[a.id] ?? 0), 0) <= total, "Gols ou assistências dos atletas ultrapassam o placar do time.");
  }
  const sorteio = camp.ordem as string[], grupos = objetoCT(camp.grupos) as Record<string, string[]>;
  const mesmoMapa = (a: unknown, b: unknown) => JSON.stringify(Object.entries(objetoCT(a)).filter(([, n]) => n !== 0).sort()) === JSON.stringify(Object.entries(objetoCT(b)).filter(([, n]) => n !== 0).sort());
  // Resposta perdida não transforma o retry de um resultado já salvo em erro de fase fechada.
  if (j.golsCasa === golsCasa && j.golsFora === golsFora && JSON.stringify(j.penaltis) === JSON.stringify(penaltis) && mesmoMapa(j.gols, gols) && mesmoMapa(j.assistencias, assistencias)
    && mesmoMapa(j.amarelos, amarelos) && mesmoMapa(j.vermelhos, vermelhos) && (j.wo ?? null) === wo) {
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
  jogos[jogoId] = { ...jogos[jogoId], wo, amarelos: amarelos as Record<string, number>, vermelhos: vermelhos as Record<string, number> };
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
