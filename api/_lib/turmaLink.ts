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
  texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface PaginaParams {
  id: string;
  lojaIos: string | null;
  lojaAndroid: string | null;
  plataforma: Plataforma;
}

export const renderizarPagina = ({ id, lojaIos, lojaAndroid, plataforma }: PaginaParams): string => {
  const abrir = `tugyn://turma/${encodeURIComponent(id)}`;

  const lojas: { rotulo: string; url: string }[] = [];
  if (plataforma !== "android" && lojaIos) lojas.push({ rotulo: "Baixar na App Store", url: lojaIos });
  if (plataforma !== "ios" && lojaAndroid) lojas.push({ rotulo: "Baixar no Google Play", url: lojaAndroid });

  const download = lojas.length
    ? `<p class="small">Ainda não tem o app?</p>${lojas.map((l) => `<a class="btn" href="${esc(l.url)}">${esc(l.rotulo)}</a>`).join("")}`
    : `<p class="small">Ainda não tem o app? Procure por Tugyn na App Store ou no Google Play.</p>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Convite para uma turma no Tugyn</title>
<meta property="og:title" content="Convite para uma turma no Tugyn">
<meta property="og:description" content="Toque para abrir o convite no app Tugyn.">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0F172A;color:#E2E8F0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{width:100%;max-width:360px;margin:24px;padding:24px;border-radius:16px;background:#111C33;border:1px solid #1E293B;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:#94A3B8;font-size:14px;line-height:1.4}
.btn{display:block;padding:12px 16px;margin:8px 0;border-radius:10px;border:1px solid #334155;color:#E2E8F0;text-decoration:none;font-weight:600;font-size:14px}
.primary{background:#1D4ED8;border-color:#1D4ED8;color:#fff}.small{margin-top:20px;margin-bottom:4px;font-size:12px}
</style>
</head>
<body>
<main>
<h1>Você foi convidado para uma turma no Tugyn</h1>
<p>Toque no botão para abrir o convite no app.</p>
<a class="btn primary" href="${esc(abrir)}">Abrir no Tugyn</a>
${download}
</main>
</body>
</html>`;
};
