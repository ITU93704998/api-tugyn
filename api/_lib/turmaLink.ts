/**
 * Página pública de convite de turma: https://<servidor>/api/turma/<id>
 *
 * Por que existe: um link `tugyn://turma/<id>` colado no WhatsApp/Instagram não é clicável. Um link
 * https é; esta página então oferece "Abrir no Tugyn" (esquema do app) e "Baixar o app" (loja).
 * Estática e sem dados do usuário: não lê o Firestore nem mostra o nome da turma (qualquer pessoa pode abrir).
 */
export type Plataforma = "ios" | "android" | "outra";

/** Ids de documento do Firestore: letras, números, `_` e `-` (os gerados automaticamente têm 20). */
export const isValidTurmaId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);

export const detectarPlataforma = (userAgent: unknown): Plataforma => {
  const ua = Array.isArray(userAgent) ? String(userAgent[0] ?? "") : String(userAgent ?? "");
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "outra";
};

const esc = (texto: string): string =>
  texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

interface PaginaParams {
  id: string;
  lojaIos: string | null;
  lojaAndroid: string | null;
  plataforma: Plataforma;
  iconUrl?: string | null;
  paginaUrl?: string | null;
}

export const renderizarPagina = ({
  id,
  lojaIos,
  lojaAndroid,
  plataforma,
  iconUrl,
  paginaUrl,
}: PaginaParams): string => {
  const abrir = `tugyn://turma/${encodeURIComponent(id)}`;

  const lojas: { rotulo: string; url: string; icone: string }[] = [];
  if (plataforma !== "android" && lojaIos) {
    lojas.push({ rotulo: "Baixar na App Store", url: lojaIos, icone: "" });
  }
  if (plataforma !== "ios" && lojaAndroid) {
    lojas.push({ rotulo: "Baixar no Google Play", url: lojaAndroid, icone: "▶" });
  }

  const download = lojas.length
    ? `<p class="hint">Ainda não tem o app?</p>
       <div class="store-links">
         ${lojas
           .map(
             (l) =>
               `<a class="link" href="${esc(l.url)}">${esc(l.rotulo)} <span class="link-arrow">›</span></a>`
           )
           .join("")}
       </div>`
    : `<p class="hint">Ainda não tem o app? Procure por <strong>Tugyn</strong> na App Store ou no Google Play.</p>`;

  const marca = iconUrl
    ? `<img class="mark-img" src="${esc(iconUrl)}" alt="Tugyn" width="56" height="56" />`
    : `<div class="mark" aria-hidden="true">⚽</div>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F2F2F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>Convite para uma turma no Tugyn</title>
<meta property="og:title" content="Convite para uma turma no Tugyn">
<meta property="og:description" content="Toque para abrir o convite no app Tugyn.">
<meta property="og:type" content="website">
${paginaUrl ? `<meta property="og:url" content="${esc(paginaUrl)}">` : ""}
${iconUrl ? `<meta property="og:image" content="${esc(iconUrl)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<link rel="apple-touch-icon" href="${esc(iconUrl)}">
<link rel="icon" type="image/png" href="${esc(iconUrl)}">` : ""}
<style>
  :root {
    --bg: #F2F2F7;
    --surface: #FFFFFF;
    --label: #1C1C1E;
    --secondary: #6E6E73;
    --tertiary: #A1A1A6;
    --separator: rgba(60,60,67,0.12);
    --accent: #F36F50;
    --accent-pressed: #E15F41;
    --on-accent: #FFFFFF;
    --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --surface: #1C1C1E;
      --label: #F2F2F7;
      --secondary: #A1A1A6;
      --tertiary: #6E6E73;
      --separator: rgba(84,84,88,0.65);
      --shadow: none;
    }
  }

  * { box-sizing: border-box; }

  html, body { height: 100%; }

  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding:
      max(24px, env(safe-area-inset-top))
      max(20px, env(safe-area-inset-right))
      max(24px, env(safe-area-inset-bottom))
      max(20px, env(safe-area-inset-left));
    background: var(--bg);
    color: var(--label);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  main {
    width: 100%;
    max-width: 380px;
    background: var(--surface);
    border-radius: 20px;
    padding: 28px 24px 24px;
    box-shadow: var(--shadow);
    text-align: center;
  }

  /* Marca / ícone no topo */
  .mark {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: rgba(243, 111, 80, 0.12);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
    color: var(--accent);
    font-size: 26px;
    line-height: 1;
  }

  .mark-img {
    display: inline-block;
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: 16px;
    margin-bottom: 16px;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--secondary);
    margin: 0 0 10px;
  }

  h1 {
    font-size: 22px;
    line-height: 28px;
    font-weight: 700;
    letter-spacing: -0.4px;
    color: var(--label);
    margin: 0 0 8px;
  }

  p {
    color: var(--secondary);
    font-size: 15px;
    line-height: 21px;
    letter-spacing: -0.1px;
    margin: 0 0 24px;
  }

  /* Botão primário — preenchido, estilo Apple */
  .btn-primary {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 50px;
    padding: 0 20px;
    border-radius: 14px;
    background: var(--accent);
    color: var(--on-accent);
    text-decoration: none;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.2px;
    -webkit-tap-highlight-color: transparent;
    transition: background-color .15s ease, transform .08s ease;
  }
  .btn-primary:active { background: var(--accent-pressed); transform: scale(0.99); }

  /* Divisor sutil entre CTA e fallback */
  .divider {
    height: 1px;
    background: var(--separator);
    margin: 22px 0 18px;
  }

  .hint {
    font-size: 13px;
    color: var(--tertiary);
    margin: 0 0 10px;
    line-height: 1.4;
  }
  .hint strong { color: var(--secondary); font-weight: 600; }

  /* Links de loja — texto + seta (padrão iOS) */
  .store-links {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .link {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 12px 8px;
    border-radius: 12px;
    color: var(--accent);
    text-decoration: none;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.2px;
    -webkit-tap-highlight-color: transparent;
    transition: background-color .12s ease;
  }
  .link:active { background: var(--separator); }
  .link-arrow { font-size: 17px; opacity: 0.6; }

  .footer {
    margin-top: 20px;
    font-size: 12px;
    color: var(--tertiary);
    letter-spacing: 0.1px;
  }
</style>
</head>
<body>
<main>
  ${marca}
  <p class="eyebrow">Tugyn</p>
  <h1>Você foi convidado<br>para uma turma</h1>
  <p>Toque no botão para abrir o convite no app.</p>

  <a class="btn-primary" href="${esc(abrir)}">Abrir no Tugyn</a>

  <div class="divider"></div>

  ${download}

  <p class="footer">Convite enviado pelo app Tugyn</p>
</main>
</body>
</html>`;
};