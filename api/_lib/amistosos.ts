import { randomInt } from "node:crypto";
import { FieldValue, type Firestore, Timestamp } from "firebase-admin/firestore";
import { DEDUPE_MS, type PushDraft } from "./push";
import { enviarAviso } from "./pushEnvio";

/**
 * Chave pública dos times e amistosos entre times (pela rota `POST /api/desafios`: o plano da Vercel não comporta outra função).
 *  - time_chave { timeId }                                     o dono pega a chave do time (gerada na 1ª vez)
 *  - time_buscar { chave }                                     qualquer pessoa logada vê os dados PÚBLICOS do time
 *  - amistoso_propor { timeId, adversarioId, data, hora, local }   o dono convida outro time da mesma modalidade
 *  - amistoso_responder { timeId, amistosoId, aceitar }       o dono do time convidado aceita ou recusa
 *  - amistoso_cancelar { timeId, amistosoId }                 o dono de qualquer um dos dois desmarca (antes do jogo)
 *  - time_encerrar { timeId }                                  o dono vai apagar o time: cancela os amistosos em aberto
 *                                                               nos adversários e apaga a chave (a exclusão de conta também)
 * O amistoso fica em `times/{id}/amistosos/{amistosoId}` com uma cópia em cada time (o elenco de cada um lê a sua; o app
 * não grava). A chave fica em `chavesTime/{chave}` (só o servidor lê e grava) e no campo `chave` do time.
 */

export const COLECAO_CHAVES = "chavesTime";
export const SUB_AMISTOSOS = "amistosos";
/** Sem letras e números que se confundem (O/0, I/1). */
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TAMANHO_CHAVE = 6;
const CHAVE = /^[A-HJ-NP-Z2-9]{6}$/;
const TIME_ID = /^[A-Za-z0-9_-]{1,128}_[12]$/;
const AMISTOSO_ID = /^[A-Za-z0-9]{20}$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const LOCAL_MIN = 3;
export const LOCAL_MAX = 120;
/** Antecedência mínima e prazo máximo para marcar. */
export const ANTECEDENCIA_MS = 30 * 60_000;
export const PRAZO_MAXIMO_MS = 120 * 24 * 3600_000;
/** Convites pendentes enviados por um time ao mesmo tempo. */
export const MAX_PENDENTES = 10;
const NOME_MAX = 40;
/** Brasília (sem horário de verão desde 2019). */
const FUSO_MS = -3 * 3600_000;

export type StatusAmistoso = "pendente" | "aceito" | "recusado" | "cancelado";

export type AmistosoRequest =
  | { action: "time_chave"; timeId: string }
  | { action: "time_buscar"; chave: string }
  | { action: "amistoso_propor"; timeId: string; adversarioId: string; data: string; hora: string; local: string }
  | { action: "amistoso_responder"; timeId: string; amistosoId: string; aceitar: boolean }
  | { action: "amistoso_cancelar"; timeId: string; amistosoId: string }
  | { action: "time_encerrar"; timeId: string };

type Parse = { ok: true; value: AmistosoRequest } | { ok: false; error: string };

export const ehAcaoDeAmistoso = (body: unknown): boolean => {
  const action = (body as { action?: unknown } | null)?.action;
  return typeof action === "string" && (action.startsWith("amistoso_") || action === "time_chave" || action === "time_buscar" || action === "time_encerrar");
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
      if (!timeOk || typeof b.amistosoId !== "string" || !AMISTOSO_ID.test(b.amistosoId)) return { ok: false, error: "Amistoso inválido." };
      return { ok: true, value: { action: "amistoso_cancelar", timeId: b.timeId as string, amistosoId: b.amistosoId } };
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

/** Só dados PÚBLICOS do time (nada do elenco além de quantos são). */
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
  const comEle = c.pendentes.some((p) => (p.de as Doc)?.timeId === c.adversarioId || (p.para as Doc)?.timeId === c.adversarioId);
  if (comEle) return negar(409, "ja-pendente", "Já existe um convite de amistoso esperando resposta entre esses times.");
  const enviados = c.pendentes.filter((p) => (p.de as Doc)?.timeId === c.meuId).length;
  if (enviados >= MAX_PENDENTES) return negar(429, "muitos", `Seu time já tem ${MAX_PENDENTES} convites esperando resposta.`);
  return null;
};

const millis = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : typeof (v as { toMillis?: unknown })?.toMillis === "function" ? (v as Timestamp).toMillis() : 0);

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

export type EventoAmistoso = "novo" | "aceito" | "recusado" | "cancelado";

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
};

/** Melhor esforço: a ação já está salva. */
const avisar = async (db: Firestore, para: string, amistosoId: string, evento: EventoAmistoso, draft: PushDraft): Promise<void> => {
  if (!para) return;
  try {
    const dedupeKey = `amistoso_${evento}_${amistosoId}_${para}`;
    await enviarAviso(db, { evento: draft.data.tipo, turmaId: "", dedupeKey, dedupeMs: DEDUPE_MS, recipientUids: [para], dedupeUid: para, draft });
  } catch (erro) {
    console.warn("[amistosos] aviso não enviado:", (erro as Error)?.message ?? "erro");
  }
};

// ─── Ações ────────────────────────────────────────────────────────────────────

type Resultado = { ok: true; body?: Record<string, unknown> } | Negado;

const timeRef = (db: Firestore, id: string) => db.doc(`times/${id}`);
const amistosoRef = (db: Firestore, timeId: string, id: string) => db.doc(`times/${timeId}/${SUB_AMISTOSOS}/${id}`);

const pegarChave = async (db: Firestore, uid: string, timeId: string): Promise<Resultado> => {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const chave = gerarChave();
    const resultado = await db.runTransaction(async (tx): Promise<Resultado | "repetida"> => {
      const [time, ocupada] = await tx.getAll(timeRef(db, timeId), db.doc(`${COLECAO_CHAVES}/${chave}`));
      if (!time.exists || time.get("donoId") !== uid) return negar(403, "nao-dono", "Só o dono vê a chave do time.");
      const atual = normalizarChave(time.get("chave"));
      if (atual) return { ok: true, body: { chave: atual } };
      if (ocupada.exists) return "repetida";
      // donoId: a exclusão de conta acha e apaga as chaves dos times da pessoa.
      tx.create(db.doc(`${COLECAO_CHAVES}/${chave}`), { timeId, donoId: uid, criadoEm: FieldValue.serverTimestamp() });
      tx.update(timeRef(db, timeId), { chave });
      return { ok: true, body: { chave } };
    });
    if (resultado !== "repetida") return resultado;
  }
  throw new Error("chave: muitas colisões");
};

const buscar = async (db: Firestore, uid: string, chave: string): Promise<Resultado> => {
  const ref = await db.doc(`${COLECAO_CHAVES}/${chave}`).get();
  const timeId = ref.exists ? ref.get("timeId") : null;
  const time = typeof timeId === "string" ? await timeRef(db, timeId).get() : null;
  // Chave de time apagado (ou trocada) = não encontrado.
  if (!time?.exists || time.get("chave") !== chave) return negar(404, "nao-encontrado", "Nenhum time com essa chave.");
  return { ok: true, body: { time: timePublico(time.id, time.data() ?? {}, uid) } };
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
    const pendentes = await tx.get(db.collection(`times/${p.timeId}/${SUB_AMISTOSOS}`).where("status", "==", "pendente").limit(50));
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
    return { ok: true as const, doc, donoAdversario };
  });
  if (!resultado.ok) return resultado;
  await avisar(db, resultado.donoAdversario, id, "novo", avisoDeAmistoso("novo", { ...resultado.doc, quando: Timestamp.fromMillis(quando) }, resultado.doc.de, p.adversarioId));
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
): Promise<Resultado | { ok: true; amistoso: Doc; outro: Doc; outroDono: string; status: StatusAmistoso }> =>
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
    return { ok: true as const, amistoso, outro, outroDono: String(outroTime.get("donoId") ?? ""), status };
  });

const responder = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_responder" }>): Promise<Resultado> => {
  const r = await mudarStatus(db, uid, p.timeId, p.amistosoId, (meu, a) => motivoParaNaoResponder(uid, Date.now(), p.timeId, meu, a), () => (p.aceitar ? "aceito" : "recusado"));
  if (!r.ok || !("amistoso" in r)) return r;
  const evento: EventoAmistoso = p.aceitar ? "aceito" : "recusado";
  await avisar(db, r.outroDono, p.amistosoId, evento, avisoDeAmistoso(evento, r.amistoso, r.amistoso.para as Doc, String(r.outro.timeId)));
  return { ok: true, body: { status: r.status } };
};

const cancelar = async (db: Firestore, uid: string, p: Extract<AmistosoRequest, { action: "amistoso_cancelar" }>): Promise<Resultado> => {
  const r = await mudarStatus(db, uid, p.timeId, p.amistosoId, (meu, a) => motivoParaNaoCancelar(uid, Date.now(), p.timeId, meu, a), () => "cancelado");
  if (!r.ok || !("amistoso" in r)) return r;
  const eu = (r.amistoso.de as Doc)?.timeId === p.timeId ? (r.amistoso.de as Doc) : (r.amistoso.para as Doc);
  await avisar(db, r.outroDono, p.amistosoId, "cancelado", avisoDeAmistoso("cancelado", r.amistoso, eu, String(r.outro.timeId)));
  return { ok: true, body: { status: "cancelado" } };
};

/**
 * O time vai sumir (o dono apaga, ou a conta é excluída): os amistosos em aberto viram "cancelado" na cópia do adversário
 * e a chave é apagada. A cópia do próprio time some junto com o time. Idempotente.
 */
export const encerrarAmistososDoTime = async (db: Firestore, timeId: string): Promise<number> => {
  const abertos = await db.collection(`times/${timeId}/${SUB_AMISTOSOS}`).where("status", "in", ["pendente", "aceito"]).get();
  let cancelados = 0;
  for (const doc of abertos.docs) {
    const outroId = String(outroLado(doc.data(), timeId).timeId ?? "");
    const mudanca = { status: "cancelado", canceladoPor: timeId, respondidoEm: FieldValue.serverTimestamp(), atualizadoEm: FieldValue.serverTimestamp() };
    const lote = db.batch();
    lote.update(doc.ref, mudanca);
    if (TIME_ID.test(outroId)) {
      const outra = await amistosoRef(db, outroId, doc.id).get();
      if (outra.exists) lote.update(outra.ref, mudanca);
    }
    await lote.commit();
    cancelados += 1;
  }
  const chaves = await db.collection(COLECAO_CHAVES).where("timeId", "==", timeId).get();
  for (const chave of chaves.docs) await chave.ref.delete();
  return cancelados;
};

const encerrar = async (db: Firestore, uid: string, timeId: string): Promise<Resultado> => {
  const time = await timeRef(db, timeId).get();
  // Já apagado: o id do time começa com o uid do dono (`uid_1`, `uid_2`).
  const ehDono = time.exists ? time.get("donoId") === uid : timeId.startsWith(`${uid}_`);
  if (!ehDono) return negar(403, "nao-dono", "Só o dono encerra o time.");
  return { ok: true, body: { cancelados: await encerrarAmistososDoTime(db, timeId) } };
};

export const executarAmistoso = (db: Firestore, uid: string, pedido: AmistosoRequest): Promise<Resultado> => {
  switch (pedido.action) {
    case "time_chave":
      return pegarChave(db, uid, pedido.timeId);
    case "time_buscar":
      return buscar(db, uid, pedido.chave);
    case "amistoso_propor":
      return propor(db, uid, pedido);
    case "amistoso_responder":
      return responder(db, uid, pedido);
    case "amistoso_cancelar":
      return cancelar(db, uid, pedido);
    case "time_encerrar":
      return encerrar(db, uid, pedido.timeId);
  }
};
