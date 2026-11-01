import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "./auth";
import { validEmail } from "./contactCore";
import { dentroDoLimite } from "./rateLimit";

/**
 * Pedido de revisão de suspensão: POST /api/version?resource=revisao  { email, mensagem, origem: "app" | "site" }
 *
 * SEM login: a conta suspensa está desativada no Firebase Auth (não entra nem renova o token). Por isso:
 *  - a resposta é SEMPRE a mesma ("recebemos"), exista a conta ou não: ninguém descobre por aqui quais e-mails têm conta;
 *  - só vira pedido quando o e-mail é de uma conta com `users/{uid}.status == "suspended"`;
 *  - um pedido em aberto por conta (`revisoes/{uid}`); depois da decisão, a pessoa pode pedir de novo;
 *  - limite por IP (5 por hora) e por e-mail (3 por dia). O site não tem App Check: o limite é a proteção.
 *
 * Clientes não leem nem gravam `revisoes` (regras): o painel lista como administrador e decide pela moderação
 * (`reativar` aceita o pedido; `manterSuspensao` nega).
 */

export const REVISOES = "revisoes";
export const MENSAGEM_MIN = 20;
export const MENSAGEM_MAX = 1000;
const ORIGENS = ["app", "site"] as const;
type Origem = (typeof ORIGENS)[number];

/** Endereços do site que podem chamar esta rota pelo navegador (`SITE_ORIGINS`, separados por vírgula). */
const SITE_ORIGINS_PADRAO = "https://tugyn.com.br,https://www.tugyn.com.br";
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

export const origensDoSite = (valor: string | undefined): string[] =>
  (valor && valor.trim() ? valor : SITE_ORIGINS_PADRAO)
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter((item) => ORIGIN_PATTERN.test(item));

/** Texto da pessoa: sem caracteres de controle (mantém quebras de linha), de 20 a 1000 caracteres. */
export const parseMensagem = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const limpo = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return limpo.length >= MENSAGEM_MIN && limpo.length <= MENSAGEM_MAX ? limpo : null;
};

const hash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 32);

const ipDe = (req: VercelRequest): string => {
  const bruto = req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"];
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  return (typeof valor === "string" ? valor.split(",")[0].trim() : "") || "sem-ip";
};

export type Resultado = "registrada" | "ja_aberta" | "ignorada";

/** Grava o pedido se o e-mail for de uma conta suspensa. Nunca diz ao cliente qual dos casos aconteceu. */
export async function registrarRevisao(db: Firestore, email: string, mensagem: string, origem: Origem): Promise<Resultado> {
  const auth = getAuth(getFirebaseApp());
  const conta = await auth.getUserByEmail(email).catch((erro) => {
    if ((erro as { code?: unknown } | null)?.code === "auth/user-not-found") return null;
    throw erro;
  });
  if (!conta) return "ignorada";
  const perfil = await db.doc(`users/${conta.uid}`).get();
  if (!perfil.exists || perfil.get("status") !== "suspended") return "ignorada";

  const ref = db.doc(`${REVISOES}/${conta.uid}`);
  const atual = await ref.get();
  if (atual.exists && atual.get("status") === "aberta") return "ja_aberta";
  const anteriores = atual.exists ? (Number(atual.get("pedidosAnteriores")) || 0) + 1 : 0;

  await ref.set({
    uid: conta.uid,
    email: (conta.email ?? email).slice(0, 254),
    nome: String(perfil.get("name") ?? "").slice(0, 80),
    userName: String(perfil.get("userName") ?? "").slice(0, 30),
    mensagem,
    origem,
    status: "aberta",
    criadoEm: FieldValue.serverTimestamp(),
    suspensaEm: perfil.get("suspensaEm") ?? null,
    pedidosAnteriores: anteriores,
  });
  return "registrada";
}

/** Mesma resposta para todos os casos válidos. */
const RECEBIDO = { ok: true };

export async function handleRevisao(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin) {
    res.setHeader("Vary", "Origin");
    if (origensDoSite(process.env.SITE_ORIGINS).includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
  }
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const body = req.body ?? {};
  // Campo escondido do formulário do site: robôs preenchem, pessoas não. Finge que deu certo.
  if (typeof body.site === "string" && body.site !== "") return res.status(200).json(RECEBIDO);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!validEmail(email)) return res.status(400).json({ error: "Informe o e-mail da conta." });
  const mensagem = parseMensagem(body.mensagem);
  if (!mensagem) return res.status(400).json({ error: `Explique o pedido (de ${MENSAGEM_MIN} a ${MENSAGEM_MAX} caracteres).` });
  const origem: Origem = body.origem === "app" ? "app" : "site";

  const porIp = await dentroDoLimite(hash(ipDe(req)), "revisao-ip", 5, 3600);
  const porEmail = porIp && (await dentroDoLimite(hash(email), "revisao-email", 3, 86400));
  if (!porIp || !porEmail) return res.status(429).json({ error: "Muitos pedidos seguidos. Tente de novo mais tarde." });

  try {
    const resultado = await registrarRevisao(getFirestore(getFirebaseApp()), email, mensagem, origem);
    console.log(JSON.stringify({ evt: "revisao", resultado, origem }));
    return res.status(200).json(RECEBIDO);
  } catch (erro) {
    console.error(JSON.stringify({ evt: "revisao_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível enviar agora. Tente novamente." });
  }
}
