import { createHash } from "node:crypto";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "./auth";

/**
 * Limita requisições pelo Upstash Redis. Se ele não estiver configurado ou falhar,
 * usa um contador transacional no Firestore. Se os dois estiverem indisponíveis,
 * falha fechado: a ação é negada em vez de liberar uso sem limite.
 *
 * O fallback mantém um documento por chave de usuário/IP e ação (não cresce a cada
 * janela) e usa hash para não guardar a chave original no Firestore.
 */
const limitarNoFirestore = async (
  chave: string,
  acao: string,
  maximo: number,
  janelaSegundos: number,
): Promise<boolean> => {
  const db = getFirestore(getFirebaseApp());
  const id = createHash("sha256").update(acao + ":" + chave).digest("hex");
  const ref = db.collection("apiRateLimits").doc(id);
  const agora = Math.floor(Date.now() / 1000);
  const inicioJanela = Math.floor(agora / janelaSegundos) * janelaSegundos;

  return db.runTransaction(async (tx) => {
    const atual = await tx.get(ref);
    const dados = atual.data();
    const contagemAnterior =
      dados?.inicioJanela === inicioJanela && Number.isSafeInteger(dados?.contagem)
        ? Number(dados.contagem)
        : 0;
    const contagem = contagemAnterior + 1;
    tx.set(ref, {
      inicioJanela,
      contagem,
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    return contagem <= maximo;
  });
};

export const dentroDoLimite = async (
  uid: string,
  acao: string,
  maximo: number,
  janelaSegundos: number,
): Promise<boolean> => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    try {
      return await limitarNoFirestore(uid, acao, maximo, janelaSegundos);
    } catch (error) {
      console.error("[rateLimit] Upstash ausente e fallback Firestore indisponível:", error);
      return false;
    }
  }

  const janela = Math.floor(Date.now() / 1000 / janelaSegundos);
  const chave = "rl:" + acao + ":" + uid + ":" + janela;

  try {
    const resposta = await fetch(url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", chave],
        ["EXPIRE", chave, String(janelaSegundos * 2)],
      ]),
    });
    if (!resposta.ok) throw new Error("Upstash respondeu " + resposta.status);

    const resultado = (await resposta.json()) as { result?: unknown; error?: unknown }[];
    const contagem = Number(resultado[0]?.result);
    if (resultado[0]?.error || !Number.isSafeInteger(contagem) || contagem < 1) {
      throw new Error("Resposta inválida do Upstash.");
    }
    return contagem <= maximo;
  } catch (error) {
    console.error("[rateLimit] Upstash falhou; usando fallback Firestore:", error);
    try {
      return await limitarNoFirestore(uid, acao, maximo, janelaSegundos);
    } catch (fallbackError) {
      console.error("[rateLimit] fallback Firestore indisponível:", fallbackError);
      return false;
    }
  }
};