import type { VercelRequest, VercelResponse } from "@vercel/node";
import { compareVersions, isValidVersion, parsePlatform, resolvePolicy } from "./_lib/version";

/**
 * GET /api/version?platform=ios|android&version=1.4.0
 *
 * Público (o app precisa dela ANTES do login) e estático: não toca no Firestore. Devolve a versão
 * mínima (bloqueia) e a mais recente (só avisa). Configure pelas variáveis de ambiente da Vercel:
 *   APP_MIN_VERSION[_IOS|_ANDROID]    APP_LATEST_VERSION[_IOS|_ANDROID]
 *   APP_STORE_URL[_IOS|_ANDROID]      APP_UPDATE_MESSAGE (opcional)
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const query = req.query ?? {};
  const platform = parsePlatform(query.platform);

  const { policy, warnings } = resolvePolicy(process.env, platform);
  for (const warning of warnings) console.error(`[version] configuração: ${warning}`);

  // Registro (sem dados pessoais) de quantas instalações estão sendo bloqueadas.
  const rawVersion = Array.isArray(query.version) ? query.version[0] : query.version;
  if (policy.minVersion && isValidVersion(rawVersion) && compareVersions(rawVersion, policy.minVersion) < 0) {
    console.log(JSON.stringify({ evt: "version_blocked", platform, version: rawVersion, min: policy.minVersion }));
  }

  // A CDN da Vercel guarda por 1 min: trocar a versão mínima faz efeito em até ~1 min.
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(200).json(policy);
}
