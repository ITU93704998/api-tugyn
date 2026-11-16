import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { ID_CT, ID_TIME_CT, exigirCT, type Dados, type InscricaoCT } from "./campeonatosTimesDominio";
import type { TrofeuTimes } from "./campeonatosTimesTrofeus";
import { normalizarDesenhoTrofeu } from "./desenhoTrofeu";

export const COLECAO_TITULOS_TIME = "titulosCampeonatos";
export const milissegundosTime = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : v && typeof (v as { toMillis?: unknown }).toMillis === "function" ? (v as { toMillis(): number }).toMillis() : 0;
export interface TituloDoTime { timeId: string; timeLinkId: string | null; timeCriadoEm: number | null; inscritoEm: number; dados: { campeonatoId: string; campeonato: string; time: string; cor: string; modelo: string; modalidade: string; formato: string; cidade: string; estado: string; conquistadoEm: number; desenho?: string } }
/** Deriva somente de uma premiação já validada; nunca aceita o campeão enviado pelo cliente. */
export function tituloDoTime(camp: Dados | undefined, inscricoes: InscricaoCT[], premios: Map<string, TrofeuTimes>): TituloDoTime | null {
  const i = inscricoes.find(i => i.status === "aprovada" && i.timeId === camp?.campeaoTimeId);
  if (!i || !ID_TIME_CT.test(i.timeId)) return null;
  const t = [...premios.values()].find(t => t.titulos.includes("campeao"));
  if (!t) return null;
  const criado = Number(i.timeCriadoEm);
  return { timeId: i.timeId, timeLinkId: typeof i.timeLinkId === "string" ? i.timeLinkId : null, timeCriadoEm: Number.isFinite(criado) && criado > 0 ? criado : null, inscritoEm: Number(i.criadoEm ?? 0), dados: {
    campeonatoId: t.campeonatoId, campeonato: t.campeonato, time: t.time, cor: t.cor, modelo: t.modelo, modalidade: String(camp?.modalidade ?? ""), formato: String(camp?.formato ?? ""), cidade: String(camp?.cidade ?? "").slice(0, 100), estado: String(camp?.estado ?? "").slice(0, 40), conquistadoEm: Number(camp?.finalizadoEm ?? camp?.criadoEm ?? 0),
    ...(t.desenho ? { desenho: t.desenho } : {}),
  } };
}
/** O id dono_1 pode ser reutilizado, e o link (escolhido pelo app na criação) também pode ser repetido num time novo.
 * A geração do time é o par link + criação (`criadoEm`, hora do servidor, imutável pelas regras):
 *  - inscrição com a criação registrada: as duas precisam bater;
 *  - inscrição antiga (sem a criação): além do link, exige prova temporal de que o time já existia ao se inscrever. */
export function mesmaGeracaoDoTime(time: Dados, titulo: TituloDoTime): boolean {
  if (typeof time.linkId !== "string" || !/^[A-Za-z0-9]{16}$/.test(time.linkId)) return false;
  if (titulo.timeLinkId && time.linkId !== titulo.timeLinkId) return false;
  const criado = milissegundosTime(time.criadoEm);
  if (criado <= 0) return false;
  if (titulo.timeCriadoEm) return criado === titulo.timeCriadoEm;
  return titulo.inscritoEm >= criado;
}
/** Identidade da geração do time para a tela (cache e conferência): "link:criação". */
export const geracaoDoTime = (time: Dados): string => `${time.linkId}:${milissegundosTime(time.criadoEm)}`;

/** Leitura autenticada, sem expor uid de jogador, pagamento, elenco ou marcadores internos. */
export async function listarTitulosTime(db: Firestore, uid: string, body: Dados) {
  let timeId = body.timeId;
  const publica = typeof body.chave === "string";
  let chave = "";
  if (publica) {
    chave = String(body.chave).trim().toUpperCase(); exigirCT(/^[A-Z0-9]{6}$/.test(chave), "Chave do time inválida.");
    const c = await db.doc(`chavesTime/${chave}`).get(); timeId = c.data()?.timeId;
  }
  exigirCT(typeof timeId === "string" && ID_TIME_CT.test(timeId), "Time não encontrado.", 404);
  const ref = db.doc(`times/${timeId}`), time = await ref.get();
  exigirCT(time.exists, "Este time não existe mais.", 404);
  const d = time.data()!;
  if (!publica && body.geracao !== undefined) exigirCT(typeof body.geracao === "string" && (body.geracao === geracaoDoTime(d) || body.geracao === d.linkId), "Este time mudou. Abra-o novamente.", 404);
  const criado = milissegundosTime(d.criadoEm);
  exigirCT(publica ? d.chave === chave : Array.isArray(d.membros) && d.membros.includes(uid), "Você não pode consultar este time.", 403);
  let q = ref.collection(COLECAO_TITULOS_TIME).where("timeLinkId", "==", d.linkId).orderBy(FieldPath.documentId()).limit(7);
  if (body.cursor !== undefined) { exigirCT(typeof body.cursor === "string" && ID_CT.test(body.cursor), "Página inválida."); q = q.startAfter(body.cursor); }
  const s = await q.get(), pagina = s.docs.slice(0, 6);
  // Só aparece título confirmado para esta criação do time. Título antigo, sem a criação registrada, fica oculto até o
  // reconciliador revalidá-lo (ele regrava com `timeCriadoEm` ou remove); link reaproveitado não herda nada.
  const daGeracao = (t: Dados) => criado > 0 && t.timeCriadoEm === criado;
  const itens = pagina.filter(s => daGeracao(s.data())).map(s => { const t = s.data(); return { campeonatoId: s.id, campeonato: String(t.campeonato ?? "Campeonato").slice(0, 60), time: String(t.time ?? "").slice(0, 80), cor: /^#[a-f0-9]{6}$/i.test(t.cor) ? t.cor : "#FE7552", modelo: "classica", modalidade: String(t.modalidade ?? "").slice(0, 30), formato: String(t.formato ?? "").slice(0, 30), cidade: String(t.cidade ?? "").slice(0, 100), estado: String(t.estado ?? "").slice(0, 40), conquistadoEm: milissegundosTime(t.conquistadoEm), desenho: normalizarDesenhoTrofeu(t.desenho) }; });
  return { itens, proximoCursor: s.docs.length > 6 ? pagina.at(-1)!.id : null };
}
