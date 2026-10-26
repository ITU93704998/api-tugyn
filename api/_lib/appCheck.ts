import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAppCheck } from "firebase-admin/app-check";
import { getFirebaseApp } from "./auth";

/**
 * App Check: confere que a requisição veio do app Tugyn original (Play Integrity / App Attest).
 * O app manda o token no cabeçalho `X-Firebase-AppCheck`.
 *
 * Interruptor `APP_CHECK_ENFORCE` (variável de ambiente da Vercel):
 *   "true"  → sem token válido, responde 401 e a rota para.
 *   outro   → só registra no log (`app_check_missing` / `app_check_invalid`) e deixa passar.
 * Assim dá para desligar o bloqueio na hora, sem deploy, se algo der errado.
 *
 * O painel de anúncios (navegador) não tem App Check: as rotas que ele usa liberam administradores
 * (claim `admin`, conferida no token do login) antes de chamar esta função.
 */
const bloquear = (): boolean => process.env.APP_CHECK_ENFORCE === "true";

/** `code` deixa o app diferenciar esta recusa de um login expirado (os dois são 401). */
const RECUSA = { code: "app_check_failed", error: "Requisição não verificada. Atualize o app e tente novamente." };

const lerToken = (req: VercelRequest): string | null => {
  const bruto = req.headers["x-firebase-appcheck"];
  const token = Array.isArray(bruto) ? bruto[0] : bruto;
  return typeof token === "string" && token.length > 0 && token.length <= 4096 ? token : null;
};

/** true = pode seguir. false = já respondeu 401. */
export const verificarAppCheck = async (
  req: VercelRequest,
  res: VercelResponse,
  rota: string,
): Promise<boolean> => {
  const token = lerToken(req);
  if (!token) {
    console.log(JSON.stringify({ evt: "app_check_missing", rota, bloqueado: bloquear() }));
    if (!bloquear()) return true;
    res.status(401).json(RECUSA);
    return false;
  }

  try {
    await getAppCheck(getFirebaseApp()).verifyToken(token);
    return true;
  } catch (error) {
    console.log(
      JSON.stringify({
        evt: "app_check_invalid",
        rota,
        bloqueado: bloquear(),
        motivo: error instanceof Error ? error.message.slice(0, 120) : "desconhecido",
      }),
    );
    if (!bloquear()) return true;
    res.status(401).json(RECUSA);
    return false;
  }
};
