/**
 * Página pública de um campeonato entre times: https://link.tugyntec.com.br/campeonato/<código> (ou o antigo /api/campeonato/<id>)
 * (vercel.json reescreve para /api/turma/<id>?tipo=campeonato, sem criar uma função nova; mesma lógica de turma e time).
 *
 * Mostra só o que o catálogo do app já mostra a qualquer pessoa: nome, situação, formato, modalidade, cidade, datas,
 * vagas, valor da inscrição e o banner. Nada de organizador, elencos, ids de usuário ou pagamentos.
 * Campeonatos de teste (`testeTugyn`) e os que estão sendo excluídos aparecem como "não encontrado".
 * O botão abre o app em `tugyn://campeonato/<id>`; com o app instalado, o próprio link https já abre o app.
 */
import { blocoDasLojas, documentoPublico, esc, topoHtml, type Plataforma } from "./paginaPublica";
import { normalizarDesenhoTrofeu } from "./desenhoTrofeu";
import { tacaSvg } from "./tacaSvg";
import { fotoPequena } from "./timeLink";
import { limpar } from "./turmaLink";

export const isValidCampeonatoId = (v: unknown): v is string => typeof v === "string" && /^ct_[a-f0-9]{24}$/.test(v);

export interface CampeonatoPublico {
  nome: string; status: "inscricoes" | "em_andamento" | "encerrado" | "cancelado"; formato: string; modalidade: string;
  cidade: string; estado: string; inscricoesAte: number | null; dataInicio: number | null; inscricaoCentavos: number;
  maxTimes: number; aprovados: number; banner: string;
  /** Taça escolhida pelo organizador (texto das peças); null = taça clássica. */
  trofeu: string | null;
}

const FORMATOS: Record<string, string> = { triangular: "Triangular", quadrangular: "Quadrangular", mata: "Mata-mata", grupos_mata: "Grupos + mata-mata" };
const MODALIDADES: Record<string, string> = { campo: "Campo", society: "Society", futsal: "Futsal" };
const STATUS = ["inscricoes", "em_andamento", "encerrado", "cancelado"] as const;
/** Banner horizontal da prévia do link (proporção usada pelas redes: 1200x630). */
export const CORTE_BANNER_LINK = "c_fill,g_auto,w_1200,h_630,q_auto,f_jpg";

const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/** Documento `campeonatosTimes/<id>` → o que a página pode mostrar; null se não servir. */
export const campeonatoDoDocumento = (dados: unknown): CampeonatoPublico | null => {
  if (!dados || typeof dados !== "object") return null;
  const d = dados as Record<string, unknown>;
  if (d.testeTugyn === true || d.excluindo === true) return null;
  const nome = limpar(d.nome, 60);
  const status = STATUS.find((s) => s === d.status);
  if (!nome || !status) return null;
  return {
    nome, status,
    formato: FORMATOS[String(d.formato)] ?? "",
    modalidade: MODALIDADES[String(d.modalidade)] ?? "",
    cidade: limpar(d.cidade, 80), estado: limpar(d.estado, 2).toUpperCase(),
    inscricoesAte: num(d.inscricoesAte, 0, 9e15), dataInicio: num(d.dataInicio, 0, 9e15),
    inscricaoCentavos: num(d.inscricaoCentavos, 0, 1e9) ?? 0,
    maxTimes: num(d.maxTimes, 2, 64) ?? 0, aprovados: num(d.aprovados, 0, 64) ?? 0,
    banner: fotoPequena(d.bannerUrl, CORTE_BANNER_LINK),
    trofeu: normalizarDesenhoTrofeu(d.trofeuDesenho),
  };
};

const dataBrasilia = (ms: number): string =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(ms);
const reais = (centavos: number): string =>
  centavos > 0 ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(centavos / 100) : "Grátis";

/** Situação para a faixa: inscrições abertas (com prazo), encerradas, em andamento, encerrado ou cancelado. */
export const situacaoDoCampeonato = (c: CampeonatoPublico, agoraMs: number): { texto: string; aviso: boolean } => {
  if (c.status === "cancelado") return { texto: "Campeonato cancelado pelo organizador.", aviso: true };
  if (c.status === "encerrado") return { texto: "Campeonato encerrado. Veja o campeão e a tabela no app.", aviso: false };
  if (c.status === "em_andamento") return { texto: "Campeonato em andamento. Acompanhe os jogos e a tabela no app.", aviso: false };
  if (c.inscricoesAte !== null && c.inscricoesAte <= agoraMs) return { texto: "Inscrições encerradas. O campeonato começa em breve.", aviso: false };
  const vagas = Math.max(0, c.maxTimes - c.aprovados);
  return { texto: `Inscrições abertas${c.inscricoesAte !== null ? ` até ${dataBrasilia(c.inscricoesAte)}` : ""}. ${vagas} ${vagas === 1 ? "vaga" : "vagas"} de ${c.maxTimes}.`, aviso: false };
};

interface PaginaCampeonatoParams {
  campeonato: CampeonatoPublico | null; id: string; agoraMs: number;
  lojaIos: string | null; lojaAndroid: string | null; plataforma: Plataforma; iconUrl?: string | null; paginaUrl?: string | null;
  cartaoUrl?: string | null;
}

const linhaInfo = (rotulo: string, valor: string): string =>
  `<li style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--borda)"><span style="color:var(--texto2)">${esc(rotulo)}</span><strong style="text-align:right">${esc(valor)}</strong></li>`;

export const renderizarPaginaCampeonato = ({ campeonato: c, id, agoraMs, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, cartaoUrl }: PaginaCampeonatoParams): string => {
  const abrir = c && isValidCampeonatoId(id) ? `tugyn://campeonato/${encodeURIComponent(id)}` : "tugyn://";
  const local = c ? [c.cidade, c.estado].filter(Boolean).join(", ") : "";
  const situacao = c ? situacaoDoCampeonato(c, agoraMs) : null;
  const titulo = c ? `${c.nome} · Campeonato no Tugyn` : "Campeonato no Tugyn";
  const descricao = c
    ? `${[c.formato, c.modalidade, local].filter(Boolean).join(" · ")}. ${situacao!.texto} Inscreva seu time pelo app Tugyn.`
    : "Campeonatos entre times no app Tugyn.";
  const imagemMeta = c?.banner
    ? `<meta property="og:image" content="${esc(c.banner)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`
    : iconUrl ? `<meta property="og:image" content="${esc(iconUrl)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">` : "";
  // A taça do campeonato no lugar do escudo, no mesmo quadro de 88px (a taça é 4:5: 70x88).
  const marca = `<div class="escudo" role="img" aria-label="Troféu do campeonato">${tacaSvg(c?.trofeu ?? null, 70, 88)}</div>`;

  const corpo = c
    ? `  ${c.banner ? `<img src="${esc(c.banner)}" alt="" width="1200" height="630" style="display:block;width:100%;height:auto;border-radius:20px">` : ""}
  ${topoHtml({ marca, titulo: c.nome, chips: [c.formato, c.modalidade, local].filter(Boolean) })}
  <div class="faixa${situacao!.aviso ? " faixa-aviso" : ""}"><span class="faixa-icone" aria-hidden="true">${situacao!.aviso ? "!" : "★"}</span>${esc(situacao!.texto)}</div>
  <section class="cartao">
    <p class="secao">Informações</p>
    <ul role="list" style="list-style:none;margin:0;padding:0;font-size:14px">
      ${linhaInfo("Times", `${c.aprovados} de ${c.maxTimes} confirmados`)}
      ${c.status === "inscricoes" && c.inscricoesAte !== null ? linhaInfo("Inscrições até", dataBrasilia(c.inscricoesAte)) : ""}
      ${c.dataInicio !== null ? linhaInfo("Início", dataBrasilia(c.dataInicio)) : ""}
      ${linhaInfo("Inscrição", reais(c.inscricaoCentavos))}
    </ul>
  </section>`
    : `  ${topoHtml({ marca, eyebrow: "Tugyn", titulo: "Campeonato não encontrado" })}
  <div class="faixa faixa-aviso"><span class="faixa-icone" aria-hidden="true">!</span>O link pode estar errado ou o campeonato foi excluído.</div>`;

  return documentoPublico({
    titulo, descricao, imagemMeta, iconUrl, paginaUrl, cartaoUrl,
    conteudo: `${corpo}
  <a class="btn" href="${esc(abrir)}">${c ? "Abrir o campeonato no Tugyn" : "Abrir no Tugyn"}</a>
  ${blocoDasLojas(lojaIos, lojaAndroid, plataforma)}`,
  });
};

/** Dados do cartão da prévia (imagem 1200x630): só o que a página já mostra. */
export const cartaoDoCampeonato = (c: CampeonatoPublico, agoraMs: number): { rotulo: string; titulo: string; detalhes: string; destaque: string; taca: string | null } => {
  const local = [c.cidade, c.estado].filter(Boolean).join(", ");
  const vagas = Math.max(0, c.maxTimes - c.aprovados);
  const destaque =
    c.status === "cancelado" ? "Campeonato cancelado"
    : c.status === "encerrado" ? "Encerrado · veja o campeão e a tabela"
    : c.status === "em_andamento" ? "Em andamento · acompanhe os jogos e a tabela"
    : c.inscricoesAte !== null && c.inscricoesAte <= agoraMs ? "Inscrições encerradas · começa em breve"
    : [c.inscricoesAte !== null ? `Inscrições até ${dataBrasilia(c.inscricoesAte).slice(0, 5)}` : "Inscrições abertas",
        `${vagas} ${vagas === 1 ? "vaga" : "vagas"}`, reais(c.inscricaoCentavos)].join(" · ");
  return { taca: c.trofeu, rotulo: "", titulo: c.nome, detalhes: [c.formato, c.modalidade, local].filter(Boolean).join(" · "), destaque };
};
