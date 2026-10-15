import type { VercelRequest, VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { requireUser } from "./_lib/auth";
import { getAccount } from "./_lib/config";
import { dentroDoLimite } from "./_lib/rateLimit";
import { isAvatar, parseBucket, parseFolderName, parseImage } from "./_lib/validation";

const MAX_UPLOADS_POR_HORA = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  // 1. Quem é o usuário: SEMPRE o uid do token. O `userId` do corpo é ignorado.
  const user = await requireUser(req, res);
  if (!user) return;

  if (!(await dentroDoLimite(user.uid, "upload", MAX_UPLOADS_POR_HORA, 3600))) {
    return res.status(429).json({ error: "Muitos envios em pouco tempo. Tente novamente mais tarde." });
  }

  // 2. Valida TUDO que veio do cliente.
  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

  const bucket = parseBucket(body.bucket);
  if (!bucket) return res.status(400).json({ error: "Bucket inválido." });

  const folder = parseFolderName(body.folderName);
  if (!folder) return res.status(400).json({ error: "Nome de pasta inválido." });

  const image = parseImage(body.image);
  if (!image.ok) return res.status(image.status).json({ error: image.error });

  const account = getAccount(bucket);
  if (!account) {
    console.error(`[upload] bucket "${bucket}" sem credenciais no ambiente`);
    return res.status(500).json({ error: "Servidor não configurado para este tipo de imagem." });
  }

  const avatar = isAvatar(bucket, folder);

  try {
    const result = await cloudinary.uploader.upload(body.image as string, {
      ...account, // credenciais por chamada (sem cloudinary.config global)
      folder: `${bucket}/${user.uid}/${folder}`,
      // Avatar: id fixo, a foto nova substitui a anterior DO PRÓPRIO usuário (não sobra imagem velha).
      // Qualquer outra imagem (banner, logo...): id único, nunca sobrescreve nada.
      public_id: avatar ? "profile" : undefined,
      overwrite: avatar,
      invalidate: avatar,
      unique_filename: !avatar,
      use_filename: false,
      resource_type: "image",
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
      // Transformação de entrada: o que fica ARMAZENADO é no máximo 1080 px, em qualidade automática.
      transformation: [{ width: 1080, height: 1080, crop: "limit", quality: "auto" }],
      tags: [`uid_${user.uid}`], // permite apagar tudo de um usuário (ex.: exclusão de conta)
    });

    return res.status(200).json({ url: result.secure_url, public_id: result.public_id });
  } catch (error) {
    console.error("[upload] falha no Cloudinary:", error); // detalhe só no log do servidor
    return res.status(502).json({ error: "Não foi possível enviar a imagem. Tente novamente." });
  }
}
