import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleContacts } from "./_lib/contatos";
import { handleModeracao } from "./_lib/moderacao";
import { handleRevisao } from "./_lib/revisao";
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
  if (req.query?.resource === "contatos") return handleContacts(req, res);
  // Moderação do painel (Segurança › Denúncias): só administradores. Fica aqui para não criar outra função na Vercel.
  if (req.query?.resource === "moderacao") return handleModeracao(req, res);
  // Pedido de revisão de conta suspensa (app e site, SEM login: a conta suspensa não entra).
  if (req.query?.resource === "revisao") return handleRevisao(req, res);
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
