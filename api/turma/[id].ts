import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "../_lib/auth";
import { resolvePolicy } from "../_lib/version";
import {
  detectarPlataforma,
  isValidTurmaId,
  previaDoDocumento,
  renderizarPagina,
  type PreviaTurma,
} from "../_lib/turmaLink";
import {
  conviteDoDocumento,
  isValidLinkId,
  renderizarPaginaConvite,
  renderizarPaginaTime,
  timeDoDocumento,
  type ConvitePublico,
  type TimePublico,
} from "../_lib/timeLink";
import { campeonatoDoDocumento, cartaoDoCampeonato, isValidCampeonatoId, renderizarPaginaCampeonato, type CampeonatoPublico } from "../_lib/campeonatoLink";
import { CODIGO_CAMPEONATO, CODIGO_TURMA, caminhoPublico, campeonatoPorCodigo, turmaPorCodigo, type TipoLink } from "../_lib/linkCurto";
import { gerarCartao, type DadosCartao } from "../_lib/cartaoLink";

/**
 * Páginas públicas dos links compartilhados (não exigem login: quem recebe o link talvez nem tenha o app).
 * vercel.json reescreve para cá, sem criar outra função na Vercel:
 *
 *   /turma/<código ou id>        (e o antigo /api/turma/<id>)        prévia `turmaPreviews/<id>`
 *   /time/<linkId>               (e o antigo /api/time/<linkId>)     ?tipo=time
 *   /convocacao/<codigo>         (e o antigo /api/time/c/<codigo>)   ?tipo=convite: link de 1 hora, `convitesTime/<codigo>`
 *   /campeonato/<código ou id>   (e o antigo /api/campeonato/<id>)   ?tipo=campeonato: `campeonatosTimes/<id>`
 *   /imagem/<tipo>/<código>      ?formato=imagem: o cartão 1200x630 da prévia (WhatsApp etc.)
 *   /turma|campeonato/<código>?formato=id   o id (JSON) para o app abrir a tela quando o link curto abre direto nele.
 *                                Nada novo fica público: a página já leva o id no botão tugyn://.
 *
 * Se a leitura demorar ou falhar, a página sai genérica em vez de travar. Os links das lojas vêm das MESMAS variáveis do
 * /api/version (APP_STORE_URL[_IOS|_ANDROID]), já validadas.
 */
const PREVIA_TIMEOUT_MS = 2500;

const comPrazo = async <T>(leitura: Promise<T>, rotulo: string, prazoMs = PREVIA_TIMEOUT_MS): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const limite = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), prazoMs);
    });
    return await Promise.race([leitura, limite]);
  } catch (error) {
    console.warn(`[${rotulo}] indisponível:`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Igual ao comPrazo, mas demora ou falha viram ERRO (não null): para quem precisa separar "não existe" de "indisponível". */
const comPrazoEstrito = async <T>(leitura: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const limite = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("prazo esgotado")), PREVIA_TIMEOUT_MS);
    });
    return await Promise.race([leitura, limite]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const db = () => getFirestore(getFirebaseApp());

/** Turma pelo código de convite (6 letras) ou pelo id: o id resolvido e a prévia pública. */
const buscarTurma = async (idOuCodigo: string): Promise<{ turmaId: string; previa: PreviaTurma | null } | null> => {
  const turmaId = CODIGO_TURMA.test(idOuCodigo) ? await turmaPorCodigo(db(), idOuCodigo) : idOuCodigo;
  if (!turmaId) return null;
  const snap = await db().collection("turmaPreviews").doc(turmaId).get();
  return { turmaId, previa: snap.exists ? previaDoDocumento(snap.data()) : null };
};
const lerTurma = (idOuCodigo: string) => comPrazo(buscarTurma(idOuCodigo), "turma-link");

/** O time pelo `linkId` (1 leitura; só os campos que a página mostra). */
const lerTime = async (linkId: string): Promise<TimePublico | null> =>
  comPrazo(
    db()
      .collection("times")
      .where("linkId", "==", linkId)
      .select("nome", "cor", "donoId", "jogadores", "sigla", "modalidade", "genero", "faixaEtaria", "cidade", "escudoUrl", "camisas")
      .limit(1)
      .get()
      .then((snap) => (snap.empty ? null : timeDoDocumento(snap.docs[0].data()))),
    "time-link",
  );

/** Prévia do link de convocação (1 leitura). */
const lerConvite = async (codigo: string): Promise<ConvitePublico | null> =>
  comPrazo(
    db().collection("convitesTime").doc(codigo).get().then((snap) => (snap.exists ? conviteDoDocumento(snap.data()) : null)),
    "time-convite",
  );

/** O campeonato pelo id ou pelo código curto (só os campos públicos do catálogo). null se não existir, for de teste... */
const buscarCampeonato = async (idOuCodigo: string): Promise<{ id: string; campeonato: CampeonatoPublico } | null> => {
  const id = isValidCampeonatoId(idOuCodigo) ? idOuCodigo : await campeonatoPorCodigo(db(), idOuCodigo);
  if (!id) return null;
  const snap = await db().collection("campeonatosTimes").doc(id).get();
  const campeonato = snap.exists ? campeonatoDoDocumento(snap.data()) : null;
  return campeonato ? { id, campeonato } : null;
};
/**
 * Campeonato: duas leituras seguidas (código → id e o documento). Com a função fria, 2,5 s não bastavam, a página saía
 * como "não encontrado" e a imagem virava o ícone (a prévia do WhatsApp ficava sem o cartão). Página: 5 s; imagem: 8 s.
 */
const PRAZO_CAMPEONATO_PAGINA_MS = 5000;
const PRAZO_CAMPEONATO_IMAGEM_MS = 8000;
const lerCampeonato = (idOuCodigo: string, prazoMs = PRAZO_CAMPEONATO_PAGINA_MS) => comPrazo(buscarCampeonato(idOuCodigo), "campeonato-link", prazoMs);

const CABECALHOS_SEGURANCA: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Sem scripts: a página é só HTML e CSS. Imagens: as do próprio servidor (ícone, cartão) e as do Cloudinary.
  "Content-Security-Policy": "default-src 'none'; img-src 'self' https://res.cloudinary.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const primeiro = (v: unknown): string | undefined => (Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : typeof v === "string" ? v : undefined);

const tipoDaQuery = (tipo: string | undefined): TipoLink =>
  tipo === "time" ? "time" : tipo === "convite" ? "convite" : tipo === "campeonato" ? "campeonato" : "turma";

const idValido = (tipo: TipoLink, id: unknown): id is string =>
  tipo === "campeonato"
    ? isValidCampeonatoId(id) || (typeof id === "string" && CODIGO_CAMPEONATO.test(id))
    : tipo === "time" || tipo === "convite"
      ? isValidLinkId(id)
      : isValidTurmaId(id);

/** Dados do cartão para a imagem; null se não houver o que mostrar. */
const dadosDoCartao = async (tipo: TipoLink, id: string): Promise<DadosCartao | null> => {
  if (tipo === "campeonato") {
    const r = await lerCampeonato(id, PRAZO_CAMPEONATO_IMAGEM_MS);
    return r ? cartaoDoCampeonato(r.campeonato, Date.now()) : null;
  }
  if (tipo === "time" || tipo === "convite") {
    const t = tipo === "time" ? await lerTime(id) : await lerConvite(id);
    if (!t) return null;
    const jogadores = tipo === "time" ? (t as TimePublico).jogadores.length : 0;
    return {
      rotulo: tipo === "time" ? "Time" : "Convocação",
      titulo: `${t.nome}${t.sigla ? ` (${t.sigla})` : ""}`,
      detalhes: t.detalhes,
      destaque: tipo === "time" ? `${jogadores} ${jogadores === 1 ? "jogador" : "jogadores"} no elenco` : "Toque para pedir para entrar no time",
      escudo: { url: t.escudo, cor: t.cor, sigla: t.sigla },
    };
  }
  const r = await lerTurma(id);
  if (!r?.previa) return null;
  return {
    rotulo: "Convite para a turma",
    titulo: r.previa.nome,
    detalhes: [r.previa.arenaNome, r.previa.dias, r.previa.horario].filter(Boolean).join(" · "),
    destaque: "Toque para pedir para entrar",
  };
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  for (const [nome, valor] of Object.entries(CABECALHOS_SEGURANCA)) res.setHeader(nome, valor);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).send("Método não permitido.");
  }

  const query = req.query ?? {};
  const bruto = primeiro(query.id);
  const tipo = tipoDaQuery(primeiro(query.tipo));
  if (!idValido(tipo, bruto)) {
    // Nunca devolve o que foi digitado.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(400).send("Link inválido.");
  }

  const host = req.headers.host;
  const origin = typeof host === "string" && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) ? `https://${host}` : null;
  const iconUrl = origin ? new URL("/tugyn-icon.png", origin).toString() : null;

  // ── Imagem da prévia ──
  if (primeiro(query.formato) === "imagem") {
    const dados = await dadosDoCartao(tipo, bruto);
    try {
      if (!dados) throw new Error("sem dados");
      const png = await gerarCartao(dados);
      res.setHeader("Content-Type", "image/png");
      // 10 min na CDN e até 1 dia servindo a cópia anterior enquanto atualiza: vagas e situação mudam devagar.
      res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
      return res.status(200).send(png);
    } catch (error) {
      if (dados) console.warn("[link-cartao] falhou:", error instanceof Error ? error.message : error);
      // Sem cartão: manda para o ícone (a prévia sai pequena, mas sai).
      res.setHeader("Cache-Control", "public, s-maxage=60");
      return res.redirect(302, "/tugyn-icon.png");
    }
  }

  // ── Código → id (app) ──
  if (primeiro(query.formato) === "id" && (tipo === "turma" || tipo === "campeonato")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    let id: string | undefined;
    try {
      id = tipo === "turma" ? (await comPrazoEstrito(buscarTurma(bruto)))?.turmaId : (await comPrazoEstrito(buscarCampeonato(bruto)))?.id;
    } catch (error) {
      // Demora ou falha do banco: NÃO é "não existe". 503 sem cache, e o app oferece tentar de novo.
      console.warn("[link-id] indisponível:", error instanceof Error ? error.message : error);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "indisponivel" });
    }
    res.setHeader("Cache-Control", id ? "public, s-maxage=300" : "public, s-maxage=30");
    return res.status(id ? 200 : 404).json(id ? { id } : { error: "nao_encontrado" });
  }

  const lojaIos = resolvePolicy(process.env, "ios").policy.storeUrl;
  const lojaAndroid = resolvePolicy(process.env, "android").policy.storeUrl;
  const plataforma = detectarPlataforma(req.headers["user-agent"]);
  // Endereço bonito (o mesmo que o app compartilha) no og:url e no cartão, em qualquer domínio deste projeto.
  const enderecos = (idPublico: string) => ({
    paginaUrl: origin ? new URL(caminhoPublico(tipo, idPublico), origin).toString() : null,
    cartaoUrl: origin ? new URL(`/imagem/${tipo}${caminhoPublico(tipo, idPublico).replace(/^\/[a-z]+/, "")}`, origin).toString() : null,
  });
  // Escudos, fotos e banners vêm do Cloudinary.
  res.setHeader("Content-Security-Policy", CABECALHOS_SEGURANCA["Content-Security-Policy"]);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // O conteúdo muda conforme o aparelho (qual loja mostrar): a CDN guarda uma cópia por User-Agent.
  res.setHeader("Vary", "User-Agent");

  if (tipo === "campeonato") {
    const r = await lerCampeonato(bruto);
    // 5 min na CDN: compartilhar no grupo não vira uma leitura por pessoa; vagas e situação se atualizam logo.
    res.setHeader("Cache-Control", r ? "public, s-maxage=300, stale-while-revalidate=600" : "public, s-maxage=60");
    const { paginaUrl, cartaoUrl } = enderecos(r?.id ?? bruto);
    return res.status(r ? 200 : 404).send(
      renderizarPaginaCampeonato({ campeonato: r?.campeonato ?? null, id: r?.id ?? bruto, agoraMs: Date.now(), lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, cartaoUrl: r ? cartaoUrl : null }),
    );
  }

  if (tipo === "convite") {
    const convite = await lerConvite(bruto);
    // Pouco tempo na CDN: o link vence em 1 hora (o app confere o prazo de novo ao pedir).
    res.setHeader("Cache-Control", "public, s-maxage=60");
    const { paginaUrl, cartaoUrl } = enderecos(bruto);
    return res
      .status(convite ? 200 : 404)
      .send(renderizarPaginaConvite({ convite, codigo: bruto, agoraMs: Date.now(), lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, cartaoUrl: convite ? cartaoUrl : null }));
  }

  if (tipo === "time") {
    const time = await lerTime(bruto);
    // 5 min na CDN: compartilhar no grupo não vira uma leitura por pessoa que abre; um jogador novo aparece logo.
    res.setHeader("Cache-Control", time ? "public, s-maxage=300, stale-while-revalidate=600" : "public, s-maxage=60");
    const { paginaUrl, cartaoUrl } = enderecos(bruto);
    return res
      .status(time ? 200 : 404)
      .send(renderizarPaginaTime({ time, linkId: bruto, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, cartaoUrl: time ? cartaoUrl : null }));
  }

  const r = await lerTurma(bruto);
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  const { paginaUrl, cartaoUrl } = enderecos(bruto);
  // O botão abre o app com o id da turma (resolvido do código); sem resolver, com o que veio (o app também resolve código).
  return res.status(200).send(
    renderizarPagina({ id: r?.turmaId ?? bruto, lojaIos, lojaAndroid, plataforma, iconUrl, paginaUrl, cartaoUrl: r?.previa ? cartaoUrl : null, previa: r?.previa ?? null }),
  );
}
