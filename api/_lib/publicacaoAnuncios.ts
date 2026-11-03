import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { type BuildResult, type Campaign, buildAdsConfig, validateCampaignInput } from "./adCore";

/**
 * Publicação dos anúncios próprios (`adsConfig/atual`) feita pelo SERVIDOR, numa transação que lê o inventário atual
 * (`adCampaigns`). Antes, o painel montava a lista com o que tinha na tela: uma aba atrasada podia republicar uma campanha já
 * pausada ou apagada por outra, e a publicação depois de aprovar dependia da aba continuar aberta.
 *
 * Se uma campanha muda durante a publicação, a transação é refeita com os dados novos (o Firestore confere tudo o que foi lido).
 * Cada publicação deixa um registro em `adsPublicacoes` (quem, quando, por quê e quantos anúncios): só o servidor lê e grava.
 */

export const COLECAO_CAMPANHAS = "adCampaigns";
const CONFIG = "adsConfig/atual";
const TRILHA = "adsPublicacoes";

export type MotivoPublicacao = "publicar" | "aprovar" | "excluir";

/** Todas as campanhas válidas, lidas DENTRO da transação (as inválidas não entram na publicação, como no painel). */
export const lerCampanhasNaTransacao = async (db: Firestore, tx: Transaction): Promise<Campaign[]> => {
  const snapshot = await tx.get(db.collection(COLECAO_CAMPANHAS));
  const campanhas: Campaign[] = [];
  for (const doc of snapshot.docs) {
    const validada = validateCampaignInput(doc.data());
    if (validada.ok) campanhas.push({ id: doc.id, ...validada.value });
  }
  return campanhas;
};

/** Grava `adsConfig/atual` e o registro da publicação. Só depois de todas as leituras da transação. */
export const gravarPublicacao = (db: Firestore, tx: Transaction, campanhas: readonly Campaign[], agora: number, uid: string, motivo: MotivoPublicacao): BuildResult => {
  const resultado = buildAdsConfig(campanhas, agora);
  tx.set(db.doc(CONFIG), { version: 1, generatedAt: FieldValue.serverTimestamp(), ads: resultado.ads });
  tx.create(db.collection(TRILHA).doc(), {
    uid,
    motivo,
    em: FieldValue.serverTimestamp(),
    anuncios: resultado.ads.length,
    ids: resultado.ads.map((ad) => ad.id).slice(0, 100),
    ignoradas: resultado.skipped.slice(0, 50),
  });
  return resultado;
};

/** Botão "Publicar" do painel. */
export const publicarAnuncios = (db: Firestore, uid: string, agora: number): Promise<BuildResult> =>
  db.runTransaction(async (tx) => gravarPublicacao(db, tx, await lerCampanhasNaTransacao(db, tx), agora, uid, "publicar"));

export interface ExclusaoDeCampanha {
  /** A campanha existia (false = já tinha sido apagada; a publicação, se pedida, acontece igual). */
  existia: boolean;
  /** Outra campanha usa a mesma imagem (o painel não apaga o banner do Cloudinary). */
  imagemEmUso: boolean;
  publicacao: BuildResult | null;
}

/**
 * Apaga a campanha e, se pedido, republica sem ela, na MESMA transação: não existe o meio-termo "apagada do cadastro mas ainda
 * no app". Números (adStats) e a imagem continuam com o painel (não afetam o que o app mostra).
 */
export const excluirCampanha = (db: Firestore, campanhaId: string, publicar: boolean, uid: string, agora: number): Promise<ExclusaoDeCampanha> =>
  db.runTransaction(async (tx) => {
    const ref = db.collection(COLECAO_CAMPANHAS).doc(campanhaId);
    const atual = await tx.get(ref);
    const todas = await lerCampanhasNaTransacao(db, tx);
    const imagem = atual.exists ? atual.get("imageUrl") : undefined;
    const restantes = todas.filter((campanha) => campanha.id !== campanhaId);
    const imagemEmUso = typeof imagem === "string" && imagem !== "" && restantes.some((campanha) => campanha.imageUrl === imagem);
    if (atual.exists) tx.delete(ref);
    const publicacao = publicar ? gravarPublicacao(db, tx, restantes, agora, uid, "excluir") : null;
    return { existia: atual.exists, imagemEmUso, publicacao };
  });
