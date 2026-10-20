import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";
import { FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { dayKey, parseAdEvents, statDocId, type AdEvent } from "./_lib/adEvents";
import { getFirebaseApp } from "./_lib/auth";
import { dentroDoLimite } from "./_lib/rateLimit";

/**
 * Recebe as impressões e os cliques dos anúncios próprios (em lote, vindos do app) e soma nos contadores do Firestore:
 * `adStats/<anuncio>_<AAAAMMDD>`. É ABERTO (o app mostra anúncio também a quem não tem conta), então:
 *  - só conta anúncio que está PUBLICADO em `adsConfig/atual` (ids inventados são ignorados: ninguém cria lixo no banco);
 *  - limita por endereço de rede (guardado só como código embaralhado, nunca o IP);
 *  - recusa corpo fora do padrão e contagens absurdas.
 * Não grava nada sobre a pessoa. Os números são ESTIMATIVAS de exibição (um aparelho adulterado poderia inflar a própria contagem).
 */
const MAX_REQUESTS_PER_HOUR = 120;
const PUBLISHED_TTL_MS = 60_000;

let publishedCache: { ids: Set<string>; at: number } | null = null;

/** Ids dos anúncios publicados, com cópia de 1 minuto na memória da instância (no máximo 1 leitura por minuto). */
const publishedIds = async (db: Firestore): Promise<Set<string>> => {
  const now = Date.now();
  if (publishedCache && now - publishedCache.at < PUBLISHED_TTL_MS) return publishedCache.ids;
  const snapshot = await db.doc("adsConfig/atual").get();
  const list: unknown = snapshot.exists ? snapshot.data()?.ads : [];
  const ids = new Set<string>();
  if (Array.isArray(list)) for (const ad of list) if (typeof ad === "object" && ad !== null && typeof (ad as { id?: unknown }).id === "string") ids.add((ad as { id: string }).id);
  publishedCache = { ids, at: now };
  return ids;
};

const clientKey = (req: VercelRequest): string => {
  const forwarded = req.headers["x-forwarded-for"];
  const real = req.headers["x-real-ip"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  const ip = first || (typeof real === "string" ? real.trim() : "") || "desconhecido";
  return `ip_${createHash("sha256").update(`${process.env.ADS_IP_SALT ?? "tugyn"}:${ip}`).digest("hex").slice(0, 24)}`;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const parsed = parseAdEvents(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  if (!(await dentroDoLimite(clientKey(req), "ad-events", MAX_REQUESTS_PER_HOUR, 3600))) {
    return res.status(429).json({ error: "Muitas requisições. Tente novamente mais tarde." });
  }

  let db: Firestore;
  try {
    db = getFirestore(getFirebaseApp());
  } catch (error) {
    console.error("[ad-events] Firebase Admin não configurado:", error);
    return res.status(500).json({ error: "Servidor não configurado." });
  }

  try {
    const published = await publishedIds(db);
    const accepted = parsed.events.filter((event) => published.has(event.id));

    if (accepted.length > 0) {
      const day = dayKey(Date.now());
      // Um documento por anúncio e dia: os lugares do mesmo anúncio viram campos do mesmo documento (1 escrita por anúncio).
      const byAd = new Map<string, AdEvent[]>();
      for (const event of accepted) byAd.set(event.id, [...(byAd.get(event.id) ?? []), event]);

      const batch = db.batch();
      for (const [adId, events] of byAd) {
        const byPlacement: Record<string, { impressions: ReturnType<typeof FieldValue.increment>; clicks: ReturnType<typeof FieldValue.increment> }> = {};
        for (const event of events) byPlacement[event.placement] = { impressions: FieldValue.increment(event.impressions), clicks: FieldValue.increment(event.clicks) };
        batch.set(
          db.doc(`adStats/${statDocId(adId, day)}`),
          {
            campaignId: adId,
            day,
            impressions: FieldValue.increment(events.reduce((sum, event) => sum + event.impressions, 0)),
            clicks: FieldValue.increment(events.reduce((sum, event) => sum + event.clicks, 0)),
            byPlacement,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      await batch.commit();
    }

    return res.status(200).json({ accepted: accepted.length, ignored: parsed.events.length - accepted.length });
  } catch (error) {
    console.error("[ad-events] falha ao gravar:", error); // detalhe só no log do servidor
    return res.status(503).json({ error: "Não foi possível registrar agora. Tente novamente." });
  }
}
