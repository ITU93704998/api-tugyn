/**
 * O anúncio que o CLIENTE envia no contrato (texto ou banner) e a campanha que sai dele ao ser aprovado.
 * Lógica PURA, usada pelo painel (formulário do cliente e prévia) e pelo servidor (valida e monta a campanha). Este arquivo é IDÊNTICO
 * nos dois lugares. Os limites repetem os de `AD_LIMITS` (adCore.ts); um teste do painel confere que não divergem.
 */

export const ANUNCIO_LIMITES = { anunciante: 60, titulo: 40, texto: 100, botao: 20, alt: 80, url: 500 } as const;

/** O banner tem proporção FIXA de 3,2 : 1. O painel entrega 1280 × 400 (exatamente 3,2); o servidor aceita uma pequena tolerância. */
export const BANNER = { razao: 3.2, largura: 1280, altura: 400, tolerancia: 0.02, larguraMin: 640, larguraMax: 4096 } as const;

/** A imagem tem a proporção 3,2:1 (com tolerância) e um tamanho utilizável? */
export const bannerOk = (largura: number, altura: number): boolean =>
  Number.isFinite(largura) && Number.isFinite(altura) && altura > 0 && largura >= BANNER.larguraMin && largura <= BANNER.larguraMax && Math.abs(largura / altura - BANNER.razao) <= BANNER.tolerancia;

export interface ImagemAnuncio {
  url: string;
  publicId: string;
  largura: number;
  altura: number;
  bytes: number;
}

export interface AnuncioContrato {
  anunciante: string;
  /** Só texto: título obrigatório; texto e botão opcionais. Banner: ficam null. */
  titulo: string | null;
  texto: string | null;
  botao: string | null;
  linkUrl: string;
  /** Só banner. */
  textoAlternativo: string | null;
  imagem: ImagemAnuncio | null;
}

export type ErrosAnuncio = Record<string, string>;
export type ResultadoAnuncio = { ok: true; anuncio: AnuncioContrato } | { ok: false; erros: ErrosAnuncio };

const limpar = (valor: unknown): string => (typeof valor === "string" ? valor.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
const HTTPS = /^https:\/\/[^\s]+$/;

/**
 * Valida o que o cliente digitou (texto vindo da rede: nada é confiado). Para banner, a imagem já enviada é passada à parte
 * (`imagem`): ela foi validada no envio (proporção, tipo, tamanho). Mensagens prontas para mostrar.
 */
export const validarAnuncio = (modelo: "text" | "banner", raw: unknown, imagem: ImagemAnuncio | null): ResultadoAnuncio => {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const erros: ErrosAnuncio = {};
  const anunciante = limpar(r.anunciante);
  if (!anunciante) erros.anunciante = "Informe o nome que aparece no anúncio.";
  else if (anunciante.length > ANUNCIO_LIMITES.anunciante) erros.anunciante = `No máximo ${ANUNCIO_LIMITES.anunciante} caracteres.`;
  const linkUrl = typeof r.linkUrl === "string" ? r.linkUrl.trim() : "";
  if (!HTTPS.test(linkUrl) || linkUrl.length > ANUNCIO_LIMITES.url) erros.linkUrl = "O link precisa começar com https:// (sem espaços).";

  let titulo: string | null = null;
  let texto: string | null = null;
  let botao: string | null = null;
  let textoAlternativo: string | null = null;
  if (modelo === "text") {
    titulo = limpar(r.titulo);
    if (!titulo) erros.titulo = "O anúncio de texto precisa de um título.";
    else if (titulo.length > ANUNCIO_LIMITES.titulo) erros.titulo = `No máximo ${ANUNCIO_LIMITES.titulo} caracteres.`;
    texto = limpar(r.texto) || null;
    if (texto && texto.length > ANUNCIO_LIMITES.texto) erros.texto = `No máximo ${ANUNCIO_LIMITES.texto} caracteres.`;
    botao = limpar(r.botao) || null;
    if (botao && botao.length > ANUNCIO_LIMITES.botao) erros.botao = `No máximo ${ANUNCIO_LIMITES.botao} caracteres.`;
  } else {
    if (!imagem) erros.imagem = "Envie a imagem do banner.";
    else if (!bannerOk(imagem.largura, imagem.altura)) erros.imagem = "A imagem precisa ter a proporção 3,2 : 1.";
    textoAlternativo = limpar(r.textoAlternativo) || null;
    if (textoAlternativo && textoAlternativo.length > ANUNCIO_LIMITES.alt) erros.textoAlternativo = `No máximo ${ANUNCIO_LIMITES.alt} caracteres.`;
  }
  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return { ok: true, anuncio: { anunciante, titulo: titulo || null, texto, botao, linkUrl, textoAlternativo, imagem: modelo === "banner" ? imagem : null } };
};

/**
 * A campanha que nasce da aprovação, COM EXATAMENTE os campos que as regras do Firestore aceitam (`adCampaigns` recusa chave extra):
 * sem id do contrato. A origem fica nas observações. `cities` só quando é uma cidade; em "todas" o campo não existe (= todas).
 */
export const montarCampanha = (p: {
  codigo: string;
  clienteNome: string;
  modelo: "text" | "banner";
  telas: readonly string[];
  escopo: "cidade" | "todas";
  cidadeId: string | null;
  anuncio: AnuncioContrato;
  inicioMs: number;
  fimMs: number;
}): Record<string, unknown> => ({
  type: p.modelo,
  advertiser: p.anuncio.anunciante,
  placements: [...p.telas],
  linkUrl: p.anuncio.linkUrl,
  startsAt: p.inicioMs,
  endsAt: p.fimMs,
  weight: 1,
  status: "active",
  notes: `Contrato ${p.codigo} · ${p.clienteNome}`.slice(0, 300),
  ...(p.modelo === "text" ? { title: p.anuncio.titulo ?? "", ...(p.anuncio.texto ? { body: p.anuncio.texto } : {}), ...(p.anuncio.botao ? { cta: p.anuncio.botao } : {}) } : {}),
  ...(p.modelo === "banner" && p.anuncio.imagem ? { imageUrl: p.anuncio.imagem.url, ...(p.anuncio.textoAlternativo ? { imageAlt: p.anuncio.textoAlternativo } : {}) } : {}),
  ...(p.escopo === "cidade" && p.cidadeId ? { cities: [p.cidadeId] } : {}),
});
