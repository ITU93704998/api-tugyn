/**
 * Página pública de convite de turma: https://<servidor>/api/turma/<id>
 *
 * Por que existe: um link `tugyn://turma/<id>` colado no WhatsApp/Instagram não é clicável. Um link
 * https é; esta página então oferece "Abrir no Tugyn" (esquema do app) e "Baixar o app" (loja).
 * Prévia do link (WhatsApp etc.): usa só a cópia pública `turmaPreviews/<id>` (a mesma que o app mostra
 * para quem abre o convite). Sem ela, a página fica genérica.
 */
import { blocoDasLojas, documentoPublico, esc, topoHtml, type Plataforma } from "./paginaPublica";

export { esc, type Plataforma };

/** Ids de documento do Firestore: letras, números, `_` e `-` (os gerados automaticamente têm 20). */
export const isValidTurmaId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);

export const detectarPlataforma = (userAgent: unknown): Plataforma => {
  const ua = Array.isArray(userAgent) ? String(userAgent[0] ?? "") : String(userAgent ?? "");
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "outra";
};

/** Campos da prévia pública que aparecem no link (já limpos). */
export interface PreviaTurma {
  nome: string;
  arenaNome: string;
  dias: string;
  horario: string;
  /** Banner recortado em 1200x630 (formato de prévia grande), ou "" sem banner. */
  imagem: string;
}

export const limpar = (valor: unknown, max: number): string =>
  typeof valor === "string"
    ? valor.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim()
    : "";

const DIAS_CURTOS: Record<string, string> = {
  sunday: "Dom", monday: "Seg", tuesday: "Ter", wednesday: "Qua",
  thursday: "Qui", friday: "Sex", saturday: "Sáb",
};

/**
 * Banner do Cloudinary recortado em 1200x630 (o WhatsApp mostra a prévia grande nesse formato).
 * Só aceita URLs do próprio Cloudinary; qualquer outra coisa vira "" (a página usa o ícone).
 */
export const imagemDaPrevia = (url: unknown): string => {
  const bruto = limpar(url, 500);
  const m = /^https:\/\/res\.cloudinary\.com\/([a-z0-9_-]+)\/image\/upload\/([A-Za-z0-9_\-./,]+)$/i.exec(bruto);
  if (!m) return "";
  const partes = m[2].split("/");
  const corte = "c_fill,g_auto,w_1200,h_630,q_auto,f_jpg";
  const versao = partes.findIndex((p) => /^v\d+$/.test(p));
  if (versao >= 0) partes.splice(versao, 0, corte);
  else if (/^[a-z]{1,3}_/.test(partes[0])) return "";
  else partes.unshift(corte);
  return `https://res.cloudinary.com/${m[1]}/image/upload/${partes.join("/")}`;
};

/** Converte o documento `turmaPreviews/<id>` (dado de usuário) na prévia; null se não servir. */
export const previaDoDocumento = (dados: unknown): PreviaTurma | null => {
  if (!dados || typeof dados !== "object") return null;
  const d = dados as Record<string, unknown>;
  const nome = limpar(d.nome, 80);
  if (!nome) return null;
  const dias = Array.isArray(d.diasSemana)
    ? d.diasSemana
        .slice(0, 7)
        .map((dia) => {
          const texto = limpar(dia, 20);
          return DIAS_CURTOS[texto.toLowerCase()] ?? texto;
        })
        .filter(Boolean)
        .join(", ")
    : "";
  return {
    nome,
    arenaNome: limpar(d.arenaNome, 80),
    dias,
    horario: limpar(d.horario, 20),
    imagem: imagemDaPrevia(d.bannerUrl),
  };
};

interface PaginaParams {
  id: string;
  lojaIos: string | null;
  lojaAndroid: string | null;
  plataforma: Plataforma;
  iconUrl?: string | null;
  paginaUrl?: string | null;
  previa?: PreviaTurma | null;
}

/** Convite de turma: o banner (ou o ícone), o nome, o local, os dias e o horário, e o botão que abre o convite no app. */
export const renderizarPagina = ({ id, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, previa }: PaginaParams): string => {
  const abrir = `tugyn://turma/${encodeURIComponent(id)}`;
  const titulo = previa ? `${previa.nome} · Tugyn` : "Convite para uma turma no Tugyn";
  const detalhes = previa ? [previa.arenaNome, previa.dias, previa.horario].filter(Boolean).join(" · ") : "";
  const descricao = detalhes ? `${detalhes}. Toque para entrar na turma pelo app Tugyn.` : "Toque para abrir o convite no app Tugyn.";

  // Banner em formato grande quando existe; senão, o ícone (prévia pequena).
  const imagemMeta = previa?.imagem
    ? `<meta property="og:image" content="${esc(previa.imagem)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">`
    : iconUrl
      ? `<meta property="og:image" content="${esc(iconUrl)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">`
      : "";

  const marca = previa?.imagem
    ? `<img class="banner" src="${esc(previa.imagem)}" alt="" width="1200" height="630">`
    : iconUrl
      ? `<img class="marca" src="${esc(iconUrl)}" alt="Tugyn" width="64" height="64">`
      : `<div class="marca marca-letra" aria-hidden="true">T</div>`;

  const topo = topoHtml({
    marca,
    eyebrow: "Convite para a turma",
    titulo: previa ? previa.nome : "Você foi convidado para uma turma",
    chips: previa ? [previa.arenaNome, previa.dias, previa.horario].filter(Boolean) : [],
  });

  return documentoPublico({
    titulo,
    descricao,
    imagemMeta,
    iconUrl,
    paginaUrl,
    conteudo: `  ${topo}
  <div class="faixa"><span class="faixa-icone" aria-hidden="true">✓</span>Abra no app para pedir para entrar. O organizador confirma a sua entrada.</div>
  <a class="btn" href="${esc(abrir)}">Abrir convite no Tugyn</a>
  ${blocoDasLojas(lojaIos, lojaAndroid, plataforma)}`,
  });
};
