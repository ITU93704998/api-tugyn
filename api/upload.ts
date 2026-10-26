import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { verificarAppCheck } from "./_lib/appCheck";
import { requireUser } from "./_lib/auth";
import { handleCors } from "./_lib/cors";
import { getAccount, isAdminOnlyBucket } from "./_lib/config";
import { dentroDoLimite } from "./_lib/rateLimit";
import { isAvatar, parseBucket, parseFolderName, parseImage } from "./_lib/validation";
import { verificarIntervaloDaImagem } from "./_lib/mediaCooldown";

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
  const user = await requireUser(req, res);
  if (!user) return;
  // Administradores usam o painel (navegador, sem App Check); o app manda o token.
  if (!user.admin && !(await verificarAppCheck(req, res, "upload"))) return;

  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

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

  // Foto e banner: verifica prazo e propriedade no servidor antes de gastar no Cloudinary.
  let cooldown: Awaited<ReturnType<typeof verificarIntervaloDaImagem>> | null = null;
  try {
    if (bucket === "usuarios" && folder === "profile") {
      cooldown = await verificarIntervaloDaImagem(user.uid, "fotoPerfil");
    } else if ((bucket === "turmas" || bucket === "times") && folder === "banner") {
      cooldown = await verificarIntervaloDaImagem(user.uid, "bannerTurma", body.turmaId);
    }
  } catch (error) {
    console.error("[upload] falha ao validar prazo da imagem:", error);
    return res.status(503).json({ error: "Não foi possível validar o prazo para trocar esta imagem." });
  }
  if (cooldown && !cooldown.allowed) {
    if (cooldown.retryAfterSeconds) res.setHeader("Retry-After", String(cooldown.retryAfterSeconds));
    return res.status(cooldown.status).json({ error: cooldown.error, retryAfterSeconds: cooldown.retryAfterSeconds });
  }

  const image = parseImage(body.image);
  if (!image.ok) return res.status(image.status).json({ error: image.error });

  const account = getAccount(bucket);
  if (!account) {
    console.error("[upload] bucket \"" + bucket + "\" sem credenciais no ambiente");
    return res.status(500).json({ error: "Servidor não configurado para este tipo de imagem." });
  }

  const avatar = isAvatar(bucket, folder);

  try {
    const result = await cloudinary.uploader.upload(body.image as string, {
      ...account, // credenciais por chamada (sem cloudinary.config global)
      folder: bucket + "/" + user.uid + "/" + folder,
      // Avatar: id fixo, a foto nova substitui a anterior do próprio usuário.
      // Outras imagens: id único, nunca sobrescreve nada.
      public_id: avatar ? "profile" : undefined,
      overwrite: avatar,
      invalidate: avatar,
      unique_filename: !avatar,
      use_filename: false,
      resource_type: "image",
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
      transformation: [{ width: 1080, height: 1080, crop: "limit", quality: "auto" }],
      tags: isAdminOnlyBucket(bucket) ? ["anuncio"] : ["uid_" + user.uid],
    });

    return res.status(200).json({ url: result.secure_url, public_id: result.public_id });
  } catch (error) {
    console.error("[upload] falha no Cloudinary:", error); // detalhe só no log do servidor
    return res.status(502).json({ error: "Não foi possível enviar a imagem. Tente novamente." });
  }
}
