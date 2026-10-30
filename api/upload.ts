import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { handleCors } from "./_lib/cors";
import { getAccount, isAdminOnlyBucket } from "./_lib/config";
import { confirmarFotoDePerfil, registrarEnvio, reservarTrocaDeImagem } from "./_lib/midiaReservasJob";
import { dentroDoLimite } from "./_lib/rateLimit";
import { isAvatar, parseBucket, parseFolderName, parseImage } from "./_lib/validation";

const MAX_UPLOADS_POR_USUARIO_HORA = 15;
const MAX_UPLOADS_POR_IP_HORA = 80;

/** O IP fica só como hash no limitador; o UID continua sendo a chave principal. */
const chaveAnonimaDoIp = (req: VercelRequest): string => {
  const forwarded = req.headers["x-forwarded-for"];
  const real = req.headers["x-real-ip"];
  const cadeia = typeof forwarded === "string" ? forwarded.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const primeiro = cadeia.length ? cadeia[cadeia.length - 1] : "";
  const ip = primeiro || (typeof real === "string" ? real.trim() : "") || "desconhecido";
  const secret = process.env.ADS_IP_SALT || process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!secret) return "ip_sem_chave";
  return "ip_" + createHmac("sha256", secret).update(ip).digest("hex").slice(0, 24);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return; // painel de anúncios (navegador): consulta prévia e cabeçalhos de CORS

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  // O UID sempre vem do token validado; userId no corpo nunca é autoridade.
  const user = await requireUser(req, res, "upload");
  if (!user) return;
  // Administradores usam o painel (navegador, sem App Check); o app manda o token.
  if (!user.admin && !(await verificarAppCheck(req, res, "upload"))) return;

  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

  // Etapa 3 da troca da foto de perfil (ver `_lib/midiaReservas.ts`): grava a referência e o prazo no servidor.
  if (body.action === "confirmar") {
    if (!(await dentroDoLimite(user.uid, "upload-confirmar", MAX_UPLOADS_POR_USUARIO_HORA, 3600))) {
      return res.status(429).json({ error: "Muitas tentativas em pouco tempo. Tente novamente mais tarde." });
    }
    try {
      const confirmacao = await confirmarFotoDePerfil(getFirestore(getFirebaseApp()), user.uid, body.reservaId);
      if (!confirmacao.ok) {
        if (confirmacao.retryAfterSeconds) res.setHeader("Retry-After", String(confirmacao.retryAfterSeconds));
        return res.status(confirmacao.status).json({ error: confirmacao.error, retryAfterSeconds: confirmacao.retryAfterSeconds });
      }
      return res.status(200).json({ url: confirmacao.url, public_id: confirmacao.publicId, promovida: confirmacao.promovida });
    } catch (error) {
      console.error("[upload] falha ao confirmar a foto:", error);
      return res.status(503).json({ error: "Não foi possível salvar a foto agora. Tente novamente." });
    }
  }

  const bucket = parseBucket(body.bucket);
  if (!bucket) return res.status(400).json({ error: "Bucket inválido." });

  // Banners de anúncios: só administradores (claim admin). Quem não é recebe 403.
  if (isAdminOnlyBucket(bucket) && !user.admin) {
    return res.status(403).json({ error: "Somente administradores enviam imagens de anúncios." });
  }

  const folder = parseFolderName(body.folderName);
  if (!folder) return res.status(400).json({ error: "Nome de pasta inválido." });

  // A conta de turmas é exclusiva para banners associados a uma turma existente.
  // Não aceitar upload sem turmaId evita uploads órfãos antes da criação da turma.
  if (bucket === "turmas" && folder !== "banner") {
    return res.status(400).json({ error: "Este bucket aceita somente banners de turma." });
  }
  if (bucket === "turmas" || (bucket === "times" && folder === "banner")) {
    if (typeof body.turmaId !== "string" || body.turmaId.length === 0) {
      return res.status(400).json({ error: "Informe a turma para enviar o banner." });
    }
  }

  const limiteUsuario = bucket === "anuncios" ? 80 : MAX_UPLOADS_POR_USUARIO_HORA;
  if (!(await dentroDoLimite(user.uid, "upload", limiteUsuario, 3600))) {
    return res.status(429).json({ error: "Muitos envios em pouco tempo. Tente novamente mais tarde." });
  }
  if (!(await dentroDoLimite(chaveAnonimaDoIp(req), "upload-ip", MAX_UPLOADS_POR_IP_HORA, 3600))) {
    return res.status(429).json({ error: "Muitos envios nesta rede. Tente novamente mais tarde." });
  }

  const image = parseImage(body.image);
  if (!image.ok) return res.status(image.status).json({ error: image.error });

  const account = getAccount(bucket);
  if (!account) {
    console.error("[upload] bucket \"" + bucket + "\" sem credenciais no ambiente");
    return res.status(500).json({ error: "Servidor não configurado para este tipo de imagem." });
  }

  const pasta = bucket + "/" + user.uid + "/" + folder;
  const tipo = isAvatar(bucket, folder)
    ? "fotoPerfil"
    : (bucket === "turmas" || bucket === "times") && folder === "banner"
      ? "bannerTurma"
      : null;

  // Foto e banner: RESERVA a troca no servidor (prazo, propriedade e uma troca por vez) antes de gastar no Cloudinary.
  let reserva: { reservaId: string; nome: string } | null = null;
  if (tipo) {
    let feita: Awaited<ReturnType<typeof reservarTrocaDeImagem>>;
    try {
      feita = await reservarTrocaDeImagem(getFirestore(getFirebaseApp()), { uid: user.uid, tipo, turmaId: body.turmaId, bucket, pasta });
    } catch (error) {
      console.error("[upload] falha ao reservar a troca da imagem:", error);
      return res.status(503).json({ error: "Não foi possível validar o prazo para trocar esta imagem." });
    }
    if (!feita.ok) {
      if (feita.retryAfterSeconds) res.setHeader("Retry-After", String(feita.retryAfterSeconds));
      return res.status(feita.status).json({ error: feita.error, retryAfterSeconds: feita.retryAfterSeconds });
    }
    reserva = feita;
  }

  try {
    const result = await cloudinary.uploader.upload(body.image as string, {
      ...account, // credenciais por chamada (sem cloudinary.config global)
      folder: pasta,
      // Sempre um id NOVO: nada publicado é sobrescrito ou invalidado antes da confirmação. Foto/banner: o id reservado.
      public_id: reserva?.nome,
      overwrite: false,
      unique_filename: !reserva,
      use_filename: false,
      resource_type: "image",
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
      transformation: [{ width: 1080, height: 1080, crop: "limit", quality: "auto" }],
      tags: isAdminOnlyBucket(bucket) ? ["anuncio"] : ["uid_" + user.uid],
    });

    if (reserva) await registrarEnvio(getFirestore(getFirebaseApp()), reserva.reservaId, result.secure_url);
    return res.status(200).json({
      url: result.secure_url,
      public_id: result.public_id,
      ...(reserva ? { reserva_id: reserva.reservaId } : {}),
    });
  } catch (error) {
    // A reserva vence já: a rotina diária apaga o que possa ter chegado ao Cloudinary e libera o alvo.
    if (reserva) await registrarEnvio(getFirestore(getFirebaseApp()), reserva.reservaId, null);
    console.error("[upload] falha no Cloudinary:", error); // detalhe só no log do servidor
    return res.status(502).json({ error: "Não foi possível enviar a imagem. Tente novamente." });
  }
}
