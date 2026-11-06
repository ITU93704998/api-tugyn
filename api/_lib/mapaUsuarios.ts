import { FieldPath, FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Mapa de usuários do painel (Plataforma › Usuários). Só é gerado quando o administrador clica em "Gerar mapa": a API lê
 * a localização dos perfis (cidade e estado que a pessoa informou; nunca coordenadas) e grava SÓ OS TOTAIS em
 * `sistema/mapaUsuarios`. Abrir a tela lê esse documento (1 leitura) e mostra o último mapa gerado.
 *
 * Custo de gerar: 1 leitura por perfil (o `select` só diminui o tráfego, não a cobrança).
 * Não entram contas suspensas nem em exclusão. Nenhum nome ou identificador vai para o documento.
 */

export const DOC_MAPA = "sistema/mapaUsuarios";
const PAGINA = 1000;
const PAGINAS_MAX = 200; // 200 mil perfis por geração
/** Cidades guardadas no documento (as demais somam em `outrasCidades`). Mantém o documento bem abaixo de 1 MB. */
export const CIDADES_MAX = 3000;

export const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"] as const;
const UF_SET = new Set<string>(UFS);

type Dados = Record<string, unknown>;

export interface CidadeNoMapa {
  id: string;
  cidade: string;
  uf: string;
  total: number;
}

export interface MapaUsuarios {
  geradoEm: number;
  /** Perfis contados (ativos). */
  perfis: number;
  comLocalizacao: number;
  semLocalizacao: number;
  /** Suspensos e em exclusão, que ficaram de fora. */
  ignorados: number;
  porEstado: Record<string, number>;
  cidades: CidadeNoMapa[];
  /** Pessoas em cidades além das `CIDADES_MAX` maiores. */
  outrasCidades: number;
  /** Passou do limite de leitura: os números são parciais. */
  parcial: boolean;
}

/** Mesma regra do app (`generateCityId`): minúsculas, sem acento, só letras e números separados por "_". */
export const slug = (v: string): string =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const ID_CIDADE = /^[a-z0-9]+(?:_[a-z0-9]+)*_[a-z]{2}$/;
const texto = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Cidade e estado de um perfil. null = sem localização utilizável. Pura: testada sem Firestore. */
export const localizacaoDoPerfil = (d: Dados): { id: string; cidade: string; uf: string } | null => {
  const loc = (typeof d.location === "object" && d.location !== null ? d.location : {}) as Dados;
  const cidade = texto(loc.city, 80);
  let uf = texto(loc.state, 30).toUpperCase();
  const idGravado = texto(loc.cityId, 120).toLowerCase();
  if (!UF_SET.has(uf) && ID_CIDADE.test(idGravado)) uf = idGravado.slice(-2).toUpperCase();
  if (!UF_SET.has(uf)) return null;
  const id = ID_CIDADE.test(idGravado) && idGravado.endsWith(`_${uf.toLowerCase()}`) ? idGravado : cidade ? `${slug(cidade)}_${uf.toLowerCase()}` : "";
  if (!id || !ID_CIDADE.test(id)) return { id: "", cidade: "", uf };
  return { id, cidade, uf };
};

/** Soma os perfis em totais por estado e por cidade. Pura: testada sem Firestore. */
export const agregar = (perfis: Iterable<Dados>, agora: number, parcial = false): MapaUsuarios => {
  const porEstado: Record<string, number> = {};
  const cidades = new Map<string, CidadeNoMapa>();
  let perfisContados = 0;
  let semLocalizacao = 0;
  let ignorados = 0;
  for (const d of perfis) {
    if (d.status === "suspended" || d.excluindoEm != null) {
      ignorados++;
      continue;
    }
    perfisContados++;
    const loc = localizacaoDoPerfil(d);
    if (!loc) {
      semLocalizacao++;
      continue;
    }
    porEstado[loc.uf] = (porEstado[loc.uf] ?? 0) + 1;
    if (!loc.id) continue; // sabe o estado, não a cidade: conta só no estado
    const atual = cidades.get(loc.id);
    if (atual) {
      atual.total++;
      if (!atual.cidade && loc.cidade) atual.cidade = loc.cidade;
    } else cidades.set(loc.id, { id: loc.id, cidade: loc.cidade, uf: loc.uf, total: 1 });
  }
  const ordenadas = [...cidades.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const guardadas = ordenadas.slice(0, CIDADES_MAX);
  return {
    geradoEm: agora,
    perfis: perfisContados,
    comLocalizacao: perfisContados - semLocalizacao,
    semLocalizacao,
    ignorados,
    porEstado,
    cidades: guardadas,
    outrasCidades: ordenadas.slice(CIDADES_MAX).reduce((s, c) => s + c.total, 0),
    parcial,
  };
};

/** Lê os perfis em páginas (só os campos de localização e situação). */
async function* lerPerfis(db: Firestore): AsyncGenerator<Dados | "limite"> {
  let ultimo: string | null = null;
  for (let i = 0; i < PAGINAS_MAX; i++) {
    let q = db.collection("users").orderBy(FieldPath.documentId()).select("location.city", "location.state", "location.cityId", "status", "excluindoEm").limit(PAGINA);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    for (const doc of snap.docs) yield doc.data() as Dados;
    if (snap.size < PAGINA) return;
    ultimo = snap.docs[snap.docs.length - 1].id;
  }
  yield "limite";
}

let emAndamento: Promise<MapaUsuarios> | null = null;

/** Gera e grava o mapa. Pedidos simultâneos nesta instância esperam a mesma geração. */
export function gerarMapa(db: Firestore, adminUid: string, agora = Date.now()): Promise<MapaUsuarios> {
  if (!emAndamento) {
    emAndamento = (async () => {
      const lidos: Dados[] = [];
      let parcial = false;
      for await (const p of lerPerfis(db)) {
        if (p === "limite") parcial = true;
        else lidos.push(p);
      }
      const mapa = agregar(lidos, agora, parcial);
      await db.doc(DOC_MAPA).set({ ...mapa, geradoPor: adminUid, salvoEm: FieldValue.serverTimestamp() });
      console.log(JSON.stringify({ evt: "mapa_usuarios_gerado", perfis: mapa.perfis, cidades: mapa.cidades.length, parcial }));
      return mapa;
    })().finally(() => {
      emAndamento = null;
    });
  }
  return emAndamento;
}

const numero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** O último mapa gerado (null = nunca gerado). */
export async function lerMapa(db: Firestore): Promise<MapaUsuarios | null> {
  const snap = await db.doc(DOC_MAPA).get();
  if (!snap.exists) return null;
  const d = (snap.data() ?? {}) as Dados;
  const porEstado: Record<string, number> = {};
  if (typeof d.porEstado === "object" && d.porEstado !== null) {
    for (const [uf, n] of Object.entries(d.porEstado as Dados)) if (UF_SET.has(uf)) porEstado[uf] = numero(n);
  }
  return {
    geradoEm: numero(d.geradoEm),
    perfis: numero(d.perfis),
    comLocalizacao: numero(d.comLocalizacao),
    semLocalizacao: numero(d.semLocalizacao),
    ignorados: numero(d.ignorados),
    porEstado,
    cidades: (Array.isArray(d.cidades) ? d.cidades : [])
      .filter((c): c is Dados => typeof c === "object" && c !== null)
      .map((c) => ({ id: texto(c.id, 120), cidade: texto(c.cidade, 80), uf: texto(c.uf, 2), total: numero(c.total) }))
      .filter((c) => c.id && UF_SET.has(c.uf)),
    outrasCidades: numero(d.outrasCidades),
    parcial: d.parcial === true,
  };
}
