import { randomBytes } from "node:crypto";
import type { VercelResponse } from "@vercel/node";
import type { Firestore } from "firebase-admin/firestore";
import { v2 as cloudinary } from "cloudinary";
import { CONFIG_CONTRATO_DOC, configuracaoInicial, gerarPdfContrato, hashPdf, preencherTexto, validarConfiguracao, VARIAVEIS, type ConfiguracaoContrato } from "./contratoConfiguracao";
import { MODELO_DOC, parseModelo, proximaVersao, type ContratoModelo, type VersaoModelo } from "./contratoModelo";
import { contaDosComprovantes, type ContratoDoc } from "./contratos";
import { responder } from "./contratosComuns";

export const exemploPedido = (versao: number): Record<string, string> => ({ versao: String(versao), cliente_nome: "CLIENTE DE EXEMPLO — PRÉVIA", cliente_email: "cliente@example.com", cliente_telefone: "(00) 0 0000-0000", pedido_codigo: "PRÉVIA", pedido_modelo: "Banner", pedido_telas: "Partidas e Turmas", pedido_cidade: "Cidade de exemplo", pedido_inicio: "01/12/2026 09:00", pedido_fim: "08/12/2026 09:00", pedido_dias: "7", pedido_total: "R$ 100,00" });
const dataBR = (ms: number) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(ms));
export const dadosDoPedido = (d: ContratoDoc, versao: number): Record<string, string> => ({
  versao: String(versao), cliente_nome: d.cliente.nome, cliente_email: d.cliente.email || "Não informado", cliente_telefone: d.cliente.whatsapp || "Não informado", pedido_codigo: d.codigo,
  pedido_modelo: d.pedido?.modelo === "banner" ? "Banner" : "Texto", pedido_telas: d.pedido?.telas.join(", ") ?? "A definir no pedido", pedido_cidade: d.pedido?.escopo === "todas" ? "Todas as cidades atendidas pelo aplicativo" : `${d.pedido?.cidade?.nome ?? "A definir"} ${d.pedido?.cidade?.uf ?? ""}`.trim(),
  pedido_inicio: d.pedido ? dataBR(d.pedido.inicioMs) : "A definir no pedido", pedido_fim: d.pedido ? dataBR(d.pedido.fimMs) : "A definir no pedido", pedido_dias: d.pedido ? String(d.pedido.dias) : "A definir no pedido", pedido_total: d.preco ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(d.preco.total / 100) : "A definir no pedido",
});

/** A cópia do pedido prevalece sobre o modelo global, inclusive depois de novas publicações. */
export async function modeloDoCliente(db: Firestore, d: ContratoDoc): Promise<ContratoModelo | null> {
  if (d.documentoContrato) return { ...d.documentoContrato, enviadoPor: "", anteriores: [] };
  const snap = await db.doc(MODELO_DOC).get(), atual = snap.exists ? parseModelo(snap.data()) : null;
  if (!d.aceite || !atual || d.aceite.versao === atual.versao) return atual;
  const anterior = atual.anteriores.find(v => v.versao === d.aceite!.versao);
  if (anterior) return { ...anterior, enviadoPor: "", anteriores: [] };
  const arquivo = await db.doc(`adsContratoVersoes/${d.aceite.versao}`).get();
  return arquivo.exists ? parseModelo({ ...arquivo.data(), anteriores: [], enviadoPor: "" }) : null;
}

export async function subirPdf(buffer: Buffer, pasta: string): Promise<{ publicId: string; bytes: number; sha256: string }> {
  const conta = contaDosComprovantes();
  if (!conta) throw new Error("Conta do Cloudinary dos contratos não configurada.");
  const r = await cloudinary.uploader.upload(`data:application/pdf;base64,${buffer.toString("base64")}`, { ...conta, resource_type: "raw", type: "authenticated", folder: pasta, public_id: `contrato-${randomBytes(12).toString("hex")}.pdf`, tags: ["contrato-modelo"] });
  return { publicId: r.public_id, bytes: buffer.length, sha256: hashPdf(new Uint8Array(buffer)) };
}
export async function apagarPdf(publicId: string): Promise<void> {
  const conta = contaDosComprovantes();
  if (conta) await cloudinary.uploader.destroy(publicId, { ...conta, resource_type: "raw", type: "authenticated" }).catch(() => undefined);
}

/** Todas as ações passam pelo mesmo requireUser/admin e rate limit da rota existente. */
export async function adminConfiguracaoContrato(db: Firestore, acao: string, body: Record<string, unknown>, uid: string, agora: number, res: VercelResponse) {
  const ref = db.doc(CONFIG_CONTRATO_DOC);
  const snap = await ref.get(), estado = snap.data();
  const revisao = typeof estado?.revisao === "number" ? estado.revisao : 0;
  if (acao === "contrato_config_ver") return responder(res, 200, { revisao, configuracao: estado?.rascunho ?? configuracaoInicial(), publicadoVersao: estado?.publicadoVersao ?? null, publicadoEm: estado?.publicadoEm ?? null, variaveis: VARIAVEIS });
  const publicar = acao === "contrato_config_publicar";
  const v = validarConfiguracao(body.configuracao, publicar);
  if (!v.ok) return responder(res, 400, { error: v.error });
  if (publicar && body.revisado !== true) return responder(res, 400, { error: "Confirme que revisou o documento antes de publicar." });
  if (acao === "contrato_config_previa") {
    try { const buffer = await gerarPdfContrato(`PRÉVIA — NÃO PUBLICADA\n\n${preencherTexto(v.valor, exemploPedido(((await db.doc(MODELO_DOC).get()).data()?.versao ?? 0) + 1))}`); return responder(res, 200, { pdf: buffer.toString("base64") }); }
    catch (e) { return responder(res, 400, { error: e instanceof Error ? e.message : "Modelo inválido." }); }
  }
  if (body.revisao !== revisao) return responder(res, 409, { error: "Outro administrador alterou o rascunho. Recarregue antes de salvar." });
  const modeloAntesSnap = publicar ? await db.doc(MODELO_DOC).get() : null;
  const versaoAntes = modeloAntesSnap?.data()?.versao ?? 0;
  let upload: Awaited<ReturnType<typeof subirPdf>> | null = null;
  if (publicar) {
    // Também valida caracteres e tamanho ANTES de qualquer publicação ou upload.
    try { upload = await subirPdf(await gerarPdfContrato(preencherTexto(v.valor, exemploPedido(versaoAntes + 1))), "contrato-modelo"); }
    catch (e) { return responder(res, 400, { error: e instanceof Error ? e.message : "Não foi possível gerar o PDF." }); }
  }
  let versao: number | null = null;
  try {
    await db.runTransaction(async tx => {
      const recente = await tx.get(ref);
      if ((recente.data()?.revisao ?? 0) !== revisao) throw new Error("conflito");
      if (publicar && upload) {
        const modeloRef = db.doc(MODELO_DOC), modeloSnap = await tx.get(modeloRef);
        if ((modeloSnap.data()?.versao ?? 0) !== versaoAntes) throw new Error("conflito");
        const anterior = modeloSnap.exists ? parseModelo(modeloSnap.data()) : null;
        const novo = proximaVersao(anterior, { ...upload, nome: "contrato-tugyn-ads.pdf" }, agora, uid);
        versao = novo.versao;
        tx.create(db.doc(`adsContratoVersoes/${novo.versao}`), { ...novo, anteriores: [], configuracao: v.valor });
        // Migra também as versões legadas que ainda estão no histórico, sem removê-las.
        for (const a of anterior ? [anterior, ...anterior.anteriores] : []) tx.set(db.doc(`adsContratoVersoes/${a.versao}`), { ...a, anteriores: [] });
        tx.set(modeloRef, { ...novo, configuracao: v.valor });
      }
      tx.set(ref, { revisao: revisao + 1, rascunho: v.valor, atualizadoEm: agora, atualizadoPor: uid, ...(publicar ? { publicadoVersao: versao, publicadoEm: agora, publicadoPor: uid } : {}) }, { merge: true });
    });
  } catch (e) {
    if (upload) await apagarPdf(upload.publicId);
    if (e instanceof Error && e.message === "conflito") return responder(res, 409, { error: "Outro administrador alterou o rascunho. Recarregue antes de salvar." });
    throw e;
  }
  return responder(res, 200, { ok: true, revisao: revisao + 1, versao });
}

export const resumoVersao = (m: VersaoModelo): VersaoModelo => ({ versao: m.versao, nome: m.nome, bytes: m.bytes, sha256: m.sha256, publicId: m.publicId, enviadoEm: m.enviadoEm, ...(m.preenchivel ? { preenchivel: true } : {}) });

/** Preserva a prova anterior quando o cliente altera um pedido ainda não pago. */
export const registroAceiteAnterior = (d: ContratoDoc) => d.aceite ? { aceite: d.aceite, documentoContrato: d.documentoContrato ?? null, pedido: d.pedido, preco: d.preco, cliente: d.cliente } : null;
