import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Universal Links (iOS) e App Links (Android): com o app instalado, os links compartilhados abrem DIRETO no app; sem ele,
 * abrem a página de sempre no navegador. O celular confere que o domínio autoriza o app lendo dois arquivos:
 *
 *   GET /.well-known/apple-app-site-association   (iOS)      → rewrite para /api/version?resource=apple-app-site-association
 *   GET /.well-known/assetlinks.json              (Android)  → rewrite para /api/version?resource=assetlinks
 *
 * (Servidos pela rota /api/version para não criar outra função na Vercel.) Só os links de turma e de time abrem o app:
 *   /api/turma/<turmaId>   /api/time/<linkId>   /api/time/c/<codigo>
 *
 * Variáveis da Vercel (sem elas o arquivo responde 404 e os links continuam abrindo no navegador, como antes):
 *   APPLE_TEAM_ID                  Team ID da conta da Apple (10 letras/números; developer.apple.com › Membership)
 *   ANDROID_SHA256_FINGERPRINTS    SHA-256 do certificado que ASSINA o app instalado. Loja: Play Console › Integridade do
 *                                  app › Assinatura do app (chave do Google). Outro só se ele assinar builds instaladas
 *                                  direto (ex.: keystore do EAS num APK de teste). Vários separados por vírgula.
 *   IOS_BUNDLE_ID / ANDROID_PACKAGE   opcionais (padrão: os do app.json)
 */

export const IOS_BUNDLE_PADRAO = "com.tugyn.tugynfut";
export const ANDROID_PACKAGE_PADRAO = "com.tugynfut.tugyn";
/** Caminhos que abrem o app (o resto do domínio continua só no navegador). */
export const CAMINHOS_DO_APP = ["/api/turma/*", "/api/time/*"] as const;

type Env = Record<string, string | undefined>;

const TEAM_ID = /^[A-Z0-9]{10}$/;
const PACOTE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Aceita a impressão digital com ou sem ":" e em minúsculas; devolve no formato AA:BB:... (32 pares) ou null. */
export const normalizarSha256 = (valor: string): string | null => {
  const hex = valor.replace(/[\s:]/g, "").toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(":") : null;
};

export const associacaoApple = (env: Env): Record<string, unknown> | null => {
  const team = (env.APPLE_TEAM_ID ?? "").trim().toUpperCase();
  const bundle = (env.IOS_BUNDLE_ID ?? "").trim() || IOS_BUNDLE_PADRAO;
  if (!TEAM_ID.test(team) || !PACOTE.test(bundle)) return null;
  const appID = `${team}.${bundle}`;
  // Só o formato moderno (`appIDs` + `components`, iOS 13+): o app exige iOS 16.4, e a Apple recomenda não misturar com o
  // antigo (`appID` + `paths`).
  return {
    applinks: {
      details: [
        {
          appIDs: [appID],
          components: CAMINHOS_DO_APP.map((caminho) => ({ "/": caminho })),
        },
      ],
    },
  };
};

export const associacaoAndroid = (env: Env): unknown[] | null => {
  const pacote = (env.ANDROID_PACKAGE ?? "").trim() || ANDROID_PACKAGE_PADRAO;
  const digitais = (env.ANDROID_SHA256_FINGERPRINTS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map(normalizarSha256);
  if (!PACOTE.test(pacote) || digitais.length === 0 || digitais.some((d) => d === null)) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pacote, sha256_cert_fingerprints: digitais },
    },
  ];
};

export const RECURSOS_APP_LINKS = ["apple-app-site-association", "assetlinks"] as const;

export const handleAppLinks = (req: VercelRequest, res: VercelResponse, env: Env = process.env) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Método não permitido." });
  }
  const conteudo = req.query?.resource === "assetlinks" ? associacaoAndroid(env) : associacaoApple(env);
  if (!conteudo) {
    // Sem configuração: os links continuam abrindo a página no navegador. Fica no log para não passar despercebido.
    console.error(JSON.stringify({ evt: "app_links_sem_configuracao", recurso: req.query?.resource }));
    return res.status(404).json({ error: "Não configurado." });
  }
  // A Apple exige application/json, HTTPS e nenhum redirecionamento; a resposta pode ficar em cache (muda raramente).
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).send(JSON.stringify(conteudo));
};
