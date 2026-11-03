import { createHash, randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldPath, getFirestore, type DocumentReference, type Firestore, type Query } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import {
  EXPO_CONEXOES_MAX, EXPO_TIMEOUT_MS, QUERY_IN_LIMIT, type PushDraft, type PushResult,
  buildMessages, chunk, emParalelo, isValidPushToken, sendExpoPush, tokenDocId, tokenNoPrazo,
} from "./push";
import { COLECAO_RECIBOS, enviarAviso, reciboPendente } from "./pushEnvio";
import { dentroDoLimite } from "./rateLimit";

/**
 * Notificações do painel para os usuários do app (Tugyn APP › Notificações): POST /api/version?resource=notificacoes, só `admin`.
 *  - locais     { atualizar? }                     cidades (e estados) dos usuários cadastrados, com quantos usuários há em cada
 *  - enviar     { envioId, titulo, texto, alvo }   cria a campanha (ou retoma a mesma) e avança o que couber nesta chamada
 *  - progresso  { envioId }                        avança mais um pedaço e devolve a situação (o painel chama enquanto não termina)
 *  - historico  { antesDe? }                       os envios, do mais recente, 20 por vez
 *  - teste      { titulo, texto }                  manda só para os aparelhos do próprio administrador
 *
 * CAMPANHA DURÁVEL: `notificacoesGerais/{envioId}` guarda a mensagem, o público, a fase e os totais; `lotes/` guarda até 100
 * aparelhos cada, com o resultado de CADA aparelho. Cada chamada (do painel ou da rotina protegida de /api/push) avança com prazo:
 *  1. preparando: lê o público em páginas (cursor), grava os lotes da página e o cursor na MESMA transação;
 *  2. enviando: reserva um lote (lease), envia só os aparelhos ainda sem resultado e grava resultado + tickets de recibo + totais
 *     na MESMA transação. Aceito nunca é reenviado; falha transitória volta com espera (até 3 tentativas); resultado incerto
 *     (rede caiu sem resposta, ou a chamada morreu no meio do envio) fica incerto e NÃO é reenviado;
 *  3. concluido: enviado | parcial | incerto | sem-aparelhos | excedeu-limite.
 * O mesmo envioId com outra mensagem ou outro destino é recusado (409). Quem desligou "Avisos de turma" não tem token e não
 * recebe; contas suspensas ou em exclusão também não.
 */

export const TITULO_MAX = 60;
export const TEXTO_MAX = 180;
/** Teto de aparelhos por campanha: passou disso, a campanha termina antes de enviar qualquer coisa. */
export const MAX_DISPOSITIVOS = 5000;
export const LOCAIS_VALIDADE_MS = 24 * 3600_000;
export const LOCAIS_ATUALIZAR_MIN_MS = 10 * 60_000;
const LOCAIS_DOC = "adminCache/locaisUsuarios";
const CAMPANHAS = "notificacoesGerais";
const LOTE_TAMANHO = 100;
const PAGINA_USUARIOS = 300;
const PAGINA_LOCAIS = 1000;
const MAX_TENTATIVAS = 3;
const ESPERA_RETRY_MS = 30_000;
const LEASE_MS = 60_000;
/** Quanto cada chamada trabalha antes de responder (o painel chama de novo). */
export const PRAZO_PASSO_MS = 20_000;
/** Um lote só começa se ainda houver tempo para a resposta do Expo e para gravar o resultado. */
const FOLGA_ENVIO_MS = EXPO_TIMEOUT_MS + 4_000;

const UFS = new Set(["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]);
const CITY_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*_([a-z]{2})$/;
const ENVIO_ID = /^[A-Za-z0-9-]{16,64}$/;

export interface Local { cityId: string; cidade: string; uf: string; usuarios: number }
export interface Locais { geradoEm: number; locais: Local[]; semCidade: number; total: number; atualizando?: boolean }
export type Alvo = { tipo: "todos" } | { tipo: "estado"; uf: string } | { tipo: "cidade"; cityId: string };
export interface Mensagem { titulo: string; texto: string }
type Fase = "preparando" | "enviando" | "concluido";
export type ResultadoFinal = "enviado" | "parcial" | "incerto" | "sem-aparelhos" | "excedeu-limite";
type Saida = "accepted" | "invalid" | "failed" | "uncertain";

interface Campanha {
  schema: 2;
  adminUid: string;
  titulo: string;
  texto: string;
  alvo: Alvo & { rotulo: string };
  payloadHash: string;
  fase: Fase;
  resultado?: ResultadoFinal;
  cursor: string | null;
  pagina: number;
  usuarios: number;
  dispositivos: number;
  aceitos: number;
  falhas: number;
  incertos: number;
  owner: string;
  leaseUntil: number;
  criadoEm: number;
  atualizadoEm: number;
  concluidoEm?: number;
}

interface Lote {
  tokens: Record<string, { token: string; updatedAt: number | null }>;
  outcomes: Record<string, Saida>;
  tries: Record<string, number>;
  estado: "pendente" | "enviando" | "concluido";
  nextAttemptAt: number;
  owner: string;
  leaseUntil: number;
  envios: number;
  enviadoEm?: number;
}

export class Recusa extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** "palmas_to" → "TO" (null se o id não tem o formato do app ou o estado não existe). */
export const ufDoCityId = (cityId: unknown): string | null => {
  if (typeof cityId !== "string" || cityId.length > 80) return null;
  const uf = CITY_ID.exec(cityId)?.[1].toUpperCase();
  return uf && UFS.has(uf) ? uf : null;
};

const limpo = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= 1 && t.length <= max ? t : null;
};

export const parseMensagem = (body: Record<string, unknown>): Mensagem | null => {
  const titulo = limpo(body.titulo, TITULO_MAX);
  const texto = limpo(body.texto, TEXTO_MAX);
  return titulo && texto ? { titulo, texto } : null;
};

export const parseAlvo = (raw: unknown): Alvo | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (a.tipo === "todos") return { tipo: "todos" };
  if (a.tipo === "estado" && typeof a.uf === "string" && UFS.has(a.uf)) return { tipo: "estado", uf: a.uf };
  if (a.tipo === "cidade" && ufDoCityId(a.cityId)) return { tipo: "cidade", cityId: a.cityId as string };
  return null;
};

/** Identidade do conteúdo: o mesmo envioId só vale para a mesma mensagem e o mesmo destino (já normalizados). */
export const hashDoPedido = (alvo: Alvo, msg: Mensagem): string =>
  createHash("sha256").update(JSON.stringify([msg.titulo, msg.texto, alvo.tipo, alvo.tipo === "estado" ? alvo.uf : alvo.tipo === "cidade" ? alvo.cityId : ""])).digest("hex").slice(0, 32);

const ativa = (status: unknown, excluindoEm: unknown): boolean => status !== "suspended" && excluindoEm == null;

// ───────────────────────────── lista de locais (só para a tela; não decide quem recebe) ─────────────────────────────

export const agruparLocais = (perfis: ReadonlyArray<{ status?: unknown; excluindoEm?: unknown; location?: unknown }>, agora: number): Locais => {
  const porCidade = new Map<string, Local>();
  let semCidade = 0;
  let total = 0;
  for (const p of perfis) {
    if (!ativa(p.status, p.excluindoEm)) continue;
    total++;
    const loc = typeof p.location === "object" && p.location !== null ? (p.location as Record<string, unknown>) : {};
    const uf = ufDoCityId(loc.cityId);
    if (!uf) { semCidade++; continue; }
    const cityId = loc.cityId as string;
    const atual = porCidade.get(cityId);
    if (atual) atual.usuarios++;
    else porCidade.set(cityId, { cityId, cidade: limpo(loc.city, 60) ?? cityId.slice(0, -3).replace(/_/g, " "), uf, usuarios: 1 });
  }
  const locais = [...porCidade.values()].sort((a, b) => a.uf.localeCompare(b.uf) || a.cidade.localeCompare(b.cidade, "pt-BR"));
  return { geradoEm: agora, locais, semCidade, total };
};

/** Lê uma coleção inteira em páginas (cursor pelo id): memória limitada por página. */
async function lerEmPaginas(base: Query, tamanho: number, porPagina: (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => void | Promise<void>): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    let q = base.orderBy(FieldPath.documentId()).limit(tamanho);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    await porPagina(snap.docs);
    if (snap.docs.length < tamanho) return;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
}

/**
 * Cópia guardada (24 h) ou uma leitura nova dos perfis. Só UMA reconstrução por vez (reserva no próprio documento): quem chega
 * durante a reconstrução recebe a cópia anterior marcada como `atualizando` (ou um pedido para tentar de novo, se não houver cópia).
 */
export async function lerLocais(db: Firestore, atualizar: boolean, agora = Date.now()): Promise<Locais> {
  const ref = db.doc(LOCAIS_DOC);
  const decisao = await db.runTransaction(async (tx) => {
    const guardado = (await tx.get(ref)).data() as (Locais & { reconstruindoAte?: number }) | undefined;
    const idade = guardado && Array.isArray(guardado.locais) ? agora - Number(guardado.geradoEm ?? 0) : Infinity;
    if (idade < LOCAIS_ATUALIZAR_MIN_MS || (!atualizar && idade < LOCAIS_VALIDADE_MS)) return { usar: guardado };
    if (Number(guardado?.reconstruindoAte ?? 0) > agora) return { usar: guardado, ocupado: true };
    tx.set(ref, { reconstruindoAte: agora + LEASE_MS }, { merge: true });
    return { reconstruir: true };
  });
  if (!decisao.reconstruir) {
    if (decisao.usar && Array.isArray(decisao.usar.locais)) {
      const { geradoEm, locais, semCidade, total } = decisao.usar;
      return { geradoEm, locais, semCidade, total, ...(decisao.ocupado ? { atualizando: true } : {}) };
    }
    throw new Recusa(503, "A lista de locais está sendo montada. Tente de novo em alguns segundos.");
  }
  const perfis: Array<Record<string, unknown>> = [];
  try {
    await lerEmPaginas(db.collection("users").select("status", "excluindoEm", "location"), PAGINA_LOCAIS, (docs) => { for (const d of docs) perfis.push(d.data()); });
  } catch (erro) {
    await ref.set({ reconstruindoAte: 0 }, { merge: true }).catch(() => undefined);
    throw erro;
  }
  const locais = agruparLocais(perfis, agora);
  await ref.set({ ...locais, reconstruindoAte: 0 });
  return locais;
}

export const rotuloDoAlvo = (alvo: Alvo): string =>
  alvo.tipo === "todos" ? "Todos os usuários" : alvo.tipo === "estado" ? `Estado: ${alvo.uf}` : `Cidade: ${alvo.cityId}`;

// ───────────────────────────── campanha ─────────────────────────────

export interface Progresso {
  envioId: string;
  fase: Fase;
  resultado: ResultadoFinal | null;
  titulo: string;
  texto: string;
  alvo: string;
  usuarios: number;
  dispositivos: number;
  aceitos: number;
  falhas: number;
  incertos: number;
  pendentes: number;
  criadoEm: number;
  repetido?: boolean;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Documento → situação para o painel. Documentos do formato antigo (sem lotes) aparecem como concluídos. */
export const progressoDe = (envioId: string, x: Record<string, unknown>): Progresso => {
  const alvo = (x.alvo ?? {}) as { rotulo?: unknown };
  const base = { envioId, titulo: String(x.titulo ?? ""), texto: String(x.texto ?? ""), alvo: String(alvo.rotulo ?? ""), usuarios: n(x.usuarios), dispositivos: n(x.dispositivos), aceitos: n(x.aceitos), criadoEm: n(x.criadoEm) };
  if (x.schema !== 2) {
    const enviado = x.estado === "enviado";
    return { ...base, fase: "concluido", resultado: enviado ? (n(x.falhas) ? "parcial" : "enviado") : "incerto", falhas: n(x.falhas), incertos: enviado ? 0 : base.dispositivos, pendentes: 0 };
  }
  const fase: Fase = x.fase === "preparando" || x.fase === "enviando" ? x.fase : "concluido";
  const falhas = n(x.falhas);
  const incertos = n(x.incertos);
  return {
    ...base, fase, falhas, incertos,
    resultado: fase === "concluido" ? ((["enviado", "parcial", "incerto", "sem-aparelhos", "excedeu-limite"] as const).find((r) => r === x.resultado) ?? "incerto") : null,
    pendentes: fase === "concluido" ? 0 : Math.max(base.dispositivos - base.aceitos - falhas - incertos, 0),
  };
};

/** Cria a campanha; com o mesmo id e o mesmo conteúdo, devolve a existente; com outro conteúdo, recusa (409). */
export async function criarCampanha(db: Firestore, adminUid: string, envioId: string, alvo: Alvo, msg: Mensagem, agora: number): Promise<{ repetido: boolean }> {
  const ref = db.doc(`${CAMPANHAS}/${envioId}`);
  const payloadHash = hashDoPedido(alvo, msg);
  return db.runTransaction(async (tx) => {
    const atual = await tx.get(ref);
    if (atual.exists) {
      if (atual.get("payloadHash") !== payloadHash) throw new Recusa(409, "Este identificador de envio já foi usado com outra mensagem ou outro destino. Recarregue a página e confira o histórico.");
      return { repetido: true };
    }
    const campanha: Campanha = {
      schema: 2, adminUid, titulo: msg.titulo, texto: msg.texto, alvo: { ...alvo, rotulo: rotuloDoAlvo(alvo) }, payloadHash,
      fase: "preparando", cursor: null, pagina: 0, usuarios: 0, dispositivos: 0, aceitos: 0, falhas: 0, incertos: 0,
      owner: "", leaseUntil: 0, criadoEm: agora, atualizadoEm: agora,
    };
    tx.create(ref, campanha);
    return { repetido: false };
  });
}

/** O público em páginas, direto dos perfis atuais (nunca da lista de locais): estado = cityId terminando com a UF. */
const consultaDoPublico = (db: Firestore, alvo: Alvo): Query => {
  const users = db.collection("users");
  if (alvo.tipo === "cidade") return users.where("location.cityId", "==", alvo.cityId).select("status", "excluindoEm");
  return users.select("status", "excluindoEm", "location.cityId");
};

const loteId = (pagina: number, k: number): string => `${String(pagina).padStart(6, "0")}_${String(k).padStart(2, "0")}`;

/** Prepara páginas do público até o prazo. Cada página é gravada (lotes + cursor + totais) numa transação só. */
async function preparar(db: Firestore, ref: DocumentReference, prazo: number, agora: () => number): Promise<void> {
  const owner = randomUUID();
  const reservada = await db.runTransaction(async (tx) => {
    const c = (await tx.get(ref)).data() as Campanha | undefined;
    if (!c || c.fase !== "preparando" || c.leaseUntil > agora()) return null;
    tx.update(ref, { owner, leaseUntil: agora() + LEASE_MS });
    return c;
  });
  if (!reservada) return;
  const alvo = reservada.alvo;
  let { cursor, pagina } = reservada;

  while (Date.now() < prazo) {
    let q = consultaDoPublico(db, alvo).orderBy(FieldPath.documentId()).limit(PAGINA_USUARIOS);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    const uids = snap.docs
      .filter((d) => ativa(d.get("status"), d.get("excluindoEm")))
      .filter((d) => alvo.tipo !== "estado" || ufDoCityId(d.get("location.cityId")) === alvo.uf)
      .map((d) => d.id);
    const tokens: Array<{ id: string; token: string; updatedAt: number | null }> = [];
    for (const grupo of chunk(uids, QUERY_IN_LIMIT)) {
      const t = await db.collection("pushTokens").where("uid", "in", grupo).select("token", "updatedAt").get();
      for (const d of t.docs) {
        const token = d.get("token");
        if (isValidPushToken(token) && tokenNoPrazo(d.get("updatedAt"), agora())) tokens.push({ id: tokenDocId(token), token, updatedAt: typeof d.get("updatedAt") === "number" ? d.get("updatedAt") : null });
      }
    }
    const ultima = snap.docs.length < PAGINA_USUARIOS;
    const proximoCursor = snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor;
    const ok = await db.runTransaction(async (tx) => {
      const c = (await tx.get(ref)).data() as Campanha | undefined;
      // Fencing: outra chamada assumiu (lease vencido) ou esta página já foi gravada.
      if (!c || c.owner !== owner || c.fase !== "preparando" || c.cursor !== cursor) return false;
      const dispositivos = c.dispositivos + tokens.length;
      const t = agora();
      if (dispositivos > MAX_DISPOSITIVOS) {
        tx.update(ref, { fase: "concluido", resultado: "excedeu-limite", dispositivos, usuarios: c.usuarios + uids.length, leaseUntil: 0, atualizadoEm: t, concluidoEm: t });
        return false;
      }
      chunk(tokens, LOTE_TAMANHO).forEach((parte, k) => {
        const lote: Lote = { tokens: Object.fromEntries(parte.map((x) => [x.id, { token: x.token, updatedAt: x.updatedAt }])), outcomes: {}, tries: {}, estado: "pendente", nextAttemptAt: 0, owner: "", leaseUntil: 0, envios: 0 };
        tx.set(ref.collection("lotes").doc(loteId(pagina, k)), lote);
      });
      const fim = ultima ? (dispositivos === 0 ? { fase: "concluido", resultado: "sem-aparelhos", concluidoEm: t } : { fase: "enviando" }) : {};
      tx.update(ref, { cursor: proximoCursor, pagina: pagina + 1, usuarios: c.usuarios + uids.length, dispositivos, atualizadoEm: t, leaseUntil: ultima ? 0 : t + LEASE_MS, ...fim });
      return true;
    });
    if (!ok || ultima) return;
    cursor = proximoCursor;
    pagina += 1;
  }
  // Prazo acabou no meio: libera a reserva para a próxima chamada continuar do cursor.
  await db.runTransaction(async (tx) => {
    const c = (await tx.get(ref)).data() as Campanha | undefined;
    if (c?.owner === owner && c.fase === "preparando") tx.update(ref, { leaseUntil: 0 });
  });
}

const resultadoFinal = (c: Pick<Campanha, "aceitos" | "falhas" | "incertos" | "dispositivos">): ResultadoFinal =>
  c.dispositivos === 0 ? "sem-aparelhos" : c.incertos > 0 ? "incerto" : c.falhas > 0 ? "parcial" : "enviado";

/** Lote reservado por uma chamada que morreu: o que ficou sem resultado pode ter chegado ao Expo → incerto (nunca reenvia). */
async function encerrarLoteAbandonado(db: Firestore, ref: DocumentReference, loteRef: DocumentReference, agora: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    const [c, l] = await Promise.all([tx.get(ref), tx.get(loteRef)]);
    const lote = l.data() as Lote | undefined;
    if (!c.exists || !lote || lote.estado !== "enviando" || lote.leaseUntil > agora) return;
    const outcomes = { ...lote.outcomes };
    let novos = 0;
    for (const id of Object.keys(lote.tokens)) if (!outcomes[id]) { outcomes[id] = "uncertain"; novos++; }
    tx.update(loteRef, { outcomes, estado: "concluido", leaseUntil: 0 });
    tx.update(ref, { incertos: n(c.get("incertos")) + novos, atualizadoEm: agora });
  });
}

async function enviarLote(
  db: Firestore, ref: DocumentReference, loteRef: DocumentReference, envioId: string, draft: PushDraft,
  agora: () => number, send: typeof sendExpoPush,
): Promise<void> {
  const owner = randomUUID();
  const reservado = await db.runTransaction(async (tx) => {
    const lote = (await tx.get(loteRef)).data() as Lote | undefined;
    if (!lote || lote.estado !== "pendente" || lote.nextAttemptAt > agora()) return null;
    tx.update(loteRef, { estado: "enviando", owner, leaseUntil: agora() + LEASE_MS, enviadoEm: agora() });
    return lote;
  });
  if (!reservado) return;
  const ids = Object.keys(reservado.tokens).filter((id) => !reservado.outcomes[id]);
  const enviadoEm = agora();
  let results: PushResult[];
  try {
    results = await send(buildMessages(ids.map((id) => reservado.tokens[id].token), draft), { accessToken: process.env.EXPO_ACCESS_TOKEN });
  } catch {
    results = ids.map((id) => ({ token: reservado.tokens[id].token, ok: false, invalid: false, uncertain: true, error: "rede" }));
  }
  const porToken = new Map(results.map((r) => [r.token, r]));
  const outcomes = { ...reservado.outcomes };
  const tries = { ...reservado.tries };
  const tickets: Record<string, string> = {};
  const invalidos: string[] = [];
  let aceitos = 0, falhas = 0, incertos = 0, repetir = false;
  for (const id of ids) {
    const r = porToken.get(reservado.tokens[id].token);
    tries[id] = (tries[id] ?? 0) + 1;
    if (r?.ok) { outcomes[id] = "accepted"; aceitos++; if (r.ticketId) tickets[r.ticketId] = id; }
    else if (r?.invalid) { outcomes[id] = "invalid"; falhas++; invalidos.push(id); }
    else if (!r || r.uncertain) { outcomes[id] = "uncertain"; incertos++; }
    else if (r.retryable && tries[id] < MAX_TENTATIVAS) repetir = true;
    else { outcomes[id] = "failed"; falhas++; }
  }
  const maxTry = Math.max(1, ...ids.map((id) => tries[id]));
  // Resultado do lote, tickets de recibo e totais da campanha: uma transação só (sem recibo perdido, sem total desencontrado).
  const gravou = await db.runTransaction(async (tx) => {
    const [c, l] = await Promise.all([tx.get(ref), tx.get(loteRef)]);
    const lote = l.data() as Lote | undefined;
    if (!c.exists || lote?.owner !== owner || lote.estado !== "enviando") return false;
    tx.update(loteRef, {
      outcomes, tries, estado: repetir ? "pendente" : "concluido", owner: "", leaseUntil: 0, envios: (lote.envios ?? 0) + 1,
      nextAttemptAt: repetir ? agora() + ESPERA_RETRY_MS * 2 ** (maxTry - 1) : 0,
    });
    if (Object.keys(tickets).length) tx.set(db.doc(`${COLECAO_RECIBOS}/geral_${envioId}_${loteRef.id}_${lote.envios ?? 0}`), reciboPendente(tickets, `geral:${envioId}`, enviadoEm));
    tx.update(ref, { aceitos: n(c.get("aceitos")) + aceitos, falhas: n(c.get("falhas")) + falhas, incertos: n(c.get("incertos")) + incertos, atualizadoEm: agora() });
    return true;
  });
  if (!gravou) return;
  // Token que o Expo diz não existir mais: apaga só se o cadastro ainda é o mesmo que foi enviado (não um renovado depois).
  for (const id of invalidos) {
    const tokenRef = db.doc(`pushTokens/${id}`);
    await db.runTransaction(async (tx) => {
      const t = await tx.get(tokenRef);
      const atual = t.get("updatedAt");
      if (t.exists && t.get("token") === reservado.tokens[id].token && (typeof atual !== "number" || atual <= enviadoEm)) tx.delete(tokenRef);
    }).catch(() => undefined);
  }
}

async function enviarLotes(db: Firestore, ref: DocumentReference, c: Campanha, envioId: string, prazo: number, agora: () => number, send: typeof sendExpoPush): Promise<void> {
  const draft: PushDraft = { title: c.titulo, body: c.texto, data: { tipo: "aviso_geral", turmaId: "", notificationId: envioId } };
  const abertos = await ref.collection("lotes").where("estado", "in", ["pendente", "enviando"]).limit(60).get();
  const prontos: DocumentReference[] = [];
  for (const d of abertos.docs) {
    const lote = d.data() as Lote;
    if (lote.estado === "enviando" && lote.leaseUntil <= agora()) await encerrarLoteAbandonado(db, ref, d.ref, agora());
    else if (lote.estado === "pendente" && lote.nextAttemptAt <= agora()) prontos.push(d.ref);
  }
  await emParalelo(prontos, EXPO_CONEXOES_MAX, async (loteRef) => {
    if (Date.now() + FOLGA_ENVIO_MS > prazo) return;
    await enviarLote(db, ref, loteRef, envioId, draft, agora, send);
  });
  // Todos os aparelhos com resultado: fecha a campanha.
  await db.runTransaction(async (tx) => {
    const atual = (await tx.get(ref)).data() as Campanha | undefined;
    if (!atual || atual.fase !== "enviando" || atual.aceitos + atual.falhas + atual.incertos < atual.dispositivos) return;
    tx.update(ref, { fase: "concluido", resultado: resultadoFinal(atual), concluidoEm: agora(), atualizadoEm: agora() });
  });
}

/** Campanha concluída: apaga os lotes (eles guardam cópias dos tokens dos aparelhos); ficam só os totais. */
async function apagarLotes(db: Firestore, ref: DocumentReference): Promise<void> {
  const lotes = await ref.collection("lotes").limit(500).get();
  if (lotes.size) {
    const batch = db.batch();
    for (const d of lotes.docs) batch.delete(d.ref);
    await batch.commit();
  }
  if (lotes.size < 500) await ref.update({ lotesApagados: true });
}

/** Avança a campanha até o prazo (preparar → enviar) e devolve a situação. */
export async function avancar(db: Firestore, envioId: string, opcoes: { prazoAte?: number; agora?: () => number; send?: typeof sendExpoPush } = {}): Promise<Progresso> {
  const agora = opcoes.agora ?? Date.now;
  const prazo = opcoes.prazoAte ?? Date.now() + PRAZO_PASSO_MS;
  const ref = db.doc(`${CAMPANHAS}/${envioId}`);
  const ler = async () => (await ref.get()).data() as (Campanha & Record<string, unknown>) | undefined;
  let c = await ler();
  if (!c) throw new Recusa(404, "Envio não encontrado.");
  if (c.schema === 2 && c.fase === "preparando") { await preparar(db, ref, prazo, agora); c = await ler(); }
  if (c && c.schema === 2 && c.fase === "enviando") { await enviarLotes(db, ref, c, envioId, prazo, agora, opcoes.send ?? sendExpoPush); c = await ler(); }
  if (c && c.schema === 2 && c.fase === "concluido" && c.lotesApagados !== true) await apagarLotes(db, ref).catch(() => undefined);
  return progressoDe(envioId, c ?? {});
}

/** Rotina protegida (/api/push GET): retoma campanhas que ninguém está acompanhando no painel. */
export async function avancarCampanhasPendentes(db: Firestore, opcoes: { prazoAte: number; limit?: number }): Promise<Record<string, number>> {
  const snap = await db.collection(CAMPANHAS).where("fase", "in", ["preparando", "enviando"]).limit(opcoes.limit ?? 3).get();
  const counts = { campanhas: snap.size, concluidas: 0, falhas: 0 };
  for (const d of snap.docs) {
    if (Date.now() + FOLGA_ENVIO_MS > opcoes.prazoAte) break;
    try { if ((await avancar(db, d.id, { prazoAte: opcoes.prazoAte })).fase === "concluido") counts.concluidas++; }
    catch { counts.falhas++; }
  }
  return counts;
}

export async function historico(db: Firestore, antesDe?: number): Promise<{ envios: Progresso[]; mais: boolean }> {
  let q = db.collection(CAMPANHAS).orderBy("criadoEm", "desc");
  if (antesDe) q = q.where("criadoEm", "<", antesDe);
  const snap = await q.limit(21).get();
  return { envios: snap.docs.slice(0, 20).map((d) => progressoDe(d.id, d.data())), mais: snap.docs.length > 20 };
}

export async function handleNotificacoes(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "notificacoes");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Somente administradores." });

  const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const acao = body.action;
  if (!["locais", "enviar", "progresso", "historico", "teste"].includes(acao as string)) return res.status(400).json({ error: "Ação inválida." });
  // Criar campanha e testar: poucos por hora. Acompanhar o progresso: o painel chama a cada poucos segundos.
  const [chave, max] = acao === "enviar" || acao === "teste" ? ["notificacoes-enviar", 10] : acao === "progresso" ? ["notificacoes-progresso", 600] : ["notificacoes-ler", 120];
  if (!(await dentroDoLimite(user.uid, chave, max, 3600))) return res.status(429).json({ error: "Muitas requisições. Tente novamente mais tarde." });

  try {
    const db = getFirestore(getFirebaseApp());
    if (acao === "locais") return res.status(200).json(await lerLocais(db, body.atualizar === true));
    if (acao === "historico") return res.status(200).json(await historico(db, typeof body.antesDe === "number" && body.antesDe > 0 ? body.antesDe : undefined));
    if (acao === "teste") {
      const msg = parseMensagem(body);
      if (!msg) return res.status(400).json({ error: `Escreva o título (até ${TITULO_MAX} caracteres) e a mensagem (até ${TEXTO_MAX}).` });
      // Pela fila de avisos (retry e recibos dela). A chave muda a cada minuto: dois cliques seguidos não mandam duas vezes.
      const r = await enviarAviso(db, {
        evento: "aviso_geral_teste", turmaId: "", recipientUids: [user.uid], dedupeUid: user.uid, dedupeMs: 60_000,
        dedupeKey: `aviso_teste_${user.uid}_${hashDoPedido({ tipo: "todos" }, msg).slice(0, 12)}_${Math.floor(Date.now() / 60_000)}`,
        draft: { title: msg.titulo, body: msg.texto, data: { tipo: "aviso_geral", turmaId: "" } },
      });
      return res.status(200).json({ aceitos: r.enviados, motivo: r.motivo ?? null });
    }
    if (typeof body.envioId !== "string" || !ENVIO_ID.test(body.envioId)) return res.status(400).json({ error: "Identificador do envio inválido." });
    if (acao === "progresso") return res.status(200).json(await avancar(db, body.envioId));
    const msg = parseMensagem(body);
    if (!msg) return res.status(400).json({ error: `Escreva o título (até ${TITULO_MAX} caracteres) e a mensagem (até ${TEXTO_MAX}).` });
    const alvo = parseAlvo(body.alvo);
    if (!alvo) return res.status(400).json({ error: "Escolha para quem enviar: todos, um estado ou uma cidade." });
    const { repetido } = await criarCampanha(db, user.uid, body.envioId, alvo, msg, Date.now());
    const progresso = await avancar(db, body.envioId);
    console.log(JSON.stringify({ evt: "notificacao_geral", tipo: alvo.tipo, fase: progresso.fase, dispositivos: progresso.dispositivos, repetido }));
    return res.status(200).json({ ...progresso, ...(repetido ? { repetido: true } : {}) });
  } catch (erro) {
    if (erro instanceof Recusa) return res.status(erro.status).json({ error: erro.message });
    console.error(JSON.stringify({ evt: "notificacoes_falhou", acao, message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível concluir. Tente novamente." });
  }
}
