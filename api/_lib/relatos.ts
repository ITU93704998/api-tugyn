import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { verificarAppCheck } from "./appCheck";
import { getFirebaseApp, requireUser } from "./auth";
import { dentroDoLimite } from "./rateLimit";
import { versaoDoPedido } from "./sistema";

/**
 * Relatos de problema enviados pelo app (Configurações › Relatar um problema): POST /api/version?resource=relato.
 *
 * `relatos/{id}` = { uid, categoria, texto, versao, plataforma, sistema, modelo, status, nota, criadoEm, atualizadoEm,
 *                    atualizadoPor? }. Só o servidor lê e grava (as regras do Firestore negam ao app).
 * A equipe trata na Caixa de relatos do painel (`adminSuporte.ts`) e responde por e-mail. Os relatos de uma conta são
 * apagados junto com ela (`exclusaoContaJob.ts`, campo `uid`).
 */

export const RELATOS = "relatos";
export const CATEGORIAS = ["erro", "duvida", "sugestao", "conta", "outro"] as const;
export type Categoria = (typeof CATEGORIAS)[number];
export const STATUS_RELATO = ["aberto", "respondido", "resolvido"] as const;
export type StatusRelato = (typeof STATUS_RELATO)[number];
export const TEXTO_MIN = 10;
export const TEXTO_MAX = 2000;
/** Por conta: no máximo 5 relatos a cada 24 h. */
export const RELATOS_POR_DIA = 5;

export interface RelatoEnviado {
  categoria: Categoria;
  texto: string;
  sistema: string;
  modelo: string;
}

// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;
const curto = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(CONTROLE, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Valida o corpo do app. O texto mantém as quebras de linha (sem caracteres de controle). */
export const parseRelato = (body: unknown): { ok: true; value: RelatoEnviado } | { ok: false; error: string } => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  if (!(CATEGORIAS as readonly unknown[]).includes(b.categoria)) return { ok: false, error: "Escolha o tipo do relato." };
  const texto = typeof b.texto === "string" ? b.texto.replace(CONTROLE, " ").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (texto.length < TEXTO_MIN) return { ok: false, error: `Conte um pouco mais (pelo menos ${TEXTO_MIN} caracteres).` };
  if (texto.length > TEXTO_MAX) return { ok: false, error: `O texto pode ter até ${TEXTO_MAX} caracteres.` };
  return { ok: true, value: { categoria: b.categoria as Categoria, texto, sistema: curto(b.sistema, 30), modelo: curto(b.modelo, 60) } };
};

export async function handleRelato(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const user = await requireUser(req, res, "relato");
  if (!user) return;
  if (!(await verificarAppCheck(req, res, "relato"))) return;
  const parsed = parseRelato(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  if (!(await dentroDoLimite(user.uid, "relato", RELATOS_POR_DIA, 86_400))) {
    return res.status(429).json({ error: "Você já enviou vários relatos hoje. Tente de novo amanhã ou escreva para o suporte." });
  }
  try {
    const v = versaoDoPedido(req);
    const ref = await getFirestore(getFirebaseApp()).collection(RELATOS).add({
      uid: user.uid,
      ...parsed.value,
      versao: v?.versao ?? "",
      plataforma: v?.plataforma ?? "",
      status: "aberto",
      nota: "",
      criadoEm: FieldValue.serverTimestamp(),
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    console.log(JSON.stringify({ evt: "relato_recebido", categoria: parsed.value.categoria }));
    return res.status(200).json({ ok: true, id: ref.id });
  } catch (erro) {
    console.error(JSON.stringify({ evt: "relato_falhou", message: (erro as Error)?.message ?? String(erro) }));
    return res.status(503).json({ error: "Não foi possível enviar agora. Tente novamente." });
  }
}
