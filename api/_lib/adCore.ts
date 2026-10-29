/**
 * Anúncios próprios (venda de espaço no app): núcleo PURO, sem React nem Firebase.
 * O MESMO arquivo é usado no app e no painel administrativo (copie sem alterar), então os dois sempre concordam sobre
 * o que é um anúncio válido, como se monta a configuração publicada e como se escolhe qual anúncio mostrar.
 *
 * Fluxo: o painel grava as campanhas em `adCampaigns/{id}` e publica a lista dos anúncios VIGENTES em
 * `adsConfig/atual` (um só documento). O app lê esse documento (1 leitura, guardada no aparelho) e mostra o anúncio.
 */

// ───────────────────────────── vocabulário ─────────────────────────────

/** Lugares do app onde há anúncio (os mesmos dos banners do AdMob). Para criar um novo, acrescente aqui. */
export const AD_PLACEMENTS = [
  { id: "home", label: "Início" },
  { id: "partidas", label: "Partidas" },
  { id: "listaJogadores", label: "Lista de jogadores" },
  { id: "turmas", label: "Lista de turmas" },
  { id: "turmaDetalhe", label: "Detalhe da turma" },
] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number]["id"];

/**
 * Os espaços da PRIMEIRA versão do app. Versões antigas do app não conhecem os espaços novos e descartam a campanha INTEIRA
 * que cite um deles (leitura estrita). Por isso, ao lançar espaços novos, crie campanhas só para eles (veja `mixesLegacyAndNew`).
 * Versões novas do app ignoram só o espaço desconhecido e mantêm o resto da campanha (leitura tolerante).
 */
export const LEGACY_PLACEMENTS: readonly AdPlacement[] = ["home", "partidas", "listaJogadores"];

/** True se a lista mistura espaços antigos e novos (versões antigas do app não mostrariam essa campanha). */
export const mixesLegacyAndNew = (placements: readonly AdPlacement[]): boolean =>
  placements.some((placement) => LEGACY_PLACEMENTS.includes(placement)) && placements.some((placement) => !LEGACY_PLACEMENTS.includes(placement));

export const AD_TYPES = [
  { id: "banner", label: "Banner (imagem)" },
  { id: "text", label: "Só texto" },
] as const;
export type AdType = (typeof AD_TYPES)[number]["id"];

/** Limites. Os de tamanho de texto também valem nas regras do Firestore (`adCampaigns`). */
export const AD_LIMITS = {
  advertiser: 60,
  title: 40,
  body: 100,
  cta: 20,
  alt: 80,
  url: 500,
  notes: 300,
  cities: 20,
  weightMin: 1,
  weightMax: 10,
  /** Quantos anúncios cabem na configuração publicada (mantém o documento pequeno). */
  maxAdsInConfig: 60,
} as const;

/** O app recebe também anúncios que ainda vão começar nesta janela (o app só mostra dentro do período). */
export const CONFIG_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Estado da campanha no painel. SÓ `active` entra na configuração publicada (rascunho, pausada e arquivada ficam de fora).
 */
export type CampaignStatus = "draft" | "active" | "paused" | "archived";
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["draft", "active", "paused", "archived"];

/** Anúncio como o app o recebe (já validado). Datas em milissegundos. */
export interface DirectAd {
  id: string;
  type: AdType;
  advertiser: string;
  placements: AdPlacement[];
  /** Texto: título obrigatório. Banner: não usado. */
  title?: string;
  body?: string;
  cta?: string;
  /** Banner: imagem obrigatória (https). */
  imageUrl?: string;
  imageAlt?: string;
  linkUrl: string;
  startsAt: number;
  endsAt: number;
  weight: number;
  /** Vazio/ausente = todas as cidades. Valores no formato de `users/{uid}.location.cityId` (ex.: "palmas_to"). */
  cities?: string[];
}

/** O que o painel preenche (campanha, sem id). */
export interface CampaignInput extends Omit<DirectAd, "id"> {
  status: CampaignStatus;
  notes?: string;
}

export interface Campaign extends CampaignInput {
  id: string;
}

// ───────────────────────────── validação ─────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Id de cidade: minúsculas e números, partes separadas por "_" (ou "-", que é convertido para "_"). */
const CITY_PATTERN = /^[a-z0-9]+([-_][a-z0-9]+)*$/;

/**
 * Forma ÚNICA de comparar ids de cidade. O app grava `users/{uid}.location.cityId` com sublinhado (ex.: "palmas_to"); a entrada
 * com hífen ("palmas-to") é aceita e tratada como a mesma cidade, assim como ids antigos com apóstrofo ou acento ("pau_d'arco_to"
 * = "pau_d_arco_to"). Use dos dois lados ao comparar.
 */
export const canonicalCity = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
/** https obrigatório, sem usuário/senha, sem espaços nem caracteres de controle. Barra `javascript:`, `http:`, `data:` etc. */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?([/?#][^\s\u0000-\u001f\u007f]*)?$/;

export const isHttpsUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length <= AD_LIMITS.url && HTTPS_URL.test(value);

const isPlacement = (value: unknown): value is AdPlacement => AD_PLACEMENTS.some((p) => p.id === value);
const isAdType = (value: unknown): value is AdType => AD_TYPES.some((t) => t.id === value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Texto aparado, de 1 até `max` caracteres. Devolve null se vazio ou longo demais. */
const requiredText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= max ? text : null;
};
/** Texto opcional: ausente/vazio = undefined; longo demais = null (inválido). */
const optionalText = (value: unknown, max: number): string | undefined | null => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return undefined;
  return text.length <= max ? text : null;
};

const normalizeWeight = (value: unknown): number | null => {
  if (value === undefined || value === null) return 1;
  if (!isFiniteNumber(value) || !Number.isInteger(value)) return null;
  return value >= AD_LIMITS.weightMin && value <= AD_LIMITS.weightMax ? value : null;
};

const normalizeCities = (value: unknown): string[] | undefined | null => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > AD_LIMITS.cities) return null;
  const cities: string[] = [];
  for (const city of value) {
    if (typeof city !== "string" || !CITY_PATTERN.test(city.trim())) return null;
    const id = canonicalCity(city);
    if (!cities.includes(id)) cities.push(id);
  }
  return cities.length ? cities : undefined;
};

/** ESTRITA (formulário do painel): qualquer lugar desconhecido invalida. */
const normalizePlacements = (value: unknown): AdPlacement[] | null => {
  if (!Array.isArray(value)) return null;
  const placements: AdPlacement[] = [];
  for (const item of value) {
    if (!isPlacement(item)) return null;
    if (!placements.includes(item)) placements.push(item);
  }
  return placements.length ? placements : null;
};

/** TOLERANTE (leitura no app e na publicação): ignora os lugares que esta versão não conhece. Só descarta se não sobrar nenhum. */
const normalizePlacementsLenient = (value: unknown): AdPlacement[] | null => {
  if (!Array.isArray(value)) return null;
  const placements: AdPlacement[] = [];
  for (const item of value) if (isPlacement(item) && !placements.includes(item)) placements.push(item);
  return placements.length ? placements : null;
};

/**
 * Valida UM anúncio vindo do Firestore (app) ou da campanha (montagem da configuração). Rígido: qualquer campo fora do
 * padrão invalida o anúncio inteiro (devolve null). Nunca lança.
 */
export const parseAd = (raw: unknown): DirectAd | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) return null;
  if (!isAdType(r.type)) return null;
  const advertiser = requiredText(r.advertiser, AD_LIMITS.advertiser);
  const placements = normalizePlacementsLenient(r.placements);
  const weight = normalizeWeight(r.weight);
  const cities = normalizeCities(r.cities);
  const title = optionalText(r.title, AD_LIMITS.title);
  const body = optionalText(r.body, AD_LIMITS.body);
  const cta = optionalText(r.cta, AD_LIMITS.cta);
  const imageAlt = optionalText(r.imageAlt, AD_LIMITS.alt);
  if (!advertiser || !placements || weight === null || cities === null) return null;
  if (title === null || body === null || cta === null || imageAlt === null) return null;
  if (!isHttpsUrl(r.linkUrl)) return null;
  if (!isFiniteNumber(r.startsAt) || !isFiniteNumber(r.endsAt) || r.endsAt <= r.startsAt) return null;

  if (r.type === "text" && !title) return null;
  if (r.type === "banner" && !isHttpsUrl(r.imageUrl)) return null;
  if (r.imageUrl !== undefined && r.imageUrl !== null && r.imageUrl !== "" && !isHttpsUrl(r.imageUrl)) return null;

  return {
    id: r.id,
    type: r.type,
    advertiser,
    placements,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(cta ? { cta } : {}),
    ...(r.type === "banner" ? { imageUrl: r.imageUrl as string } : {}),
    ...(r.type === "banner" && imageAlt ? { imageAlt } : {}),
    linkUrl: r.linkUrl,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    weight,
    ...(cities ? { cities } : {}),
  };
};

export type ValidationResult = { ok: true; value: CampaignInput } | { ok: false; errors: Record<string, string> };

/** Validação do FORMULÁRIO do painel: mensagens em português por campo. */
export const validateCampaignInput = (input: unknown): ValidationResult => {
  const errors: Record<string, string> = {};
  const r = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const advertiser = requiredText(r.advertiser, AD_LIMITS.advertiser);
  if (!advertiser) errors.advertiser = `Informe o anunciante (até ${AD_LIMITS.advertiser} caracteres).`;
  if (!isAdType(r.type)) errors.type = "Escolha o tipo: banner ou só texto.";
  const placements = normalizePlacements(r.placements);
  if (!placements) errors.placements = "Escolha pelo menos um lugar para o anúncio aparecer.";
  const weight = normalizeWeight(r.weight);
  if (weight === null) errors.weight = `O peso é um número inteiro de ${AD_LIMITS.weightMin} a ${AD_LIMITS.weightMax}.`;
  const cities = normalizeCities(r.cities);
  if (cities === null) errors.cities = `Cidades no formato palmas_to, o mesmo do perfil dos usuários (até ${AD_LIMITS.cities}), separadas por vírgula.`;
  const title = optionalText(r.title, AD_LIMITS.title);
  if (title === null) errors.title = `O título tem no máximo ${AD_LIMITS.title} caracteres.`;
  const body = optionalText(r.body, AD_LIMITS.body);
  if (body === null) errors.body = `O texto tem no máximo ${AD_LIMITS.body} caracteres.`;
  const cta = optionalText(r.cta, AD_LIMITS.cta);
  if (cta === null) errors.cta = `O botão tem no máximo ${AD_LIMITS.cta} caracteres.`;
  const imageAlt = optionalText(r.imageAlt, AD_LIMITS.alt);
  if (imageAlt === null) errors.imageAlt = `A descrição da imagem tem no máximo ${AD_LIMITS.alt} caracteres.`;
  const notes = optionalText(r.notes, AD_LIMITS.notes);
  if (notes === null) errors.notes = `As observações têm no máximo ${AD_LIMITS.notes} caracteres.`;
  if (!isHttpsUrl(r.linkUrl)) errors.linkUrl = "O link precisa começar com https:// (sem espaços).";
  if (r.type === "text" && !title) errors.title = "O anúncio de texto precisa de um título.";
  if (r.type === "banner" && !isHttpsUrl(r.imageUrl)) errors.imageUrl = "O banner precisa de uma imagem (link https).";
  if (r.type === "text" && r.imageUrl) errors.imageUrl = "Anúncio só de texto não leva imagem.";
  if (!isFiniteNumber(r.startsAt)) errors.startsAt = "Informe a data de início.";
  if (!isFiniteNumber(r.endsAt)) errors.endsAt = "Informe a data de término.";
  if (isFiniteNumber(r.startsAt) && isFiniteNumber(r.endsAt) && r.endsAt <= r.startsAt) errors.endsAt = "O término precisa ser depois do início.";
  if (!CAMPAIGN_STATUSES.includes(r.status as CampaignStatus)) errors.status = "Escolha o estado da campanha (rascunho, ativa, pausada ou arquivada).";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: r.type as AdType,
      advertiser: advertiser as string,
      placements: placements as AdPlacement[],
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(cta ? { cta } : {}),
      ...(r.type === "banner" ? { imageUrl: r.imageUrl as string, ...(imageAlt ? { imageAlt } : {}) } : {}),
      linkUrl: r.linkUrl as string,
      startsAt: r.startsAt as number,
      endsAt: r.endsAt as number,
      weight: weight as number,
      ...(cities ? { cities } : {}),
      status: r.status as CampaignStatus,
      ...(notes ? { notes } : {}),
    },
  };
};

// ───────────────────────────── configuração publicada ─────────────────────────────

export interface BuildResult {
  ads: DirectAd[];
  /** Campanhas que ficaram de fora e por quê (o painel mostra ao publicar). */
  skipped: { id: string; reason: string }[];
}

/**
 * Monta a lista que vai para `adsConfig/atual`: só campanhas ATIVAS, que ainda não terminaram e que começam dentro da
 * janela de 7 dias. Campanhas inválidas ficam de fora (com o motivo). A ordem é a do início da veiculação.
 */
export const buildAdsConfig = (campaigns: readonly Campaign[], now: number): BuildResult => {
  const skipped: BuildResult["skipped"] = [];
  const valid: DirectAd[] = [];
  for (const campaign of campaigns) {
    if (campaign.status !== "active") continue;
    if (isFiniteNumber(campaign.endsAt) && campaign.endsAt <= now) continue;
    if (isFiniteNumber(campaign.startsAt) && campaign.startsAt > now + CONFIG_LOOKAHEAD_MS) continue;
    const ad = parseAd(campaign);
    if (!ad) {
      skipped.push({ id: String(campaign.id), reason: "dados inválidos (revise os campos)" });
      continue;
    }
    valid.push(ad);
  }
  valid.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  const ads = valid.slice(0, AD_LIMITS.maxAdsInConfig);
  for (const extra of valid.slice(AD_LIMITS.maxAdsInConfig)) skipped.push({ id: extra.id, reason: `acima do limite de ${AD_LIMITS.maxAdsInConfig} anúncios` });
  return { ads, skipped };
};

/** O app lê o documento publicado: descarta qualquer item inválido e respeita o limite. */
export const readAdsConfig = (data: unknown): DirectAd[] => {
  if (typeof data !== "object" || data === null) return [];
  const list = (data as { ads?: unknown }).ads;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, AD_LIMITS.maxAdsInConfig)
    .map(parseAd)
    .filter((ad): ad is DirectAd => ad !== null);
};

// ───────────────────────────── escolha do anúncio ─────────────────────────────

export const isActiveNow = (ad: Pick<DirectAd, "startsAt" | "endsAt">, now: number): boolean => ad.startsAt <= now && now < ad.endsAt;

export interface AdContext {
  /** Cidade do usuário (`location.cityId`). Sem ela, só anúncios para todas as cidades. */
  cityId?: string | null;
}

/** Candidatos para um lugar: vigentes agora e que valem para a cidade do usuário. */
export const eligibleAds = (ads: readonly DirectAd[], placement: AdPlacement, now: number, context: AdContext = {}): DirectAd[] =>
  ads.filter((ad) => {
    if (!ad.placements.includes(placement)) return false;
    if (!isActiveNow(ad, now)) return false;
    if (ad.cities && ad.cities.length > 0) {
      const city = context.cityId ? canonicalCity(context.cityId) : "";
      return city !== "" && ad.cities.some((id) => canonicalCity(id) === city);
    }
    return true;
  });

/** Sorteio ponderado pelo peso (peso 3 aparece 3x mais que peso 1). `random` devolve [0, 1). */
export const pickAd = (
  ads: readonly DirectAd[],
  placement: AdPlacement,
  now: number,
  context: AdContext = {},
  random: () => number = Math.random,
): DirectAd | null => {
  const candidates = eligibleAds(ads, placement, now, context);
  if (candidates.length === 0) return null;
  const total = candidates.reduce((sum, ad) => sum + ad.weight, 0);
  let point = random() * total;
  for (const ad of candidates) {
    point -= ad.weight;
    if (point < 0) return ad;
  }
  return candidates[candidates.length - 1];
};

// ───────────────────────────── ligar e desligar anúncios por espaço (pelo servidor) ─────────────────────────────

/**
 * O que está ligado em um espaço do app. `own`: anúncios próprios (vendidos no painel). `admob`: o banner do AdMob (reserva).
 * Os dois desligados = o espaço some da tela. Fica em `adsConfig/espacos` (leitura pública), editado no painel: vale sem atualizar o app.
 */
export interface PlacementSettings {
  own: boolean;
  admob: boolean;
}

export type PlacementSettingsMap = Record<AdPlacement, PlacementSettings>;

/** Tudo ligado. É o valor de qualquer espaço que ainda não tem configuração (e de todos, se o documento não existir ou falhar). */
export const defaultPlacementSettings = (): PlacementSettings => ({ own: true, admob: true });

export const defaultSettingsMap = (): PlacementSettingsMap =>
  Object.fromEntries(AD_PLACEMENTS.map(({ id }) => [id, defaultPlacementSettings()])) as PlacementSettingsMap;

/**
 * Lê o documento `adsConfig/espacos`. É um interruptor de EMERGÊNCIA, então só o valor literal `false` desliga: qualquer coisa
 * malformada, ausente ou de espaço que esta versão não conhece fica LIGADA (ou ignorada). Nunca lança.
 */
export const readPlacementSettings = (data: unknown): PlacementSettingsMap => {
  const map = defaultSettingsMap();
  if (typeof data !== "object" || data === null) return map;
  const placements = (data as { placements?: unknown }).placements;
  if (typeof placements !== "object" || placements === null) return map;
  for (const { id } of AD_PLACEMENTS) {
    const entry = (placements as Record<string, unknown>)[id];
    if (typeof entry !== "object" || entry === null) continue;
    const { own, admob } = entry as Record<string, unknown>;
    map[id] = { own: own !== false, admob: admob !== false };
  }
  return map;
};

/** O que o painel grava (sem a hora, que vem do servidor). */
export const buildPlacementSettingsDoc = (settings: PlacementSettingsMap): { version: 1; placements: PlacementSettingsMap } => ({
  version: 1,
  placements: Object.fromEntries(AD_PLACEMENTS.map(({ id }) => [id, { own: settings[id].own, admob: settings[id].admob }])) as PlacementSettingsMap,
});
