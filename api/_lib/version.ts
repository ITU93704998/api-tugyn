/**
 * Política de versão do app (funções PURAS). Tudo vem de variáveis de ambiente da Vercel,
 * então mudar a versão mínima é trocar uma variável e republicar, sem mexer em código.
 */

export type AppPlatform = "ios" | "android";

export interface VersionPolicy {
  /** Abaixo disto o app BLOQUEIA e manda atualizar. null = sem versão mínima. */
  minVersion: string | null;
  /** Abaixo disto o app só AVISA (opcional). null = sem aviso. */
  latestVersion: string | null;
  /** Link da loja (só https de Apple/Google). */
  storeUrl: string | null;
  /** Texto extra opcional exibido na tela de atualização. */
  message: string | null;
}

const VERSION_REGEX = /^\d{1,4}(\.\d{1,4}){1,2}$/;
const ALLOWED_STORE_HOSTS = new Set(["apps.apple.com", "itunes.apple.com", "play.google.com"]);
const MAX_MESSAGE_LENGTH = 200;

export const isValidVersion = (value: unknown): value is string =>
  typeof value === "string" && VERSION_REGEX.test(value);

/** Compara "1.4" com "1.4.0" como iguais. Negativo: a < b; 0: iguais; positivo: a > b. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const isAllowedStoreUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_STORE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

export const parsePlatform = (value: unknown): AppPlatform | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "ios" || raw === "android" ? raw : null;
};

type Env = Record<string, string | undefined>;

const pick = (env: Env, base: string, platform: AppPlatform | null): string | undefined => {
  const specific = platform ? env[`${base}_${platform.toUpperCase()}`] : undefined;
  return specific || env[base] || undefined;
};

export interface ResolvedPolicy {
  policy: VersionPolicy;
  /** Problemas de configuração encontrados (vão para o log do servidor, nunca para o cliente). */
  warnings: string[];
}

/**
 * Monta a política para uma plataforma: `APP_MIN_VERSION_IOS` vale antes de `APP_MIN_VERSION`.
 * Valor inválido é IGNORADO (e registrado), nunca vira bloqueio. E uma mínima MAIOR que a
 * mais recente é rebaixada para a mais recente: assim um erro de digitação não tranca todo mundo.
 */
export const resolvePolicy = (env: Env, platform: AppPlatform | null): ResolvedPolicy => {
  const warnings: string[] = [];

  const read = (base: string): string | null => {
    const raw = pick(env, base, platform);
    if (raw === undefined) return null;
    if (isValidVersion(raw)) return raw;
    warnings.push(`${base}: valor inválido "${raw}" (ignorado)`);
    return null;
  };

  let minVersion = read("APP_MIN_VERSION");
  const latestVersion = read("APP_LATEST_VERSION");

  if (minVersion && latestVersion && compareVersions(minVersion, latestVersion) > 0) {
    warnings.push(`APP_MIN_VERSION (${minVersion}) é MAIOR que APP_LATEST_VERSION (${latestVersion}): usando ${latestVersion}`);
    minVersion = latestVersion;
  }

  const rawStore = pick(env, "APP_STORE_URL", platform);
  let storeUrl: string | null = null;
  if (rawStore !== undefined) {
    if (isAllowedStoreUrl(rawStore)) storeUrl = rawStore;
    else warnings.push("APP_STORE_URL: deve ser https de apps.apple.com, itunes.apple.com ou play.google.com (ignorado)");
  }

  const rawMessage = env.APP_UPDATE_MESSAGE;
  const message = rawMessage && rawMessage.trim() ? rawMessage.trim().slice(0, MAX_MESSAGE_LENGTH) : null;

  return { policy: { minVersion, latestVersion, storeUrl, message }, warnings };
};
