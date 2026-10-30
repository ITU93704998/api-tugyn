import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";
import { DEFAULT_CONTACTS, parseContacts, validEmail, type PublicContacts } from "./contactCore";

const DOC = "adsConfig/contatos";
type State = { contacts: PublicContacts; version: number };
let cache: { value: State; until: number } | null = null;
let pending: Promise<State> | null = null;
export async function readContacts(db: Firestore, fresh = false): Promise<State> {
  if (!fresh && cache && cache.until > Date.now()) return cache.value;
  if (!fresh && pending) return pending;
  const load = async (): Promise<State> => {
    const snap = await db.doc(DOC).get();
    const data = snap.data();
    let contacts = parseContacts(data);
    if (snap.exists && !contacts) throw new Error("Invalid contact configuration");
    if (!contacts) {
      // Preserve the commercial address already configured before the migration.
      const legacy = (await db.doc("adsConfig/contratos").get()).data();
      const email = legacy?.contato?.email;
      contacts = { ...DEFAULT_CONTACTS, commercialEmail: validEmail(email) ? email : DEFAULT_CONTACTS.commercialEmail };
    }
    const value = { contacts, version: Number.isSafeInteger(data?.version) && data!.version >= 0 ? data!.version : 0 };
    cache = { value, until: Date.now() + 60_000 };
    return value;
  };
  if (fresh) return load();
  pending = load();
  try { return await pending; } finally { pending = null; }
}

export async function handleContacts(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  // Only the two public addresses are exposed without login. No document metadata.
  if (req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const state = await readContacts(getFirestore(getFirebaseApp()));
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
      return res.status(200).json(state.contacts);
    } catch { return res.status(503).json({ error: "Contatos indisponíveis. Tente novamente." }); }
  }
  if (handleCors(req, res)) return;
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST, OPTIONS"); return res.status(405).json({ error: "Método não permitido." }); }
  const user = await requireUser(req, res, "contatos-admin");
  if (!user) return;
  if (!user.admin) return res.status(403).json({ error: "Apenas administradores podem gerenciar contatos." });
  if (!(await dentroDoLimite(user.uid, "contatos-config", 30, 60))) return res.status(429).json({ error: "Aguarde antes de tentar novamente." });
  try {
    const db = getFirestore(getFirebaseApp());
    const body = req.body;
    if (body?.action === "read") return res.status(200).json(await readContacts(db, true));
    if (body?.action !== "save" || !Number.isSafeInteger(body.version) || body.version < 0) return res.status(400).json({ error: "Configuração inválida." });
    const contacts = parseContacts(body.contacts);
    if (!contacts || Object.keys(body.contacts).some(key => key !== "supportEmail" && key !== "commercialEmail")) return res.status(400).json({ error: "Informe dois e-mails válidos, sem outros campos." });
    const saved = await db.runTransaction(async tx => {
      const ref = db.doc(DOC);
      const snap = await tx.get(ref);
      const current = snap.data()?.version ?? 0;
      if (current !== body.version) return null;
      const value = { contacts, version: current + 1 };
      tx.set(ref, { ...contacts, version: value.version, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
      return value;
    });
    if (!saved) return res.status(409).json({ error: "Outro administrador alterou os contatos. Recarregue antes de salvar." });
    cache = null;
    return res.status(200).json(saved);
  } catch { return res.status(503).json({ error: "Não foi possível acessar os contatos. Tente novamente." }); }
}
