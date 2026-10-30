import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./_lib/appCheck";
import { getFirebaseApp, requireUser } from "./_lib/auth";
import {
  DIAS_ENTRE_ENVIOS,
  autorizarAvaliacao,
  deltaDoResumo,
  idDaAvaliacao,
  parseAvaliacaoBody,
  type AvaliacaoRequest,
  type Resumo,
} from "./_lib/avaliacoes";
import { dentroDoLimite } from "./_lib/rateLimit";
import { perfilDisponivel } from "./_lib/suspensao";

/**
 * POST /api/avaliacoes   (corpo: { avaliadoId, turmaId, notas: { convivencia, comprometimento, fairPlay } })
 * Cria ou edita a avaliação que o usuário dá a um colega de turma. Pelo servidor porque o avaliado NÃO pode ver quem
 * avaliou (o app não grava nada em `avaliacoes` nem no resumo `users/{uid}/restrito/perfil.avaliacao`). Regras em `_lib/avaliacoes.ts`.
 * O resumo fica na parte RESTRITA do perfil: com o perfil privado, as regras do Firestore só deixam o dono ler.
 */

const COLECAO = "avaliacoes";
const LIMITE_POR_HORA = 30;
const DIA_MS = 24 * 3600_000;

type Resultado = { ok: true; proximaEm: number } | { ok: false; status: number; code: string; error: string; proximaEm?: number };

/** Soma no resumo do perfil (só números: nada de quem avaliou nem quando). */
const somarNoResumo =(delta: Resumo) => ({
  avaliacao: {
    convivencia: FieldValue.increment(delta.convivencia),
    comprometimento: FieldValue.increment(delta.comprometimento),
    fairPlay: FieldValue.increment(delta.fairPlay),
    total: FieldValue.increment(delta.total),
  },
});

/** Exportada para o teste de concorrência no emulador (`tests-emulador/`). */
export const avaliar = async (db: Firestore, uid: string, pedido: AvaliacaoRequest): Promise<Resultado> => {
  const { avaliadoId, turmaId, notas } = pedido;
  const ref = db.doc(`${COLECAO}/${idDaAvaliacao(uid, avaliadoId)}`);
  const perfilRef = db.doc(`users/${avaliadoId}`);

  // TUDO o que decide é lido DENTRO da transação (turma, perfil, bloqueios e a avaliação anterior): uma saída da turma, um
  // bloqueio ou o início da exclusão da conta (`excluindoEm` no perfil) ao mesmo tempo faz a transação reler e decidir de
  // novo. Como o perfil fica travado pela leitura, a exclusão só apaga a conta DEPOIS desta gravação: o resumo nunca fica
  // órfão (documento parcial sem perfil).
  return db.runTransaction(async (tx): Promise<Resultado> => {
    const [anterior, turma, perfil, bloqueioA, bloqueioB, avaliador] = await tx.getAll(
      ref,
      db.doc(`turmas/${turmaId}`),
      perfilRef,
      db.doc(`users/${uid}/blocked/${avaliadoId}`),
      db.doc(`users/${avaliadoId}/blocked/${uid}`),
      db.doc(`users/${uid}`),
    );
    // Quem avalia está excluindo a conta: a exclusão já vai apagar as avaliações que ele deu, nada novo pode entrar.
    if (!perfilDisponivel(avaliador.exists ? (avaliador.data() ?? null) : null)) {
      return { ok: false, status: 403, code: "conta_indisponivel", error: "Sua conta não pode avaliar agora." };
    }
    const agoraMs = Date.now();
    const auth = autorizarAvaliacao({
      uid,
      avaliadoId,
      agoraMs,
      turma: turma.exists ? (turma.data() ?? null) : null,
      perfilAvaliado: perfil.exists ? (perfil.data() ?? null) : null,
      bloqueio: bloqueioA.exists || bloqueioB.exists,
      anterior: anterior.exists ? (anterior.data() ?? null) : null,
    });
    if (!auth.ok) return auth;

    tx.set(ref, {
      avaliadorId: uid,
      avaliadoId,
      notas,
      ...(anterior.exists ? {} : { criadoEm: FieldValue.serverTimestamp() }),
      atualizadoEm: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(db.doc(`users/${avaliadoId}/restrito/perfil`), somarNoResumo(deltaDoResumo(notas, auth.anteriores)), { merge: true });
    return { ok: true, proximaEm: agoraMs + DIAS_ENTRE_ENVIOS * DIA_MS };
  });
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const user = await requireUser(req, res, "avaliar");
  if (!user) return;
  if (!(await verificarAppCheck(req, res, "avaliacoes"))) return;

  const parsed = parseAvaliacaoBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  if (!(await dentroDoLimite(user.uid, "avaliacoes", LIMITE_POR_HORA, 3600))) {
    return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
  }

  let db: Firestore;
  try {
    db = getFirestore(getFirebaseApp());
  } catch (error) {
    console.error("[avaliacoes] Firebase Admin não configurado:", error);
    return res.status(500).json({ error: "Servidor não configurado." });
  }

  try {
    const resultado = await avaliar(db, user.uid, parsed.value);
    if (!resultado.ok) {
      return res.status(resultado.status).json({ code: resultado.code, error: resultado.error, ...(resultado.proximaEm ? { proximaEm: resultado.proximaEm } : {}) });
    }
    console.log(JSON.stringify({ evt: "avaliacao_salva" }));
    return res.status(200).json({ success: true, proximaEm: resultado.proximaEm });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "avaliacao_failed", message: (erro as Error)?.message ?? String(erro) }));
    return res.status(502).json({ error: "Não foi possível salvar agora. Tente novamente." });
  }
}
