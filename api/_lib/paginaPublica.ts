/**
 * Molde das páginas públicas abertas pelos links compartilhados (turma, time e convocação de time): o mesmo visual do app
 * (fundo creme, cartões brancos, topo escuro com a cor do time e o laranja #FE7552). Só HTML e CSS, sem scripts.
 */
export type Plataforma = "ios" | "android" | "outra";

export const esc = (texto: string): string =>
  texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const HEX = /^#[0-9A-Fa-f]{6}$/;
export const COR_APP = "#FE7552";
const ESCURO = "#17212F";

/** Cor de texto legível sobre `cor` (a mesma regra do app: luminância). */
export const textoNaCor = (cor: string): string => {
  if (!HEX.test(cor)) return "#FFFFFF";
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(cor.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? ESCURO : "#FFFFFF";
};

/** "rgba(...)" de uma cor #RRGGBB (as cores já chegam validadas; inválida vira a do app). */
const comAlfa = (cor: string, alfa: number): string => {
  const c = HEX.test(cor) ? cor : COR_APP;
  return `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${alfa})`;
};

/**
 * Escudo do time: a imagem, se houver; senão o escudo desenhado na cor do time com a sigla no meio (na segunda cor, se
 * houver), como no app.
 */
export const escudoHtml = (t: { escudo: string; cor: string; corSecundaria?: string; nome: string; sigla: string }): string => {
  if (t.escudo) return `<div class="escudo"><img src="${esc(t.escudo)}" alt="Escudo do ${esc(t.nome)}" width="88" height="88"></div>`;
  const cor = HEX.test(t.cor) ? t.cor : COR_APP;
  const letra = t.corSecundaria && HEX.test(t.corSecundaria) && t.corSecundaria.toLowerCase() !== cor.toLowerCase() ? t.corSecundaria : textoNaCor(cor);
  const sigla = t.sigla || (Array.from(t.nome)[0] ?? "?").toUpperCase();
  return `<div class="escudo" role="img" aria-label="Escudo do ${esc(t.nome)}">
    <svg viewBox="0 0 24 24" width="88" height="88" aria-hidden="true"><path d="M12 1.5 3.5 5.2v5.6c0 5.2 3.6 10 8.5 11.2 4.9-1.2 8.5-6 8.5-11.2V5.2L12 1.5Z" fill="${esc(cor)}" stroke="rgba(255,255,255,.55)" stroke-width=".7"/></svg>
    <span style="color:${esc(letra)}">${esc(sigla)}</span>
  </div>`;
};

/** Bloco "Ainda não tem o app?" com as lojas do aparelho. */
export const blocoDasLojas = (lojaIos: string | null, lojaAndroid: string | null, plataforma: Plataforma): string => {
  const lojas: { rotulo: string; url: string }[] = [];
  if (plataforma !== "android" && lojaIos) lojas.push({ rotulo: "Baixar na App Store", url: lojaIos });
  if (plataforma !== "ios" && lojaAndroid) lojas.push({ rotulo: "Baixar no Google Play", url: lojaAndroid });
  return `<section class="cartao lojas">
    <p class="lojas-titulo">Ainda não tem o app?</p>
    ${lojas.length
      ? lojas.map((l) => `<a class="loja" href="${esc(l.url)}">${esc(l.rotulo)}<span aria-hidden="true">›</span></a>`).join("")
      : `<p class="lojas-texto">Procure por <strong>Tugyn</strong> na App Store ou no Google Play.</p>`}
  </section>`;
};

export interface Topo {
  /** Cor que tinge o topo escuro (a do time; turma usa a do app). */
  cor?: string;
  /** Escudo, ícone ou banner, já em HTML. */
  marca: string;
  eyebrow: string;
  titulo: string;
  /** Informações em pílulas abaixo do título (já sem vazios). */
  chips?: string[];
}

export const topoHtml = ({ cor = COR_APP, marca, eyebrow, titulo, chips = [] }: Topo): string => `<header class="topo" style="--tinta:${comAlfa(cor, 0.42)}">
  <div class="orbita" aria-hidden="true"></div>
  ${marca}
  <p class="eyebrow">${esc(eyebrow)}</p>
  <h1>${esc(titulo)}</h1>
  ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
</header>`;

export const documentoPublico = (p: {
  titulo: string;
  descricao: string;
  imagemMeta: string;
  iconUrl?: string | null;
  paginaUrl?: string | null;
  conteudo: string;
}): string => {
  const { titulo, descricao, imagemMeta, iconUrl, paginaUrl, conteudo } = p;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F7F5F2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E141D" media="(prefers-color-scheme: dark)">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descricao)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tugyn">
<meta property="og:locale" content="pt_BR">
${paginaUrl ? `<meta property="og:url" content="${esc(paginaUrl)}">` : ""}
${imagemMeta}
${iconUrl ? `<link rel="apple-touch-icon" href="${esc(iconUrl)}">
<link rel="icon" type="image/png" href="${esc(iconUrl)}">` : ""}
<style>
  :root { --bg:#F7F5F2; --cartao:#FFFFFF; --borda:#E4DED8; --texto:#1A1612; --texto2:#6B6560; --texto3:#8A847C;
    --primaria:#FE7552; --primaria-forte:#B5472D; --lavagem:rgba(254,117,82,.12); --escuro:#17212F; --sombra:0 1px 2px rgba(26,22,18,.04),0 10px 28px rgba(26,22,18,.07); }
  @media (prefers-color-scheme: dark) { :root { --bg:#0E141D; --cartao:#17212F; --borda:rgba(255,255,255,.09); --texto:#F4F1EC;
    --texto2:#B5AEA6; --texto3:#8E877F; --primaria-forte:#FF9065; --lavagem:rgba(254,117,82,.16); --sombra:none; } }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; min-height:100dvh; display:flex; justify-content:center; background:var(--bg); color:var(--texto);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif; -webkit-font-smoothing:antialiased;
    padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left)); }
  main { width:100%; max-width:440px; display:flex; flex-direction:column; gap:12px; }
  .topo { position:relative; overflow:hidden; border-radius:24px; padding:30px 20px 22px; text-align:center; color:#fff;
    background:radial-gradient(120% 90% at 85% 0%, var(--tinta), transparent 60%), var(--escuro); box-shadow:var(--sombra); }
  .orbita, .orbita::after { position:absolute; border-radius:50%; border:1px solid rgba(255,255,255,.08); pointer-events:none; }
  .orbita { width:260px; height:260px; left:50%; top:-70px; transform:translateX(-50%); }
  .orbita::after { content:""; inset:40px; }
  .escudo { position:relative; width:88px; height:88px; margin:0 auto 14px; display:flex; align-items:center; justify-content:center; }
  .escudo img { width:88px; height:88px; object-fit:contain; filter:drop-shadow(0 6px 14px rgba(0,0,0,.35)); }
  .escudo svg { position:absolute; inset:0; filter:drop-shadow(0 6px 14px rgba(0,0,0,.35)); }
  .escudo span { position:relative; margin-top:-4px; font-size:22px; font-weight:900; letter-spacing:.5px; }
  .marca { width:64px; height:64px; margin:0 auto 14px; border-radius:18px; display:block; object-fit:cover; }
  .marca-letra { display:flex; align-items:center; justify-content:center; background:var(--primaria); color:var(--escuro); font-size:28px; font-weight:900; }
  .banner { display:block; width:calc(100% + 40px); margin:-30px -20px 18px; aspect-ratio:1200/630; object-fit:cover; }
  .eyebrow { margin:0 0 6px; font-size:11px; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; color:rgba(255,255,255,.62); }
  h1 { position:relative; margin:0; font-size:26px; line-height:31px; font-weight:900; letter-spacing:-.4px; overflow-wrap:anywhere; }
  .chips { position:relative; display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin-top:14px; }
  .chip { padding:5px 11px; border-radius:999px; background:rgba(255,255,255,.09); border:1px solid rgba(255,255,255,.14);
    font-size:12px; font-weight:700; color:rgba(255,255,255,.88); }
  .faixa { display:flex; align-items:center; gap:10px; padding:12px 14px; border-radius:16px; background:var(--lavagem); color:var(--primaria-forte);
    font-size:14px; font-weight:700; line-height:19px; }
  .faixa-icone { flex:none; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:var(--primaria); color:var(--escuro); font-size:14px; font-weight:900; }
  .faixa-aviso { background:rgba(211,38,38,.1); color:#D32626; }
  .faixa-aviso .faixa-icone { background:#D32626; color:#fff; }
  .btn { display:flex; align-items:center; justify-content:center; min-height:54px; border-radius:16px; background:var(--primaria); color:var(--escuro);
    text-decoration:none; font-size:17px; font-weight:800; letter-spacing:-.2px; box-shadow:0 8px 20px rgba(254,117,82,.28); -webkit-tap-highlight-color:transparent; }
  .btn:active { transform:scale(.99); filter:brightness(.96); }
  .cartao { background:var(--cartao); border:1px solid var(--borda); border-radius:20px; padding:16px; box-shadow:var(--sombra); }
  .secao { display:flex; align-items:center; gap:8px; margin:0 0 12px; font-size:12px; font-weight:800; letter-spacing:1px; text-transform:uppercase; color:var(--texto2); }
  .contagem { min-width:22px; padding:1px 7px; border-radius:11px; background:var(--lavagem); color:var(--primaria-forte); font-size:11px; text-align:center; letter-spacing:0; }
  .grupo + .grupo { margin-top:16px; }
  .grupo-titulo { margin:0 0 8px; font-size:13px; font-weight:800; color:var(--texto); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .grade { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .jogador { position:relative; display:flex; flex-direction:column; align-items:center; gap:3px; padding:16px 10px 14px; border-radius:16px;
    background:var(--escuro); border:1px solid rgba(255,255,255,.08); color:#fff; text-align:center; min-width:0; }
  .foto { position:relative; width:64px; height:64px; margin-bottom:12px; border-radius:50%; border:1px solid rgba(255,255,255,.14);
    background:rgba(254,117,82,.18); display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:900; color:var(--primaria); }
  .foto img { position:absolute; inset:0; width:100%; height:100%; border-radius:50%; object-fit:cover; }
  .numero { position:absolute; bottom:-10px; left:50%; transform:translateX(-50%); min-width:32px; padding:2px 7px; border-radius:11px;
    background:var(--escuro); border:1.5px solid var(--primaria); color:#fff; font-size:13px; font-weight:900; font-variant-numeric:tabular-nums; }
  .capitao { position:absolute; top:-2px; left:-6px; width:22px; height:22px; border-radius:5px; overflow:hidden; display:flex; align-items:center; justify-content:center;
    background:repeating-linear-gradient(135deg,#FACC15 0 4px,#FFFFFF 4px 8px); color:#17212F; font-size:12px; font-weight:900; border:1px solid rgba(0,0,0,.15); }
  .nome { width:100%; font-size:14px; line-height:18px; font-weight:800; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .posicao { font-size:12px; color:rgba(255,255,255,.72); }
  .dono { margin-top:4px; padding:2px 8px; border-radius:8px; background:rgba(254,117,82,.18); color:#FF9065; font-size:10px; font-weight:800; letter-spacing:.6px; text-transform:uppercase; }
  .vazio { margin:0; color:var(--texto2); font-size:14px; line-height:20px; }
  .lojas-titulo { margin:0 0 6px; font-size:13px; font-weight:700; color:var(--texto2); text-align:center; }
  .lojas-texto { margin:0; font-size:14px; color:var(--texto2); text-align:center; }
  .loja { display:flex; align-items:center; justify-content:center; gap:6px; min-height:44px; color:var(--primaria-forte); text-decoration:none; font-size:15px; font-weight:700; }
  .loja span { opacity:.6; font-size:18px; }
  .rodape { margin:4px 0 0; text-align:center; font-size:12px; color:var(--texto3); }
</style>
</head>
<body>
<main>
${conteudo}
  <p class="rodape">Compartilhado pelo app Tugyn</p>
</main>
</body>
</html>`;
};
