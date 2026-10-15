/**
 * Limite de requisições por usuário e ação, usando o Upstash Redis via REST (sem dependências).
 * É OPCIONAL: sem `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` não limita nada.
 * Se o Upstash falhar, deixa passar (um defeito do limitador não pode derrubar o app).
 *
 * Em serverless não dá para limitar com variável em memória (cada instância tem a sua).
 */
export const dentroDoLimite = async (
  uid: string,
  acao: string,
  maximo: number,
  janelaSegundos: number,
): Promise<boolean> => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return true;

  const janela = Math.floor(Date.now() / 1000 / janelaSegundos);
  const chave = `rl:${acao}:${uid}:${janela}`;

  try {
    const resposta = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", chave],
        ["EXPIRE", chave, String(janelaSegundos * 2)],
      ]),
    });
    if (!resposta.ok) throw new Error(`Upstash respondeu ${resposta.status}`);

    const resultado = (await resposta.json()) as { result?: unknown }[];
    const contagem = Number(resultado[0]?.result);
    return Number.isFinite(contagem) ? contagem <= maximo : true;
  } catch (error) {
    console.error("[rateLimit] falhou, liberando:", error);
    return true;
  }
};
