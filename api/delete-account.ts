import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore } from "firebase-admin/firestore";
import { StepError } from "./_lib/accountDeletion";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { executarExclusao, processarJob } from "./_lib/exclusaoContaJob";
import { dentroDoLimite } from "./_lib/rateLimit";

/** Apagar a conta é irreversível: exige senha digitada há pouco (o app reautentica antes de chamar). */
const MAX_IDADE_DO_LOGIN_SEGUNDOS = 5 * 60;

/** Apagar tudo pode levar um tempo (turmas com muitas partidas). Se estourar, é só tentar de novo. */
export const config = { maxDuration: 60 };

/**
 * Exclusão de conta em job durável (`exclusoesConta/{uid}`, ver `_lib/exclusaoConta.ts`): a lápide é gravada antes de
 * qualquer remoção; o fluxo principal termina com a conta do Auth; as etapas que dependem disso (avaliações dadas, vagas dos
 * adversários, imagens) e a verificação final rodam aqui e, se algo ficar pendente, a rotina diária continua até concluir.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res, "excluir-conta");
  if (!user) return;
  if (!(await verificarAppCheck(req, res, "delete-account"))) return;

  if (Date.now() / 1000 - user.authTime > MAX_IDADE_DO_LOGIN_SEGUNDOS) {
    return res.status(403).json({
      code: "recent_login_required",
      error: "Confirme sua senha novamente para excluir a conta.",
    });
  }

  if (!(await dentroDoLimite(user.uid, "delete-account", 5, 3600))) {
    return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
  }

  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  // Só o booleano `true` vale (nada de "true" em texto): encerrar turmas é uma escolha explícita.
  const closeOwnedTurmas = body.closeOwnedTurmas === true;

  try {
    const db = getFirestore(getFirebaseApp());
    const outcome = await executarExclusao(db, user.uid, closeOwnedTurmas);

    if (!outcome.ok) {
      return res.status(409).json({
        code: outcome.reason,
        turmas: outcome.turmas,
        error: "Você organiza turmas com outros participantes.",
      });
    }

    // A conta já saiu: o resto é do job. Pendência aqui não é erro para a pessoa (a rotina diária termina e alerta).
    let concluida = false;
    try {
      concluida = await processarJob(db, user.uid);
    } catch (erro) {
      console.error(JSON.stringify({ evt: "account_delete_job_failed", message: (erro as Error)?.message ?? String(erro) }));
    }

    console.log(JSON.stringify({ evt: "account_deleted", concluida, ...outcome.report }));
    return res.status(200).json({ success: true });
  } catch (erro) {
    const step = erro instanceof StepError ? erro.step : "desconhecida";
    const causa = erro instanceof StepError ? erro.causa : erro;
    // Detalhe só no log do servidor; o cliente recebe uma mensagem genérica e pode tentar de novo.
    console.error(JSON.stringify({ evt: "account_delete_failed", step, message: (causa as Error)?.message ?? String(causa) }));
    return res.status(502).json({
      code: "delete_failed",
      error: "Não foi possível concluir a exclusão. Tente novamente.",
      retryable: true,
    });
  }
}
