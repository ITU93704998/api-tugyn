/**
 * Imagem da prévia dos links (1200x630, PNG): o "cartão" grande que o WhatsApp, o Instagram e afins mostram ao colar o link.
 * Gerada na hora pelo @vercel/og a partir dos MESMOS dados públicos da página (nada além do que a página já mostra) e
 * guardada na CDN. Fontes (Inter) e logo vêm de dentro do projeto; banner e escudo, só do próprio Cloudinary, com prazo
 * curto: se não vierem, o cartão sai sem eles em vez de falhar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tacaSvg } from "./tacaSvg";
import { ajustarTitulo, caberEm, larguraDoTexto } from "./medirTexto";

export interface DadosCartao {
  /** Faixa de cima: "CAMPEONATO ENTRE TIMES", "CONVITE PARA A TURMA"... */
  rotulo: string;
  titulo: string;
  /** Linha de detalhes ("Mata-mata · Society · Palmas, TO"). */
  detalhes: string;
  /** A chamada em destaque ("Inscrições abertas até 20/11 · 4 vagas"). */
  destaque: string;
  /** Banner do Cloudinary (fundo), ou "". */
  fundo?: string;
  /** Escudo do time (à direita): imagem do Cloudinary ou, sem ela, a sigla na cor do time. */
  escudo?: { url: string; cor: string; sigla: string } | null;
  /** Campeonato: a taça escolhida (texto das peças; null = clássica), à direita no lugar do escudo. */
  taca?: string | null;
  /** Campeonato: os nomes dos patrocinadores ("A · B · C"), numa faixa embaixo. */
  patrocinadores?: string;
}

export const LARGURA_CARTAO = 1200;
export const ALTURA_CARTAO = 630;

let fontes: { name: string; data: Buffer; weight: 400 | 700 | 800; style: "normal" }[] | null = null;
let logo: string | null = null;
const carregarFontes = () =>
  (fontes ??= [
    { name: "Inter", data: readFileSync(join(process.cwd(), "api", "assets", "fontes", "inter-400.woff")), weight: 400, style: "normal" },
    { name: "Inter", data: readFileSync(join(process.cwd(), "api", "assets", "fontes", "inter-700.woff")), weight: 700, style: "normal" },
    { name: "Inter", data: readFileSync(join(process.cwd(), "api", "assets", "fontes", "inter-800.woff")), weight: 800, style: "normal" },
  ]);
const carregarLogo = (): string => (logo ??= `data:image/png;base64,${readFileSync(join(process.cwd(), "api", "assets", "icon.png")).toString("base64")}`);

const CLOUDINARY = /^https:\/\/res\.cloudinary\.com\/[a-z0-9_-]+\/image\/upload\/[A-Za-z0-9_\-./,]+$/i;
const MAX_IMAGEM = 4 * 1024 * 1024;

/**
 * Corpo da resposta com no máximo `max` bytes: recusa pelo Content-Length declarado e, durante a leitura, para (e cancela o
 * download) assim que passar do limite. Nunca junta na memória uma imagem maior que o limite.
 */
export const lerAteLimite = async (r: Response, max: number, controle?: AbortController): Promise<Buffer | null> => {
  const declarado = Number(r.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declarado) && declarado > max) { controle?.abort(); return null; }
  if (!r.body) return null;
  const leitor = r.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await leitor.cancel().catch(() => undefined); controle?.abort(); return null; }
    partes.push(value);
  }
  return Buffer.concat(partes, total);
};

/** Imagem do Cloudinary como data URI (o gerador não busca nada sozinho). null se não for do Cloudinary, demorar ou falhar. */
export const imagemComoDataUri = async (url: string | undefined, prazoMs = 2500): Promise<string | null> => {
  if (!url || !CLOUDINARY.test(url)) return null;
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), prazoMs);
  try {
    const r = await fetch(url, { signal: controle.signal, redirect: "error" });
    const tipo = r.headers.get("content-type") ?? "";
    if (!r.ok || !/^image\/(png|jpe?g|webp)$/.test(tipo.split(";")[0].trim())) return null;
    const buf = await lerAteLimite(r, MAX_IMAGEM, controle);
    return buf && buf.length > 0 ? `data:${tipo.split(";")[0].trim()};base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const cortar = (texto: string, max: number): string => (texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto);
const corValida = (cor: string): string => (/^#[0-9A-Fa-f]{6}$/.test(cor) ? cor : "#FE7552");

type No = { type: string; props: Record<string, unknown> };
const div = (style: Record<string, unknown>, ...children: (No | string | null)[]): No => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: children.filter((c) => c !== null) },
});
const img = (src: string, style: Record<string, unknown>): No => ({ type: "img", props: { src, style } });

/** A árvore do cartão (sem JSX: objetos no formato que o gerador aceita). Separada para os testes. */
export const arvoreDoCartao = (d: DadosCartao, imagens: { logo: string; fundo: string | null; escudo: string | null }): No => {
  const temEscudo = Boolean(d.escudo) || d.taca !== undefined;
  // Largura útil do texto (1200 - 2 x 64), menos a taça/escudo (até 336) e o espaço entre eles: o título nunca invade a taça.
  const largura = temEscudo ? 690 : 1072;
  // Título pela largura medida: uma linha grande, ou até duas menores (palavra comprida demais é cortada com "…").
  const umaLinha = ajustarTitulo(d.titulo, [84, 72, 60], largura, 1);
  const titulo = umaLinha.linhas[0].endsWith("…") ? ajustarTitulo(d.titulo, [60, 52, 44, 38], largura, 2) : umaLinha;
  const textoAbrir = "Abra no app Tugyn";
  const larguraDestaque = 1072 - larguraDoTexto(textoAbrir, 24) - 40;
  // Faixa dos patrocinadores: 1072 menos o padding (2 x 20), o rótulo e o espaço entre eles.
  const larguraPatrocinio = 1072 - 40 - larguraDoTexto("PATROCÍNIO", 20, 2) - 16;
  const escudo = d.taca !== undefined
    ? img(`data:image/svg+xml;base64,${Buffer.from(tacaSvg(d.taca, 480, 600, "cartao")).toString("base64")}`, d.patrocinadores ? { width: 256, height: 320 } : { width: 336, height: 420 })
    : d.escudo
    ? imagens.escudo
      ? img(imagens.escudo, { width: 288, height: 288, objectFit: "contain" })
      : div({ width: 280, height: 280, borderRadius: 140, background: corValida(d.escudo.cor), alignItems: "center", justifyContent: "center",
            color: "#FFFFFF", fontSize: 96, fontWeight: 800, border: "8px solid rgba(255,255,255,0.85)" }, cortar(d.escudo.sigla || d.titulo.slice(0, 3).toUpperCase(), 3))
    : null;

  return div(
    { width: LARGURA_CARTAO, height: ALTURA_CARTAO, position: "relative", background: "#17212F", fontFamily: "Inter", color: "#FFFFFF" },
    imagens.fundo ? img(imagens.fundo, { position: "absolute", left: 0, top: 0, width: LARGURA_CARTAO, height: ALTURA_CARTAO, objectFit: "cover" }) : null,
    // Véu: com banner, escurece para o texto ler bem; sem banner, o brilho laranja da marca.
    div({
      position: "absolute", left: 0, top: 0, width: LARGURA_CARTAO, height: ALTURA_CARTAO,
      backgroundImage: imagens.fundo
        ? "linear-gradient(90deg, rgba(14,20,29,0.94) 0%, rgba(14,20,29,0.82) 55%, rgba(14,20,29,0.45) 100%)"
        : "radial-gradient(circle at 88% 0%, rgba(254,117,82,0.55) 0%, rgba(254,117,82,0) 55%), radial-gradient(circle at 0% 100%, rgba(254,117,82,0.18) 0%, rgba(254,117,82,0) 45%)",
    }),
    div(
      { position: "absolute", left: 0, top: 0, width: LARGURA_CARTAO, height: ALTURA_CARTAO, padding: "56px 64px", flexDirection: "column", justifyContent: "space-between" },
      // Marca
      div({ alignItems: "center", gap: 18 },
        img(imagens.logo, { width: 64, height: 64, borderRadius: 16 }),
        div({ fontSize: 40, fontWeight: 800, letterSpacing: -1 }, "Tugyn")),
      // Miolo
      div({ alignItems: "center", justifyContent: "space-between", gap: 40 },
        div({ flexDirection: "column", gap: 18, width: largura, flexShrink: 0 },
          d.rotulo ? div({ alignSelf: "flex-start", background: "#FE7552", color: "#FFFFFF", fontSize: 24, fontWeight: 800, letterSpacing: 2, padding: "8px 18px", borderRadius: 999 },
            caberEm(d.rotulo.toUpperCase(), 24, largura - 36, 2)) : null,
          div({ flexDirection: "column" }, ...titulo.linhas.map((linha) => div({ fontSize: titulo.fonte, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2, whiteSpace: "nowrap" }, linha))),
          d.detalhes ? div({ fontSize: 32, fontWeight: 400, color: "#E4DED8", whiteSpace: "nowrap" }, caberEm(d.detalhes, 32, largura)) : null),
        escudo ? div({ flexShrink: 0 }, escudo) : null),
      // Rodapé (com patrocinadores: a chamada em cima e a faixa "PATROCÍNIO" embaixo)
      div({ flexDirection: "column", gap: 14 },
        div({ alignItems: "center", justifyContent: "space-between" },
          d.destaque ? div({ fontSize: 30, fontWeight: 700, color: "#FFB59E", whiteSpace: "nowrap" }, caberEm(d.destaque, 30, larguraDestaque)) : div({}),
          div({ fontSize: 24, fontWeight: 700, color: "#B5AEA6", whiteSpace: "nowrap" }, textoAbrir)),
        d.patrocinadores ? div({ alignItems: "center", gap: 16, padding: "12px 20px", borderRadius: 16, background: "rgba(23,33,47,0.88)", width: 1072, overflow: "hidden" },
          div({ fontSize: 20, fontWeight: 800, letterSpacing: 2, color: "#FE7552", flexShrink: 0 }, "PATROCÍNIO"),
          div({ fontSize: 26, fontWeight: 700, color: "#FFFFFF", whiteSpace: "nowrap" }, caberEm(d.patrocinadores, 26, larguraPatrocinio))) : null),
    ),
  );
};

/**
 * O @vercel/og só existe como ESM, e a API compila para CommonJS: um import() comum vira require(), que falha
 * em Node sem require(esm) (o cartão caía sempre no ícone). Este import é nativo; o pacote inteiro (package.json + dist) vai no deploy pelo
 * includeFiles do vercel.json.
 */
type Gerador = typeof import("@vercel/og");
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importarNativo = new Function("m", "return import(m)") as (m: string) => Promise<Gerador>;
let gerador: Promise<Gerador> | null = null;
const importarGerador = (): Promise<Gerador> => (gerador ??= importarNativo("@vercel/og").catch((e) => { gerador = null; throw e; }));

/** PNG do cartão. Lança se o gerador falhar (quem chama responde com o ícone). */
export const gerarCartao = async (d: DadosCartao): Promise<Buffer> => {
  const [fundo, escudo] = await Promise.all([imagemComoDataUri(d.fundo), imagemComoDataUri(d.escudo?.url)]);
  // Carregado só quando há imagem para gerar: as páginas (a maioria dos pedidos) não pagam o custo do gerador.
  const { ImageResponse } = await importarGerador();
  const arvore = arvoreDoCartao(d, { logo: carregarLogo(), fundo, escudo });
  const resposta = new ImageResponse(arvore as unknown as ConstructorParameters<typeof ImageResponse>[0], {
    width: LARGURA_CARTAO,
    height: ALTURA_CARTAO,
    fonts: carregarFontes(),
  });
  return Buffer.from(await resposta.arrayBuffer());
};
