import { createHash } from "node:crypto";
import type { VercelResponse } from "@vercel/node";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
import { type ErrosSolicitacao, validarSolicitacao } from "./solicitacaoCore";
import { comHistorico, gerarCodigo } from "./contratos";
import { Conflito, NaoEncontrado, prepararContrato, responder } from "./contratosComuns";

/**
 * Solicitações de quem quer anunciar, vindas da página pública. Fica numa coleção À PARTE (`solicitacoes`), separada dos contratos:
 * o administrador aprova (vira um contrato comum, com link exclusivo) ou exclui. Ninguém grava nessa coleção pelo app: só o servidor.
 */
export const SOLICITACOES = "solicitacoes";
/** Teto de pedidos pendentes: protege o painel (e a cota do plano gratuito) de uma enxurrada de pedidos falsos. */
export const MAX_PENDENTES = 200;
/** Quem preenche 3 campos leva mais que isso; um robô é instantâneo. */
export const TEMPO_MINIMO_MS = 2000;

/**
 * Limites de pedidos ACEITOS. Ficam no Firestore (não dependem de Upstash nem de nenhum serviço externo) e valem mesmo depois de o
 * administrador excluir o pedido. Por aparelho/rede (IP), por WhatsApp e por e-mail.
 */
export const LIMITES = { ipHora: 3, ipDia: 10, whatsappDia: 2, emailDia: 2, pendentesPorIp: 5 } as const;
export const LIMITES_COLECAO = "solicitacoesLimites";
const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

const MENSAGEM = {
  ip: "Muitos pedidos deste aparelho ou desta rede em pouco tempo. Tente novamente mais tarde.",
  whatsapp: "Já recebemos pedidos com este WhatsApp hoje. A equipe da Tugyn ADS vai falar com você; se precisar, tente de novo amanhã.",
  email: "Já recebemos pedidos com este e-mail hoje. A equipe da Tugyn ADS vai falar com você; se precisar, tente de novo amanhã.",
  pendentes: "Você já tem pedidos esperando análise. Aguarde o contato da equipe da Tugyn ADS pelo WhatsApp.",
} as const;

class LimiteExcedido extends Error {}

/** Código anônimo (hash com sal) de um valor: o limitador nunca guarda o WhatsApp nem o e-mail em si. */
const chaveDe = (tipo: "wa" | "em", valor: string, env: NodeJS.ProcessEnv): string => `${tipo}_${createHash("sha256").update(`${env.ADS_IP_SALT ?? "tugyn"}:${tipo}:${valor}`).digest("hex").slice(0, 24)}`;

/** Os momentos (ms) dos pedidos aceitos nas últimas 24 h. Ignora lixo e datas no futuro. */
const eventosRecentes = (dados: unknown, agora: number): number[] => {
  const lista = typeof dados === "object" && dados !== null ? (dados as { eventos?: unknown }).eventos : undefined;
  return Array.isArray(lista) ? lista.filter((e): e is number => typeof e === "number" && Number.isFinite(e) && agora - e < DIA_MS && e <= agora + 60_000) : [];
};

/** Pública (sem login). O limite por IP é aplicado pela rota. */
export const solicitar = async (db: Firestore, body: Record<string, unknown>, res: VercelResponse, agora: number, origem: string, env: NodeJS.ProcessEnv = process.env) => {
  // armadilha: o campo "website" fica escondido na página; só um robô o preenche. Finge sucesso e NÃO grava nada.
  if (typeof body.website === "string" && body.website.trim() !== "") return responder(res, 200, { ok: true, codigo: gerarCodigo() });
  const v = validarSolicitacao(body);
  if (!v.ok) return responder(res, 400, { error: primeiroErro(v.erros), erros: v.erros });
  if (!(typeof body.tempoMs === "number" && body.tempoMs >= TEMPO_MINIMO_MS)) return responder(res, 400, { error: "Aguarde alguns segundos e envie de novo." });

  // o mesmo WhatsApp já tem um pedido esperando: não duplica (e não é erro para a pessoa)
  const repetida = await db.collection(SOLICITACOES).where("whatsappDigitos", "==", v.whatsappDigitos).where("status", "==", "pendente").limit(1).get();
  if (!repetida.empty) return responder(res, 200, { ok: true, codigo: String(repetida.docs[0].data().codigo ?? ""), repetida: true });

  // muitos pedidos ESPERANDO vindos do mesmo aparelho/rede
  const doIp = await db.collection(SOLICITACOES).where("origem", "==", origem).where("status", "==", "pendente").count().get();
  if (doIp.data().count >= LIMITES.pendentesPorIp) return responder(res, 429, { error: MENSAGEM.pendentes });

  const pendentes = await db.collection(SOLICITACOES).where("status", "==", "pendente").count().get();
  if (pendentes.data().count >= MAX_PENDENTES) return responder(res, 503, { error: "No momento não estamos recebendo novas solicitações. Tente novamente mais tarde." });

  const codigo = gerarCodigo();
  const limites = { ip: db.collection(LIMITES_COLECAO).doc(origem), wa: db.collection(LIMITES_COLECAO).doc(chaveDe("wa", v.whatsappDigitos, env)), em: db.collection(LIMITES_COLECAO).doc(chaveDe("em", v.dados.email.toLowerCase(), env)) };
  const pedido = db.collection(SOLICITACOES).doc();
  try {
    // confere os limites E grava o pedido na MESMA transação: dois pedidos simultâneos não furam o limite
    await db.runTransaction(async (tx) => {
      const [ip, wa, em] = await Promise.all([tx.get(limites.ip), tx.get(limites.wa), tx.get(limites.em)]);
      const doAparelho = eventosRecentes(ip.exists ? ip.data() : null, agora);
      const doWhatsapp = eventosRecentes(wa.exists ? wa.data() : null, agora);
      const doEmail = eventosRecentes(em.exists ? em.data() : null, agora);
      if (doAparelho.filter((e) => agora - e < HORA_MS).length >= LIMITES.ipHora || doAparelho.length >= LIMITES.ipDia) throw new LimiteExcedido(MENSAGEM.ip);
      if (doWhatsapp.length >= LIMITES.whatsappDia) throw new LimiteExcedido(MENSAGEM.whatsapp);
      if (doEmail.length >= LIMITES.emailDia) throw new LimiteExcedido(MENSAGEM.email);
      const expiraEm = Timestamp.fromMillis(agora + 2 * DIA_MS); // para a política de expiração (TTL) do Firestore limpar sozinha
      tx.set(limites.ip, { eventos: [...doAparelho, agora], expiraEm });
      tx.set(limites.wa, { eventos: [...doWhatsapp, agora], expiraEm });
      tx.set(limites.em, { eventos: [...doEmail, agora], expiraEm });
      tx.create(pedido, { status: "pendente", codigo, ...v.dados, whatsappDigitos: v.whatsappDigitos, origem, criadoEm: agora });
    });
  } catch (error) {
    if (error instanceof LimiteExcedido) return responder(res, 429, { error: error.message });
    throw error;
  }
  return responder(res, 200, { ok: true, codigo });
};

const primeiroErro = (erros: ErrosSolicitacao): string => Object.values(erros)[0] ?? "Dados inválidos.";

/** Administrador: vira um contrato comum (aguardando o cliente escolher). O link só é devolvido AGORA, uma vez, como no "Novo contrato". */
export const aprovarSolicitacao = async (db: Firestore, id: string, uid: string, agora: number, res: VercelResponse) => {
  const ref = db.collection(SOLICITACOES).doc(id);
  let resposta: Record<string, unknown> = {};
  try {
    const inicial = await ref.get();
    if (!inicial.exists) throw new NaoEncontrado();
    const dados = inicial.data() ?? {};
    const cliente = { nome: String(dados.nome ?? "").slice(0, 80), email: String(dados.email ?? "").slice(0, 120), whatsapp: String(dados.whatsapp ?? "").slice(0, 30), observacao: String(dados.mensagem ?? "").slice(0, 300) };
    const novo = await prepararContrato(db, cliente, uid, agora);
    novo.doc.historico = comHistorico(novo.doc.historico, { em: agora, por: "admin", acao: "aprovou a solicitação feita pela página pública", nota: `solicitação ${String(dados.codigo ?? "")}` });
    await db.runTransaction(async (tx) => {
      const atual = await tx.get(ref);
      if (!atual.exists) throw new NaoEncontrado();
      if (atual.data()?.status !== "pendente") throw new Conflito();
      tx.create(novo.ref, novo.doc);
      tx.update(ref, { status: "aprovada", contratoId: novo.ref.id, aprovadaEm: agora, aprovadaPor: uid, origem: null }); // o código do IP só existe enquanto o pedido está pendente
    });
    resposta = { ok: true, id: novo.ref.id, codigo: novo.codigo, token: novo.token, validoAte: novo.doc.tokenExpiresAt };
  } catch (error) {
    if (error instanceof NaoEncontrado) return responder(res, 404, { error: "Solicitação não encontrada." });
    if (error instanceof Conflito) return responder(res, 409, { error: "Esta solicitação já foi tratada." });
    throw error;
  }
  return responder(res, 200, resposta);
};

/** Administrador: apaga a solicitação de vez (os dados pessoais saem do banco). */
export const excluirSolicitacao = async (db: Firestore, id: string, res: VercelResponse) => {
  const ref = db.collection(SOLICITACOES).doc(id);
  try {
    await db.runTransaction(async (tx) => {
      const atual = await tx.get(ref);
      if (!atual.exists) throw new NaoEncontrado();
      tx.delete(ref);
    });
  } catch (error) {
    if (error instanceof NaoEncontrado) return responder(res, 404, { error: "Solicitação não encontrada." });
    throw error;
  }
  return responder(res, 200, { ok: true });
};
