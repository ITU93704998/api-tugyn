import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";
import { isSafeUid } from "./validation";

/**
 * Moderação pelo painel (Segurança › Denúncias): POST /api/version?resource=moderacao, só para a permissão `admin`.
 *
 *  consultar      { tipo: "user" | "turma", id, denuncias? }  → situação atual do alvo + histórico de medidas
 *                 (com `denuncias: true`, também as denúncias recebidas, para decidir um pedido de revisão)
 *  suspender      { id, motivo }  → os MESMOS passos de `scripts/moderar-conta.cjs suspender` (status, Auth desativado,
 *                                   sessões revogadas, tokens de aviso apagados) e resolve as denúncias do usuário
 *  reativar       { id, motivo }  → reativa no Auth e volta o status para "active" (e aceita o pedido de revisão aberto)
 *  manterSuspensao { id, motivo } → nega o pedido de revisão aberto (`revisoes/{uid}`); a conta continua suspensa
 *  encerrarTurma  { id, motivo }  → encerra a turma (como o organizador faria) marcando `encerradaPor: "moderacao"`
 *                                   e resolve as denúncias da turma
 *  reabrirTurma   { id, motivo }  → só reabre turma encerrada pela moderação
 *
 * Toda medida grava `moderacaoLog/{id}` (ação, alvo, quem, motivo, quando). Clientes não leem nem gravam essa coleção.
 * Se mudar os passos da suspensão aqui, mude também no script (ele roda sem build e não importa este arquivo).
 */

export const MOTIVO_MIN = 3;
export const MOTIVO_MAX = 500;
const LOG = "moderacaoLog";
const HISTORICO_MAX = 20;
const DENUNCIAS_MAX = 50;
const STATUS_DENUNCIA = ["open", "reviewing", "resolved", "dismissed"] as const;

type Tipo = "user" | "turma";
type Acao = "suspender" | "reativar" | "manterSuspensao" | "encerrarTurma" | "reabrirTurma";
const ACOES: readonly Acao[] = ["suspender", "reativar", "manterSuspensao", "encerrarTurma", "reabrirTurma"];
const ACOES_DE_USUARIO: readonly Acao[] = ["suspender", "reativar", "manterSuspensao"];
const REVISOES = "revisoes";

export interface Medida {
  acao: Acao;
  adminUid: string;
  motivo: string;
  em: number;
  denunciasResolvidas: number;
}

export interface EstadoDoAlvo {
  tipo: Tipo;
  id: string;
  existe: boolean;
  nome: string;
  /** Usuário: @. Turma: nome do organizador. */
  detalhe: string;
  foto: string;
  /** Usuário: "ativa" | "suspensa". Turma: "ativa" | "encerrada". */
  situacao: "ativa" | "suspensa" | "encerrada";
  desde: number;
  /** Turma encerrada pela moderação (só essa a moderação reabre). */
  pelaModeracao: boolean;
  historico: Medida[];
  /** Só quando pedido (`denuncias: true`): denúncias recebidas, da mais recente para a mais antiga. Sem quem denunciou. */
  denuncias?: DenunciaRecebida[];
}

export interface DenunciaRecebida {
  motivo: string;
  detalhes: string;
  status: (typeof STATUS_DENUNCIA)[number];
  em: number;
  nota: string;
}

class Recusa extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const txt = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const ms = (v: unknown): number => {
  const fn = (v as { toMillis?: unknown } | null)?.toMillis;
  if (typeof fn === "function") {
    const n = fn.call(v);
    return Number.isFinite(n) ? n : 0;
  }
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/** Motivo obrigatório nas medidas: texto simples, sem caracteres de controle. */
export const parseMotivo = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const limpo = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return limpo.length >= MOTIVO_MIN && limpo.length <= MOTIVO_MAX ? limpo : null;
};

async function historico(db: Firestore, id: string): Promise<Medida[]> {
  // Um filtro só (não pede índice composto); ordena aqui.
  const snap = await db.collection(LOG).where("alvoId", "==", id).limit(HISTORICO_MAX).get();
  return snap.docs
    .map((d) => d.data())
    .map((d) => ({
      acao: (ACOES as readonly string[]).includes(d.acao) ? (d.acao as Acao) : "suspender",
      adminUid: txt(d.adminUid, 128),
      motivo: txt(d.motivo, MOTIVO_MAX),
      em: ms(d.em),
      denunciasResolvidas: Number.isSafeInteger(d.denunciasResolvidas) ? d.denunciasResolvidas : 0,
    }))
    .sort((a, b) => b.em - a.em);
}

/** Denúncias recebidas pelo alvo (todas as situações). Não devolve quem denunciou. */
async function denunciasRecebidas(db: Firestore, tipo: Tipo, id: string): Promise<DenunciaRecebida[]> {
  const snap = await db.collection("reports").where("targetId", "==", id).limit(300).get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((d) => d.targetType === tipo)
    .map((d) => ({
      motivo: txt(d.reason, 40) || "other",
      detalhes: txt(d.details, 500),
      status: (STATUS_DENUNCIA as readonly string[]).includes(d.status) ? (d.status as DenunciaRecebida["status"]) : "open",
      em: ms(d.createdAt),
      nota: txt(d.nota, MOTIVO_MAX),
    }))
    .sort((a, b) => b.em - a.em)
    .slice(0, DENUNCIAS_MAX);
}

export async function consultar(db: Firestore, tipo: Tipo, id: string, comDenuncias = false): Promise<EstadoDoAlvo> {
  const [snap, medidas, denuncias] = await Promise.all([
    db.doc(`${tipo === "user" ? "users" : "turmas"}/${id}`).get(),
    historico(db, id),
    comDenuncias ? denunciasRecebidas(db, tipo, id) : Promise.resolve(undefined),
  ]);
  const d = snap.exists ? snap.data() ?? {} : {};
  const base = {
    tipo,
    id,
    existe: snap.exists,
    historico: medidas.filter((m) => (tipo === "user") === ACOES_DE_USUARIO.includes(m.acao)),
    ...(denuncias ? { denuncias } : {}),
  };
  if (tipo === "user") {
    const suspensa = d.status === "suspended";
    return {
      ...base,
      nome: txt(d.name, 80),
      detalhe: d.userName ? `@${txt(d.userName, 30).replace(/^@/, "")}` : "",
      foto: txt(d.profileImage, 500),
      situacao: suspensa ? "suspensa" : "ativa",
      desde: suspensa ? ms(d.suspensaEm) : 0,
      pelaModeracao: suspensa,
    };
  }
  const encerrada = d.status === "encerrada" || d.ativo === false;
  return {
    ...base,
    nome: txt(d.nome, 80),
    detalhe: txt(d.creatorName, 80),
    foto: txt(d.bannerUrl, 500),
    situacao: encerrada ? "encerrada" : "ativa",
    desde: encerrada ? ms(d.encerradaEm) : 0,
    pelaModeracao: encerrada && d.encerradaPor === "moderacao",
  };
}

/** Resolve as denúncias abertas/em análise do alvo, com a medida na nota. Devolve quantas mudou. */
async function resolverDenuncias(db: Firestore, tipo: Tipo, id: string, nota: string, adminUid: string): Promise<number> {
  const snap = await db.collection("reports").where("targetId", "==", id).limit(300).get();
  const alvo = snap.docs.filter((d) => d.get("targetType") === tipo && (d.get("status") === "open" || d.get("status") === "reviewing"));
  if (!alvo.length) return 0;
  const batch = db.batch();
  for (const d of alvo) {
    batch.update(d.ref, { status: "resolved", nota: nota.slice(0, MOTIVO_MAX), atualizadoPor: adminUid, atualizadoEm: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  return alvo.length;
}

/** Fecha o pedido de revisão aberto da conta. `exigir`: sem pedido aberto, recusa (409). */
async function decidirRevisao(db: Firestore, uid: string, decisao: "aceita" | "negada", nota: string, adminUid: string, exigir: boolean): Promise<void> {
  const ref = db.doc(`${REVISOES}/${uid}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get("status") !== "aberta") {
    if (exigir) throw new Recusa(409, "Não há pedido de revisão em aberto para esta conta.");
    return;
  }
  await ref.update({ status: decisao, nota: nota.slice(0, MOTIVO_MAX), decididaPor: adminUid, decididaEm: FieldValue.serverTimestamp() });
}

const ignorarSemConta = (erro: unknown) => {
  // Perfil sem conta no Auth (apagada à mão): o status no Firestore já basta.
  if ((erro as { code?: unknown } | null)?.code !== "auth/user-not-found") throw erro;
};

export async function aplicar(db: Firestore, acao: Acao, id: string, motivo: string, adminUid: string): Promise<EstadoDoAlvo> {
  const auth = getAuth(getFirebaseApp());
  const tipo: Tipo = ACOES_DE_USUARIO.includes(acao) ? "user" : "turma";
  const ref = db.doc(`${tipo === "user" ? "users" : "turmas"}/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Recusa(404, tipo === "user" ? "Usuário não encontrado." : "Turma não encontrada.");
  const nomeDoAlvo = txt(tipo === "user" ? snap.get("name") : snap.get("nome"), 80);
  let denunciasResolvidas = 0;

  if (acao === "suspender") {
    if (id === adminUid) throw new Recusa(400, "Você não pode suspender a própria conta.");
    const conta = await auth.getUser(id).catch((erro) => {
      ignorarSemConta(erro);
      return null;
    });
    if (conta?.customClaims?.admin === true) throw new Recusa(409, "Esta conta é de administrador: remova a permissão antes de suspender.");
    await ref.update({ status: "suspended", suspensaEm: FieldValue.serverTimestamp() });
    await auth.updateUser(id, { disabled: true }).catch(ignorarSemConta);
    await auth.revokeRefreshTokens(id).catch(ignorarSemConta);
    const tokens = await db.collection("pushTokens").where("uid", "==", id).get();
    for (const t of tokens.docs) await t.ref.delete();
    denunciasResolvidas = await resolverDenuncias(db, "user", id, `Conta suspensa: ${motivo}`, adminUid);
  } else if (acao === "reativar") {
    await auth.updateUser(id, { disabled: false }).catch(ignorarSemConta);
    await ref.update({ status: "active", suspensaEm: FieldValue.delete() });
    await decidirRevisao(db, id, "aceita", motivo, adminUid, false);
  } else if (acao === "manterSuspensao") {
    if (snap.get("status") !== "suspended") throw new Recusa(409, "Esta conta não está suspensa.");
    await decidirRevisao(db, id, "negada", motivo, adminUid, true);
  } else if (acao === "encerrarTurma") {
    await ref.update({
      status: "encerrada",
      ativo: false,
      encerradaEm: FieldValue.serverTimestamp(),
      encerradaPor: "moderacao",
      updatedAt: FieldValue.serverTimestamp(),
      // muda a "versão" da turma: os caches dos membros se renovam
      ultimaAtividade: FieldValue.serverTimestamp(),
    });
    denunciasResolvidas = await resolverDenuncias(db, "turma", id, `Turma encerrada: ${motivo}`, adminUid);
  } else {
    if (snap.get("encerradaPor") !== "moderacao") throw new Recusa(409, "Só é possível reabrir turmas encerradas pela moderação.");
    await ref.update({
      status: "ativa",
      ativo: true,
      encerradaEm: null,
      encerradaPor: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
      ultimaAtividade: FieldValue.serverTimestamp(),
    });
  }

  await db.collection(LOG).add({
    acao,
    alvoTipo: tipo,
    alvoId: id,
    alvoNome: nomeDoAlvo,
    adminUid,
    motivo,
    denunciasResolvidas,
    em: FieldValue.serverTimestamp(),
  });
  console.log(JSON.stringify({ evt: "moderacao", acao, tipo, denunciasResolvidas }));
  return consultar(db, tipo, id);
}

export async function handleModeracao(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (handleCors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "moderacao");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Apenas administradores podem moderar." });
  if (!(await dentroDoLimite(user.uid, "moderacao", 60, 60))) return res.status(429).json({ error: "Muitas ações seguidas. Aguarde um minuto." });

  const body = req.body ?? {};
  const id = body.id;
  if (!isSafeUid(id)) return res.status(400).json({ error: "Identificador inválido." });

  try {
    const db = getFirestore(getFirebaseApp());
    if (body.action === "consultar") {
      if (body.tipo !== "user" && body.tipo !== "turma") return res.status(400).json({ error: "Tipo inválido." });
      return res.status(200).json(await consultar(db, body.tipo, id, body.denuncias === true));
    }
    if (!(ACOES as readonly unknown[]).includes(body.action)) return res.status(400).json({ error: "Ação inválida." });
    const motivo = parseMotivo(body.motivo);
    if (!motivo) return res.status(400).json({ error: `Escreva o motivo (de ${MOTIVO_MIN} a ${MOTIVO_MAX} caracteres).` });
    return res.status(200).json(await aplicar(db, body.action as Acao, id, motivo, user.uid));
  } catch (erro) {
    if (erro instanceof Recusa) return res.status(erro.status).json({ error: erro.message });
    console.error(JSON.stringify({ evt: "moderacao_falhou", acao: String(body.action).slice(0, 20), message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível concluir. Tente novamente." });
  }
}
