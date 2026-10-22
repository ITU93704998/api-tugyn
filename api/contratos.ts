import type { VercelRequest, VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { type Firestore, getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { type Acao, type Status, linkExpirado, proximoStatus, validadeAposPagamento, validadeDoLinkNovo, validarSelecao } from "./_lib/contratoCore";
import {
  COLECAO,
  COMPROVANTE_URL_SEGUNDOS,
  type ContratoDoc,
  chaveDoIp,
  comHistorico,
  contaDosComprovantes,
  gerarCodigo,
  gerarToken,
  hashToken,
  limparTexto,
  novoContrato,
  parseContrato,
  parseCriar,
  pedidoEPreco,
  temPrecos,
  validarImagem,
  visaoPublica,
} from "./_lib/contratos";
import { Conflito, NaoEncontrado, buscarPorToken, lerConfig, lerNaTransacao, responder } from "./_lib/contratosComuns";
import { adminAprovar, adminModeloEnviar, adminModeloUrl, adminPedirAjustes, clienteEnviarAnuncio, clienteImagem, clientePdf, lerModelo } from "./_lib/contratosFase2";
import { handleCors } from "./_lib/cors";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * POST /api/contratos  — contratos de anúncio (Tugyn ADS). Uma rota só (o plano gratuito da Vercel limita o número de funções).
 *
 * O CLIENTE (sem login; o token do link é a chave): `ver`, `configurar`, `comprovante`.
 * O ADMINISTRADOR (login do Firebase com a permissão `admin`): `criar`, `novo_link`, `ver_comprovante`, `confirmar_pagamento`,
 *   `pedir_comprovante`, `cancelar`.
 *
 * O cliente NUNCA fala com o Firestore: esta rota confere o token e a etapa, RECALCULA o preço e grava (o valor que a tela do cliente mostra é só apoio).
 */

const ACOES_CLIENTE = ["ver", "configurar", "comprovante", "contrato_pdf", "anuncio_imagem", "anuncio_enviar"] as const;
const ACOES_ADMIN = ["criar", "novo_link", "ver_comprovante", "confirmar_pagamento", "pedir_comprovante", "cancelar", "modelo_enviar", "modelo_url", "aprovar", "pedir_ajustes"] as const;
const ID = /^[A-Za-z0-9]{10,40}$/;

/** Ação da rota → ação do núcleo de etapas (sem `as`: se um nome mudar de um lado, o compilador acusa). */
const ACAO_DO_NUCLEO: Record<"novo_link" | "confirmar_pagamento" | "pedir_comprovante" | "cancelar", Acao> = {
  novo_link: "novo_link",
  confirmar_pagamento: "confirmar_pagamento",
  pedir_comprovante: "pedir_novo_comprovante",
  cancelar: "cancelar",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** O contrato em PDF só entra na visão depois do pagamento (antes disso o cliente não precisa dele): economiza uma leitura. */
const modeloDaVisao = (db: Firestore, status: Status) => (status === "pago" || status === "em_analise" || status === "ajustes_solicitados" || status === "aprovado" ? lerModelo(db) : Promise.resolve(null));

// ─────────────────────────── CLIENTE ───────────────────────────
const cliente = async (db: Firestore, acao: (typeof ACOES_CLIENTE)[number], body: Record<string, unknown>, res: VercelResponse, ipHash: string) => {
  const encontrado = await buscarPorToken(db, body.token);
  if (!encontrado) return responder(res, 404, { error: "Link inválido." }); // mesma resposta para token errado e inexistente
  const agora = Date.now();
  const config = await lerConfig(db);
  if (linkExpirado(encontrado.data, agora)) {
    const cancelado = encontrado.data.status === "cancelado";
    return responder(res, 410, { error: cancelado ? "Este contrato foi cancelado." : "Este link expirou.", motivo: cancelado ? "cancelado" : "expirado", contato: config.contato });
  }

  if (acao === "ver") return responder(res, 200, { contrato: visaoPublica(encontrado.data, config, agora, await modeloDaVisao(db, encontrado.data.status)) });

  // Fase 2: contrato em PDF, imagem do banner e envio do anúncio
  if (acao === "contrato_pdf" || acao === "anuncio_imagem" || acao === "anuncio_enviar") {
    const contexto = { db, res, body, agora, encontrado, config, ipHash };
    return acao === "contrato_pdf" ? clientePdf(contexto) : acao === "anuncio_imagem" ? clienteImagem(contexto) : clienteEnviarAnuncio(contexto);
  }

  if (acao === "configurar") {
    if (!temPrecos(config)) return responder(res, 503, { error: "Os valores ainda não foram configurados. Fale com a Tugyn ADS." });
    const proximo = proximoStatus(encontrado.data.status, "configurar", "cliente");
    if (!proximo) return responder(res, 409, { error: "Não é possível alterar o pedido neste momento." });
    const resultado = validarSelecao(config, body.selecao, agora);
    if (!resultado.ok) return responder(res, 400, { error: resultado.erros[0] ?? "Escolha inválida.", erros: resultado.erros });
    const { pedido, preco } = pedidoEPreco(resultado, agora);
    let gravado: ContratoDoc | null = null;
    try {
      await db.runTransaction(async (tx) => {
        const atual = await lerNaTransacao(tx, encontrado.ref);
        const novoStatus = proximoStatus(atual.status, "configurar", "cliente");
        if (atual.tokenHash !== encontrado.data.tokenHash || linkExpirado(atual, agora) || !novoStatus) throw new Conflito();
        gravado = { ...atual, pedido, preco, status: novoStatus, atualizadoEm: agora, historico: comHistorico(atual.historico, { em: agora, por: "cliente", acao: "confirmou o pedido", nota: `${preco.total} centavos, ${pedido.dias} dia(s)` }) };
        tx.update(encontrado.ref, { pedido, preco, status: novoStatus, atualizadoEm: agora, historico: gravado.historico });
      });
    } catch (error) {
      if (error instanceof Conflito || error instanceof NaoEncontrado) return responder(res, 409, { error: "O contrato mudou. Atualize a página." });
      throw error;
    }
    return responder(res, 200, { contrato: visaoPublica(gravado as unknown as ContratoDoc, config, agora) });
  }

  // comprovante
  if (!proximoStatus(encontrado.data.status, "enviar_comprovante", "cliente") || !encontrado.data.pedido || !encontrado.data.preco) return responder(res, 409, { error: "Não é possível enviar o comprovante neste momento." });
  if (body.confirmo !== true) return responder(res, 400, { error: "Confirme que você fez o pagamento." });
  const imagem = validarImagem(body.imagem);
  if (!imagem.ok) return responder(res, 400, { error: imagem.error });
  const conta = contaDosComprovantes();
  if (!conta) return responder(res, 503, { error: "O envio de comprovantes ainda não está disponível. Fale com a Tugyn ADS." });

  const enviado = await cloudinary.uploader.upload(imagem.dataUri, {
    ...conta, // credenciais por chamada (sem cloudinary.config global)
    folder: `comprovantes/${encontrado.ref.id}`,
    type: "authenticated", // privado: só com link assinado, gerado aqui para o administrador
    resource_type: "image",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    tags: ["comprovante", `contrato_${encontrado.ref.id}`],
  });
  let gravado: ContratoDoc | null = null;
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, encontrado.ref);
      const novoStatus = proximoStatus(atual.status, "enviar_comprovante", "cliente");
      if (atual.tokenHash !== encontrado.data.tokenHash || linkExpirado(atual, agora) || !novoStatus) throw new Conflito();
      const pagamento = { ...atual.pagamento, comprovante: { publicId: enviado.public_id, formato: String(enviado.format ?? ""), bytes: Number(enviado.bytes ?? imagem.bytes), enviadoEm: agora }, declaradoEm: agora };
      gravado = { ...atual, status: novoStatus, pagamento, atualizadoEm: agora, historico: comHistorico(atual.historico, { em: agora, por: "cliente", acao: "enviou o comprovante e declarou o pagamento" }) };
      tx.update(encontrado.ref, { status: novoStatus, pagamento, atualizadoEm: agora, historico: gravado.historico });
    });
  } catch (error) {
    // a etapa mudou no meio do caminho: a imagem que acabou de subir não é mais necessária
    await cloudinary.uploader.destroy(enviado.public_id, { ...conta, type: "authenticated", resource_type: "image" }).catch(() => undefined);
    if (error instanceof Conflito || error instanceof NaoEncontrado) return responder(res, 409, { error: "O contrato mudou. Atualize a página." });
    throw error;
  }
  return responder(res, 200, { contrato: visaoPublica(gravado as unknown as ContratoDoc, config, agora) });
};

// ─────────────────────────── ADMINISTRADOR ───────────────────────────
const idValido = (valor: unknown): string | null => (typeof valor === "string" && ID.test(valor) ? valor : null);

const admin = async (db: Firestore, acao: (typeof ACOES_ADMIN)[number], body: Record<string, unknown>, uid: string, res: VercelResponse) => {
  const agora = Date.now();

  if (acao === "criar") {
    const dados = parseCriar(body);
    if (!dados.ok) return responder(res, 400, { error: dados.error });
    const config = await lerConfig(db);
    let codigo = gerarCodigo();
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      const repetido = await db.collection(COLECAO).where("codigo", "==", codigo).limit(1).get();
      if (repetido.empty) break;
      codigo = gerarCodigo();
    }
    const token = gerarToken();
    const doc = novoContrato(dados.cliente, token, codigo, config, agora);
    const ref = db.collection(COLECAO).doc();
    await ref.create({ ...doc, criadoPor: uid });
    return responder(res, 200, { id: ref.id, codigo, token, validoAte: doc.tokenExpiresAt });
  }

  // o contrato em PDF é único (não pertence a um contrato do cliente): não usa id
  if (acao === "modelo_enviar") return adminModeloEnviar(db, body, uid, agora, res);
  if (acao === "modelo_url") return adminModeloUrl(db, body, agora, res);

  const id = idValido(body.id);
  if (!id) return responder(res, 400, { error: "Contrato inválido." });
  const ref = db.collection(COLECAO).doc(id);
  const nota = limparTexto(body.nota, 300);

  if (acao === "ver_comprovante") {
    const snapshot = await ref.get();
    const doc = snapshot.exists ? parseContrato(snapshot.data()) : null;
    if (!doc) return responder(res, 404, { error: "Contrato não encontrado." });
    if (!doc.pagamento.comprovante) return responder(res, 404, { error: "Este contrato não tem comprovante." });
    const conta = contaDosComprovantes();
    if (!conta) return responder(res, 503, { error: "Conta do Cloudinary dos anúncios não configurada." });
    const expiraEmSegundos = Math.floor(agora / 1000) + COMPROVANTE_URL_SEGUNDOS;
    const url = cloudinary.utils.private_download_url(doc.pagamento.comprovante.publicId, doc.pagamento.comprovante.formato || "jpg", { ...conta, type: "authenticated", resource_type: "image", expires_at: expiraEmSegundos });
    return responder(res, 200, { url, expiraEm: expiraEmSegundos * 1000 });
  }

  if (acao === "aprovar") return adminAprovar(db, ref, uid, agora, res);
  if (acao === "pedir_ajustes") return adminPedirAjustes(db, ref, nota, agora, res);

  if (acao === "pedir_comprovante" && nota.length < 3) return responder(res, 400, { error: "Explique ao cliente o que precisa ser reenviado." });

  let comprovanteAnterior: string | null = null;
  let resposta: Record<string, unknown> = { ok: true };
  // só o link novo precisa da validade padrão: lê ANTES da transação (dentro dela a leitura se repetiria a cada nova tentativa)
  const validadeLinkDias = acao === "novo_link" ? (await lerConfig(db)).validadeLinkDias : 0;
  try {
    await db.runTransaction(async (tx) => {
      const atual = await lerNaTransacao(tx, ref);
      const novoStatus = proximoStatus(atual.status, ACAO_DO_NUCLEO[acao], "admin");
      if (!novoStatus) throw new Conflito();

      if (acao === "novo_link") {
        const token = gerarToken();
        // a validade depende da etapa (ver `validadeDoLinkNovo`): aprovado e já terminado = não há o que abrir
        const validoAte = validadeDoLinkNovo({ status: atual.status, fimMs: atual.pedido ? atual.pedido.fimMs : null }, agora, validadeLinkDias);
        if (validoAte === null) throw new Conflito();
        tx.update(ref, { tokenHash: hashToken(token), tokenExpiresAt: validoAte, atualizadoEm: agora, historico: comHistorico(atual.historico, { em: agora, por: "admin", acao: "gerou um novo link" }) });
        resposta = { ok: true, token, validoAte };
        return;
      }

      const item: { em: number; por: "admin"; acao: string; nota?: string } = { em: agora, por: "admin", acao: "" };
      let pagamento = atual.pagamento;
      let tokenExpiresAt = atual.tokenExpiresAt;
      if (acao === "confirmar_pagamento") {
        if (!atual.pedido || !atual.preco) throw new Conflito();
        pagamento = { ...atual.pagamento, confirmadoEm: agora, confirmadoPor: uid, notaDoAdmin: null };
        tokenExpiresAt = validadeAposPagamento(atual.pedido.fimMs); // o link passa a valer SÓ até o fim do anúncio
        item.acao = "confirmou o pagamento";
      } else if (acao === "pedir_comprovante") {
        comprovanteAnterior = atual.pagamento.comprovante ? atual.pagamento.comprovante.publicId : null;
        pagamento = { ...atual.pagamento, comprovante: null, declaradoEm: null, notaDoAdmin: nota };
        item.acao = "pediu novo comprovante";
      } else {
        item.acao = "cancelou o contrato";
      }
      if (nota) item.nota = nota;
      tx.update(ref, { status: novoStatus as Status, pagamento, tokenExpiresAt, atualizadoEm: agora, historico: comHistorico(atual.historico, item) });
    });
  } catch (error) {
    if (error instanceof NaoEncontrado) return responder(res, 404, { error: "Contrato não encontrado." });
    if (error instanceof Conflito) return responder(res, 409, { error: "Esta ação não é possível na etapa atual do contrato." });
    throw error;
  }
  // o comprovante antigo (privado) não é mais necessário: apaga (melhor esforço)
  const conta = contaDosComprovantes();
  if (comprovanteAnterior && conta) await cloudinary.uploader.destroy(comprovanteAnterior, { ...conta, type: "authenticated", resource_type: "image" }).catch(() => undefined);
  return responder(res, 200, resposta);
};

// ─────────────────────────── ENTRADA ───────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const body = isRecord(req.body) ? req.body : {};
  const acao = body.action;
  const ehCliente = (ACOES_CLIENTE as readonly unknown[]).includes(acao);
  const ehAdmin = (ACOES_ADMIN as readonly unknown[]).includes(acao);
  if (!ehCliente && !ehAdmin) return res.status(400).json({ error: "Ação inválida." });

  let uid = "";
  if (ehAdmin) {
    const user = await requireUser(req, res);
    if (!user) return; // requireUser já respondeu (401/500)
    if (!user.admin) return res.status(403).json({ error: "Somente administradores." });
    uid = user.uid;
    if (!(await dentroDoLimite(uid, "contratos-admin", 200, 3600))) return res.status(429).json({ error: "Muitas requisições. Tente novamente mais tarde." });
  } else {
    // limite por IP (hash): ver é leve; comprovante é pesado
    const limite = acao === "comprovante" || acao === "anuncio_imagem" ? 10 : acao === "configurar" || acao === "contrato_pdf" ? 60 : acao === "anuncio_enviar" ? 30 : 120;
    if (!(await dentroDoLimite(chaveDoIp(req), `contratos-${String(acao)}`, limite, 3600))) return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
  }

  let db: Firestore;
  try {
    db = getFirestore(getFirebaseApp());
  } catch (error) {
    console.error("[contratos] Firebase Admin não configurado:", error instanceof Error ? error.message : "erro");
    return res.status(500).json({ error: "Servidor não configurado." });
  }

  try {
    return ehCliente ? await cliente(db, acao as (typeof ACOES_CLIENTE)[number], body, res, chaveDoIp(req)) : await admin(db, acao as (typeof ACOES_ADMIN)[number], body, uid, res);
  } catch (error) {
    console.error("[contratos] falha:", error instanceof Error ? error.message : "erro desconhecido"); // sem token nem dados do cliente no log
    return res.status(503).json({ error: "Não foi possível agora. Tente novamente." });
  }
}
