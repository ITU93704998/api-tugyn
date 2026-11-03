import { randomInt } from "node:crypto";
import { FieldValue, type Firestore, Timestamp, type Transaction } from "firebase-admin/firestore";
import {
  MAX_GOLS,
  PRAZO_PLACAR_MS,
  type StatusAmistoso,
  diferencaDeGols,
  efetivo,
  emAndamento,
  millis,
  motivoParaNaoConfirmarPlacar,
  motivoParaNaoInformarPlacar,
  motivoParaNaoMarcarArtilheiros,
  motivoParaNaoRecusarPlacar,
  placarDoDocumento,
  placarTexto,
  propostaDe,
  resumoDoResultado,
} from "./amistososResultado";
import { DEDUPE_MS, type PushDraft } from "./push";
import { type Aviso, COLECAO_AVISOS, avisoPendente, enviarAviso } from "./pushEnvio";
import { isValidLinkId, timeDoDocumento } from "./timeLink";

/**
 * Chave pública dos times e amistosos entre times (pela rota `POST /api/desafios`: o plano da Vercel não comporta outra função).
 *  - time_chave { timeId }                                     o dono pega a chave do time (gerada na 1ª vez)
 *  - time_buscar { chave }                                     qualquer pessoa logada vê os dados PÚBLICOS do time
 *  - time_link { linkId }                                      quem tocou em "Abrir no Tugyn" na página do time: quem é do
 *                                                               time recebe o id (abre o time); os outros, a chave (abre o
 *                                                               time público, como quem digita a chave)
 *  - amistoso_propor { timeId, adversarioId, data, hora, local }   o dono convida outro time da mesma modalidade
 *  - amistoso_responder { timeId, amistosoId, aceitar }       o dono do time convidado aceita ou recusa
 *  - amistoso_cancelar { timeId, amistosoId }                 o dono de qualquer um dos dois desmarca (antes do jogo)
 *  - time_encerrar { timeId }                                  o dono apaga o time: cancela os amistosos em aberto nos
 *                                                               adversários, apaga a chave, o histórico, o resumo e o time
 *  - amistoso_placar { timeId, amistosoId, golsMeu, golsOutro }   finalizar a partida (ou não concordar mandando outro placar)
 *  - amistoso_confirmar { timeId, amistosoId }                 o outro time confirma o placar
 *  - amistoso_recusar_placar { timeId, amistosoId }            não concordar de novo: o jogo fica sem acordo
 *  - amistoso_artilheiros { timeId, amistosoId, gols }         o dono marca quem fez os gols do próprio time
 *  - amistoso_apurar { timeId }                                alguém do elenco abre os jogos: aplica os prazos vencidos
 * Regras do resultado em `amistososResultado.ts`. O retrospecto de cada time fica em `times/{id}/resumo/geral`.
 * O amistoso fica em `times/{id}/amistosos/{amistosoId}` com uma cópia em cada time (o elenco de cada um lê a sua; o app
 * não grava). A chave fica em `chavesTime/{chave}` (só o servidor lê e grava) e no campo `chave` do time.
 */

export const COLECAO_CHAVES = "chavesTime";
export const SUB_AMISTOSOS = "amistosos";
export const SUB_RESUMO = "resumo";
/** Sem letras e números que se confundem (O/0, I/1). */
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TAMANHO_CHAVE = 6;
const CHAVE = /^[A-HJ-NP-Z2-9]{6}$/;
const TIME_ID = /^[A-Za-z0-9_-]{1,128}_[12]$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ARTILHEIROS = 40;
const AMISTOSO_ID = /^[A-Za-z0-9]{20}$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const LOCAL_MIN = 3;
export const LOCAL_MAX = 60;
/** Antecedência mínima e prazo máximo para marcar. */
export const ANTECEDENCIA_MS = 30 * 60_000;
export const PRAZO_MAXIMO_MS = 120 * 24 * 3600_000;
/** Convites pendentes enviados por um time ao mesmo tempo. */
export const MAX_PENDENTES = 10;
const NOME_MAX = 40;
/** Brasília (sem horário de verão desde 2019). */
const FUSO_MS = -3 * 3600_000;

export type { StatusAmistoso };

export type AmistosoRequest =
  | { action: "time_chave"; timeId: string }
  | { action: "time_buscar"; chave: string }
  | { action: "time_link"; linkId: string }
  | { action: "amistoso_propor"; timeId: string; adversarioId: string; data: string; hora: string; local: string }
  | { action: "amistoso_responder"; timeId: string; amistosoId: string; aceitar: boolean }
  | { action: "amistoso_cancelar"; timeId: string; amistosoId: string }
  | { action: "time_encerrar"; timeId: string }
  | { action: "amistoso_placar"; timeId: string; amistosoId: string; golsMeu: number; golsOutro: number }
  | { action: "amistoso_confirmar"; timeId: string; amistosoId: string }
  | { action: "amistoso_recusar_placar"; timeId: string; amistosoId: string }
  | { action: "amistoso_artilheiros"; timeId: string; amistosoId: string; gols: Record<string, number> }
  | { action: "amistoso_apurar"; timeId: string };

type Parse = { ok: true; value: AmistosoRequest } | { ok: false; error: string };

export const ehAcaoDeAmistoso = (body: unknown): boolean => {
  const action = (body as { action?: unknown } | null)?.action;
  return typeof action === "string" && (action.startsWith("amistoso_") || action === "time_chave" || action === "time_buscar" || action === "time_link" || action === "time_encerrar");
};

export const normalizarChave = (valor: unknown): string | null => {
  if (typeof valor !== "string") return null;
  const chave = valor.replace(/[\s-]/g, "").toUpperCase();
  return CHAVE.test(chave) ? chave : null;
};

export const gerarChave = (sorteio: (max: number) => number = randomInt): string =>
  Array.from({ length: TAMANHO_CHAVE }, () => ALFABETO[sorteio(ALFABETO.length)]).join("");

/** Dia e hora de Brasília → instante. Null se a data não existe (31/02) ou o formato é inválido. */
export const instanteDe = (data: string, hora: string): number | null => {
  const d = DATA.exec(data);
  const h = HORA.exec(hora);
  if (!d || !h) return null;
  const [ano, mes, dia] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const utc = Date.UTC(ano, mes - 1, dia, Number(h[1]), Number(h[2]));
  const conferir = new Date(utc);
  if (conferir.getUTCFullYear() !== ano || conferir.getUTCMonth() !== mes - 1 || conferir.getUTCDate() !== dia) return null;
  return utc - FUSO_MS;
};

const SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
/** "sáb, 12/11 às 20:00" (horário de Brasília). */
export const quandoTexto = (ms: number): string => {
  const d = new Date(ms + FUSO_MS);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${SEMANA[d.getUTCDay()]}, ${dois(d.getUTCDate())}/${dois(d.getUTCMonth() + 1)} às ${dois(d.getUTCHours())}:${dois(d.getUTCMinutes())}`;
};

const limparLocal = (valor: unknown): string | null => {
  if (typeof valor !== "string") return null;
  const local = valor.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return local.length >= LOCAL_MIN && local.length <= LOCAL_MAX ? local : null;
};

export const parseAmistosoBody = (body: unknown): Parse => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  const timeOk = typeof b.timeId === "string" && TIME_ID.test(b.timeId);
  switch (b.action) {
    case "time_chave":
      return timeOk ? { ok: true, value: { action: "time_chave", timeId: b.timeId as string } } : { ok: false, error: "Time inválido." };
    case "time_encerrar":
      return timeOk ? { ok: true, value: { action: "time_encerrar", timeId: b.timeId as string } } : { ok: false, error: "Time inválido." };
    case "time_link":
      return isValidLinkId(b.linkId) ? { ok: true, value: { action: "time_link", linkId: b.linkId } } : { ok: false, error: "Link inválido." };
    case "time_buscar": {
      const chave = normalizarChave(b.chave);
      return chave ? { ok: true, value: { action: "time_buscar", chave } } : { ok: false, error: "Chave inválida. Ela tem 6 letras e números." };
    }
    case "amistoso_propor": {
      if (!timeOk || typeof b.adversarioId !== "string" || !TIME_ID.test(b.adversarioId)) return { ok: false, error: "Time inválido." };
      if (typeof b.data !== "string" || typeof b.hora !== "string" || instanteDe(b.data, b.hora) === null) {
        return { ok: false, error: "Dia ou horário inválido." };
      }
      const local = limparLocal(b.local);
      if (!local) return { ok: false, error: `Informe o local (de ${LOCAL_MIN} a ${LOCAL_MAX} caracteres).` };
      return { ok: true, value: { action: "amistoso_propor", timeId: b.timeId as string, adversarioId: b.adversarioId, data: b.data, hora: b.hora, local } };
    }
    case "amistoso_responder":
      if (!timeOk || typeof b.amistosoId !== "string" || !AMISTOSO_ID.test(b.amistosoId)) return { ok: false, error: "Amistoso inválido." };
      if (typeof b.aceitar !== "boolean") return { ok: false, error: "Resposta inválida." };
      return { ok: true, value: { action: "amistoso_responder", timeId: b.timeId as string, amistosoId: b.amistosoId, aceitar: b.aceitar } };
    case "amistoso_cancelar":
    case "amistoso_confirmar":
    case "amistoso_recusar_placar":
      if (!timeOk || typeof b.amistosoId !== "string" || !AMISTOSO_ID.test(b.amistosoId)) return { ok: false, error: "Amistoso inválido." };
      return { ok: true, value: { action: b.action, timeId: b.timeId as string, amistosoId: b.amistosoId } };
    case "amistoso_placar": {
      if (!timeOk || typeof b.amistosoId !== "string" || !AMISTOSO_ID.test(b.amistosoId)) return { ok: false, error: "Amistoso inválido." };
      const gol = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_GOLS;
      if (!gol(b.golsMeu) || !gol(b.golsOutro)) return { ok: false, error: `Placar inválido (de 0 a ${MAX_GOLS} gols).` };
      return { ok: true, value: { action: "amistoso_placar", timeId: b.timeId as string, amistosoId: b.amistosoId, golsMeu: b.golsMeu as number, golsOutro: b.golsOutro as number } };
    }
    case "amistoso_artilheiros": {
      if (!timeOk || typeof b.amistosoId !== "string" || !AMISTOSO_ID.test(b.amistosoId)) return { ok: false, error: "Amistoso inválido." };
      const g = b.gols;
      if (typeof g !== "object" || g === null || Array.isArray(g)) return { ok: false, error: "Gols inválidos." };
      const entradas = Object.entries(g as Record<string, unknown>);
      const valido = ([u, n]: [string, unknown]) => UID.test(u) && Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_GOLS;
      if (entradas.length > MAX_ARTILHEIROS || !entradas.every(valido)) return { ok: false, error: "Gols inválidos." };
      return { ok: true, value: { action: "amistoso_artilheiros", timeId: b.timeId as string, amistosoId: b.amistosoId, gols: Object.fromEntries(entradas) as Record<string, number> } };
    }
    case "amistoso_apurar":
      return timeOk ? { ok: true, value: { action: "amistoso_apurar", timeId: b.timeId as string } } : { ok: false, error: "Time inválido." };
    default:
      return { ok: false, error: "Ação inválida." };
  }
};

// ─── Dados do time ────────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;
const texto = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** O que o amistoso guarda de cada time (aparece na lista dos dois). */
export const resumoDoTime = (timeId: string, d: Doc) => ({
  timeId,
  nome: texto(d.nome, 40),
  sigla: texto(d.sigla, 3),
  cor: texto(d.cor, 7),
  corSecundaria: texto(d.corSecundaria, 7),
  escudoUrl: texto(d.escudoUrl, 500),
  chave: texto(d.chave, TAMANHO_CHAVE),
});

/**
 * Dados PÚBLICOS do time, os mesmos da página do link do time ("Divulgar"): o elenco vai com nome, foto pequena, número
 * e posição de quem aceitou a convocação (sem uid, @usuário, convocações pendentes, pedidos ou recusas).
 */
export const timePublico = (timeId: string, d: Doc, uid: string) => {
  const cidade = d.cidade as { city?: unknown; state?: unknown } | undefined;
  const membros = Array.isArray(d.membros) ? d.membros : [];
  return {
    timeId,
    nome: texto(d.nome, 40),
    sigla: texto(d.sigla, 3),
    cor: texto(d.cor, 7),
    corSecundaria: texto(d.corSecundaria, 7),
    escudoUrl: texto(d.escudoUrl, 500),
    modalidade: texto(d.modalidade, 10),
    genero: texto(d.genero, 10),
    faixaEtaria: texto(d.faixaEtaria, 10),
    cidade: cidade?.city ? { city: texto(cidade.city, 100), state: texto(cidade.state, 40) } : null,
    jogadores: membros.length,
    elenco: timeDoDocumento(d)?.jogadores ?? [],
    chave: texto(d.chave, TAMANHO_CHAVE),
    souDono: d.donoId === uid,
    souMembro: membros.includes(uid),
  };
};

// ─── Regras da proposta (puras, testadas) ────────────────────────────────────

export interface CenarioProposta {
  uid: string;
  agora: number;
  quando: number;
  meuId: string;
  meu: Doc | null;
  adversarioId: string;
  adversario: Doc | null;
  bloqueio: boolean;
  /** Amistosos pendentes que o MEU time tem (enviados e recebidos). */
  pendentes: Doc[];
  /** Todos os amistosos do MEU time com este adversário (histórico do par). */
  comEle: Doc[];
}

type Negado = { ok: false; status: number; code: string; error: string };
const negar = (status: number, code: string, error: string): Negado => ({ ok: false, status, code, error });

export const motivoParaNaoPropor = (c: CenarioProposta): Negado | null => {
  if (!c.meu || c.meu.donoId !== c.uid) return negar(403, "nao-dono", "Só o dono do time marca amistosos.");
  if (!c.adversario) return negar(404, "time-inexistente", "Este time não existe mais.");
  if (c.adversarioId === c.meuId) return negar(400, "mesmo-time", "Escolha outro time.");
  if (c.adversario.donoId === c.uid) return negar(400, "mesmo-dono", "Os dois times são seus.");
  if (c.adversario.modalidade !== c.meu.modalidade) return negar(400, "modalidade", "Só times da mesma modalidade marcam amistoso.");
  if (c.bloqueio) return negar(403, "bloqueado", "Não é possível marcar amistoso com este time.");
  if (c.quando < c.agora + ANTECEDENCIA_MS) return negar(400, "cedo", "Escolha um horário com pelo menos 30 minutos de antecedência.");
  if (c.quando > c.agora + PRAZO_MAXIMO_MS) return negar(400, "longe", "Marque com no máximo 120 dias de antecedência.");
  // Amistosos com um time que foi apagado (e talvez recriado com o mesmo id) não contam.
  const comEle = c.comEle.filter((a) => a.adversarioEncerrado !== true);
  if (comEle.some((a) => a.status === "sem_acordo")) {
    return negar(409, "sem-acordo", "Estes times não podem mais se enfrentar: um amistoso entre eles terminou sem acordo no placar.");
  }
  if (comEle.some((a) => emAndamento(a, c.agora))) return negar(409, "em-andamento", "Já existe um amistoso em andamento entre esses times.");
  const enviados = c.pendentes.filter((p) => (p.de as Doc)?.timeId === c.meuId).length;
  if (enviados >= MAX_PENDENTES) return negar(429, "muitos", `Seu time já tem ${MAX_PENDENTES} convites esperando resposta.`);
  return null;
};

export const motivoParaNaoResponder = (uid: string, agora: number, meuId: string, meu: Doc | null, amistoso: Doc | null): Negado | null => {
  if (!meu || meu.donoId !== uid) return negar(403, "nao-dono", "Só o dono do time responde convites de amistoso.");
  if (!amistoso) return negar(404, "inexistente", "Este convite não existe mais.");
  if ((amistoso.para as Doc)?.timeId !== meuId) return negar(403, "nao-convidado", "Este convite não é para o seu time.");
  if (amistoso.status !== "pendente") return negar(409, "respondido", "Este convite já foi respondido ou cancelado.");
  if (millis(amistoso.quando) <= agora) return negar(409, "passou", "O horário deste amistoso já passou.");
  return null;
};

export const motivoParaNaoCancelar = (uid: string, agora: number, meuId: string, meu: Doc | null, amistoso: Doc | null): Negado | null => {
  if (!meu || meu.donoId !== uid) return negar(403, "nao-dono", "Só o dono do time desmarca amistosos.");
  if (!amistoso) return negar(404, "inexistente", "Este amistoso não existe mais.");
  if (amistoso.status !== "pendente" && amistoso.status !== "aceito") return negar(409, "fechado", "Este amistoso já foi recusado ou cancelado.");
  if (millis(amistoso.quando) <= agora) return negar(409, "passou", "O horário deste amistoso já passou.");
  return null;
};

/** O outro time do amistoso (visto de `meuId`). */
export const outroLado = (amistoso: Doc, meuId: string): Doc => ((amistoso.de as Doc)?.timeId === meuId ? (amistoso.para as Doc) : (amistoso.de as Doc)) ?? {};

// ─── Avisos ───────────────────────────────────────────────────────────────────

export type EventoAmistoso = "novo" | "aceito" | "recusado" | "cancelado" | "placar" | "contestado" | "confirmado" | "sem_acordo";

const nome = (d: Doc | undefined): string => texto(d?.nome, NOME_MAX) || "Um time";

export const avisoDeAmistoso = (evento: EventoAmistoso, amistoso: Doc, quemAgiu: Doc, paraTimeId: string): PushDraft => {
  const quando = quandoTexto(millis(amistoso.quando));
  const local = texto(amistoso.local, 60);
  const data = { tipo: "time_amistoso" as const, turmaId: "", timeId: paraTimeId };
  switch (evento) {
    case "novo":
      return { title: "Convite para amistoso", body: `${nome(quemAgiu)} chamou o seu time para um amistoso: ${quando} · ${local}`, data };
    case "aceito":
      return { title: "Amistoso confirmado!", body: `${nome(quemAgiu)} aceitou o amistoso de ${quando} · ${local}`, data };
    case "recusado":
      return { title: "Amistoso recusado", body: `${nome(quemAgiu)} recusou o convite para ${quando}.`, data };
    case "cancelado":
      return { title: "Amistoso cancelado", body: `${nome(quemAgiu)} desmarcou o amistoso de ${quando}.`, data };
  }
  const p = propostaDe(amistoso);
  const r = amistoso.resultado as { golsDe?: number; golsPara?: number } | undefined;
  const placar = p ? placarTexto(amistoso, p.golsDe, p.golsPara) : r ? placarTexto(amistoso, Number(r.golsDe), Number(r.golsPara)) : "";
  switch (evento) {
    case "placar":
      return { title: "Placar para confirmar", body: `${nome(quemAgiu)} informou o placar: ${placar}. Confirme em até 1 hora.`, data };
    case "contestado":
      return { title: "Placar contestado", body: `${nome(quemAgiu)} não concordou e informou: ${placar}. Confirme em até 1 hora.`, data };
    case "confirmado":
      return { title: "Placar confirmado", body: `${nome(quemAgiu)} confirmou o placar: ${placar}.`, data };
    case "sem_acordo":
      return { title: "Amistoso sem acordo", body: `${nome(quemAgiu)} não concordou com o placar. O jogo foi para o histórico sem acordo e os times não podem mais se enfrentar.`, data };
  }
};

/**
 * Avisos: nascem na MESMA transação da ação (`agendarAviso`, na fila de push) e são enviados logo depois
 * (`dispararAviso`). Se o envio falhar ou a função cair no meio, a rotina de recuperação da fila manda depois.
 */
const prepararAviso = (para: string, amistosoId: string, evento: EventoAmistoso, draft: PushDraft): Aviso | null =>
  para
    ? { evento: draft.data.tipo, turmaId: "", dedupeKey: `amistoso_${evento}_${amistosoId}_${para}`, dedupeMs: DEDUPE_MS, recipientUids: [para], dedupeUid: para, draft }
    : null;

const agendarAviso = (tx: Transaction, db: Firestore, aviso: Aviso | null): void => {
  if (aviso) tx.set(db.doc(`${COLECAO_AVISOS}/${aviso.dedupeKey}`), avisoPendente(aviso, Date.now()));
};

/** Melhor esforço: a ação e o aviso já estão salvos. */
const dispararAviso = async (db: Firestore, aviso: Aviso | null): Promise<void> => {
  if (!aviso) return;
  try {
    await enviarAviso(db, aviso);
  } catch (erro) {
    console.warn("[amistosos] aviso fica na fila:", (erro as Error)?.message ?? "erro");
  }
};

// ─── Ações ────────────────────────────────────────────────────────────────────

type Resultado = { ok: true; body?: Record<string, unknown> } | Negado;

const timeRef = (db: Firestore, id: string) => db.doc(`times/${id}`);
const amistosoRef = (db: Firestore, timeId: string, id: string) => db.doc(`times/${timeId}/${SUB_AMISTOSOS}/${id}`);

/** `apenasDoDono`: o botão "chave" do dono. Sem ele (link público do time), qualquer pessoa logada recebe a chave. */
const pegarChave = async (db: Firestore, uid: string, timeId: string, apenasDoDono = true): Promise<Resultado> => {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const chave = gerarChave();
    const resultado = await db.runTransaction(async (tx): Promise<Resultado | "repetida"> => {
      const [time, ocupada] = await tx.getAll(timeRef(db, timeId), db.doc(`${COLECAO_CHAVES}/${chave}`));
      if (!time.exists) return negar(404, "nao-encontrado", "Este time não existe mais.");
      if (apenasDoDono && time.get("donoId") !== uid) return negar(403, "nao-dono", "Só o dono vê a chave do time.");
      const atual = normalizarChave(time.get("chave"));
      if (atual) return { ok: true, body: { chave: atual } };
      if (ocupada.exists) return "repetida";
      // donoId: a exclusão de conta acha e apaga as chaves dos times da pessoa.
      tx.create(db.doc(`${COLECAO_CHAVES}/${chave}`), { timeId, donoId: time.get("donoId"), criadoEm: FieldValue.serverTimestamp() });
      tx.update(timeRef(db, timeId), { chave });
      return { ok: true, body: { chave } };
    });
    if (resultado !== "repetida") return resultado;
  }
  throw new Error("chave: muitas colisões");
};

/**
 * "Abrir no Tugyn" na página pública do time (o link leva o `linkId`, nunca o id do time, que contém o uid do dono).
 * Quem é do time (jogador, convocado ou quem pediu para entrar) recebe o id e abre o time; os outros recebem a chave e
 * abrem o time público (os mesmos dados de quem digita a chave). O dono divulgou a página: a chave serve para marcar amistoso.
 */
const abrirPeloLink = async (db: Firestore, uid: string, linkId: string): Promise<Resultado> => {
  const achados = await db.collection("times").where("linkId", "==", linkId).limit(1).get();
  const time = achados.docs[0];
  if (!time) return negar(404, "nao-encontrado", "Este time não existe mais.");
  const lista = (campo: string): unknown[] => (Array.isArray(time.get(campo)) ? time.get(campo) : []);
  if ([...lista("membros"), ...lista("convidados"), ...lista("solicitantes")].includes(uid)) return { ok: true, body: { timeId: time.id } };
  const atual = normalizarChave(time.get("chave"));
  if (atual) return { ok: true, body: { chave: atual } };
  const gerada = await pegarChave(db, uid, time.id, false);
  return gerada.ok ? { ok: true, body: { chave: gerada.body?.chave } } : gerada;
};

const contagem = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Resumo dos amistosos para quem visita o time: números do time e os 2 maiores artilheiros que ainda estão no elenco
 * (só nome e gols, sem uid). Sem jogos com placar = null.
 */
/** Resumo para quem visita o time: só os números do time (artilheiros ficam só para o próprio elenco). */
export const resumoPublico = (d: Doc | undefined) => {
  if (!d || contagem(d.jogos) === 0) return null;
  return {
    jogos: contagem(d.jogos),
    vitorias: contagem(d.vitorias),
    empates: contagem(d.empates),
    derrotas: contagem(d.derrotas),
    golsPro: contagem(d.golsPro),
    golsContra: contagem(d.golsContra),
    // Lista vazia (e não ausente): versões antigas do app esperam o campo.
    artilheiros: [],
  };
};

const buscar = async (db: Firestore, uid: string, chave: string): Promise<Resultado> => {
  const ref = await db.doc(`${COLECAO_CHAVES}/${chave}`).get();
  const timeId = ref.exists ? ref.get("timeId") : null;
  const time = typeof timeId === "string" ? await timeRef(db, timeId).get() : null;
  // Chave de time apagado (ou trocada) = não encontrado.
  if (!time?.exists || time.get("chave") !== chave) return negar(404, "nao-encontrado", "Nenhum time com essa chave.");
  // Placar que já valeu pelo prazo (ninguém do time abriu os jogos depois): grava antes, para entrar nos últimos jogos.
  try {
    await aplicarPrazos(db, time.id);
  } catch (erro) {
    console.warn("[amistosos] prazos na busca:", (erro as Error)?.message ?? "erro");
  }
  // Somente jogos encerrados têm finalizadoEm. Consulta limitada, sem expor o histórico privado.
  const jogos = await db.collection(`times/${time.id}/${SUB_AMISTOSOS}`)
    .orderBy("finalizadoEm", "desc").limit(5).get();
  // Os mesmos 5 jogos na aba Jogos de quem visita: data, adversário (dados públicos dele) e placar. Sem local nem gols
  // por jogador. Adversário apagado vai sem a chave (não dá mais para abrir).
  const ultimosJogos = jogos.docs.flatMap((jogo) => {
    const d = jogo.data();
    const placar = d.resultado as { golsDe?: unknown; golsPara?: unknown } | undefined;
    if (d.status !== "finalizado" || !placar
      || typeof placar.golsDe !== "number" || typeof placar.golsPara !== "number"
      || !Number.isInteger(placar.golsDe) || !Number.isInteger(placar.golsPara)
      || placar.golsDe < 0 || placar.golsPara < 0 || placar.golsDe > MAX_GOLS || placar.golsPara > MAX_GOLS) return [];
    const meus = d.de?.timeId === time.id ? placar.golsDe : placar.golsPara;
    const deles = d.de?.timeId === time.id ? placar.golsPara : placar.golsDe;
    const outro = outroLado(d, time.id);
    const { timeId: _id, ...adversario } = resumoDoTime(String(outro.timeId ?? ""), outro);
    return [{
      id: jogo.id,
      quando: millis(d.quando) || (typeof d.quando === "number" && d.quando > 0 ? d.quando : 0),
      adversario: d.adversarioEncerrado === true ? { ...adversario, chave: "" } : adversario,
      golsMeu: meus,
      golsAdversario: deles,
    }];
  });
  const ultimosResultados = ultimosJogos.map((j): "V" | "E" | "D" => (j.golsMeu > j.golsAdversario ? "V" : j.golsMeu === j.golsAdversario ? "E" : "D"));
  const resumo = await resumoRef(db, time.id).get();
  return {
    ok: true,
    body: { time: { ...timePublico(time.id, time.data() ?? {}, uid), ultimosResultados, ultimosJogos, resumo: resumoPublico(resumo.data()) } },
  };
};

const propor = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_propor" }>): Promise<Resultado> => {
  const quando = instanteDe(p.data, p.hora) as number;
  const id = db.collection("_").doc().id;
  const resultado = await db.runTransaction(async (tx) => {
    const [meu, adversario] = await tx.getAll(timeRef(db, p.timeId), timeRef(db, p.adversarioId));
    const donoAdversario = adversario.exists ? String(adversario.get("donoId") ?? "") : "";
    const [bloqueioA, bloqueioB] = donoAdversario
      ? await tx.getAll(db.doc(`users/${uid}/blocked/${donoAdversario}`), db.doc(`users/${donoAdversario}/blocked/${uid}`))
      : [null, null];
    const meus = db.collection(`times/${p.timeId}/${SUB_AMISTOSOS}`);
    const [pendentes, enviados, recebidos] = await Promise.all([
      tx.get(meus.where("status", "==", "pendente").limit(50)),
      tx.get(meus.where("para.timeId", "==", p.adversarioId).limit(100)),
      tx.get(meus.where("de.timeId", "==", p.adversarioId).limit(100)),
    ]);
    const negado = motivoParaNaoPropor({
      uid,
      agora: Date.now(),
      quando,
      meuId: p.timeId,
      meu: meu.exists ? (meu.data() ?? {}) : null,
      adversarioId: p.adversarioId,
      adversario: adversario.exists ? (adversario.data() ?? {}) : null,
      bloqueio: Boolean(bloqueioA?.exists || bloqueioB?.exists),
      pendentes: pendentes.docs.map((d) => d.data()),
      comEle: [...enviados.docs, ...recebidos.docs].map((d) => d.data()),
    });
    if (negado) return negado;
    const doc = {
      de: resumoDoTime(p.timeId, meu.data() ?? {}),
      para: resumoDoTime(p.adversarioId, adversario.data() ?? {}),
      quando: Timestamp.fromMillis(quando),
      local: p.local,
      status: "pendente" as StatusAmistoso,
      criadoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    };
    tx.create(amistosoRef(db, p.timeId, id), doc);
    tx.create(amistosoRef(db, p.adversarioId, id), doc);
    const aviso = prepararAviso(donoAdversario, id, "novo", avisoDeAmistoso("novo", doc, doc.de, p.adversarioId));
    agendarAviso(tx, db, aviso);
    return { ok: true as const, aviso };
  });
  if (!resultado.ok) return resultado;
  await dispararAviso(db, resultado.aviso);
  return { ok: true, body: { amistosoId: id } };
};

/** Muda o status nas duas cópias (a do outro time pode não existir mais, se ele foi apagado). */
const mudarStatus = async (
  db: Firestore,
  uid: string,
  meuId: string,
  amistosoId: string,
  validar: (meu: Doc | null, amistoso: Doc | null) => Negado | null,
  novoStatus: (amistoso: Doc) => StatusAmistoso,
  avisoDe: (amistoso: Doc, outro: Doc, outroDono: string) => Aviso | null,
): Promise<Resultado | { ok: true; amistoso: Doc; outro: Doc; outroDono: string; status: StatusAmistoso; aviso: Aviso | null }> =>
  db.runTransaction(async (tx) => {
    const [meu, minhaCopia] = await tx.getAll(timeRef(db, meuId), amistosoRef(db, meuId, amistosoId));
    const amistoso = minhaCopia.exists ? (minhaCopia.data() ?? {}) : null;
    const negado = validar(meu.exists ? (meu.data() ?? {}) : null, amistoso);
    if (negado || !amistoso) return negado ?? negar(404, "inexistente", "Este amistoso não existe mais.");
    const outro = outroLado(amistoso, meuId);
    const outroId = String(outro.timeId ?? "");
    const [outroTime, outraCopia] = TIME_ID.test(outroId)
      ? await tx.getAll(timeRef(db, outroId), amistosoRef(db, outroId, amistosoId))
      : [null, null];
    // O outro time foi apagado: o amistoso não acontece mais.
    const status: StatusAmistoso = outroTime?.exists ? novoStatus(amistoso) : "cancelado";
    const mudanca = { status, respondidoEm: FieldValue.serverTimestamp(), atualizadoEm: FieldValue.serverTimestamp(), ...(status === "cancelado" ? { canceladoPor: meuId } : {}) };
    tx.update(minhaCopia.ref, mudanca);
    if (outraCopia?.exists) tx.update(outraCopia.ref, mudanca);
    if (!outroTime?.exists) return negar(409, "time-apagado", "O outro time não existe mais. O amistoso foi cancelado.");
    const outroDono = String(outroTime.get("donoId") ?? "");
    const aviso = avisoDe(amistoso, outro, outroDono);
    agendarAviso(tx, db, aviso);
    return { ok: true as const, amistoso, outro, outroDono, status, aviso };
  });

const responder = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_responder" }>): Promise<Resultado> => {
  const evento: EventoAmistoso = p.aceitar ? "aceito" : "recusado";
  const r = await mudarStatus(
    db,
    uid,
    p.timeId,
    p.amistosoId,
    (meu, a) => motivoParaNaoResponder(uid, Date.now(), p.timeId, meu, a),
    () => (p.aceitar ? "aceito" : "recusado"),
    (a, outro, dono) => prepararAviso(dono, p.amistosoId, evento, avisoDeAmistoso(evento, a, a.para as Doc, String(outro.timeId))),
  );
  if (!r.ok || !("amistoso" in r)) return r;
  await dispararAviso(db, r.aviso);
  return { ok: true, body: { status: r.status } };
};

const cancelar = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_cancelar" }>): Promise<Resultado> => {
  const r = await mudarStatus(
    db,
    uid,
    p.timeId,
    p.amistosoId,
    (meu, a) => motivoParaNaoCancelar(uid, Date.now(), p.timeId, meu, a),
    () => "cancelado",
    (a, outro, dono) => prepararAviso(dono, p.amistosoId, "cancelado", avisoDeAmistoso("cancelado", a, meuLado(a, p.timeId), String(outro.timeId))),
  );
  if (!r.ok || !("amistoso" in r)) return r;
  await dispararAviso(db, r.aviso);
  return { ok: true, body: { status: "cancelado" } };
};

/**
 * O time vai sumir (o dono apaga, ou a conta é excluída). Na cópia de cada adversário, o amistoso em aberto vira
 * "cancelado" e todos ficam marcados `adversarioEncerrado` (histórico preservado para ele, mas não bloqueiam nem contam
 * como "em andamento" se um time novo nascer com o mesmo id). As cópias do próprio time, a chave e o resumo são apagados:
 * um time novo na mesma vaga (`uid_1`) começa sem histórico. Idempotente.
 */
/** Amistosos tratados por vez ao encerrar: as cópias dos adversários são lidas juntas e gravadas num lote só (≤ 100 escritas). */
const LOTE_ENCERRAR = 50;

export const encerrarAmistososDoTime = async (db: Firestore, timeId: string): Promise<number> => {
  const todos = await db.collection(`times/${timeId}/${SUB_AMISTOSOS}`).get();
  let cancelados = 0;
  // Em blocos (e não um jogo por vez): um time com histórico grande termina dentro do tempo do app. Cada bloco é um
  // lote atômico e o processo todo é idempotente, então uma repetição continua de onde parou.
  for (let i = 0; i < todos.docs.length; i += LOTE_ENCERRAR) {
    const bloco = todos.docs.slice(i, i + LOTE_ENCERRAR);
    const copias = await Promise.all(
      bloco.map((doc) => {
        const outroId = String(outroLado(doc.data(), timeId).timeId ?? "");
        return TIME_ID.test(outroId) ? amistosoRef(db, outroId, doc.id).get() : Promise.resolve(null);
      }),
    );
    const lote = db.batch();
    bloco.forEach((doc, j) => {
      const aberto = ["pendente", "aceito", "placar"].includes(String(doc.data().status));
      const outra = copias[j];
      if (outra?.exists) {
        lote.update(outra.ref, {
          adversarioEncerrado: true,
          ...(aberto ? { status: "cancelado", canceladoPor: timeId, respondidoEm: FieldValue.serverTimestamp(), atualizadoEm: FieldValue.serverTimestamp() } : {}),
        });
      }
      lote.delete(doc.ref);
      if (aberto) cancelados += 1;
    });
    await lote.commit();
  }
  const chaves = await db.collection(COLECAO_CHAVES).where("timeId", "==", timeId).get();
  await Promise.all(chaves.docs.map((chave) => chave.ref.delete()));
  await resumoRef(db, timeId).delete();
  return cancelados;
};

// ─── Resultado (placar, artilheiros e prazos) ────────────────────────────────

const resumoRef = (db: Firestore, timeId: string) => db.doc(`times/${timeId}/${SUB_RESUMO}/geral`);

type Placar = { golsDe: number; golsPara: number };
/** O que a ação faz com o amistoso (nas duas cópias). */
interface Plano {
  status: StatusAmistoso;
  campos?: Doc;
  /** Com status "finalizado": o placar que vale. */
  resultado?: Placar;
  como?: "confirmado" | "prazo";
}

/** Os prazos vencidos (o placar enviado vale, ou o jogo fica sem placar). */
const planoDoPrazo = (a: Doc, agora: number): Plano | null => {
  const e = efetivo(a, agora);
  if (e.status === String(a.status)) return null;
  return e.status === "finalizado" && e.resultado ? { status: "finalizado", resultado: e.resultado, como: "prazo" } : { status: e.status };
};

const somarNoResumo = (tx: Transaction, db: Firestore, timeId: string, golsPro: number, golsContra: number) => {
  const r = resumoDoResultado(golsPro, golsContra);
  const inc = FieldValue.increment;
  tx.set(
    resumoRef(db, timeId),
    {
      jogos: inc(r.jogos),
      vitorias: inc(r.vitorias),
      empates: inc(r.empates),
      derrotas: inc(r.derrotas),
      golsPro: inc(r.golsPro),
      golsContra: inc(r.golsContra),
      atualizadoEm: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};

type Feito = { ok: true; amistoso: Doc; outro: Doc; outroDono: string; plano: Plano; aviso: Aviso | null };

/**
 * Lê o amistoso (e o outro time) numa transação e aplica o plano nas duas cópias. Se a ação foi negada mas um prazo já
 * venceu, grava o que o prazo decidiu (o documento estava atrasado). Finalizado soma no resumo dos dois times.
 */
const agirNoResultado = (
  db: Firestore,
  meuId: string,
  amistosoId: string,
  acao: (meu: Doc | null, amistoso: Doc | null, agora: number) => Negado | Plano,
  avisoDe?: (feito: Omit<Feito, "aviso">) => Aviso | null,
): Promise<Negado | Feito> =>
  db.runTransaction(async (tx) => {
    const [meu, minhaCopia] = await tx.getAll(timeRef(db, meuId), amistosoRef(db, meuId, amistosoId));
    const amistoso = minhaCopia.exists ? (minhaCopia.data() ?? {}) : null;
    const outro = amistoso ? outroLado(amistoso, meuId) : {};
    const outroId = String(outro.timeId ?? "");
    const [outroTime, outraCopia] = amistoso && TIME_ID.test(outroId) ? await tx.getAll(timeRef(db, outroId), amistosoRef(db, outroId, amistosoId)) : [null, null];
    const agora = Date.now();
    const pedido = acao(meu.exists ? (meu.data() ?? {}) : null, amistoso, agora);
    const plano: Plano | null = "ok" in pedido ? (amistoso ? planoDoPrazo(amistoso, agora) : null) : pedido;
    if (!plano || !amistoso) return pedido as Negado;
    const gravar = (mudanca: Doc) => {
      tx.update(minhaCopia.ref, mudanca);
      if (outraCopia?.exists) tx.update(outraCopia.ref, mudanca);
    };
    // O outro time foi apagado: o amistoso não acontece mais.
    if (!outroTime?.exists) {
      gravar({ status: "cancelado", canceladoPor: meuId, atualizadoEm: FieldValue.serverTimestamp() });
      return negar(409, "time-apagado", "O outro time não existe mais. O amistoso foi cancelado.");
    }
    const mudanca: Doc = { status: plano.status, atualizadoEm: FieldValue.serverTimestamp(), ...plano.campos };
    if (plano.status === "finalizado" && plano.resultado) {
      Object.assign(mudanca, { resultado: plano.resultado, como: plano.como ?? "confirmado", finalizadoEm: FieldValue.serverTimestamp() });
      const deId = String((amistoso.de as Doc)?.timeId ?? "");
      const paraId = String((amistoso.para as Doc)?.timeId ?? "");
      somarNoResumo(tx, db, deId, plano.resultado.golsDe, plano.resultado.golsPara);
      somarNoResumo(tx, db, paraId, plano.resultado.golsPara, plano.resultado.golsDe);
    }
    gravar(mudanca);
    if ("ok" in pedido) return pedido;
    const feito = { ok: true as const, amistoso: { ...amistoso, ...mudanca }, outro, outroDono: String(outroTime.get("donoId") ?? ""), plano };
    const aviso = avisoDe?.(feito) ?? null;
    agendarAviso(tx, db, aviso);
    return { ...feito, aviso };
  });

/** O time de quem agiu, visto no amistoso. */
const meuLado = (a: Doc, meuId: string): Doc => ((a.de as Doc)?.timeId === meuId ? (a.de as Doc) : (a.para as Doc)) ?? {};

const informarPlacar = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_placar" }>): Promise<Resultado> => {
  const r = await agirNoResultado(db, p.timeId, p.amistosoId, (meu, a, agora) => {
    const negado = motivoParaNaoInformarPlacar(uid, agora, p.timeId, meu, a, p.golsMeu, p.golsOutro);
    if (negado || !a) return negado ?? negar(404, "inexistente", "Este amistoso não existe mais.");
    const rodada = efetivo(a, agora).status === "placar" ? 2 : 1;
    const placar = placarDoDocumento(a, p.timeId, p.golsMeu, p.golsOutro);
    return { status: "placar", campos: { proposta: { porTimeId: p.timeId, ...placar, rodada, venceEm: Timestamp.fromMillis(agora + PRAZO_PLACAR_MS) } } };
  }, (f) => {
    const evento: EventoAmistoso = (f.plano.campos?.proposta as Doc)?.rodada === 2 ? "contestado" : "placar";
    return prepararAviso(f.outroDono, p.amistosoId, evento, avisoDeAmistoso(evento, f.amistoso, meuLado(f.amistoso, p.timeId), String(f.outro.timeId)));
  });
  if (!r.ok) return r;
  await dispararAviso(db, r.aviso);
  return { ok: true, body: { status: "placar" } };
};

const confirmarPlacar = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_confirmar" }>): Promise<Resultado> => {
  const r = await agirNoResultado(db, p.timeId, p.amistosoId, (meu, a, agora) => {
    const negado = motivoParaNaoConfirmarPlacar(uid, agora, p.timeId, meu, a);
    const proposta = a ? propostaDe(a) : null;
    if (negado || !proposta) return negado ?? negar(409, "estado", "Não foi possível ler o placar enviado. Tente de novo.");
    return { status: "finalizado", resultado: { golsDe: proposta.golsDe, golsPara: proposta.golsPara }, como: "confirmado" };
  }, (f) => prepararAviso(f.outroDono, p.amistosoId, "confirmado", avisoDeAmistoso("confirmado", f.amistoso, meuLado(f.amistoso, p.timeId), String(f.outro.timeId))));
  if (!r.ok) return r;
  await dispararAviso(db, r.aviso);
  return { ok: true, body: { status: "finalizado" } };
};

const recusarPlacar = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_recusar_placar" }>): Promise<Resultado> => {
  const r = await agirNoResultado(db, p.timeId, p.amistosoId, (meu, a, agora) => {
    const negado = motivoParaNaoRecusarPlacar(uid, agora, p.timeId, meu, a);
    return negado ?? { status: "sem_acordo", campos: { semAcordoEm: FieldValue.serverTimestamp() } };
  }, (f) => prepararAviso(f.outroDono, p.amistosoId, "sem_acordo", avisoDeAmistoso("sem_acordo", f.amistoso, meuLado(f.amistoso, p.timeId), String(f.outro.timeId))));
  if (!r.ok) return r;
  await dispararAviso(db, r.aviso);
  return { ok: true, body: { status: "sem_acordo" } };
};

/** Quem fez os gols do meu time: fica na cópia do meu time e soma (ou corrige) no resumo do meu time. */
const marcarArtilheiros = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_artilheiros" }>): Promise<Resultado> =>
  db.runTransaction(async (tx): Promise<Resultado> => {
    const [meu, minhaCopia] = await tx.getAll(timeRef(db, p.timeId), amistosoRef(db, p.timeId, p.amistosoId));
    const time = meu.exists ? (meu.data() ?? {}) : null;
    const amistoso = minhaCopia.exists ? (minhaCopia.data() ?? {}) : null;
    const negado = motivoParaNaoMarcarArtilheiros(uid, Date.now(), p.timeId, time, amistoso, p.gols);
    if (negado || !time || !amistoso) return negado ?? negar(404, "inexistente", "Este amistoso não existe mais.");
    const anteriores = (amistoso.artilheiros ?? {}) as Record<string, { nome?: string; gols?: number }>;
    const jogadores = (time.jogadores ?? {}) as Record<string, { nome?: string }>;
    const nomeDe = (u: string) => texto(jogadores[u]?.nome, NOME_MAX) || texto(anteriores[u]?.nome, NOME_MAX) || "Jogador";
    const novos = Object.fromEntries(Object.entries(p.gols).map(([u, gols]) => [u, { nome: nomeDe(u), gols }]));
    const antes = Object.fromEntries(Object.entries(anteriores).map(([u, v]) => [u, Number(v?.gols) || 0]));
    const dif = diferencaDeGols(antes, p.gols);
    tx.update(minhaCopia.ref, { artilheiros: novos, artilheirosEm: FieldValue.serverTimestamp() });
    if (Object.keys(dif).length > 0) {
      const porJogador = Object.fromEntries(Object.entries(dif).map(([u, d]) => [u, { nome: nomeDe(u), gols: FieldValue.increment(d) }]));
      tx.set(resumoRef(db, p.timeId), { jogadores: porJogador, atualizadoEm: FieldValue.serverTimestamp() }, { merge: true });
    }
    return { ok: true, body: { artilheiros: Object.keys(novos).length } };
  });

/** Alguém do elenco abriu os jogos: grava o que os prazos vencidos decidiram. */
const apurar = async (db: Firestore, uid: string, timeId: string): Promise<Resultado> => {
  const time = await timeRef(db, timeId).get();
  const membros = time.exists && Array.isArray(time.get("membros")) ? (time.get("membros") as unknown[]) : [];
  if (!membros.includes(uid)) return negar(403, "nao-membro", "Só quem é do time vê os jogos.");
  return { ok: true, body: { apurados: await aplicarPrazos(db, timeId) } };
};

const MAX_ABERTOS_APURAR = 300;

/** Grava o que os prazos vencidos decidiram (placar que valeu, jogo sem placar). Devolve quantos mudaram. */
const aplicarPrazos = async (db: Firestore, timeId: string): Promise<number> => {
  // Todos os confirmados/com placar do time (é um por adversário, então é pouco): com um limite pequeno, os mesmos jogos
  // ainda não vencidos podiam ocupar a consulta e deixar os vencidos de fora. O teto só protege contra dado anormal.
  const abertos = await db.collection(`times/${timeId}/${SUB_AMISTOSOS}`).where("status", "in", ["aceito", "placar"]).limit(MAX_ABERTOS_APURAR).get();
  const agora = Date.now();
  let apurados = 0;
  for (const doc of abertos.docs) {
    if (!planoDoPrazo(doc.data(), agora)) continue;
    const r = await agirNoResultado(db, timeId, doc.id, () => negar(409, "apurado", ""));
    if (!r.ok && r.code === "apurado") apurados += 1;
  }
  return apurados;
};

/** Apaga o time inteiro no servidor (amistosos, chave, resumo, prévia do link e o documento). Repetir é seguro. */
const encerrar = async (db: Firestore, uid: string, timeId: string): Promise<Resultado> => {
  const time = await timeRef(db, timeId).get();
  // Já apagado: o id do time começa com o uid do dono (`uid_1`, `uid_2`).
  const ehDono = time.exists ? time.get("donoId") === uid : timeId.startsWith(`${uid}_`);
  if (!ehDono) return negar(403, "nao-dono", "Só o dono encerra o time.");
  const cancelados = await encerrarAmistososDoTime(db, timeId);
  if (time.exists) {
    const codigo = time.get("conviteCodigo");
    if (typeof codigo === "string" && /^[A-Za-z0-9]{16}$/.test(codigo)) {
      const previa = db.doc(`convitesTime/${codigo}`);
      const snap = await previa.get();
      if (snap.exists && snap.get("timeId") === timeId) await previa.delete();
    }
    await db.recursiveDelete(timeRef(db, timeId));
  }
  return { ok: true, body: { cancelados, apagado: true } };
};

export const executarAmistoso = (db: Firestore, uid: string, pedido: AmistosoRequest): Promise<Resultado> => {
  switch (pedido.action) {
    case "time_chave":
      return pegarChave(db, uid, pedido.timeId);
    case "time_buscar":
      return buscar(db, uid, pedido.chave);
    case "time_link":
      return abrirPeloLink(db, uid, pedido.linkId);
    case "amistoso_propor":
      return propor(db, uid, pedido);
    case "amistoso_responder":
      return responder(db, uid, pedido);
    case "amistoso_cancelar":
      return cancelar(db, uid, pedido);
    case "time_encerrar":
      return encerrar(db, uid, pedido.timeId);
    case "amistoso_placar":
      return informarPlacar(db, uid, pedido);
    case "amistoso_confirmar":
      return confirmarPlacar(db, uid, pedido);
    case "amistoso_recusar_placar":
      return recusarPlacar(db, uid, pedido);
    case "amistoso_artilheiros":
      return marcarArtilheiros(db, uid, pedido);
    case "amistoso_apurar":
      return apurar(db, uid, pedido.timeId);
  }
};
