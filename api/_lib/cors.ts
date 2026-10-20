import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * CORS para o PAINEL de anúncios (um site, em outro endereço que o da API). O app de celular não precisa disto: só o navegador
 * bloqueia chamadas entre endereços diferentes, e antes de um envio com `Authorization` ele faz uma consulta prévia (`OPTIONS`).
 *
 * Só os endereços listados em `PANEL_ORIGINS` (separados por vírgula, ex.: `http://localhost:5173,https://painel.vercel.app`) são
 * liberados. Nunca `*`. Sem a variável, nada muda para o navegador (continua bloqueado), e o app de celular segue igual.
 */
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

/** Endereços válidos da variável: sem barra no fim, sem `*`, sem caminho; o que estiver fora do padrão é descartado. */
export const parseAllowedOrigins = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter((item) => ORIGIN_PATTERN.test(item));

/**
 * Aplica os cabeçalhos de CORS e responde a consulta prévia (`OPTIONS`). Chame no INÍCIO da rota.
 * Devolve true se a requisição já foi respondida (era `OPTIONS`): a rota deve parar.
 */
export const handleCors = (req: VercelRequest, res: VercelResponse): boolean => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const allowed = origin !== "" && parseAllowedOrigins(process.env.PANEL_ORIGINS).includes(origin);

  if (origin) res.setHeader("Vary", "Origin");
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method !== "OPTIONS") return false;
  // A consulta prévia não leva login: responde antes de qualquer autenticação ou limite.
  if (allowed) res.status(204).send("");
  else res.status(403).json({ error: "Origem não autorizada." });
  return true;
};
