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

/**
 * GET /api/turma/<id>  (link de convite compartilhado)
 *
 * Público: não exige login (quem recebe o link talvez nem tenha o app).
 * Lê só a cópia pública `turmaPreviews/<id>` (já liberada para leitura nas regras) para a prévia do link;
 * se demorar ou falhar, a página sai genérica em vez de travar.
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
  if (!isValidTurmaId(bruto)) {
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
    ? new URL(`/api/turma/${encodeURIComponent(bruto)}`, origin).toString()
    : null;
  const previa = await lerPrevia(bruto);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // O conteúdo muda conforme o aparelho (qual loja mostrar): a CDN guarda uma cópia por User-Agent.
  res.setHeader("Vary", "User-Agent");
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  return res.status(200).send(renderizarPagina({ id: bruto, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, previa }));
}
