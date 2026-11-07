import { BUCKETS, type Bucket } from "./config";

/**
 * Validações PURAS de tudo que vem do cliente. Nada que vem do corpo da requisição vai
 * para o Cloudinary sem passar por aqui.
 */

/** Tamanho máximo do arquivo (binário). O app comprime para ~1,2 MB; a Vercel limita o corpo a 4,5 MB. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const FOLDER_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const PUBLIC_ID_REGEX = /^[A-Za-z0-9_\-./]+$/;
const DATA_URI_PREFIX = /^data:image\/(?:jpeg|jpg|png|webp);base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

export const isSafeUid = (uid: unknown): uid is string => typeof uid === "string" && UID_REGEX.test(uid);

export const parseBucket = (value: unknown): Bucket | null =>
  typeof value === "string" && (BUCKETS as readonly string[]).includes(value) ? (value as Bucket) : null;

/**
 * Uma pasta, um único segmento ("profile", "banner"...). Sem "/", "..", espaços ou caracteres
 * especiais: o cliente não consegue escolher outro caminho. Vazio vira "geral".
 */
export const parseFolderName = (value: unknown): string | null => {
  if (value === undefined || value === null || value === "") return "geral";
  return typeof value === "string" && FOLDER_REGEX.test(value) ? value : null;
};

/** Só o avatar usa id fixo (e sobrescreve a foto anterior do MESMO usuário). */
export const isAvatar = (bucket: Bucket, folder: string): boolean =>
  bucket === "usuarios" && folder === "profile";

export type ImageCheck = { ok: true; bytes: number } | { ok: false; status: 400 | 413; error: string };

/**
 * Confere os primeiros bytes: só aceita assinaturas de JPEG/PNG/WebP.
 * Usa Uint8Array puro (sem métodos exclusivos de Buffer) para evitar atrito de tipos
 * entre TypeScript 5.9 e @types/node no runtime da Vercel.
 */
const hasImageSignature = (bytes: Uint8Array): boolean => {
  const isJpeg =
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const isPng = bytes.length >= 8 && pngSignature.every((b, i) => bytes[i] === b);

  const isWebp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";

  return isJpeg || isPng || isWebp;
};

/**
 * Aceita SOMENTE um data URI base64 de JPEG/PNG/WebP. Recusa URLs remotas (o Cloudinary as
 * BAIXARIA do servidor deles), qualquer outro esquema, texto/HTML disfarçado e arquivos grandes.
 */
export const parseImage = (value: unknown): ImageCheck => {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, status: 400, error: "Imagem ausente." };
  }

  // Barra tamanhos absurdos ANTES de rodar qualquer regex sobre o texto inteiro.
  const maxChars = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 128;
  if (value.length > maxChars) return { ok: false, status: 413, error: "A imagem é grande demais." };

  const prefix = DATA_URI_PREFIX.exec(value);
  if (!prefix) return { ok: false, status: 400, error: "Formato de imagem não permitido. Use JPEG, PNG ou WebP." };

  const body = value.slice(prefix[0].length);
  if (!BASE64_BODY.test(body) || body.length % 4 !== 0) {
    return { ok: false, status: 400, error: "Imagem corrompida." };
  }

  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  const bytes = (body.length * 3) / 4 - padding;
  if (bytes > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "A imagem é grande demais." };

  // Confere os primeiros bytes: o que diz ser imagem precisa começar como imagem.
  const head = new Uint8Array(Buffer.from(body.slice(0, 24), "base64"));
  if (!hasImageSignature(head)) {
    return { ok: false, status: 400, error: "O arquivo não é uma imagem válida." };
  }

  return { ok: true, bytes };
};

/**
 * `public_id` a apagar: precisa estar DENTRO da pasta do próprio usuário naquele bucket
 * (`<bucket>/<uid>/...`) e não pode ter "..", caracteres estranhos nem ser longo demais.
 */
export const parseOwnedPublicId = (value: unknown, bucket: Bucket, uid: string): string | null => {
  if (typeof value !== "string" || value.length > 200) return null;
  if (!PUBLIC_ID_REGEX.test(value) || value.includes("..") || value.includes("//")) return null;

  const ownPrefix = `${bucket}/${uid}/`;
  return value.startsWith(ownPrefix) && value.length > ownPrefix.length ? value : null;
};

/**
 * Banner de anúncio que QUALQUER administrador pode apagar: `anuncios/<uid de quem enviou>/<pasta>/<nome>`.
 * A pasta `contratos` fica de fora (é o registro do banner aprovado pelo cliente): devolve "contrato".
 */
export const parseBannerDeAnuncio = (value: unknown): string | "contrato" | null => {
  if (typeof value !== "string" || value.length > 200) return null;
  const m = /^anuncios\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (!m) return null;
  return m[2] === "contratos" ? "contrato" : value;
};

/** Segmento de assinatura (`s--abc--`), transformação (`f_auto`, `c_fill,w_300`, `t_nome`...) ou versão (`v1700000000`). */
const SEGMENTO_DE_ENTREGA = /^(?:s--[^/]+--|v\d+|[a-z]{1,4}_[^/]*|[^/]*,[^/]*)$/;
const EXTENSAO = /\.[A-Za-z0-9]{1,5}$/;

/**
 * A URL (de uma campanha ou do anúncio publicado) aponta para esta imagem? Lê a URL de entrega do Cloudinary
 * (`https://res.cloudinary.com/<cloud>/image/upload/[transformações/][v123/]<public_id>[.ext][?...]`), com ou sem extensão,
 * com transformações, versão, query string e fragmento, e compara o `public_id` INTEIRO (segmento a segmento: um id com o
 * mesmo começo não confunde). Com `cloud`, URL de outra conta do Cloudinary é outra imagem.
 *
 * Na dúvida, responde que USA (quem chama mantém a imagem): URL que não dá para ler, de outro endereço ou em formato
 * desconhecido, mas que contém o id.
 */
export const urlUsaImagem = (url: unknown, publicId: string, cloud?: string): boolean => {
  if (typeof url !== "string" || !url || !publicId) return false;
  let partes: string[];
  let host: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    partes = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    return url.includes(publicId);
  }
  if (host !== "res.cloudinary.com") return url.includes(publicId); // CDN própria/formato desconhecido: na dúvida, usa
  const upload = partes.indexOf("upload");
  if (upload < 2 || partes[upload - 1] !== "image") return url.includes(publicId);
  if (cloud && partes[0] !== cloud) return false;
  const resto = partes.slice(upload + 1);
  if (!resto.length) return false;
  resto[resto.length - 1] = resto[resto.length - 1].replace(EXTENSAO, "");
  const alvo = publicId.split("/");
  if (resto.length < alvo.length) return false;
  const fim = resto.slice(resto.length - alvo.length);
  if (fim.some((p, i) => p !== alvo[i])) return false;
  const antes = resto.slice(0, resto.length - alvo.length);
  // Antes do id só cabem assinatura, transformações e versão; outra pasta na frente = id mais longo = outra imagem.
  return antes.every((p) => SEGMENTO_DE_ENTREGA.test(p));
};

/** Todos os textos de um documento (campos aninhados e listas), para procurar URLs de imagem. */
export const textosDoDocumento = (valor: unknown, limite = 5000): string[] => {
  const saida: string[] = [];
  const visitar = (v: unknown, profundidade: number) => {
    if (saida.length >= limite || profundidade > 8) return;
    if (typeof v === "string") saida.push(v);
    else if (Array.isArray(v)) v.forEach((x) => visitar(x, profundidade + 1));
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => visitar(x, profundidade + 1));
  };
  visitar(valor, 0);
  return saida;
};