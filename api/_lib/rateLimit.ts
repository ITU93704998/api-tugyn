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
 *
 * Custo sob abuso: quem já estourou a janela é negado SEM escrita (o fallback só lê o contador) e, nesta instância da
 * função, sem nem consultar Redis/Firestore até a janela acabar (`negadosAteFimDaJanela`). O Upstash tem timeout curto
 * para um Redis lento não segurar a função. Limite de borda (Vercel Firewall/WAF) é configuração do painel: ver docs.
 */

/** Tempo máximo esperando o Upstash antes de cair no fallback. */
export const UPSTASH_TIMEOUT_MS = 800;
const MAX_NEGADOS_EM_MEMORIA = 5000;
/** chave (ação + usuário + janela) → fim da janela em ms. Por instância: só economiza, quem decide continua sendo o contador. */
const negadosAteFimDaJanela = new Map<string, number>();

const lembrarNegado = (chave: string, fimDaJanelaMs: number): void => {
  if (negadosAteFimDaJanela.size >= MAX_NEGADOS_EM_MEMORIA) {
    const agora = Date.now();
    for (const [k, fim] of negadosAteFimDaJanela) if (fim <= agora) negadosAteFimDaJanela.delete(k);
    if (negadosAteFimDaJanela.size >= MAX_NEGADOS_EM_MEMORIA) negadosAteFimDaJanela.clear();
  }
  negadosAteFimDaJanela.set(chave, fimDaJanelaMs);
};

/** Só para testes. */
export const limparMemoriaDoLimite = (): void => negadosAteFimDaJanela.clear();

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
    // Já estourou nesta janela: nega sem gravar (a transação só leu; nada de escrita por tentativa negada).
    if (contagemAnterior >= maximo) return false;
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
  const janela = Math.floor(Date.now() / 1000 / janelaSegundos);
  const chave = "rl:" + acao + ":" + uid + ":" + janela;
  const fimDaJanelaMs = (janela + 1) * janelaSegundos * 1000;

  // Negado há pouco nesta instância e a janela não acabou: nega sem nenhuma chamada (nem Redis, nem Firestore).
  const negadoAte = negadosAteFimDaJanela.get(chave);
  if (negadoAte !== undefined) {
    if (negadoAte > Date.now()) return false;
    negadosAteFimDaJanela.delete(chave);
  }
  const decidir = (permitido: boolean): boolean => {
    if (!permitido) lembrarNegado(chave, fimDaJanelaMs);
    return permitido;
  };

  if (!url || !token) {
    try {
      return decidir(await limitarNoFirestore(uid, acao, maximo, janelaSegundos));
    } catch (error) {
      console.error("[rateLimit] Upstash ausente e fallback Firestore indisponível:", error);
      return false;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
  try {
    const resposta = await fetch(url + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", chave],
        ["EXPIRE", chave, String(janelaSegundos * 2)],
      ]),
      signal: controller.signal,
    });
    if (!resposta.ok) throw new Error("Upstash respondeu " + resposta.status);

    const resultado = (await resposta.json()) as { result?: unknown; error?: unknown }[];
    const contagem = Number(resultado[0]?.result);
    if (resultado[0]?.error || !Number.isSafeInteger(contagem) || contagem < 1) {
      throw new Error("Resposta inválida do Upstash.");
    }
    return decidir(contagem <= maximo);
  } catch (error) {
    const motivo = (error as Error)?.name === "AbortError" ? "timeout" : (error as Error)?.message ?? "erro";
    console.error("[rateLimit] Upstash falhou; usando fallback Firestore:", motivo);
    try {
      return decidir(await limitarNoFirestore(uid, acao, maximo, janelaSegundos));
    } catch (fallbackError) {
      console.error("[rateLimit] fallback Firestore indisponível:", fallbackError);
      return false;
    }
  } finally {
    clearTimeout(timer);
  }
};