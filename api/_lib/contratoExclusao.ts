import type { VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { COLECAO_CODIGOS, responder } from "./contratosComuns";
import { COLECAO, type ContratoDoc, contaDosComprovantes, parseContrato, recursoDoComprovante } from "./contratos";
import { excluirCampanha } from "./publicacaoAnuncios";
import { SOLICITACOES } from "./solicitacoes";

/**
 * EXCLUSÃO DEFINITIVA de um contrato (em qualquer etapa), pedida pelo administrador. Apaga a campanha criada na aprovação (sai do app),
 * os números dela, os arquivos no Cloudinary (comprovante, banners, contrato preenchido) e os dados no Firestore (contrato, aceites,
 * reserva do código, solicitação de origem). O contrato em PDF compartilhado (o modelo) nunca é apagado aqui.
 */

type Conta = { cloud_name: string; api_key: string; api_secret: string };
const LOTE = 400;

const ignorarAusente = (error: unknown): void => {
  const e = error as { http_code?: number; error?: { http_code?: number } } | null;
  if (e?.http_code === 404 || e?.error?.http_code === 404) return;
  throw error;
};

/** Ids conhecidos de arquivos DESTE contrato (o modelo compartilhado fica de fora). */
export const arquivosDoContrato = (d: ContratoDoc, aceitesAnteriores: unknown[] = []): Array<{ publicId: string; type: "authenticated" | "upload"; resource_type: "raw" | "image" }> => {
  const lista: Array<{ publicId: string; type: "authenticated" | "upload"; resource_type: "raw" | "image" }> = [];
  if (d.pagamento.comprovante) lista.push({ publicId: d.pagamento.comprovante.publicId, type: "authenticated", resource_type: recursoDoComprovante(d.pagamento.comprovante.formato) });
  for (const imagem of [d.anuncio?.imagem, d.rascunhoImagem]) if (imagem?.publicId) lista.push({ publicId: imagem.publicId, type: "upload", resource_type: "image" });
  const preenchidos = [d.documentoContrato, ...aceitesAnteriores.map((a) => (a as { documentoContrato?: ContratoDoc["documentoContrato"] } | null)?.documentoContrato ?? null)];
  for (const doc of preenchidos) if (doc?.preenchivel && typeof doc.publicId === "string") lista.push({ publicId: doc.publicId, type: "authenticated", resource_type: "raw" });
  const vistos = new Set<string>();
  return lista.filter((a) => (vistos.has(a.resource_type + a.publicId) ? false : (vistos.add(a.resource_type + a.publicId), true)));
};

const apagarArquivos = async (conta: Conta, id: string, conhecidos: ReturnType<typeof arquivosDoContrato>): Promise<void> => {
  for (const a of conhecidos) {
    const r = (await cloudinary.uploader.destroy(a.publicId, { ...conta, type: a.type, resource_type: a.resource_type, invalidate: true })) as { result?: string } | undefined;
    if (r?.result && r.result !== "ok" && r.result !== "not found") throw new Error(`Cloudinary recusou apagar ${a.publicId}: ${r.result}`);
  }
  // o que tiver escapado da lista (reenvios antigos): pela marca do contrato e pelas pastas dele
  await cloudinary.api.delete_resources_by_tag(`contrato_${id}`, { ...conta, resource_type: "image" }).catch(ignorarAusente);
  await cloudinary.api.delete_resources_by_tag(`contrato_${id}`, { ...conta, resource_type: "raw" }).catch(ignorarAusente);
  for (const [prefixo, resource_type] of [[`comprovantes/${id}/`, "image"], [`comprovantes/${id}/`, "raw"], [`contratos-preenchidos/${id}/`, "raw"]] as const) {
    await cloudinary.api.delete_resources_by_prefix(prefixo, { ...conta, type: "authenticated", resource_type }).catch(ignorarAusente);
  }
};

const apagarConsulta = async (db: Firestore, refs: DocumentReference[]): Promise<void> => {
  for (let i = 0; i < refs.length; i += LOTE) {
    const lote = db.batch();
    for (const ref of refs.slice(i, i + LOTE)) lote.delete(ref);
    await lote.commit();
  }
};

/** Mensagens de falha: dizem o que JÁ foi feito (o link do cliente já foi desativado; a exclusão pode ser retomada). */
const FALHA_ARQUIVOS = "Não foi possível apagar os arquivos do contrato agora. O link do cliente já foi desativado e o contrato ficou bloqueado; a campanha e os dados continuam. Toque em Excluir de novo para continuar.";
const FALHA_DADOS = "Os arquivos do contrato já foram apagados, mas parte dos dados não. Toque em Excluir de novo para terminar.";

/**
 * Etapas (pode ser chamada de novo depois de qualquer falha: cada etapa aceita o que já foi feito):
 *  1. marca `excluindoEm` e desativa o link do cliente, numa transação: dali em diante nenhuma ação muda o contrato
 *     (`lerNaTransacao` o trata como inexistente) e um envio em andamento do cliente falha e apaga o próprio arquivo;
 *  2. relê o contrato (já bloqueado) e apaga os arquivos no Cloudinary;
 *  3. só então tira a campanha do app (republicando), os números, os registros ligados e, por último, o próprio contrato.
 */
export const adminExcluirContrato = async (db: Firestore, ref: DocumentReference, codigoConfirmado: unknown, uid: string, agora: number, res: VercelResponse) => {
  const inicial = await ref.get();
  const codigoInicial = inicial.exists ? inicial.data()?.codigo : undefined;
  if (typeof codigoInicial !== "string") return responder(res, 404, { error: "Contrato não encontrado." });
  if (typeof codigoConfirmado !== "string" || codigoConfirmado.trim().toUpperCase() !== codigoInicial) return responder(res, 400, { error: `Para excluir, digite o código do pedido (${codigoInicial}).` });
  const conta = contaDosComprovantes();
  if (!conta) return responder(res, 503, { error: "Conta do Cloudinary dos anúncios não configurada: os arquivos do contrato não podem ser apagados agora." });

  // 1. bloqueia (idempotente: uma exclusão já começada só continua)
  await db.runTransaction(async (tx) => {
    const atual = await tx.get(ref);
    if (!atual.exists) return;
    if (atual.data()?.excluindoEm) return;
    tx.update(ref, { excluindoEm: agora, excluidoPor: uid, tokenHash: "excluindo", tokenExpiresAt: 0, atualizadoEm: agora });
  });

  // 2. arquivos, a partir do contrato JÁ bloqueado (nada novo entra depois desta leitura)
  const snapshot = await ref.get();
  if (!snapshot.exists) return responder(res, 200, { ok: true, campanhaExcluida: false, arquivos: 0, publicacao: null }); // outra chamada terminou antes
  const doc = parseContrato(snapshot.data());
  if (!doc) return responder(res, 409, { error: "O contrato está com dados inválidos e não pode ser excluído automaticamente." });
  const aceites = await ref.collection("aceites").get();
  const conhecidos = arquivosDoContrato(doc, aceites.docs.map((a) => a.data()));
  try {
    await apagarArquivos(conta, ref.id, conhecidos);
  } catch (error) {
    console.error("[contratos] falha ao apagar os arquivos do contrato", ref.id, error);
    return responder(res, 502, { error: FALHA_ARQUIVOS, etapa: "arquivos" });
  }

  // 3. campanha, números e dados (cada passo aceita o que já foi apagado); o contrato sai por último
  let publicacao: { anuncios: number } | null = null;
  try {
    if (doc.campanhaId) {
      const r = await excluirCampanha(db, doc.campanhaId, true, uid, agora);
      publicacao = r.publicacao ? { anuncios: r.publicacao.ads.length } : null;
      const numeros = await db.collection("adStats").where("campaignId", "==", doc.campanhaId).get();
      await apagarConsulta(db, numeros.docs.map((d) => d.ref));
    }
    const solicitacoes = await db.collection(SOLICITACOES).where("contratoId", "==", ref.id).get();
    const codigoRef = db.doc(`${COLECAO_CODIGOS}/${doc.codigo}`);
    const codigo = await codigoRef.get();
    const extras = [...aceites.docs.map((d) => d.ref), ...solicitacoes.docs.map((d) => d.ref), ...(codigo.exists && codigo.get("contratoId") === ref.id ? [codigoRef] : [])];
    await apagarConsulta(db, extras);
    await db.collection(COLECAO).doc(ref.id).delete();
  } catch (error) {
    console.error("[contratos] falha ao apagar os dados do contrato", ref.id, error);
    return responder(res, 503, { error: FALHA_DADOS, etapa: "dados" });
  }
  console.info("[contratos] contrato excluído pelo administrador", { contrato: ref.id, por: uid, em: agora, arquivos: conhecidos.length, campanha: !!doc.campanhaId });
  return responder(res, 200, { ok: true, campanhaExcluida: !!doc.campanhaId, arquivos: conhecidos.length, publicacao });
};
