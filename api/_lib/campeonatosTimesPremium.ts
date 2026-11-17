import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import { getFirebaseApp } from "./auth";
import { RecusaCT, exigirCT, type Dados } from "./campeonatosTimesDominio";
import { contaEmExclusao } from "./suspensao";

/**
 * Campeonato premium (grupos + mata-mata). Cada compra de R$ 29,90 na loja (produto consumível `campeonato_premium`)
 * vira UM crédito, que não expira. Criar um campeonato de grupos + mata-mata gasta 1 crédito na mesma transação da
 * criação; cancelar o campeonato antes do início devolve o crédito. Reembolso feito pela loja retira o crédito ainda não
 * usado (o campeonato já criado com ele continua).
 *
 * REGISTRO GLOBAL, UM DOCUMENTO POR COMPRA: `comprasPremiumCT/{sha256(id da transação da loja)}`. A identidade da compra
 * é SÓ o id da transação da loja (`store_transaction_id` na consulta, `transaction_id` no aviso): as duas fontes caem no
 * mesmo documento, em qualquer ordem e quantas vezes chegarem. Por isso:
 *  - a mesma compra nunca vira crédito em duas contas: fica com a PRIMEIRA conta que a registrou (transferência entre
 *    contas, se um dia for preciso, só pelo suporte);
 *  - compra sem o id da loja (só o id interno do RevenueCat) não é creditada pela consulta; o aviso da loja completa;
 *  - reembolso que chega antes da compra fica registrado e a compra atrasada não libera crédito;
 *  - na exclusão da conta, os registros perdem o vínculo com a conta (uid e dados da compra saem) mas o documento fica,
 *    sem dados pessoais, para um aviso atrasado não recriar o crédito; compra de conta inexistente ou em exclusão também
 *    vira esse registro vazio.
 *
 * Estados: "disponivel" | "usado" | "reembolsado" | "sem_conta" (conta excluída ou inexistente: nunca credita).
 * Campos: { uid | null, estado, loja, sandbox, compradoEm, origem, campeonatoId, usadoEm?, devolvidoEm?, reembolsadoEm?, criadoEm }.
 *
 * Variáveis da Vercel: REVENUECAT_SECRET_KEY (consulta), REVENUECAT_WEBHOOK_AUTH (o mesmo valor configurado como
 * "Authorization header" do webhook no RevenueCat) e, só para testes com compras de teste, REVENUECAT_PERMITIR_SANDBOX=sim.
 */
export const PRODUTO_PREMIUM_CT = "campeonato_premium";
export const COLECAO_COMPRAS_CT = "comprasPremiumCT";
/**
 * Fase de testes: grupos + mata-mata liberado para todas as contas, sem gastar crédito. Troque para `false` quando a
 * versão do app com a compra estiver nas lojas (o app lê pela ação "recursos" e passa a mostrar a compra).
 */
export const PREMIUM_CT = { gruposParaTodos: false };

const ID_TRANSACAO = /^[A-Za-z0-9._:-]{4,200}$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const compras = (db: Firestore) => db.collection(COLECAO_COMPRAS_CT);
/** Mesmo documento para a mesma transação da loja, venha da consulta ou do aviso, para qualquer conta. */
export const refCompraCT = (db: Firestore, transacao: string): DocumentReference => compras(db).doc(createHash("sha256").update(transacao).digest("hex").slice(0, 40));
const sandboxPermitido = (): boolean => process.env.REVENUECAT_PERMITIR_SANDBOX === "sim";
const LIMITE_SALDO = 200;

/** Liberação administrativa por conta (homologação), com validade opcional. */
async function liberacaoValida(tx: Transaction, db: Firestore, uid: string, agora: number): Promise<boolean> {
  const s = await tx.get(db.doc(`liberacoesCampeonatosTimes/${uid}`));
  return s.get("gruposMata") === true && (s.get("expiraEm") == null || Number(s.get("expiraEm")) > agora);
}

/** Créditos disponíveis da conta (para a tela de criação). Na fase gratuita não consulta nada. */
export async function creditosDisponiveisCT(db: Firestore, uid: string): Promise<number> {
  if (PREMIUM_CT.gruposParaTodos) return 0;
  return (await compras(db).where("uid", "==", uid).where("estado", "==", "disponivel").limit(LIMITE_SALDO).get()).size;
}

/**
 * Dentro da transação da criação, ANTES de qualquer gravação: confere se a conta pode criar grupos + mata-mata
 * (todos liberados, liberação da conta ou 1 crédito). Devolve a função que grava o gasto (chamar junto das gravações).
 */
export async function reservarPremiumCT(tx: Transaction, db: Firestore, uid: string, campeonatoId: string, agora: number): Promise<{ creditoId: string | null; gravar: () => void }> {
  if (PREMIUM_CT.gruposParaTodos || await liberacaoValida(tx, db, uid, agora)) return { creditoId: null, gravar: () => undefined };
  const livre = await tx.get(compras(db).where("uid", "==", uid).where("estado", "==", "disponivel").limit(1));
  if (livre.empty) throw new RecusaCT(402, "Grupos + mata-mata é do Campeonato premium. Compre um crédito para criar este campeonato.", "premium_necessario");
  const s = livre.docs[0]!;
  return { creditoId: s.id, gravar: () => tx.update(s.ref, { estado: "usado", campeonatoId, usadoEm: agora }) };
}

/**
 * Cancelamento antes do início: lê o crédito gasto (antes das gravações) e devolve a função que o deixa disponível de
 * novo. Crédito reembolsado pela loja, ou de outra conta, não volta.
 */
export async function lerDevolucaoPremiumCT(tx: Transaction, db: Firestore, camp: Dados, campeonatoId: string, agora: number): Promise<() => void> {
  const creditoId = typeof camp.creditoPremium === "string" ? camp.creditoPremium : "";
  const dono = typeof camp.organizadorId === "string" ? camp.organizadorId : "";
  if (!creditoId || !dono || camp.status !== "inscricoes") return () => undefined;
  const ref = compras(db).doc(creditoId), s = await tx.get(ref);
  if (!s.exists || s.get("uid") !== dono || s.get("estado") !== "usado" || s.get("campeonatoId") !== campeonatoId || s.get("reembolsadoEm")) return () => undefined;
  return () => tx.update(ref, { estado: "disponivel", campeonatoId: null, devolvidoEm: agora });
}

export interface CompraLoja { transacao: string; loja: string; sandbox: boolean; compradoEm: number }
export type ResultadoCompra = "creditado" | "repetido" | "outra_conta" | "ja_reembolsado" | "sem_conta" | "sandbox";

/**
 * Registra uma compra (idempotente pela transação da loja). Só credita se o registro ainda não existe e a conta existe
 * e não está sendo excluída. Qualquer outro caso não muda o saldo de ninguém.
 */
export async function creditarCompraCT(db: Firestore, uid: string, compra: CompraLoja, origem: "app" | "webhook", agora = Date.now()): Promise<ResultadoCompra> {
  exigirCT(UID.test(uid), "Conta inválida.");
  exigirCT(ID_TRANSACAO.test(compra.transacao), "Compra inválida.");
  if (compra.sandbox && !sandboxPermitido()) return "sandbox";
  const ref = refCompraCT(db, compra.transacao);
  const resultado = await db.runTransaction(async (tx): Promise<ResultadoCompra> => {
    const [atual, perfil] = await tx.getAll(ref, db.doc(`users/${uid}`));
    if (atual.exists) {
      const estado = atual.get("estado");
      if (estado === "reembolsado" && !atual.get("uid")) return "ja_reembolsado";
      if (estado === "sem_conta") return "sem_conta";
      return atual.get("uid") === uid ? "repetido" : "outra_conta";
    }
    if (!perfil.exists || contaEmExclusao(perfil.data())) {
      // Registro vazio (sem conta e sem dados da compra): um aviso repetido depois também não credita.
      tx.create(ref, { uid: null, estado: "sem_conta", criadoEm: agora });
      return "sem_conta";
    }
    tx.create(ref, { uid, estado: "disponivel", loja: compra.loja.slice(0, 30), sandbox: compra.sandbox, compradoEm: compra.compradoEm || agora, origem, campeonatoId: null, criadoEm: agora });
    return "creditado";
  });
  if (resultado === "outra_conta") console.warn(JSON.stringify({ evt: "premium_compra_outra_conta", origem }));
  return resultado;
}

/**
 * Reembolso pela loja, localizado pela transação (não pela conta do aviso). Crédito disponível sai; já usado fica marcado
 * (o campeonato continua). Se a compra ainda não chegou, o reembolso fica registrado e a compra atrasada não credita.
 */
export async function reembolsarCompraCT(db: Firestore, transacao: string, agora = Date.now()): Promise<void> {
  if (!ID_TRANSACAO.test(transacao)) return;
  const ref = refCompraCT(db, transacao);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) { tx.create(ref, { uid: null, estado: "reembolsado", reembolsadoEm: agora, criadoEm: agora }); return; }
    if (s.get("reembolsadoEm") || s.get("estado") === "sem_conta") return;
    tx.update(ref, { reembolsadoEm: agora, ...(s.get("estado") === "disponivel" ? { estado: "reembolsado" } : {}) });
  });
}

type Buscar = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Depois de comprar, o app pede para conferir: a API consulta o RevenueCat SÓ para a conta logada e registra as compras
 * do produto premium que têm o id da transação da loja. Lê de uma vez quais já estão registradas e só abre transação
 * para as novas. Devolve os créditos disponíveis.
 */
export async function sincronizarCreditosCT(db: Firestore, uid: string, buscar: Buscar = fetch as unknown as Buscar, agora = Date.now()): Promise<{ creditos: number; novos: number }> {
  const chave = process.env.REVENUECAT_SECRET_KEY;
  exigirCT(Boolean(chave), "A compra ainda não está disponível. Tente mais tarde.", 503);
  const r = await buscar(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, { headers: { Authorization: `Bearer ${chave}`, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  exigirCT(r.ok, "Não foi possível conferir a compra agora. Tente de novo em instantes.", 503);
  const corpo = (await r.json()) as { subscriber?: { non_subscriptions?: Record<string, unknown> } };
  const lista = corpo?.subscriber?.non_subscriptions?.[PRODUTO_PREMIUM_CT];
  // Só compras com o id da transação da loja (a mesma identidade do aviso). As mais recentes primeiro.
  const itens = (Array.isArray(lista) ? lista : []).map((x) => (x ?? {}) as Dados)
    .filter((c) => typeof c.store_transaction_id === "string" && ID_TRANSACAO.test(c.store_transaction_id))
    .reverse().slice(0, 50);
  const existentes = itens.length ? await db.getAll(...itens.map((c) => refCompraCT(db, c.store_transaction_id as string))) : [];
  let novos = 0;
  for (const [k, c] of itens.entries()) {
    if (existentes[k]?.exists) continue;
    const quando = typeof c.purchase_date === "string" ? Date.parse(c.purchase_date) : NaN;
    const res = await creditarCompraCT(db, uid, { transacao: c.store_transaction_id as string, loja: typeof c.store === "string" ? c.store : "", sandbox: c.is_sandbox === true, compradoEm: Number.isFinite(quando) ? quando : agora }, "app", agora);
    if (res === "creditado") novos += 1;
  }
  return { creditos: await creditosDisponiveisCT(db, uid), novos };
}

/** Confere o cabeçalho do webhook em tempo constante (valor com pelo menos 24 caracteres). */
export function webhookAutorizado(cabecalho: unknown, esperado = process.env.REVENUECAT_WEBHOOK_AUTH ?? ""): boolean {
  if (typeof cabecalho !== "string" || esperado.length < 24) return false;
  const a = createHash("sha256").update(cabecalho).digest(), b = createHash("sha256").update(esperado).digest();
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Um aviso do RevenueCat: compra avulsa registra; cancelamento (reembolso) retira. Outros tipos são ignorados. */
export async function processarAvisoLojaCT(db: Firestore, evento: Dados, agora = Date.now()): Promise<ResultadoCompra | "reembolsado" | "ignorado"> {
  const transacao = typeof evento.transaction_id === "string" ? evento.transaction_id : "";
  if (evento.product_id !== PRODUTO_PREMIUM_CT || !ID_TRANSACAO.test(transacao)) return "ignorado";
  // Reembolso vale pela transação, qualquer que seja a conta do aviso (inclusive anônima ou com alias).
  if (evento.type === "CANCELLATION") { await reembolsarCompraCT(db, transacao, agora); return "reembolsado"; }
  const uid = typeof evento.app_user_id === "string" ? evento.app_user_id : "";
  if (evento.type !== "NON_RENEWING_PURCHASE" || !UID.test(uid)) return "ignorado";
  return creditarCompraCT(db, uid, { transacao, loja: typeof evento.store === "string" ? evento.store : "", sandbox: evento.environment === "SANDBOX", compradoEm: Number(evento.purchased_at_ms) || agora }, "webhook", agora);
}

/** POST /api/version?resource=loja-webhook (sem login: autenticado pelo cabeçalho combinado com o RevenueCat). */
export async function handleWebhookLoja(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Método não permitido." }); }
  if (!webhookAutorizado(req.headers.authorization)) return res.status(401).json({ error: "Não autorizado." });
  const corpo = (req.body && typeof req.body === "object" ? req.body : {}) as Dados;
  const evento = (corpo.event && typeof corpo.event === "object" ? corpo.event : {}) as Dados;
  try {
    const resultado = await processarAvisoLojaCT(getFirestore(getFirebaseApp()), evento);
    return res.status(200).json({ ok: true, resultado });
  } catch (erro) {
    if (erro instanceof RecusaCT) return res.status(200).json({ ok: true, resultado: "ignorado" });
    console.error(JSON.stringify({ evt: "loja_webhook_falhou", code: typeof (erro as { code?: unknown })?.code === "string" ? (erro as { code: string }).code.slice(0, 60) : "interno" }));
    // 5xx: o RevenueCat tenta de novo depois.
    return res.status(503).json({ error: "Tente novamente." });
  }
}

/**
 * Exclusão da conta: os registros de compra perdem o vínculo com a conta e os dados da compra (fica só o estado, sem
 * dados pessoais), e créditos não usados deixam de valer. O documento continua para um aviso atrasado da mesma compra
 * não recriar crédito nem histórico. A exclusão grava `excluindoEm` antes, então nenhuma compra nova nasce no meio.
 */
export async function excluirCreditosCT(db: Firestore, uid: string): Promise<void> {
  for (;;) {
    const pagina = await compras(db).where("uid", "==", uid).limit(200).get();
    if (pagina.empty) break;
    const lote = db.batch();
    pagina.docs.forEach((s) => lote.set(s.ref, { uid: null, estado: "sem_conta", criadoEm: Number(s.get("criadoEm") ?? 0) }));
    await lote.commit();
  }
}
