/**
 * "Sinal de vida" da rotina diária para um monitor externo (ex.: Healthchecks.io). A Vercel não avisa quando o cron
 * falha ou nem roda; o monitor avisa quando o sinal não chega no prazo ou chega como falha.
 *
 * Variável da Vercel (opcional): HEARTBEAT_URL = endereço de ping do monitor (https). Sem ela, nada é enviado.
 *  - rotina completa → POST no endereço;
 *  - rotina parcial ou com erro → POST em `<endereço>/fail` (convenção do Healthchecks.io).
 * O corpo leva só os códigos dos problemas (ex.: `push_recibos_falhas:3`), nunca dados de usuários.
 * Nunca lança erro nem segura a rotina por mais de 4 s: o monitor é conveniência, a rotina é o que importa.
 */

const TIMEOUT_MS = 4000;
const MAX_CORPO = 2000;

export interface SinalDeVida { url: string; corpo: string }

/** Monta o envio (função pura); null quando não há endereço válido configurado. */
export function montarSinalDeVida(endereco: string | undefined, ok: boolean, problemas: string[]): SinalDeVida | null {
  const base = (endereco ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" || u.username || u.password) return null;
  } catch {
    return null;
  }
  const corpo = ok ? "ok" : problemas.map((p) => String(p).replace(/[^\w:.-]/g, "_").slice(0, 80)).join("\n").slice(0, MAX_CORPO) || "falha";
  return { url: ok ? base : `${base}/fail`, corpo };
}

export async function enviarSinalDeVida(
  ok: boolean,
  problemas: string[] = [],
  endereco: string | undefined = process.env.HEARTBEAT_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const sinal = montarSinalDeVida(endereco, ok, problemas);
  if (!sinal) return;
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(sinal.url, { method: "POST", body: sinal.corpo, headers: { "content-type": "text/plain" }, signal: controle.signal });
    if (!r.ok) console.warn(JSON.stringify({ evt: "sinal_de_vida_recusado", status: r.status }));
  } catch (erro) {
    console.warn(JSON.stringify({ evt: "sinal_de_vida_falhou", message: (erro as Error)?.message ?? String(erro) }));
  } finally {
    clearTimeout(timer);
  }
}
