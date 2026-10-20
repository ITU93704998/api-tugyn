import type { VercelRequest, VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { requireUser } from "./_lib/auth";
import { handleCors } from "./_lib/cors";
import { getAccount, isAdminOnlyBucket } from "./_lib/config";
import { dentroDoLimite } from "./_lib/rateLimit";
import { parseBucket, parseOwnedPublicId } from "./_lib/validation";

const MAX_EXCLUSOES_POR_HORA = 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return; // painel de anúncios (navegador): consulta prévia e cabeçalhos de CORS

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  if (!(await dentroDoLimite(user.uid, "delete", MAX_EXCLUSOES_POR_HORA, 3600))) {
    return res.status(429).json({ error: "Muitas exclusões em pouco tempo. Tente novamente mais tarde." });
  }

  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

  const bucket = parseBucket(body.bucket);
  if (!bucket) return res.status(400).json({ error: "Bucket inválido." });

  if (isAdminOnlyBucket(bucket) && !user.admin) {
    return res.status(403).json({ error: "Somente administradores apagam imagens de anúncios." });
  }

  // Só é possível apagar o que está DENTRO da pasta do próprio usuário (`<bucket>/<uid>/...`).
  const publicId = parseOwnedPublicId(body.public_id, bucket, user.uid);
  if (!publicId) return res.status(403).json({ error: "Você não pode apagar esta imagem." });

  const account = getAccount(bucket);
  if (!account) {
    console.error(`[delete] bucket "${bucket}" sem credenciais no ambiente`);
    return res.status(500).json({ error: "Servidor não configurado para este tipo de imagem." });
  }

  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      ...account,
      resource_type: "image",
      invalidate: true, // limpa o cache da CDN: a imagem some na hora
    });

    // "not found" = já não existe. Apagar é idempotente: o resultado desejado foi alcançado.
    return res.status(200).json({ success: true, alreadyDeleted: result.result === "not found" });
  } catch (error) {
    console.error("[delete] falha no Cloudinary:", error);
    return res.status(502).json({ error: "Não foi possível apagar a imagem. Tente novamente." });
  }
}
