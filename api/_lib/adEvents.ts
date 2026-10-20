/**
 * Eventos de anúncio próprio (impressões e cliques). Validações PURAS de tudo que vem do app: nada daqui sai sem passar por elas.
 * O app NÃO envia nada sobre a pessoa (sem uid, aparelho ou localização): só "anúncio X, lugar Y, N impressões, M cliques".
 */

export const AD_PLACEMENTS = ["home", "partidas", "listaJogadores"] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export interface AdEvent {
  id: string;
  placement: AdPlacement;
  impressions: number;
  clicks: number;
}

/** Quantos itens cabem em uma requisição, e o máximo de cada contador por item (o app envia em lotes pequenos). */
export const MAX_EVENTS_PER_REQUEST = 30;
export const MAX_COUNT_PER_ITEM = 500;

const AD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ParseResult = { ok: true; events: AdEvent[] } | { ok: false; error: string };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT_PER_ITEM;

/**
 * Valida o corpo `{ events: [{ id, placement, impressions?, clicks? }] }`. Qualquer item fora do padrão recusa a requisição inteira
 * (o contrato é claro e o app descarta o que o servidor recusa). Itens repetidos (mesmo anúncio e lugar) são somados.
 */
export const parseAdEvents = (body: unknown): ParseResult => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const list = (body as { events?: unknown }).events;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "Nenhum evento enviado." };
  if (list.length > MAX_EVENTS_PER_REQUEST) return { ok: false, error: "Eventos demais em uma requisição." };

  const merged = new Map<string, AdEvent>();
  for (const item of list) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "Evento inválido." };
    const { id, placement, impressions = 0, clicks = 0 } = item as Record<string, unknown>;
    if (typeof id !== "string" || !AD_ID.test(id)) return { ok: false, error: "Anúncio inválido." };
    if (typeof placement !== "string" || !(AD_PLACEMENTS as readonly string[]).includes(placement)) return { ok: false, error: "Lugar inválido." };
    if (!isCount(impressions) || !isCount(clicks)) return { ok: false, error: "Contagem inválida." };
    if (impressions === 0 && clicks === 0) return { ok: false, error: "Evento sem contagem." };

    const key = `${id}|${placement}`;
    const current = merged.get(key);
    if (current) {
      current.impressions += impressions;
      current.clicks += clicks;
    } else {
      merged.set(key, { id, placement: placement as AdPlacement, impressions, clicks });
    }
  }
  return { ok: true, events: [...merged.values()] };
};

/** Dia do evento no fuso de São Paulo ("2026-10-19"). Decidido pelo SERVIDOR: o relógio do aparelho não conta. */
export const dayKey = (now: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** Id do documento de estatística de um anúncio em um dia: `<anuncio>_<AAAAMMDD>`. */
export const statDocId = (adId: string, day: string): string => `${adId}_${day.replace(/-/g, "")}`;
