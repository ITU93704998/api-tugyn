/**
 * Página pública de um time: https://<servidor>/api/time/<linkId>  (vercel.json reescreve para /api/turma/<linkId>?tipo=time,
 * sem criar uma função nova).
 *
 * O link usa o `linkId` do time (16 letras/números aleatórios, gerado pelo app e imutável nas regras), nunca o id do
 * documento (que leva o uid do dono). Mostra só o nome e a cor do time e o nome e a foto de quem ACEITOU a convocação:
 * nada de @usuário, uid, convocações pendentes ou recusas.
 *
 * Link de convocação: https://<servidor>/api/time/c/<codigo>  (reescrito para /api/turma/<codigo>?tipo=convite). Lê a
 * prévia `convitesTime/<codigo>` (nome, cor, sigla, escudo e detalhes) e mostra até que horas o link vale (1 hora). O
 * botão abre o app em `tugyn://time-convite/<codigo>`, onde a pessoa pede para entrar (o dono aprova).
 */
import { blocoDasLojas, documentoPublico, esc, escudoHtml, topoHtml, type Plataforma } from "./paginaPublica";
import { limpar } from "./turmaLink";

export const isValidLinkId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9]{16}$/.test(value);

export interface JogadorPublico {
  nome: string;
  /** Foto pequena do Cloudinary, ou "" (a página mostra a inicial). */
  foto: string;
  dono: boolean;
  /** Número da camisa (null sem número) e posição já por extenso ("" sem posição). */
  numero: number | null;
  posicao: string;
  capitao: boolean;
}

export interface TimePublico {
  nome: string;
  cor: string;
  /** Segunda cor (a sigla do escudo desenhado), ou "". */
  corSecundaria: string;
  sigla: string;
  /** "Society · Masculino · Recife, PE" (só o que existir). */
  detalhes: string;
  /** Escudo do Cloudinary em 256 px, ou "". */
  escudo: string;
  /** Escudo em 600x600 JPG com fundo branco: a imagem da prévia do link (WhatsApp), ou "". */
  imagem: string;
  jogadores: JogadorPublico[];
}

export const CORTE_ESCUDO = "c_pad,w_256,h_256,q_auto,f_png";
/** WhatsApp e afins: JPG (sem transparência, que vira fundo preto em alguns apps), quadrado e com mais de 300 px. */
export const CORTE_PREVIA_LINK = "c_pad,b_white,w_600,h_600,q_auto,f_jpg";

const MODALIDADES: Record<string, string> = { campo: "Futebol de campo", society: "Society", futsal: "Futsal" };
const GENEROS: Record<string, string> = { masculino: "Masculino", feminino: "Feminino", misto: "Misto" };
const POSICOES: Record<string, string> = {
  goleiro: "Goleiro", fixo: "Fixo", ala: "Ala", pivo: "Pivô", zagueiro: "Zagueiro",
  lateral: "Lateral", volante: "Volante", meia: "Meia", atacante: "Atacante",
};

const MAX_JOGADORES = 30;

/** Só fotos do próprio Cloudinary, recortadas em 96x96; qualquer outra coisa vira "". */
export const fotoPequena = (url: unknown, corte = "c_fill,g_face,w_96,h_96,q_auto,f_jpg"): string => {
  const bruto = limpar(url, 500);
  const m = /^https:\/\/res\.cloudinary\.com\/([a-z0-9_-]+)\/image\/upload\/([A-Za-z0-9_\-./,]+)$/i.exec(bruto);
  if (!m) return "";
  const partes = m[2].split("/");
  const versao = partes.findIndex((p) => /^v\d+$/.test(p));
  if (versao >= 0) partes.splice(versao, 0, corte);
  else if (/^[a-z]{1,3}_/.test(partes[0])) return "";
  else partes.unshift(corte);
  return `https://res.cloudinary.com/${m[1]}/image/upload/${partes.join("/")}`;
};

/** Documento `times/<id>` (dado de usuário) → o que a página pode mostrar; null se não servir. */
export const timeDoDocumento = (dados: unknown): TimePublico | null => {
  if (!dados || typeof dados !== "object") return null;
  const d = dados as Record<string, unknown>;
  const nome = limpar(d.nome, 40);
  if (!nome) return null;
  const cor = typeof d.cor === "string" && /^#[0-9A-Fa-f]{6}$/.test(d.cor) ? d.cor : "#FE7552";
  const donoId = typeof d.donoId === "string" ? d.donoId : "";
  const mapa = d.jogadores && typeof d.jogadores === "object" ? (d.jogadores as Record<string, unknown>) : {};
  const camisas = d.camisas && typeof d.camisas === "object" ? (d.camisas as Record<string, Record<string, unknown> | null>) : {};
  const cidade = d.cidade && typeof d.cidade === "object" ? (d.cidade as Record<string, unknown>) : {};
  const lugar = [limpar(cidade.city, 60), limpar(cidade.state, 20)].filter(Boolean).join(", ");
  const categoria = [GENEROS[String(d.genero)], d.faixaEtaria === "veterano" ? "Veterano" : ""].filter(Boolean).join(" ");
  const detalhes = [MODALIDADES[String(d.modalidade)] ?? "", categoria, lugar].filter(Boolean).join(" · ");
  const sigla = typeof d.sigla === "string" && /^[A-Z0-9]{3}$/.test(d.sigla) ? d.sigla : "";
  const jogadores = Object.entries(mapa)
    .slice(0, MAX_JOGADORES)
    .flatMap(([uid, j]): JogadorPublico[] => {
      if (!j || typeof j !== "object") return [];
      const jogador = j as Record<string, unknown>;
      const nomeJogador = limpar(jogador.nome, 60);
      const camisa = camisas[uid] && typeof camisas[uid] === "object" ? camisas[uid] : {};
      const numero = Number.isInteger(camisa?.numero) && (camisa?.numero as number) >= 0 && (camisa?.numero as number) <= 99 ? (camisa?.numero as number) : null;
      // "Treinador" só vale para o dono (as regras já garantem; aqui é defesa extra).
      const posicao = camisa?.posicao === "treinador" ? (uid === donoId ? "Treinador" : "") : POSICOES[String(camisa?.posicao)] ?? "";
      return nomeJogador ? [{ nome: nomeJogador, foto: fotoPequena(jogador.foto), dono: uid === donoId, numero, posicao, capitao: camisa?.capitao === true }] : [];
    })
    .sort((a, b) => Number(b.dono) - Number(a.dono) || (a.numero ?? 100) - (b.numero ?? 100) || a.nome.localeCompare(b.nome, "pt-BR"));
  const corSecundaria = typeof d.corSecundaria === "string" && /^#[0-9A-Fa-f]{6}$/.test(d.corSecundaria) && d.corSecundaria.toLowerCase() !== cor.toLowerCase() ? d.corSecundaria : "";
  return { nome, cor, corSecundaria, sigla, detalhes, escudo: fotoPequena(d.escudoUrl, CORTE_ESCUDO), imagem: fotoPequena(d.escudoUrl, CORTE_PREVIA_LINK), jogadores };
};

export const VALIDADE_CONVITE_MS = 60 * 60 * 1000;

export interface ConvitePublico {
  nome: string;
  cor: string;
  sigla: string;
  detalhes: string;
  escudo: string;
  imagem: string;
  /** Até quando o link vale (ms); 0 se o documento não diz. */
  expiraEmMs: number;
}

const ms = (v: unknown): number => {
  if (v && typeof v === "object" && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  return v instanceof Date ? v.getTime() : 0;
};

/** Documento `convitesTime/<codigo>` → o que a página do convite mostra; null se não servir. */
export const conviteDoDocumento = (dados: unknown): ConvitePublico | null => {
  if (!dados || typeof dados !== "object") return null;
  const d = dados as Record<string, unknown>;
  const nome = limpar(d.nome, 40);
  if (!nome) return null;
  const criadoEm = ms(d.criadoEm);
  return {
    nome,
    cor: typeof d.cor === "string" && /^#[0-9A-Fa-f]{6}$/.test(d.cor) ? d.cor : "#FE7552",
    sigla: typeof d.sigla === "string" && /^[A-Z0-9]{3}$/.test(d.sigla) ? d.sigla : "",
    detalhes: limpar(d.detalhes, 200),
    escudo: fotoPequena(d.escudoUrl, CORTE_ESCUDO),
    imagem: fotoPequena(d.escudoUrl, CORTE_PREVIA_LINK),
    expiraEmMs: criadoEm ? criadoEm + VALIDADE_CONVITE_MS : 0,
  };
};

const horaDeBrasilia = (msHora: number): string =>
  new Date(msHora).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

/** "Ana, Bruno, Carla e mais 4" (para a descrição da prévia do link). */
const resumoDoElenco = (jogadores: JogadorPublico[]): string => {
  const nomes = jogadores.map((j) => j.nome.split(" ")[0]);
  if (nomes.length <= 3) return nomes.join(", ");
  return `${nomes.slice(0, 3).join(", ")} e mais ${nomes.length - 3}`;
};

interface PaginaTimeParams {
  time: TimePublico | null;
  lojaIos: string | null;
  lojaAndroid: string | null;
  plataforma: Plataforma;
  iconUrl?: string | null;
  paginaUrl?: string | null;
}

/** Imagem da prévia do link: o escudo (600x600) quando existe; senão, o ícone do app. */
const metaDaImagem = (imagem: string, iconUrl: string | null | undefined): string =>
  imagem
    ? `<meta property="og:image" content="${esc(imagem)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="600">
<meta property="og:image:height" content="600">`
    : iconUrl
      ? `<meta property="og:image" content="${esc(iconUrl)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">`
      : "";

/** "Society", "Masculino Veterano", "Recife, PE": as pílulas do topo. */
const chipsDosDetalhes = (detalhes: string): string[] => detalhes.split(" · ").map((x) => x.trim()).filter(Boolean);

/** Topo de "não encontrado" (sem dado nenhum do time). */
const topoVazio = (titulo: string): string =>
  topoHtml({ marca: escudoHtml({ escudo: "", cor: "#FE7552", nome: "Tugyn", sigla: "?" }), eyebrow: "Tugyn", titulo });

interface PaginaConviteParams {
  convite: ConvitePublico | null;
  codigo: string;
  agoraMs: number;
  lojaIos: string | null;
  lojaAndroid: string | null;
  plataforma: Plataforma;
  iconUrl?: string | null;
  paginaUrl?: string | null;
}

/** Página do link de convocação (vale 1 hora): o time e o botão que abre o app para pedir para entrar. */
export const renderizarPaginaConvite = ({ convite, codigo, agoraMs, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl }: PaginaConviteParams): string => {
  const valido = Boolean(convite && convite.expiraEmMs > agoraMs);
  const titulo = convite ? `Convocação: ${convite.nome}${convite.sigla ? ` (${convite.sigla})` : ""}` : "Convocação para um time no Tugyn";
  const descricao = convite && valido
    ? `${convite.detalhes ? `${convite.detalhes}. ` : ""}Toque para pedir para entrar no time pelo app Tugyn. O link vale até ${horaDeBrasilia(convite.expiraEmMs)}.`
    : "Este link de convocação expirou. Peça um novo ao dono do time.";
  const corpo = convite
    ? `  ${topoHtml({ cor: convite.cor, marca: escudoHtml(convite), eyebrow: `Convocação${convite.sigla ? ` · ${convite.sigla}` : ""}`, titulo: convite.nome, chips: chipsDosDetalhes(convite.detalhes) })}
  ${valido
    ? `<div class="faixa"><span class="faixa-icone" aria-hidden="true">⏱</span>Link válido até ${esc(horaDeBrasilia(convite.expiraEmMs))}. Peça para entrar pelo app; o dono do time confirma a sua entrada.</div>
  <a class="btn" href="tugyn://time-convite/${esc(encodeURIComponent(codigo))}">Pedir para entrar no time</a>`
    : `<div class="faixa faixa-aviso"><span class="faixa-icone" aria-hidden="true">!</span>Este link expirou (vale 1 hora). Peça um novo ao dono do time.</div>
  <a class="btn" href="tugyn://">Abrir no Tugyn</a>`}`
    : `  ${topoVazio("Link não encontrado")}
  <div class="faixa faixa-aviso"><span class="faixa-icone" aria-hidden="true">!</span>O link pode ter expirado ou sido trocado pelo dono do time.</div>
  <a class="btn" href="tugyn://">Abrir no Tugyn</a>`;
  return documentoPublico({
    titulo,
    descricao,
    imagemMeta: metaDaImagem(convite?.imagem ?? "", iconUrl),
    iconUrl,
    paginaUrl,
    conteudo: `${corpo}
  ${blocoDasLojas(lojaIos, lojaAndroid, plataforma)}`,
  });
};

/** As linhas do elenco, na ordem do app (posição por extenso, como chega em `JogadorPublico.posicao`). */
const LINHAS: { titulo: string; posicoes: string[] }[] = [
  { titulo: "Treinador", posicoes: ["Treinador"] },
  { titulo: "Goleiros", posicoes: ["Goleiro"] },
  { titulo: "Defesa", posicoes: ["Zagueiro", "Lateral", "Fixo"] },
  { titulo: "Meio-campo", posicoes: ["Volante", "Meia", "Ala"] },
  { titulo: "Ataque", posicoes: ["Atacante", "Pivô"] },
];

/** Separa por linha quando alguém tem posição; sem posições, uma grade só (como no app). */
const gruposDoElenco = (jogadores: JogadorPublico[]): { titulo: string; itens: JogadorPublico[] }[] => {
  if (!jogadores.some((j) => j.posicao)) return [{ titulo: "", itens: jogadores }];
  const grupos = LINHAS.map((l) => ({ titulo: l.titulo, itens: jogadores.filter((j) => l.posicoes.includes(j.posicao)) }));
  grupos.push({ titulo: "Sem posição", itens: jogadores.filter((j) => !LINHAS.some((l) => l.posicoes.includes(j.posicao))) });
  return grupos.filter((g) => g.itens.length > 0);
};

const cartaoDoJogador = (j: JogadorPublico): string => {
  const inicial = esc((Array.from(j.nome)[0] ?? "?").toUpperCase());
  return `<li class="jogador">
      <span class="foto">${inicial}${j.foto ? `<img src="${esc(j.foto)}" alt="" width="64" height="64" loading="lazy">` : ""}${j.capitao ? `<span class="capitao" title="Capitão">C</span>` : ""}${j.numero === null ? "" : `<span class="numero">${esc(String(j.numero).padStart(2, "0"))}</span>`}</span>
      <span class="nome">${esc(j.nome)}</span>
      <span class="posicao">${esc(j.posicao || "Sem posição")}${j.capitao ? " · Capitão" : ""}</span>
      ${j.dono ? `<span class="dono">Dono</span>` : ""}
    </li>`;
};

export const renderizarPaginaTime = ({ time, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl }: PaginaTimeParams): string => {
  const total = time?.jogadores.length ?? 0;
  const titulo = time ? `${time.nome}${time.sigla ? ` (${time.sigla})` : ""} · Tugyn` : "Time no Tugyn";
  const descricao = time
    ? `${time.detalhes ? `${time.detalhes}. ` : ""}${total} ${total === 1 ? "jogador" : "jogadores"}${total ? `: ${resumoDoElenco(time.jogadores)}` : ""}. Monte o seu time no app Tugyn.`
    : "Monte o seu time no app Tugyn.";

  const elenco = time && total
    ? gruposDoElenco(time.jogadores)
        .map((g) => `<div class="grupo">${g.titulo ? `<p class="grupo-titulo">${esc(g.titulo)} · ${g.itens.length}</p>` : ""}<ul class="grade" role="list">${g.itens.map(cartaoDoJogador).join("")}</ul></div>`)
        .join("")
    : `<p class="vazio">Este time ainda não tem jogadores.</p>`;

  const corpo = time
    ? `  ${topoHtml({ cor: time.cor, marca: escudoHtml(time), eyebrow: `Time no Tugyn${time.sigla ? ` · ${time.sigla}` : ""}`, titulo: time.nome, chips: chipsDosDetalhes(time.detalhes) })}
  <section class="cartao">
    <p class="secao">Elenco <span class="contagem">${total}</span><span class="sr">${total} ${total === 1 ? "jogador" : "jogadores"}</span></p>
    ${elenco}
  </section>`
    : `  ${topoVazio("Time não encontrado")}
  <div class="faixa faixa-aviso"><span class="faixa-icone" aria-hidden="true">!</span>O link pode ter mudado ou o time foi apagado.</div>`;

  return documentoPublico({
    titulo,
    descricao,
    imagemMeta: metaDaImagem(time?.imagem ?? "", iconUrl),
    iconUrl,
    paginaUrl,
    conteudo: `${corpo}
  <a class="btn" href="tugyn://">Abrir no Tugyn</a>
  ${blocoDasLojas(lojaIos, lojaAndroid, plataforma)}`,
  });
};
