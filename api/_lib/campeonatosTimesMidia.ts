import { randomBytes, createHash } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import type { Firestore } from "firebase-admin/firestore";
import { getAccount } from "./config";
import { parseImage } from "./validation";
import { perfilDisponivel } from "./suspensao";
import { idDoCT } from "./campeonatosTimesServico";
import { COLECAO_CT, exigirCT, RecusaCT, textoCT, type Dados } from "./campeonatosTimesDominio";

const FILA = "midiaCampeonatosTimes";
const DIA = 86_400_000;
type Patrocinador = { id: string; nome: string; texto: string; site: string | null; bannerUrl: string | null; publicId: string | null };
const lista = (d: Dados) => Array.isArray(d.patrocinadores) ? d.patrocinadores as Patrocinador[] : [];
const chave = (p: string) => createHash("sha256").update(p).digest("hex");
const pode = (d: Dados, uid: string) => { exigirCT(d.organizadorId === uid, "Somente o organizador pode editar patrocinadores.", 403); exigirCT(d.status !== "cancelado" && d.status !== "encerrado", "Este campeonato está fechado.", 409); };
export const patrocinadoresPublicosCT = (d: Dados) => lista(d).map(({ publicId: _privado, ...p }) => p);

export async function patrocinadorCT(db: Firestore, uid: string, body: Dados): Promise<void> {
  const cid = idDoCT(body), ref = db.doc(`${COLECAO_CT}/${cid}`);
  const removendo = body.acao === "removerPatrocinador";
  const id = body.patrocinadorId ?? `p_${randomBytes(8).toString("hex")}`;
  exigirCT(typeof id === "string" && /^p_[a-f0-9]{16}$/.test(id), "Patrocinador inválido.");
  const nome = removendo ? "" : textoCT(body.nome, 80, "Patrocinador", true);
  const texto = removendo ? "" : textoCT(body.texto, 300, "Texto");
  const site = removendo ? "" : textoCT(body.site, 500, "Site");
  if (site) { let u: URL; try { u = new URL(site); } catch { throw new RecusaCT(400, "Use um endereço https válido."); } exigirCT(u.protocol === "https:" && !u.username && !u.password, "Use um endereço https válido."); }
  const temImagem = !removendo && body.imagem != null;
  const conta = temImagem ? getAccount("turmas") : null;
  if (temImagem) { const i = parseImage(body.imagem); if (!i.ok) throw new RecusaCT(i.status, i.error); exigirCT(conta, "Servidor não configurado para banners de turma e campeonato.", 503); }
  const publicId = temImagem ? `turmas/${uid}/campeonatos/${cid}/${randomBytes(12).toString("hex")}` : null;
  const fila = publicId ? db.doc(`${FILA}/${chave(publicId)}`) : null;
  // Reserva durável antes da chamada externa: a rotina diária recolhe uploads interrompidos.
  if (fila) await db.runTransaction(async (tx) => {
    const [cs, perfil] = await tx.getAll(ref, db.doc(`users/${uid}`));
    exigirCT(cs.exists, "Campeonato não encontrado.", 404); pode(cs.data()!, uid);
    exigirCT(perfilDisponivel(perfil.data()), "Perfil indisponível.", 403);
    exigirCT(lista(cs.data()!).some((p) => p.id === id) || lista(cs.data()!).length < 6, "Use no máximo seis patrocinadores.");
    tx.create(fila, { campeonatoId: cid, uid, publicId, status: "pendente", criadoEm: Date.now(), leaseAte: null });
  });
  let bannerUrl: string | null = null;
  if (temImagem && conta && publicId) {
    const resultado = await cloudinary.uploader.upload(body.imagem as string, { ...conta, public_id: publicId,
      overwrite: false, unique_filename: false, resource_type: "image", tags: [`uid_${uid}`],
      transformation: [{ width: 1200, height: 400, crop: "fill", gravity: "auto" }, { quality: "auto:good", fetch_format: "auto" }], timeout: 30_000 });
    exigirCT(resultado.public_id === publicId && resultado.secure_url?.startsWith("https://"), "Não foi possível preparar o banner.", 502);
    bannerUrl = resultado.secure_url;
  }
  await db.runTransaction(async (tx) => {
    const [cs, perfil, reserva] = await Promise.all([tx.get(ref), tx.get(db.doc(`users/${uid}`)), fila ? tx.get(fila) : Promise.resolve(null)]);
    exigirCT(cs.exists, "Campeonato não encontrado.", 404); const camp = cs.data()!; pode(camp, uid);
    exigirCT(perfilDisponivel(perfil.data()), "Perfil indisponível.", 403);
    if (fila) exigirCT(reserva?.exists && !reserva.get("leaseAte") && reserva.get("criadoEm") > Date.now() - DIA, "O envio venceu. Tente novamente.", 409);
    const todos = lista(camp), anterior = todos.find((p) => p.id === id);
    exigirCT(removendo || anterior || todos.length < 6, "Use no máximo seis patrocinadores.");
    const alterados = todos.filter((p) => p.id !== id);
    if (!removendo) alterados.push({ id, nome, texto, site: site || null, bannerUrl: bannerUrl ?? anterior?.bannerUrl ?? null, publicId: publicId ?? anterior?.publicId ?? null });
    // Assets antigos saem pela mesma fila, depois que a referência é removida atomicamente.
    if (anterior?.publicId && (removendo || publicId)) tx.set(db.doc(`${FILA}/${chave(anterior.publicId)}`), { campeonatoId: cid, uid, publicId: anterior.publicId, status: "pendente", criadoEm: Date.now() - DIA, leaseAte: null });
    tx.update(ref, { patrocinadores: alterados, atualizadoEm: Date.now() });
    if (fila) tx.delete(fila);
  });
}

/** Limitado por lote e prazo; nunca apaga um banner ainda referenciado. Não necessita função Vercel nova. */
export async function limparBannersCT(db: Firestore, ate: number): Promise<void> {
  if (Date.now() > ate - 1500) return;
  const s = await db.collection(FILA).where("status", "==", "pendente").where("criadoEm", "<=", Date.now() - DIA).orderBy("criadoEm").limit(5).get();
  for (const item of s.docs) {
    if (Date.now() > ate - 1500) break;
    const job = await db.runTransaction(async (tx) => {
      const atual = await tx.get(item.ref); if (!atual.exists || Number(atual.get("leaseAte") ?? 0) > Date.now()) return null;
      const d = atual.data()!;
      // Defesa adicional: a fila nunca oferece uma URL externa nem outro bucket para destruição.
      exigirCT(typeof d.publicId === "string" && d.publicId.startsWith(`turmas/${d.uid}/campeonatos/${d.campeonatoId}/`) && /^[A-Za-z0-9_/-]+$/.test(d.publicId), "Reserva de mídia inválida.");
      const camp = await tx.get(db.doc(`${COLECAO_CT}/${d.campeonatoId}`));
      if (camp.exists && lista(camp.data()!).some((p) => p.publicId === d.publicId)) { tx.delete(item.ref); return null; }
      tx.update(item.ref, { leaseAte: Date.now() + 60_000 }); return d;
    });
    if (!job) continue;
    const conta = getAccount("turmas"); exigirCT(conta, "Conta Cloudinary de turmas indisponível.", 503);
    const opcoes = { ...conta, resource_type: "image" as const, invalidate: true, timeout: Math.max(1000, Math.min(10_000, ate - Date.now())) };
    const r = await cloudinary.uploader.destroy(job.publicId, opcoes);
    exigirCT(r.result === "ok" || r.result === "not found", "Falha ao limpar banner.", 502);
    await item.ref.delete();
  }
}
