import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldPath, getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";

/**
 * Departamento médico (DM) de uma turma ou de um time: quem dos membros está fora dos jogos por lesão.
 *
 *   GET /api/version?resource=departamento-medico&tipo=turmas|times&id=<id>   →   { ok: true, dm: { [uid]: retornoMs | null } }
 *
 * O registro de cada pessoa (`departamentoMedico/{uid}`) só ela lê pelas regras. Não há cópia nos grupos: a cada consulta
 * o servidor confere, NA HORA, que quem pergunta é do grupo e devolve o DM só de quem AINDA é membro e AINDA está no DM.
 * Assim, sair do grupo, sair do DM (em qualquer aparelho) ou a volta prevista passar valem imediatamente, sem limpeza.
 * Leitura: `where(documentId, "in", ≤30 ids)` cobra só os registros que existem (no mínimo 1 por consulta).
 *
 *   GET ...&tipo=perfil&id=<uid>   →   { ok: true, dm: { [uid]: retornoMs | null } }   (ou `dm: {}`)
 *
 * No perfil de alguém, o selo só aparece para quem divide uma turma (membro ou organizador) ou um time com a pessoa.
 * Quem não divide recebe a MESMA resposta de quem não está no DM (`dm: {}`): não dá para descobrir quem está machucado.
 * Custo: 1 leitura; as consultas de grupo em comum só rodam quando a pessoa está no DM.
 */

export type TipoGrupo = "turmas" | "times";
const ID_SEGURO = /^[A-Za-z0-9_-]{1,128}$/;
const LOTE = 30;
const MAX_MEMBROS = 600;

type Dados = Record<string, unknown> | undefined;
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID_SEGURO.test(x)) : []);
const emMs = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  const t = v as { toMillis?: () => number } | undefined;
  return typeof t?.toMillis === "function" ? t.toMillis() : undefined;
};

/** Quem pode ver e de quem se mostra o DM. `null` = quem pergunta não é do grupo (ou o grupo não existe). */
export const membrosVisiveis = (tipo: TipoGrupo, grupo: Dados, quem: string): string[] | null => {
  if (!grupo) return null;
  if (tipo === "turmas") {
    const criador = typeof grupo.creatorId === "string" ? grupo.creatorId : "";
    const participantes = lista(grupo.participantes);
    if (quem !== criador && !participantes.includes(quem)) return null;
    return [...new Set([...participantes, ...(criador && ID_SEGURO.test(criador) ? [criador] : [])])];
  }
  const membros = lista(grupo.membros);
  return membros.includes(quem) ? [...new Set(membros)] : null;
};

/**
 * O DM dos membros do grupo, vigente agora. Registro vencido (volta prevista já passou) não aparece e é apagado aqui mesmo
 * (com a condição de não ter mudado desde a leitura); a política de TTL do Firestore no campo `retorno` apaga os demais.
 */
export const lerDMDoGrupo = async (
  db: Firestore,
  quem: string,
  tipo: TipoGrupo,
  id: string,
  agoraMs: number = Date.now(),
): Promise<Record<string, number | null> | null> => {
  const grupo = await db.doc(`${tipo}/${id}`).get();
  const membros = membrosVisiveis(tipo, grupo.exists ? (grupo.data() as Dados) : undefined, quem);
  if (!membros) return null;
  const dm: Record<string, number | null> = {};
  const alvo = membros.slice(0, MAX_MEMBROS);
  for (let i = 0; i < alvo.length; i += LOTE) {
    const snap = await db.collection("departamentoMedico").where(FieldPath.documentId(), "in", alvo.slice(i, i + LOTE)).get();
    for (const d of snap.docs) {
      const retorno = emMs(d.data()?.retorno);
      if (retorno === undefined) continue; // formato inesperado: não mostra
      if (retorno !== null && retorno <= agoraMs) {
        d.ref.delete(d.updateTime ? { lastUpdateTime: d.updateTime } : undefined).catch(() => undefined);
        continue;
      }
      dm[d.id] = retorno;
    }
  }
  return dm;
};

const vigenteDe = (d: Dados, agoraMs: number): number | null | undefined => {
  const retorno = emMs(d?.retorno);
  return retorno === undefined || (retorno !== null && retorno <= agoraMs) ? undefined : retorno;
};

/** Os dois dividem uma turma (participante/organizador) ou um time agora. */
export const dividemGrupo = async (db: Firestore, quem: string, alvo: string): Promise<boolean> => {
  const [comoMembro, comoCriador, times] = await Promise.all([
    db.collection("turmas").where("participantes", "array-contains", alvo).limit(200).get(),
    db.collection("turmas").where("creatorId", "==", alvo).limit(50).get(),
    db.collection("times").where("membros", "array-contains", alvo).limit(10).get(),
  ]);
  const turmas = [...comoMembro.docs, ...comoCriador.docs].map((d) => d.data() as Dados);
  if (turmas.some((t) => membrosVisiveis("turmas", t, quem) !== null)) return true;
  return times.docs.some((d) => membrosVisiveis("times", d.data() as Dados, quem) !== null);
};

/** DM de uma pessoa, para o perfil dela. `{}` = não está no DM OU quem pergunta não é colega (indistinguíveis). */
export const lerDMDoPerfil = async (
  db: Firestore,
  quem: string,
  alvo: string,
  agoraMs: number = Date.now(),
): Promise<Record<string, number | null>> => {
  const snap = await db.doc(`departamentoMedico/${alvo}`).get();
  if (!snap.exists) return {};
  const retorno = vigenteDe(snap.data() as Dados, agoraMs);
  if (retorno === undefined) return {};
  if (quem !== alvo && !(await dividemGrupo(db, quem, alvo))) return {};
  return { [alvo]: retorno };
};

export async function handleDepartamentoMedico(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const tipo = req.query?.tipo;
  const id = req.query?.id;
  if ((tipo !== "turmas" && tipo !== "times" && tipo !== "perfil") || typeof id !== "string" || !ID_SEGURO.test(id)) {
    return res.status(400).json({ error: "Grupo inválido." });
  }
  const user = await requireUser(req, res, "departamento-medico");
  if (!user) return;
  if (!(await dentroDoLimite(user.uid, "departamento-medico", 300, 3600))) {
    return res.status(429).json({ error: "Muitas consultas. Aguarde um pouco." });
  }
  try {
    if (tipo === "perfil") return res.status(200).json({ ok: true, dm: await lerDMDoPerfil(getFirestore(getFirebaseApp()), user.uid, id) });
    const dm = await lerDMDoGrupo(getFirestore(getFirebaseApp()), user.uid, tipo, id);
    // Mesmo código para "não é do grupo" e "grupo não existe": não revela quais grupos existem.
    if (!dm) return res.status(403).json({ error: "Só os membros do grupo veem o departamento médico." });
    return res.status(200).json({ ok: true, dm });
  } catch {
    console.error(JSON.stringify({ evt: "departamento_medico_leitura_falhou", tipo }));
    return res.status(503).json({ error: "Não foi possível consultar agora." });
  }
}
