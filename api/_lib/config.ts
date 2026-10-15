export type Bucket = "usuarios" | "times" | "arenas";

export const BUCKETS: readonly Bucket[] = ["usuarios", "times", "arenas"];

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
  };

  const { cloud_name, api_key, api_secret } = accounts[bucket];
  return cloud_name && api_key && api_secret ? { cloud_name, api_key, api_secret } : null;
};
