import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { erroConfigRegioes, normalizarRegioesTimes, recursoRegionalLiberado, type RegioesTimes, type RecursoRegional } from "./regioesTimesCore";
const DOC = "sistema/regioesTimes";
let cache: { config: RegioesTimes; em: number; existe: boolean } | null = null;
export const esquecerRegioesTimes = () => { cache = null; };
export class ErroRegioesTimes extends Error { constructor(readonly status: number, message: string, readonly code = "regiao_nao_liberada") { super(message); } }
export async function lerRegioesTimes(db: Firestore): Promise<{ config: RegioesTimes; existe: boolean }> {
  if (cache && Date.now() - cache.em < 30_000) return cache;
  const s = await db.doc(DOC).get();
  const bruto = s.exists ? s.data()?.config : undefined;
  const config = s.exists && erroConfigRegioes(bruto) ? normalizarRegioesTimes({ times: { modo: "desligado" }, campeonatosTimes: { modo: "desligado" } }) : normalizarRegioesTimes(bruto);
  cache = { config, existe: s.exists, em: Date.now() };
  return cache;
}
export async function exigirRegiaoTimes(db: Firestore, uid: string, recurso: RecursoRegional): Promise<void> {
  let config: RegioesTimes;
  try { config = (await lerRegioesTimes(db)).config; } catch { throw new ErroRegioesTimes(503, "Não foi possível conferir a disponibilidade na sua região. Tente novamente.", "regiao_indisponivel"); }
  if (recursoRegionalLiberado(config, recurso, null)) return;
  let perfil;
  try { perfil = (await db.doc(`users/${uid}`).get()).data(); } catch { throw new ErroRegioesTimes(503, "Não foi possível conferir sua localização. Tente novamente.", "regiao_indisponivel"); }
  if (!recursoRegionalLiberado(config, recurso, perfil)) throw new ErroRegioesTimes(403, "Este recurso ainda não está liberado para a região do seu cadastro.");
}
/** Já chega autenticado como admin pelo controlador de sistema. Configuração independente da versão/interruptores. */
export async function administrarRegioesTimes(db: Firestore, uid: string, body: Record<string, unknown>) {
  const ref = db.doc(DOC);
  if (body.action === "regioes-times-ler") {
    const s = await ref.get();
    return { status: 200, body: { config: normalizarRegioesTimes(s.data()?.config), revisao: Number(s.data()?.revisao ?? 0) } };
  }
  const erro = erroConfigRegioes(body.config);
  if (erro || typeof body.revisao !== "number" || !Number.isSafeInteger(body.revisao) || body.revisao < 0) return { status: 400, body: { error: erro || "Recarregue as regiões antes de salvar." } };
  const config = normalizarRegioesTimes(body.config);
  try {
    const revisao = await db.runTransaction(async tx => {
      const s = await tx.get(ref), anterior = Number(s.data()?.revisao ?? 0);
      if (anterior !== body.revisao) throw new ErroRegioesTimes(409, "Outro administrador alterou as regiões. Recarregue antes de salvar.", "config_mudou");
      tx.set(ref, { config, revisao: anterior + 1, atualizadoPor: uid, atualizadoEm: FieldValue.serverTimestamp() });
      tx.create(ref.collection("historico").doc(), { antes: normalizarRegioesTimes(s.data()?.config), depois: config, por: uid, em: FieldValue.serverTimestamp() });
      return anterior + 1;
    });
    esquecerRegioesTimes();
    return { status: 200, body: { config, revisao } };
  } catch (e) { if (e instanceof ErroRegioesTimes) return { status: e.status, body: { error: e.message, code: e.code } }; throw e; }
}
