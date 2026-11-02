import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "../_lib/auth";
import { resolvePolicy } from "../_lib/version";
import {
  detectarPlataforma,
  isValidTurmaId,
  previaDoDocumento,
  renderizarPagina,
  type PreviaTurma,
} from "../_lib/turmaLink";
import { isValidLinkId, renderizarPaginaTime, timeDoDocumento, type TimePublico } from "../_lib/timeLink";

/**
 * GET /api/turma/<id>  (link de convite compartilhado)
 *
 * Público: não exige login (quem recebe o link talvez nem tenha o app).
 * Lê só a cópia pública `turmaPreviews/<id>` (já liberada para leitura nas regras) para a prévia do link;
 * se demorar ou falhar, a página sai genérica em vez de travar.
 *
 * GET /api/time/<linkId>  (vercel.json reescreve para cá com ?tipo=time: a página pública de um time, sem função nova)
 * Os links das lojas vêm das MESMAS variáveis do /api/version (APP_STORE_URL[_IOS|_ANDROID]), já validadas.
 */
const PREVIA_TIMEOUT_MS = 2500;

const lerPrevia = async (turmaId: string): Promise<PreviaTurma | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const leitura = getFirestore(getFirebaseApp()).collection("turmaPreviews").doc(turmaId).get();
    const limite = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PREVIA_TIMEOUT_MS);
    });
    const snap = await Promise.race([leitura, limite]);
    return snap && snap.exists ? previaDoDocumento(snap.data()) : null;
  } catch (error) {
    console.warn("[turma-link] prévia indisponível:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
/** O time pelo `linkId` (1 leitura; só os campos que a página mostra). null se não existir, demorar ou falhar. */
const lerTime = async (linkId: string): Promise<TimePublico | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const leitura = getFirestore(getFirebaseApp())
      .collection("times")
      .where("linkId", "==", linkId)
      .select("nome", "cor", "donoId", "jogadores")
      .limit(1)
      .get();
    const limite = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PREVIA_TIMEOUT_MS);
    });
    const snap = await Promise.race([leitura, limite]);
    return snap && !snap.empty ? timeDoDocumento(snap.docs[0].data()) : null;
  } catch (error) {
    console.warn("[time-link] time indisponível:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const CABECALHOS_SEGURANCA: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Sem scripts: a página é só HTML e CSS.
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  for (const [nome, valor] of Object.entries(CABECALHOS_SEGURANCA)) res.setHeader(nome, valor);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).send("Método não permitido.");
  }

  const query = req.query ?? {};
  const bruto = Array.isArray(query.id) ? query.id[0] : query.id;
  const ehTime = (Array.isArray(query.tipo) ? query.tipo[0] : query.tipo) === "time";
  if (ehTime ? !isValidLinkId(bruto) : !isValidTurmaId(bruto)) {
    // Nunca devolve o que foi digitado.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(400).send("Link inválido.");
  }

  const lojaIos = resolvePolicy(process.env, "ios").policy.storeUrl;
  const lojaAndroid = resolvePolicy(process.env, "android").policy.storeUrl;
  const plataforma = detectarPlataforma(req.headers["user-agent"]);
  const host = req.headers.host;
  const origin =
    typeof host === "string" && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)
      ? `https://${host}`
      : null;
  const iconUrl = origin ? new URL("/tugyn-icon.png", origin).toString() : null;
  const paginaUrl = origin
    ? new URL(`/api/${ehTime ? "time" : "turma"}/${encodeURIComponent(bruto)}`, origin).toString()
    : null;

  if (ehTime) {
    const time = await lerTime(bruto);
    // As fotos dos jogadores vêm do Cloudinary (a página da turma não mostra imagens de fora).
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' https://res.cloudinary.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Vary", "User-Agent");
    // 5 min na CDN: compartilhar no grupo não vira uma leitura por pessoa que abre; um jogador novo aparece logo.
    res.setHeader("Cache-Control", time ? "public, s-maxage=300, stale-while-revalidate=600" : "public, s-maxage=60");
    return res.status(time ? 200 : 404).send(renderizarPaginaTime({ time, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl }));
  }
  const previa = await lerPrevia(bruto);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // O conteúdo muda conforme o aparelho (qual loja mostrar): a CDN guarda uma cópia por User-Agent.
  res.setHeader("Vary", "User-Agent");
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  return res.status(200).send(renderizarPagina({ id: bruto, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, previa }));
}
