import type { VercelResponse } from "@vercel/node";
import type { Firestore } from "firebase-admin/firestore";
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

/** Pública (sem login). O limite por IP é aplicado pela rota. */
export const solicitar = async (db: Firestore, body: Record<string, unknown>, res: VercelResponse, agora: number) => {
  // armadilha: o campo "website" fica escondido na página; só um robô o preenche. Finge sucesso e NÃO grava nada.
  if (typeof body.website === "string" && body.website.trim() !== "") return responder(res, 200, { ok: true, codigo: gerarCodigo() });
  const v = validarSolicitacao(body);
  if (!v.ok) return responder(res, 400, { error: primeiroErro(v.erros), erros: v.erros });
  if (!(typeof body.tempoMs === "number" && body.tempoMs >= TEMPO_MINIMO_MS)) return responder(res, 400, { error: "Aguarde alguns segundos e envie de novo." });

  // o mesmo WhatsApp já tem um pedido esperando: não duplica (e não é erro para a pessoa)
  const repetida = await db.collection(SOLICITACOES).where("whatsappDigitos", "==", v.whatsappDigitos).where("status", "==", "pendente").limit(1).get();
  if (!repetida.empty) return responder(res, 200, { ok: true, codigo: String(repetida.docs[0].data().codigo ?? ""), repetida: true });

  const pendentes = await db.collection(SOLICITACOES).where("status", "==", "pendente").count().get();
  if (pendentes.data().count >= MAX_PENDENTES) return responder(res, 503, { error: "No momento não estamos recebendo novas solicitações. Tente novamente mais tarde." });

  const codigo = gerarCodigo();
  await db.collection(SOLICITACOES).doc().create({ status: "pendente", codigo, ...v.dados, whatsappDigitos: v.whatsappDigitos, criadoEm: agora });
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
      tx.update(ref, { status: "aprovada", contratoId: novo.ref.id, aprovadaEm: agora, aprovadaPor: uid });
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
