import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { excluirConta, StepError } from "./_lib/accountDeletion";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import { deltaDeRemocao, notasDe } from "./_lib/avaliacoes";
import { apagarImagensDoUsuario } from "./_lib/cloudinaryCleanup";
import { dentroDoLimite } from "./_lib/rateLimit";

/** Apagar a conta é irreversível: exige senha digitada há pouco (o app reautentica antes de chamar). */
const MAX_IDADE_DO_LOGIN_SEGUNDOS = 5 * 60;

/** Apagar tudo pode levar um tempo (turmas com muitas partidas). Se estourar, é só tentar de novo. */
export const config = { maxDuration: 60 };

/**
 * Coleções fora do que foi analisado (notificações, convites, times...) que guardam o uid em algum
 * campo. Preencha quando souber, ex.: { collection: "notifications", field: "userId" }.
 */
const EXTRA_COLLECTIONS: { collection: string; field: string }[] = [
  { collection: "pushTokens", field: "uid" }, // tokens de notificação do usuário (api/push.ts)
  { collection: "pushDedupe", field: "targetUid" }, // registros de "já avisei" (api/push.ts)
  { collection: "desafios", field: "desafianteId" }, // desafios que ele criou (api/desafios.ts)
  { collection: "desafios", field: "desafiadoId" }, // desafios que ele recebeu
  { collection: "avaliacoes", field: "avaliadoId" }, // avaliações que ele recebeu (o resumo some junto com o perfil)
  { collection: "desafiosVagas", field: "uid" }, // vagas de desafio dele (api/desafios.ts)
];

/** Desafios em aberto dele, lidos ANTES da exclusão (o documento de vagas some junto): `{ desafioId: adversário }`. */
const desafiosEmAberto = async (db: Firestore, uid: string): Promise<Record<string, string>> => {
  const snap = await db.doc(`desafiosVagas/${uid}`).get();
  const ativos = snap.get("ativos");
  const pares: Record<string, string> = {};
  if (!ativos || typeof ativos !== "object") return pares;
  for (const id of Object.keys(ativos as Record<string, unknown>)) {
    const [, a, b] = id.split("__");
    const outro = a === uid ? b : b === uid ? a : null;
    if (outro && /^[A-Za-z0-9_-]{1,128}$/.test(outro)) pares[id] = outro;
  }
  return pares;
};

/** Os desafios dele foram apagados: a vaga que cada um ocupava no adversário é liberada. */
const liberarVagasDosAdversarios = async (db: Firestore, pares: Record<string, string>): Promise<void> => {
  const porAdversario = new Map<string, string[]>();
  for (const [id, outro] of Object.entries(pares)) porAdversario.set(outro, [...(porAdversario.get(outro) ?? []), id]);
  for (const [outro, ids] of porAdversario) {
    await db.doc(`desafiosVagas/${outro}`).set({ ativos: Object.fromEntries(ids.map((id) => [id, FieldValue.delete()])) }, { merge: true });
  }
};

/**
 * Avaliações que ele DEU (api/avaliacoes.ts): cada uma sai do resumo do avaliado e é apagada. Roda depois que a conta já
 * foi excluída (se a exclusão parar no meio, nada some antes da hora). Falha aqui só vai para o log.
 */
const removerAvaliacoesDadas = async (db: Firestore, uid: string): Promise<void> => {
  const snap = await db.collection("avaliacoes").where("avaliadorId", "==", uid).get();
  for (const docSnap of snap.docs) {
    await db.runTransaction(async (tx) => {
      const atual = await tx.get(docSnap.ref);
      if (!atual.exists) return;
      const notas = notasDe(atual.data());
      const avaliadoId = atual.get("avaliadoId");
      if (notas && typeof avaliadoId === "string" && avaliadoId) {
        const perfilRef = db.doc(`users/${avaliadoId}`);
        const perfil = await tx.get(perfilRef);
        if (perfil.exists) {
          const d = deltaDeRemocao(notas);
          tx.update(perfilRef, {
            "avaliacao.convivencia": FieldValue.increment(d.convivencia),
            "avaliacao.comprometimento": FieldValue.increment(d.comprometimento),
            "avaliacao.fairPlay": FieldValue.increment(d.fairPlay),
            "avaliacao.total": FieldValue.increment(d.total),
          });
        }
      }
      tx.delete(docSnap.ref);
    });
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res);
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
    const app = getFirebaseApp();
    const desafios = await desafiosEmAberto(getFirestore(app), user.uid).catch(() => ({}));
    const outcome = await excluirConta(
      {
        db: getFirestore(app),
        apagarImagens: async (uid) => {
          const avisos = await apagarImagensDoUsuario(uid);
          if (avisos.length) console.error(JSON.stringify({ evt: "account_delete_warning", avisos }));
        },
        apagarContaAuth: async (uid) => {
          try {
            await getAuth(app).deleteUser(uid);
          } catch (erro) {
            if ((erro as { code?: string }).code !== "auth/user-not-found") throw erro;
          }
        },
      },
      user.uid,
      { closeOwnedTurmas, extraCollections: EXTRA_COLLECTIONS },
    );

    if (!outcome.ok) {
      return res.status(409).json({
        code: outcome.reason,
        turmas: outcome.turmas,
        error: "Você organiza turmas com outros participantes.",
      });
    }

    try {
      await removerAvaliacoesDadas(getFirestore(app), user.uid);
    } catch (erro) {
      console.error(JSON.stringify({ evt: "account_delete_warning", step: "avaliacoes_dadas", message: (erro as Error)?.message ?? String(erro) }));
    }
    try {
      await liberarVagasDosAdversarios(getFirestore(app), desafios);
    } catch (erro) {
      console.error(JSON.stringify({ evt: "account_delete_warning", step: "vagas_desafios", message: (erro as Error)?.message ?? String(erro) }));
    }

    console.log(JSON.stringify({ evt: "account_deleted", ...outcome.report }));
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
