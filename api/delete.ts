import type { VercelRequest, VercelResponse } from "@vercel/node";
import { v2 as cloudinary } from "cloudinary";
import { getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { handleCors } from "./_lib/cors";
import { getAccount, isAdminOnlyBucket } from "./_lib/config";
import { COLECAO_CAMPANHAS, DOC_ANUNCIOS_PUBLICADOS } from "./_lib/publicacaoAnuncios";
import { dentroDoLimite } from "./_lib/rateLimit";
import { parseBannerDeAnuncio, parseBucket, parseOwnedPublicId, textosDoDocumento, urlUsaImagem } from "./_lib/validation";

const MAX_EXCLUSOES_POR_HORA = 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return; // painel de anúncios (navegador): consulta prévia e cabeçalhos de CORS

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res, "apagar-midia");
  if (!user) return;
  // Administradores usam o painel (navegador, sem App Check); o app manda o token.
  if (!user.admin && !(await verificarAppCheck(req, res, "delete"))) return;

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

  let publicId: string | null;
  if (isAdminOnlyBucket(bucket)) {
    // Banners de anúncio: a pasta é só de administradores, então QUALQUER administrador apaga (o banner pode ter sido enviado
    // por outro administrador ou pela mesma pessoa em outra conta). Ficam de fora a imagem do contrato e a que ainda está em uso.
    const banner = parseBannerDeAnuncio(body.public_id);
    if (banner === "contrato") {
      return res.status(403).json({ error: "Esta é a imagem de um contrato (o banner aprovado pelo cliente): ela não é apagada pelo painel." });
    }
    if (!banner) return res.status(400).json({ error: "Imagem inválida." });
    try {
      // Em uso = alguma campanha aponta para ela OU os anúncios publicados (o que o app mostra agora) ainda a usam: uma
      // campanha excluída sem republicar continua no publicado até a próxima publicação.
      const db = getFirestore(getFirebaseApp());
      const cloud = getAccount(bucket)?.cloud_name;
      const [campanhas, publicados] = await Promise.all([
        db.collection(COLECAO_CAMPANHAS).select("imageUrl").get(),
        db.doc(DOC_ANUNCIOS_PUBLICADOS).get(),
      ]);
      if (campanhas.docs.some((doc) => urlUsaImagem(doc.get("imageUrl"), banner, cloud))) {
        return res.status(409).json({ code: "em_campanha", error: "Outra campanha ainda usa esta imagem: ela foi mantida." });
      }
      if (publicados.exists && textosDoDocumento(publicados.data()).some((texto) => urlUsaImagem(texto, banner, cloud))) {
        return res.status(409).json({ code: "publicada", error: "Esta imagem ainda aparece nos anúncios publicados: publique os anúncios de novo e tente apagar depois." });
      }
    } catch (error) {
      console.error("[delete] não foi possível conferir as campanhas:", error);
      return res.status(503).json({ error: "Não foi possível conferir se a imagem está em uso. Tente novamente." });
    }
    publicId = banner;
  } else {
    // Demais imagens: só o que está DENTRO da pasta do próprio usuário (`<bucket>/<uid>/...`).
    publicId = parseOwnedPublicId(body.public_id, bucket, user.uid);
    if (!publicId) return res.status(403).json({ error: "Você não pode apagar esta imagem." });
  }

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
