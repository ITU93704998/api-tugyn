/**
 * Página pública de um time: https://<servidor>/api/time/<linkId>  (vercel.json reescreve para /api/turma/<linkId>?tipo=time,
 * sem criar uma função nova).
 *
 * O link usa o `linkId` do time (16 letras/números aleatórios, gerado pelo app e imutável nas regras), nunca o id do
 * documento (que leva o uid do dono). Mostra só o nome e a cor do time e o nome e a foto de quem ACEITOU a convocação:
 * nada de @usuário, uid, convocações pendentes ou recusas.
 */
import { esc, limpar, type Plataforma } from "./turmaLink";

export const isValidLinkId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9]{16}$/.test(value);

export interface JogadorPublico {
  nome: string;
  /** Foto pequena do Cloudinary, ou "" (a página mostra a inicial). */
  foto: string;
  dono: boolean;
  /** Número da camisa (null sem número) e posição já por extenso ("" sem posição). */
  numero: number | null;
  posicao: string;
}

export interface TimePublico {
  nome: string;
  cor: string;
  sigla: string;
  /** "Society · Masculino · Recife, PE" (só o que existir). */
  detalhes: string;
  /** Escudo do Cloudinary em 256 px, ou "". */
  escudo: string;
  jogadores: JogadorPublico[];
}

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
      const posicao = POSICOES[String(camisa?.posicao)] ?? "";
      return nomeJogador ? [{ nome: nomeJogador, foto: fotoPequena(jogador.foto), dono: uid === donoId, numero, posicao }] : [];
    })
    .sort((a, b) => Number(b.dono) - Number(a.dono) || (a.numero ?? 100) - (b.numero ?? 100) || a.nome.localeCompare(b.nome, "pt-BR"));
  return { nome, cor, sigla, detalhes, escudo: fotoPequena(d.escudoUrl, "c_pad,w_256,h_256,q_auto,f_png"), jogadores };
};

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

export const renderizarPaginaTime = ({ time, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl }: PaginaTimeParams): string => {
  const total = time?.jogadores.length ?? 0;
  const titulo = time ? `${time.nome}${time.sigla ? ` (${time.sigla})` : ""} · Tugyn` : "Time no Tugyn";
  const descricao = time
    ? `${time.detalhes ? `${time.detalhes}. ` : ""}${total} ${total === 1 ? "jogador" : "jogadores"}${total ? `: ${resumoDoElenco(time.jogadores)}` : ""}. Monte o seu time no app Tugyn.`
    : "Monte o seu time no app Tugyn.";

  const lojas: { rotulo: string; url: string }[] = [];
  if (plataforma !== "android" && lojaIos) lojas.push({ rotulo: "Baixar na App Store", url: lojaIos });
  if (plataforma !== "ios" && lojaAndroid) lojas.push({ rotulo: "Baixar no Google Play", url: lojaAndroid });
  const download = lojas.length
    ? `<p class="hint">Ainda não tem o app?</p>
       <div class="store-links">${lojas.map((l) => `<a class="link" href="${esc(l.url)}">${esc(l.rotulo)} <span class="link-arrow">›</span></a>`).join("")}</div>`
    : `<p class="hint">Ainda não tem o app? Procure por <strong>Tugyn</strong> na App Store ou no Google Play.</p>`;

  const inicial = (nome: string) => esc((Array.from(nome)[0] ?? "?").toUpperCase());
  const elenco = time && total
    ? `<ul class="elenco">${time.jogadores
        .map(
          (j) => `<li>
          <span class="avatar">${inicial(j.nome)}${j.foto ? `<img src="${esc(j.foto)}" alt="" width="40" height="40" loading="lazy">` : ""}</span>
          <span class="num">${j.numero === null ? "" : esc(String(j.numero))}</span>
          <span class="nome">${esc(j.nome)}${j.posicao ? `<small>${esc(j.posicao)}</small>` : ""}</span>${j.dono ? `<span class="tag">Dono</span>` : ""}
        </li>`,
        )
        .join("")}</ul>`
    : `<p>Este time ainda não tem jogadores.</p>`;

  const corpo = time
    ? `${time.escudo
        ? `<div class="escudo escudo-img" style="border-color:${esc(time.cor)}"><img src="${esc(time.escudo)}" alt="Escudo do ${esc(time.nome)}" width="72" height="72"></div>`
        : `<div class="escudo" style="background:${esc(time.cor)}">${esc(time.sigla) || inicial(time.nome)}</div>`}
  <p class="eyebrow">Time no Tugyn${time.sigla ? ` · ${esc(time.sigla)}` : ""}</p>
  <h1>${esc(time.nome)}</h1>
  ${time.detalhes ? `<p class="det">${esc(time.detalhes)}</p>` : ""}
  <p class="sub">${total} ${total === 1 ? "jogador" : "jogadores"}</p>
  ${elenco}`
    : `<div class="escudo" style="background:#FE7552">?</div>
  <h1>Time não encontrado</h1>
  <p>O link pode ter mudado ou o time foi apagado.</p>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descricao)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tugyn">
<meta property="og:locale" content="pt_BR">
${paginaUrl ? `<meta property="og:url" content="${esc(paginaUrl)}">` : ""}
${iconUrl ? `<meta property="og:image" content="${esc(iconUrl)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<link rel="icon" type="image/png" href="${esc(iconUrl)}">` : ""}
<style>
  :root { --bg:#F2F2F7; --surface:#FFFFFF; --label:#1C1C1E; --secondary:#6E6E73; --tertiary:#A1A1A6;
    --separator:rgba(60,60,67,0.12); --accent:#FE7552; --shadow:0 1px 2px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.06); }
  @media (prefers-color-scheme: dark) { :root { --bg:#000; --surface:#1C1C1E; --label:#F2F2F7; --secondary:#A1A1A6;
    --tertiary:#6E6E73; --separator:rgba(84,84,88,0.65); --shadow:none; } }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;
    background:var(--bg); color:var(--label); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif; }
  main { width:100%; max-width:400px; background:var(--surface); border-radius:20px; padding:28px 20px 22px; box-shadow:var(--shadow); text-align:center; }
  .escudo { width:72px; height:72px; margin:0 auto 14px; border-radius:22px; display:flex; align-items:center; justify-content:center;
    color:#fff; font-size:32px; font-weight:800; }
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--secondary); margin:0 0 6px; }
  h1 { font-size:24px; line-height:30px; margin:0 0 4px; overflow-wrap:anywhere; }
  p { color:var(--secondary); font-size:15px; line-height:21px; margin:0 0 18px; }
  .sub { font-weight:600; }
  .elenco { list-style:none; margin:0 0 20px; padding:0; text-align:left; border-top:1px solid var(--separator); }
  .elenco li { display:flex; align-items:center; gap:12px; padding:10px 2px; border-bottom:1px solid var(--separator); }
  .avatar { position:relative; flex:none; width:40px; height:40px; border-radius:50%; overflow:hidden; display:flex; align-items:center;
    justify-content:center; background:rgba(254,117,82,0.14); color:var(--accent); font-weight:800; }
  .avatar img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .nome { flex:1; min-width:0; font-size:15px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .nome small { display:block; font-size:12px; font-weight:500; color:var(--secondary); }
  .num { flex:none; width:24px; text-align:center; font-size:15px; font-weight:800; color:var(--accent); }
  .escudo-img { background:#fff; border:3px solid; overflow:hidden; padding:4px; }
  .escudo-img img { width:100%; height:100%; object-fit:contain; }
  .det { margin:0 0 4px; font-size:13px; }
  .tag { flex:none; font-size:11px; font-weight:700; color:var(--accent); background:rgba(254,117,82,0.12); padding:3px 8px; border-radius:8px; }
  .btn { display:flex; align-items:center; justify-content:center; min-height:50px; border-radius:14px; background:var(--accent);
    color:#fff; text-decoration:none; font-size:17px; font-weight:600; }
  .hint { font-size:13px; color:var(--tertiary); margin:18px 0 8px; }
  .store-links { display:flex; flex-direction:column; gap:4px; }
  .link { padding:10px 8px; color:var(--accent); text-decoration:none; font-size:15px; font-weight:500; }
  .link-arrow { opacity:.6; }
  .footer { margin:16px 0 0; font-size:12px; color:var(--tertiary); }
</style>
</head>
<body>
<main>
  ${corpo}
  <a class="btn" href="tugyn://">Abrir no Tugyn</a>
  ${download}
  <p class="footer">Compartilhado pelo app Tugyn</p>
</main>
</body>
</html>`;
};
