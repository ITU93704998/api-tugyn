import { randomBytes, createHash } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import type { Firestore } from "firebase-admin/firestore";
import { getAccount } from "./config";
import { parseImage } from "./validation";
import { perfilDisponivel } from "./suspensao";
import { idDoCT } from "./campeonatosTimesServico";
import { apagarRegulamentosCT } from "./campeonatosTimesRegulamento";
import { COLECAO_CT, exigirCT, RecusaCT, textoCT, type Dados } from "./campeonatosTimesDominio";

const FILA = "midiaCampeonatosTimes";
const DIA = 86_400_000;
/**
 * formato: "banner" = imagem deitada 3:1; "logo" = logo quadrada (inteira, com margem branca) ao lado do nome e da descrição.
 * cor: a cor da marca (#RRGGBB) que pinta o cartão (logo e só texto: o fundo; banner: a faixa do texto); null = visual padrão.
 */
type Patrocinador = { id: string; nome: string; texto: string; site: string | null; bannerUrl: string | null; publicId: string | null; formato?: "banner" | "logo"; cor?: string | null };
const COR_MARCA = /^#[0-9A-Fa-f]{6}$/;
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
  const texto = removendo ? "" : textoCT(body.texto, 200, "Texto");
  const site = removendo ? "" : textoCT(body.site, 500, "Site");
  if (site) { let u: URL; try { u = new URL(site); } catch { throw new RecusaCT(400, "Use um endereço https válido."); } exigirCT(u.protocol === "https:" && !u.username && !u.password, "Use um endereço https válido."); }
  const temImagem = !removendo && body.imagem != null;
  const formato: "banner" | "logo" = body.formato === "logo" ? "logo" : "banner";
  exigirCT(body.cor == null || body.cor === "" || (typeof body.cor === "string" && COR_MARCA.test(body.cor)), "Cor da marca inválida.");
  const cor = typeof body.cor === "string" && COR_MARCA.test(body.cor) ? body.cor.toUpperCase() : null;
  const conta = temImagem ? getAccount("turmas") : null;
  if (temImagem) { const i = parseImage(body.imagem); if (!i.ok) throw new RecusaCT(i.status, i.error); exigirCT(conta, "Servidor não configurado para banners de turma e campeonato.", 503); }
  // ID determinístico (patrocinador + conteúdo): o retry da mesma imagem reaproveita o mesmo arquivo em vez de criar outro.
  const publicId = temImagem ? `turmas/${uid}/campeonatos/${cid}/${chave(id + ":" + (formato === "logo" ? "logo:" : "") + chave(body.imagem as string)).slice(0, 24)}` : null;
  let fila = publicId ? db.doc(`${FILA}/${chave(publicId)}`) : null;
  let bannerUrl: string | null = null;
  // Reserva durável antes da chamada externa: a rotina diária recolhe uploads interrompidos.
  if (fila) await db.runTransaction(async (tx) => {
    const [cs, perfil, reserva] = await tx.getAll(ref, db.doc(`users/${uid}`), fila!);
    exigirCT(cs.exists, "Campeonato não encontrado.", 404); pode(cs.data()!, uid);
    exigirCT(perfilDisponivel(perfil.data()), "Perfil indisponível.", 403);
    const todos = lista(cs.data()!), atual = todos.find((p) => p.id === id);
    exigirCT(atual || todos.length < 6, "Use no máximo seis patrocinadores.");
    // A mesma imagem já está publicada neste patrocinador (resposta anterior perdida): sem novo envio.
    if (atual?.publicId === publicId && atual.bannerUrl) { bannerUrl = atual.bannerUrl; return; }
    exigirCT(!reserva.exists || Number(reserva.get("leaseAte") ?? 0) <= Date.now(), "Esta imagem está sendo processada. Tente novamente em instantes.", 409);
    // Reserva existente (retry ou limpeza pendente desta mesma imagem) é renovada em vez de duplicada.
    tx.set(fila!, { campeonatoId: cid, uid, publicId, status: "pendente", criadoEm: Date.now(), leaseAte: null, tentativas: 0 });
  });
  if (bannerUrl) fila = null;
  if (temImagem && conta && publicId && !bannerUrl) {
    const resultado = await cloudinary.uploader.upload(body.imagem as string, { ...conta, public_id: publicId,
      overwrite: false, unique_filename: false, resource_type: "image", tags: [`uid_${uid}`],
      // Logo: quadrada e inteira (sem cortar), completando com branco. Banner: 3:1 recortado.
      transformation: [formato === "logo" ? { width: 400, height: 400, crop: "pad", background: "white" } : { width: 1200, height: 400, crop: "fill", gravity: "auto" }, { quality: "auto:good", fetch_format: "auto" }], timeout: 30_000 });
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
    if (!removendo) alterados.push({ id, nome, texto, site: site || null, bannerUrl: bannerUrl ?? anterior?.bannerUrl ?? null, publicId: publicId ?? anterior?.publicId ?? null, formato: publicId ? formato : anterior?.formato ?? "banner", cor });
    // Assets antigos saem pela mesma fila, depois que a referência é removida atomicamente.
    if (anterior?.publicId && (removendo || publicId) && anterior.publicId !== publicId) tx.set(db.doc(`${FILA}/${chave(anterior.publicId)}`), { campeonatoId: cid, uid, publicId: anterior.publicId, status: "pendente", criadoEm: Date.now() - DIA, leaseAte: null });
    tx.update(ref, { patrocinadores: alterados, atualizadoEm: Date.now() });
    if (fila) tx.delete(fila);
  });
}

/** Tentativas antes de tirar o item da fila (fica com status "falhou" para revisão manual). */
const MAX_TENTATIVAS_LIMPEZA = 8;
export interface ResultadoLimpezaCT { apagados: number; mantidos: number; falhas: number; adiados: number; invalidos: number }

/**
 * Limitado por lote e prazo; nunca apaga um banner ainda referenciado. Não necessita função Vercel nova.
 * Uma falha num item não interrompe o lote: o item volta para a fila com espera crescente (`criadoEm` passa a valer
 * como "disponível a partir de", então a mesma consulta e o mesmo índice continuam valendo) e os demais seguem.
 */
export async function limparBannersCT(db: Firestore, ate: number): Promise<ResultadoLimpezaCT> {
  const r: ResultadoLimpezaCT = { apagados: 0, mantidos: 0, falhas: 0, adiados: 0, invalidos: 0 };
  if (Date.now() > ate - 1500) return r;
  const s = await db.collection(FILA).where("status", "==", "pendente").where("criadoEm", "<=", Date.now() - DIA).orderBy("criadoEm").limit(10).get();
  for (const item of s.docs) {
    if (Date.now() > ate - 1500) { r.adiados++; continue; }
    try {
      const job = await db.runTransaction(async (tx): Promise<Dados | null> => {
        const atual = await tx.get(item.ref); if (!atual.exists || Number(atual.get("leaseAte") ?? 0) > Date.now()) return null;
        const d = atual.data()!;
        // Defesa adicional: a fila nunca oferece uma URL externa nem outro bucket para destruição. Item assim sai da fila.
        if (!(typeof d.publicId === "string" && d.publicId.startsWith(`turmas/${d.uid}/campeonatos/${d.campeonatoId}/`) && /^[A-Za-z0-9_/-]+$/.test(d.publicId))) {
          tx.update(item.ref, { status: "invalido", leaseAte: null }); r.invalidos++; return null;
        }
        const camp = await tx.get(db.doc(`${COLECAO_CT}/${d.campeonatoId}`));
        if (camp.exists && lista(camp.data()!).some((p) => p.publicId === d.publicId)) { tx.delete(item.ref); r.mantidos++; return null; }
        tx.update(item.ref, { leaseAte: Date.now() + 60_000 }); return d;
      });
      if (!job) continue;
      const conta = getAccount("turmas"); exigirCT(conta, "Conta Cloudinary de turmas indisponível.", 503);
      const opcoes = { ...conta, resource_type: "image" as const, invalidate: true, timeout: Math.max(1000, Math.min(10_000, ate - Date.now())) };
      const res = await cloudinary.uploader.destroy(job.publicId as string, opcoes);
      exigirCT(res.result === "ok" || res.result === "not found", "Falha ao limpar banner.", 502);
      await item.ref.delete(); r.apagados++;
    } catch (e) {
      r.falhas++;
      // Libera o lease e reagenda com espera crescente (1 h, 2 h, 4 h… até 24 h); só texto curto e seguro no registro.
      const tentativas = Number(item.get("tentativas") ?? 0) + 1;
      const espera = Math.min(DIA, 3_600_000 * 2 ** (tentativas - 1));
      const ultimoErro = (e instanceof RecusaCT ? e.message : "Falha ao falar com o serviço de imagens.").slice(0, 120);
      await item.ref.update(tentativas >= MAX_TENTATIVAS_LIMPEZA
        ? { status: "falhou", leaseAte: null, tentativas, ultimoErro }
        : { criadoEm: Date.now() - DIA + espera, leaseAte: null, tentativas, ultimoErro }).catch(() => undefined);
    }
  }
  return r;
}

/**
 * Exclusão definitiva de um campeonato CANCELADO, só pelo organizador: apaga o campeonato com inscrições (e tentativas),
 * elencos, jogos e controle da premiação. Os banners dos patrocinadores entram na fila de limpeza na mesma transação que
 * marca a exclusão; a rotina diária os destrói quando o campeonato não existir mais. Os títulos/troféus (já retirados no
 * cancelamento) são conferidos de novo pelo gatilho durável ao apagar o documento.
 * Repetível: as subcoleções saem primeiro e o documento principal por último, então uma falha no meio permite repetir.
 */
export async function excluirCT(db: Firestore, uid: string, body: Dados): Promise<void> {
  const cid = idDoCT(body), ref = db.doc(`${COLECAO_CT}/${cid}`);
  const existe = await db.runTransaction(async (tx) => {
    const [cs, perfil] = await tx.getAll(ref, db.doc(`users/${uid}`));
    if (!cs.exists) return false; // já excluído (repetição após resposta perdida)
    const camp = cs.data()!;
    exigirCT(camp.organizadorId === uid, "Somente o organizador pode excluir o campeonato.", 403);
    exigirCT(camp.status === "cancelado", "Só é possível excluir um campeonato cancelado. Cancele-o antes.", 409);
    exigirCT(perfilDisponivel(perfil.data()), "Perfil indisponível.", 403);
    for (const p of lista(camp)) if (p.publicId) tx.set(db.doc(`${FILA}/${chave(p.publicId)}`), { campeonatoId: cid, uid, publicId: p.publicId, status: "pendente", criadoEm: Date.now(), leaseAte: null, tentativas: 0 });
    tx.update(ref, { excluindo: true, atualizadoEm: Date.now() });
    return true;
  });
  if (!existe) return;
  for (const col of await ref.listCollections()) await db.recursiveDelete(col);
  await ref.delete();
  // Regulamento em PDF (Firebase Storage): sai junto, depois do documento (melhor esforço).
  await apagarRegulamentosCT(cid);
}
