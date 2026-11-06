import { FieldPath, FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Mapa de usuários do painel (Plataforma › Usuários). Só é gerado quando o administrador clica em "Gerar mapa": a API lê
 * a localização dos perfis (cidade e estado que a pessoa informou; nunca coordenadas) e grava SÓ OS TOTAIS em
 * `sistema/mapaUsuarios`. Abrir a tela lê esse documento (1 leitura) e mostra o último mapa gerado.
 *
 * Custo de gerar: 1 leitura por perfil (o `select` só diminui o tráfego, não a cobrança). Para não repetir varreduras:
 *  - reserva COMPARTILHADA entre instâncias em `sistema/mapaUsuariosGeracao` (transação): uma geração por vez na plataforma;
 *  - intervalo mínimo GLOBAL (`RECENTE_MS`): se o mapa salvo é recente, devolve ele sem ler os perfis;
 *  - soma página a página com prazo próprio: perto do limite da função, guarda o progresso (cursor + totais parciais)
 *    e o próximo clique continua de onde parou, sem reler o que já foi lido;
 *  - publica só se a reserva ainda for desta geração e se o mapa salvo não for mais novo.
 * Não entram contas suspensas nem em exclusão. Nenhum nome ou identificador vai para o documento.
 */

export const DOC_MAPA = "sistema/mapaUsuarios";
/** Reserva e progresso da geração em andamento (separado do mapa: abrir a tela continua lendo 1 documento). */
export const DOC_GERACAO = "sistema/mapaUsuariosGeracao";
const PAGINA = 1000;
/** Teto total por geração (somando as retomadas): 1 milhão de perfis. Passou disso, o mapa sai marcado como parcial. */
const PAGINAS_MAX = 1000;
/** Cidades guardadas no documento do mapa (as demais somam em `outrasCidades`). Mantém o documento bem abaixo de 1 MiB. */
export const CIDADES_MAX = 3000;
/** Cidades diferentes no progresso guardado (o Brasil tem 5.570 municípios; o resto soma em "outras"). */
const CIDADES_ACUMULADAS_MAX = 8000;
/** Mapa gerado há menos que isto (por qualquer administrador): devolve o salvo, sem varrer de novo. */
export const RECENTE_MS = 10 * 60_000;
/** A reserva vence sozinha se a instância morrer (a rota tem 60 s). */
export const RESERVA_MS = 90_000;
/** Tempo de leitura por chamada: sobra margem para salvar o progresso antes dos 60 s da rota. */
export const PRAZO_MS = 40_000;
/** Progresso guardado vale por 1 h; depois disso a geração recomeça (os números ficariam velhos demais). */
export const RETOMAR_MS = 60 * 60_000;

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
const numero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

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

// ── Soma (pura): página a página, sem guardar os perfis na memória ──

/** Totais parciais de uma geração. `cidades`: id → [total, nome, UF]. Vai para o progresso guardado como JSON. */
export interface Acumulado {
  perfis: number;
  semLocalizacao: number;
  ignorados: number;
  porEstado: Record<string, number>;
  cidades: Record<string, [number, string, string]>;
  /** Pessoas em cidades além de `CIDADES_ACUMULADAS_MAX` cidades diferentes. */
  outras: number;
  /** Quantas chaves há em `cidades` (evita contar a cada perfil). */
  nCidades: number;
}

export const novoAcumulado = (): Acumulado => ({ perfis: 0, semLocalizacao: 0, ignorados: 0, porEstado: {}, cidades: {}, outras: 0, nCidades: 0 });

/** Soma um perfil nos totais (muda `acc`). */
export const somarPerfil = (acc: Acumulado, d: Dados): void => {
  if (d.status === "suspended" || d.excluindoEm != null) {
    acc.ignorados++;
    return;
  }
  acc.perfis++;
  const loc = localizacaoDoPerfil(d);
  if (!loc) {
    acc.semLocalizacao++;
    return;
  }
  acc.porEstado[loc.uf] = (acc.porEstado[loc.uf] ?? 0) + 1;
  if (!loc.id) return; // sabe o estado, não a cidade: conta só no estado
  const atual = acc.cidades[loc.id];
  if (atual) {
    atual[0]++;
    if (!atual[1] && loc.cidade) atual[1] = loc.cidade;
  } else if (acc.nCidades < CIDADES_ACUMULADAS_MAX) {
    acc.cidades[loc.id] = [1, loc.cidade, loc.uf];
    acc.nCidades++;
  } else acc.outras++;
};

/** Fecha os totais no formato do mapa salvo. */
export const fecharMapa = (acc: Acumulado, agora: number, parcial: boolean): MapaUsuarios => {
  const ordenadas = Object.entries(acc.cidades)
    .map(([id, [total, cidade, uf]]) => ({ id, cidade, uf, total }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  return {
    geradoEm: agora,
    perfis: acc.perfis,
    comLocalizacao: acc.perfis - acc.semLocalizacao,
    semLocalizacao: acc.semLocalizacao,
    ignorados: acc.ignorados,
    porEstado: { ...acc.porEstado },
    cidades: ordenadas.slice(0, CIDADES_MAX),
    outrasCidades: ordenadas.slice(CIDADES_MAX).reduce((s, c) => s + c.total, 0) + acc.outras,
    parcial,
  };
};

/** Soma os perfis em totais por estado e por cidade. Pura: testada sem Firestore. */
export const agregar = (perfis: Iterable<Dados>, agora: number, parcial = false): MapaUsuarios => {
  const acc = novoAcumulado();
  for (const d of perfis) somarPerfil(acc, d);
  return fecharMapa(acc, agora, parcial);
};

/** Progresso guardado → totais (null se inválido: a geração recomeça). */
export const lerAcumulado = (json: unknown): Acumulado | null => {
  if (typeof json !== "string" || !json) return null;
  try {
    const a = JSON.parse(json) as Dados;
    if (typeof a !== "object" || a === null || typeof a.porEstado !== "object" || typeof a.cidades !== "object" || a.porEstado === null || a.cidades === null) return null;
    const porEstado: Record<string, number> = {};
    for (const [uf, n] of Object.entries(a.porEstado as Dados)) if (UF_SET.has(uf)) porEstado[uf] = numero(n);
    const cidades: Acumulado["cidades"] = {};
    for (const [id, v] of Object.entries(a.cidades as Dados)) {
      if (ID_CIDADE.test(id) && Array.isArray(v) && UF_SET.has(String(v[2]))) cidades[id] = [numero(v[0]), texto(v[1], 80), String(v[2])];
    }
    return { perfis: numero(a.perfis), semLocalizacao: numero(a.semLocalizacao), ignorados: numero(a.ignorados), porEstado, cidades, outras: numero(a.outras), nCidades: Object.keys(cidades).length };
  } catch {
    return null;
  }
};

// ── Geração (reserva compartilhada + retomada) ──

/** Recusas com status HTTP (a rota repassa a mensagem). */
export class RecusaMapa extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type ResultadoGeracao =
  /** Terminou e publicou (ou outra geração mais nova já tinha publicado: devolve o salvo). */
  | { tipo: "pronto"; mapa: MapaUsuarios }
  /** O mapa salvo é recente: nada foi lido. */
  | { tipo: "recente"; mapa: MapaUsuarios }
  /** Base grande: o progresso foi guardado; o próximo clique continua. `mapa` = o anterior (continua na tela). */
  | { tipo: "andamento"; lidos: number; mapa: MapaUsuarios | null };

interface OpcoesGeracao {
  /** Só é chamada quando uma geração NOVA vai começar (retomar não conta no limite). false = 429. */
  podeIniciar: () => Promise<boolean>;
  agora?: () => number;
  prazoMs?: number;
}

const geradoEmDe = (d: Dados | undefined): number => numero(d?.geradoEm);

let emAndamento: Promise<ResultadoGeracao> | null = null;

/** Gera (ou continua gerando) o mapa. Pedidos simultâneos nesta instância esperam a mesma chamada. */
export function gerarMapa(db: Firestore, adminUid: string, opcoes: OpcoesGeracao): Promise<ResultadoGeracao> {
  if (!emAndamento) {
    emAndamento = executarGeracao(db, adminUid, opcoes).finally(() => {
      emAndamento = null;
    });
  }
  return emAndamento;
}

async function executarGeracao(db: Firestore, adminUid: string, opcoes: OpcoesGeracao): Promise<ResultadoGeracao> {
  const agora = opcoes.agora ?? Date.now;
  const prazo = opcoes.prazoMs ?? PRAZO_MS;
  const inicio = agora();
  const id = `${inicio.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const refMapa = db.doc(DOC_MAPA);
  const refGeracao = db.doc(DOC_GERACAO);

  // 1) Reserva (transação): uma geração por vez na plataforma; mapa recente volta sem varrer.
  const reserva = await db.runTransaction(async (t) => {
    const [snapMapa, snapGeracao] = await t.getAll(refMapa, refGeracao);
    const g = (snapGeracao.exists ? snapGeracao.data() : undefined) as Dados | undefined;
    if (g && numero(g.reservaAte) > inicio) {
      throw new RecusaMapa(409, "Outro administrador está gerando o mapa agora. Aguarde um minuto e abra a tela de novo.");
    }
    const acc = g && numero(g.iniciadoEm) > inicio - RETOMAR_MS ? lerAcumulado(g.acumulado) : null;
    const retomar = acc !== null;
    const salvo = (snapMapa.exists ? snapMapa.data() : undefined) as Dados | undefined;
    if (!retomar && salvo && geradoEmDe(salvo) > inicio - RECENTE_MS) return { tipo: "recente" as const };
    t.set(refGeracao, {
      id,
      reservaPor: adminUid,
      reservaAte: inicio + RESERVA_MS,
      iniciadoEm: retomar ? numero(g?.iniciadoEm) : inicio,
      cursor: retomar ? texto(g?.cursor, 1500) : "",
      paginas: retomar ? numero(g?.paginas) : 0,
      acumulado: retomar ? g?.acumulado : JSON.stringify(novoAcumulado()),
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    return {
      tipo: "reservado" as const,
      retomar,
      acc: acc ?? novoAcumulado(),
      cursor: retomar ? texto(g?.cursor, 1500) : "",
      paginas: retomar ? numero(g?.paginas) : 0,
      iniciadoEm: retomar ? numero(g?.iniciadoEm) : inicio,
    };
  });

  if (reserva.tipo === "recente") {
    const mapa = await lerMapa(db);
    if (mapa) return { tipo: "recente", mapa };
    throw new RecusaMapa(503, "Não foi possível ler o mapa salvo. Tente de novo.");
  }

  // Geração nova conta no limite por administrador; se não puder, devolve a reserva.
  if (!reserva.retomar && !(await opcoes.podeIniciar())) {
    await liberar(db, id, null);
    throw new RecusaMapa(429, "O mapa já foi gerado 3 vezes na última hora. Tente de novo mais tarde (o último continua na tela).");
  }

  // 2) Varredura com prazo: soma cada página e guarda só o cursor da última página COMPLETA.
  const { acc } = reserva;
  let cursor = reserva.cursor;
  let paginas = reserva.paginas;
  let terminou = false;
  try {
    while (paginas < PAGINAS_MAX) {
      if (agora() - inicio > prazo) break;
      let q = db.collection("users").orderBy(FieldPath.documentId()).select("location.city", "location.state", "location.cityId", "status", "excluindoEm").limit(PAGINA);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      for (const doc of snap.docs) somarPerfil(acc, doc.data() as Dados);
      paginas++;
      if (snap.docs.length > 0) cursor = snap.docs[snap.docs.length - 1].id;
      if (snap.size < PAGINA) {
        terminou = true;
        break;
      }
    }
  } catch (erro) {
    // Checkpoint: o que já foi somado não se perde; a próxima tentativa continua deste cursor.
    await liberar(db, id, { cursor, paginas, acumulado: JSON.stringify(acc) }).catch(() => undefined);
    throw erro;
  }

  const parcial = !terminou && paginas >= PAGINAS_MAX;
  if (!terminou && !parcial) {
    // 3a) Prazo: guarda o progresso e devolve o mapa anterior.
    await liberar(db, id, { cursor, paginas, acumulado: JSON.stringify(acc) });
    console.log(JSON.stringify({ evt: "mapa_usuarios_parcial", lidos: acc.perfis + acc.ignorados, paginas }));
    return { tipo: "andamento", lidos: acc.perfis + acc.ignorados, mapa: await lerMapa(db) };
  }

  // 3b) Publicação protegida: só a dona da reserva publica, e nunca por cima de um mapa mais novo.
  const mapa = fecharMapa(acc, agora(), parcial);
  const publicou = await db.runTransaction(async (t) => {
    const [snapMapa, snapGeracao] = await t.getAll(refMapa, refGeracao);
    const g = (snapGeracao.exists ? snapGeracao.data() : undefined) as Dados | undefined;
    if (!g || g.id !== id) return false;
    const salvo = (snapMapa.exists ? snapMapa.data() : undefined) as Dados | undefined;
    t.delete(refGeracao);
    if (salvo && geradoEmDe(salvo) >= mapa.geradoEm) return false;
    t.set(refMapa, { ...mapa, iniciadoEm: reserva.iniciadoEm, geradoPor: adminUid, salvoEm: FieldValue.serverTimestamp() });
    return true;
  });
  console.log(JSON.stringify({ evt: publicou ? "mapa_usuarios_gerado" : "mapa_usuarios_descartado", perfis: mapa.perfis, cidades: mapa.cidades.length, parcial }));
  if (publicou) return { tipo: "pronto", mapa };
  const atual = await lerMapa(db);
  return { tipo: "pronto", mapa: atual ?? mapa };
}

/** Solta a reserva (se ainda for desta geração). Com `progresso`, guarda-o para a próxima chamada continuar. */
async function liberar(db: Firestore, id: string, progresso: { cursor: string; paginas: number; acumulado: string } | null): Promise<void> {
  const ref = db.doc(DOC_GERACAO);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists || (snap.data() as Dados).id !== id) return;
    if (progresso) t.update(ref, { ...progresso, reservaAte: 0, atualizadoEm: FieldValue.serverTimestamp() });
    else t.delete(ref);
  });
}

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
