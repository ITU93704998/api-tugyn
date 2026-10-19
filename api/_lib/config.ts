export type Bucket = "usuarios" | "times" | "arenas" | "anuncios";

export const BUCKETS: readonly Bucket[] = ["usuarios", "times", "arenas", "anuncios"];

/**
 * Buckets com imagens DE UM USUÁRIO (apagadas quando a conta dele é excluída). `anuncios` NÃO entra: os banners são da
 * empresa (só administradores enviam) e precisam continuar existindo mesmo que a conta de quem os enviou seja apagada.
 */
export const USER_BUCKETS: readonly Bucket[] = ["usuarios", "times", "arenas"];

/** Só administradores (claim `admin` no login do Firebase) enviam e apagam imagens destes buckets. */
export const ADMIN_ONLY_BUCKETS: readonly Bucket[] = ["anuncios"];

export const isAdminOnlyBucket = (bucket: Bucket): boolean => ADMIN_ONLY_BUCKETS.includes(bucket);

export interface CloudinaryAccount {
  cloud_name: string;
  api_key: string;
  api_secret: string;
}

/**
 * Credenciais por bucket (variáveis de ambiente da Vercel). Retorna null se faltar qualquer uma.
 * As credenciais são passadas A CADA CHAMADA ao Cloudinary, nunca via `cloudinary.config()`:
 * a configuração global é compartilhada e requisições simultâneas de buckets diferentes
 * poderiam acabar usando a conta errada.
 */
export const getAccount = (bucket: Bucket): CloudinaryAccount | null => {
  const accounts: Record<Bucket, Partial<CloudinaryAccount>> = {
    usuarios: {
      cloud_name: process.env.CLOUDINARY_NAME_USUARIOS,
      api_key: process.env.CLOUDINARY_KEY_USUARIOS,
      api_secret: process.env.CLOUDINARY_SECRET_USUARIOS,
    },
    times: {
      cloud_name: process.env.CLOUDINARY_NAME_TIMES,
      api_key: process.env.CLOUDINARY_KEY_TIMES,
      api_secret: process.env.CLOUDINARY_SECRET_TIMES,
    },
    arenas: {
      cloud_name: process.env.CLOUDINARY_NAME_ARENAS,
      api_key: process.env.CLOUDINARY_KEY_ARENAS,
      api_secret: process.env.CLOUDINARY_SECRET_ARENAS,
    },
    anuncios: {
      cloud_name: process.env.CLOUDINARY_NAME_ANUNCIOS,
      api_key: process.env.CLOUDINARY_KEY_ANUNCIOS,
      api_secret: process.env.CLOUDINARY_SECRET_ANUNCIOS,
    },
  };

  const complete = (account: Partial<CloudinaryAccount>): CloudinaryAccount | null => {
    const { cloud_name, api_key, api_secret } = account;
    return cloud_name && api_key && api_secret ? { cloud_name, api_key, api_secret } : null;
  };

  const own = complete(accounts[bucket]);
  if (own) return own;
  // Anúncios sem conta PRÓPRIA configurada (nenhuma das 3 variáveis): usa a conta de usuários (a pasta é outra: `anuncios/`).
  // Configuração pela metade (só 1 ou 2 variáveis) é erro: devolve null em vez de misturar contas em silêncio.
  const hasAnyOwn = Object.values(accounts[bucket]).some(Boolean);
  return bucket === "anuncios" && !hasAnyOwn ? complete(accounts.usuarios) : null;
};
