import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { jogaModalidade, modalidadePrincipal, modalidadesDoTime } from "./modalidadesTime";

/**
 * "Explorar adversários": times da mesma cidade (ou do mesmo estado) do time de quem pergunta, para marcar amistoso sem
 * precisar da chave. Pela rota `POST /api/desafios` (ações `time_explorar` e `time_vitrine`, ver `amistosos.ts`).
 *  - Só quem é do elenco do time de referência pergunta; a cidade usada é a DO TIME (nunca uma cidade qualquer).
 *  - Vai só o que a página pública do time já mostra (nome, sigla, cores, escudo, modalidade, gênero, faixa, cidade, quantos
 *    jogadores e a chave): nada de elenco, uid ou @usuário.
 *  - O dono pode tirar o time da lista (`ocultoNaBusca`, gravado só pelo servidor). Os times de quem pergunta não aparecem.
 *  - Modalidade: o time entra se joga ela (qualquer uma das dele, não só a principal), conferida depois da leitura (times
 *    antigos não têm a lista de modalidades), então uma página pode ler mais de um lote até encher.
 *  - Busca pelo nome, sem acento: cada palavra digitada é o começo de uma palavra do nome ("uni" acha "Real Unidos").
 *    A consulta usa `nomeBusca` (os começos de cada palavra do nome, de 2 a 12 letras), gravado SÓ pelo servidor: o app
 *    não grava esse campo (as regras não o aceitam), então ninguém enche a lista para aparecer em buscas alheias. O app
 *    pede `time_indexar` depois de criar ou renomear o time; times antigos ganham o campo quando alguma listagem os lê
 *    (e pelo script `scripts/indexar-nomes-times.cjs`).
 */

export const MODALIDADES = ["campo", "society", "futsal"] as const;
export const GENEROS = ["masculino", "feminino", "misto"] as const;
export type Regiao = "cidade" | "estado";
export const LIMITE_MAX = 20;
/** Lidos a mais por lote: os ocultos, os do próprio usuário, o time de referência e os de outra modalidade saem depois. */
const FOLGA_LEITURA = 10;
/** Lotes por página no máximo (sem filtro que corte muito, o 1º já enche). */
const MAX_LOTES = 4;
export const BUSCA_MAX = 40;
const TIME_ID = /^[A-Za-z0-9_-]{1,128}_[12]$/;

export interface PedidoExplorar {
  action: "time_explorar";
  timeId: string;
  regiao: Regiao;
  modalidade: (typeof MODALIDADES)[number] | "";
  genero: (typeof GENEROS)[number] | "";
  limite: number;
  cursor: string;
  /** Parte do nome ("" = todos). */
  busca: string;
}
export interface PedidoIndexar {
  action: "time_indexar";
  timeId: string;
}
export interface PedidoVitrine {
  action: "time_vitrine";
  timeId: string;
  visivel: boolean;
}

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

export const parseExplorar = (b: Record<string, unknown>): Parse<PedidoExplorar> => {
  if (typeof b.timeId !== "string" || !TIME_ID.test(b.timeId)) return { ok: false, error: "Time inválido." };
  const regiao = b.regiao === undefined ? "cidade" : b.regiao;
  if (regiao !== "cidade" && regiao !== "estado") return { ok: false, error: "Região inválida." };
  const modalidade = b.modalidade ?? "";
  if (modalidade !== "" && !(MODALIDADES as readonly unknown[]).includes(modalidade)) return { ok: false, error: "Modalidade inválida." };
  const genero = b.genero ?? "";
  if (genero !== "" && !(GENEROS as readonly unknown[]).includes(genero)) return { ok: false, error: "Gênero inválido." };
  const limite = b.limite === undefined ? LIMITE_MAX : b.limite;
  if (!Number.isInteger(limite) || (limite as number) < 1 || (limite as number) > LIMITE_MAX) return { ok: false, error: "Limite inválido." };
  const cursor = b.cursor ?? "";
  if (cursor !== "" && (typeof cursor !== "string" || !TIME_ID.test(cursor))) return { ok: false, error: "Página inválida." };
  const busca = b.busca ?? "";
  if (typeof busca !== "string" || busca.length > BUSCA_MAX) return { ok: false, error: "Busca inválida." };
  return { ok: true, value: { action: "time_explorar", timeId: b.timeId, regiao, modalidade: modalidade as PedidoExplorar["modalidade"], genero: genero as PedidoExplorar["genero"], limite: limite as number, cursor: cursor as string, busca: normalizarTexto(busca) } };
};

export const parseIndexar = (b: Record<string, unknown>): Parse<PedidoIndexar> =>
  typeof b.timeId === "string" && TIME_ID.test(b.timeId) ? { ok: true, value: { action: "time_indexar", timeId: b.timeId } } : { ok: false, error: "Time inválido." };

export const parseVitrine = (b: Record<string, unknown>): Parse<PedidoVitrine> => {
  if (typeof b.timeId !== "string" || !TIME_ID.test(b.timeId)) return { ok: false, error: "Time inválido." };
  if (typeof b.visivel !== "boolean") return { ok: false, error: "Escolha inválida." };
  return { ok: true, value: { action: "time_vitrine", timeId: b.timeId, visivel: b.visivel } };
};

type Doc = Record<string, unknown>;
const texto = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
/** Sem acento, minúsculas, espaços juntados (igual à busca do app). */
export const normalizarTexto = (v: string): string =>
  v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const PREFIXO_MIN = 2;
const PREFIXO_MAX = 12;
const MAX_PALAVRAS_BUSCA = 60;
const palavras = (v: string): string[] => normalizarTexto(v).split(/[^a-z0-9]+/).filter(Boolean);
/** `nomeBusca`: os começos (2 a 12 letras) de cada palavra do nome, sem repetir. "Real Unidos" → re, rea, real, un, uni… */
export const palavrasDoNome = (nome: string): string[] => {
  const saida = new Set<string>();
  for (const p of palavras(nome)) for (let n = PREFIXO_MIN; n <= Math.min(p.length, PREFIXO_MAX); n++) saida.add(p.slice(0, n));
  return [...saida].slice(0, MAX_PALAVRAS_BUSCA);
};
/** Palavras da busca que dá para procurar no índice (pelo menos 2 letras). */
const termosDaBusca = (busca: string): string[] => palavras(busca).filter((p) => p.length >= PREFIXO_MIN);
/** O que vai para a consulta: a palavra mais longa da busca (corta menos), até 12 letras. "" = busca sem termo indexável. */
export const termoIndexado = (busca: string): string =>
  [...termosDaBusca(busca)].sort((a, b) => b.length - a.length)[0]?.slice(0, PREFIXO_MAX) ?? "";
/** Cada palavra da busca começa alguma palavra do nome. Sem termo indexável (ex.: "a b"), vale parte do nome. */
export const nomeCasaComBusca = (nome: string, busca: string): boolean => {
  if (!busca) return true;
  const termos = termosDaBusca(busca);
  if (!termos.length) return normalizarTexto(nome).includes(normalizarTexto(busca));
  const doNome = palavras(nome);
  return termos.every((t) => doNome.some((w) => w.startsWith(t)));
};
const nomeBuscaEmDia = (d: Doc): boolean => {
  const certo = palavrasDoNome(texto(d.nome, 40));
  const atual = d.nomeBusca;
  return Array.isArray(atual) && atual.length === certo.length && certo.every((p, i) => atual[i] === p);
};

/** Cidade do time como filtro: pelo id da cidade quando existe; times antigos, pelo nome + estado. */
export const filtrosDaRegiao = (cidade: unknown, regiao: Regiao): [string, string][] | null => {
  const c = cidade && typeof cidade === "object" ? (cidade as Doc) : null;
  const city = texto(c?.city, 100), state = texto(c?.state, 40), cityId = texto(c?.cityId, 60);
  if (regiao === "estado") return state ? [["cidade.state", state]] : null;
  if (cityId) return [["cidade.cityId", cityId]];
  return city && state ? [["cidade.city", city], ["cidade.state", state]] : null;
};

/** Fica fora: o time de referência, os times em que quem pergunta está, os ocultos pelo dono. */
export const entraNaLista = (id: string, d: Doc, uid: string, referenciaId: string): boolean =>
  id !== referenciaId && d.ocultoNaBusca !== true && !(Array.isArray(d.membros) && d.membros.includes(uid));

/** Modalidade (qualquer uma do time) e nome (o índice traz candidatos; aqui confere com o nome atual). */
export const passaNosFiltros = (d: Doc, modalidade: string, busca: string): boolean =>
  (!modalidade || jogaModalidade(d, modalidade)) && nomeCasaComBusca(texto(d.nome, 40), busca);

export const timeDaVitrine = (id: string, d: Doc, chave: string) => {
  const cidade = d.cidade as Doc | undefined;
  return {
    timeId: id,
    nome: texto(d.nome, 40),
    sigla: texto(d.sigla, 3),
    cor: texto(d.cor, 7),
    corSecundaria: texto(d.corSecundaria, 7),
    escudoUrl: texto(d.escudoUrl, 500),
    modalidade: modalidadePrincipal(d),
    modalidades: modalidadesDoTime(d),
    genero: texto(d.genero, 10),
    faixaEtaria: texto(d.faixaEtaria, 10),
    cidade: cidade?.city ? { city: texto(cidade.city, 100), state: texto(cidade.state, 40) } : null,
    jogadores: Array.isArray(d.membros) ? d.membros.length : 0,
    chave,
  };
};

type Negado = { ok: false; status: number; code: string; error: string };
type Resultado = { ok: true; body?: Record<string, unknown> } | Negado;
const negar = (status: number, code: string, error: string): Negado => ({ ok: false, status, code, error });

/**
 * `garantirChave`: a chave de um time que ainda não tem (o mesmo que acontece quando alguém abre o link público dele).
 * Paginação pelo id do documento (o cursor é o último lido, não o último mostrado).
 */
export const explorarTimes = async (
  db: Firestore,
  uid: string,
  p: PedidoExplorar,
  garantirChave: (timeId: string) => Promise<string | null>,
): Promise<Resultado> => {
  const meu = await db.doc(`times/${p.timeId}`).get();
  if (!meu.exists) return negar(404, "nao-encontrado", "Este time não existe mais.");
  const membros = meu.get("membros");
  if (!Array.isArray(membros) || !membros.includes(uid)) return negar(403, "nao-membro", "Só quem é do time procura adversários por ele.");
  const filtros = filtrosDaRegiao(meu.get("cidade"), p.regiao);
  if (!filtros) return negar(409, "sem-cidade", "Este time não tem cidade cadastrada. Busque adversários pela chave.");

  let base = db.collection("times") as FirebaseFirestore.Query;
  for (const [campo, valor] of filtros) base = base.where(campo, "==", valor);
  if (p.genero) base = base.where("genero", "==", p.genero);
  // Com busca: só os times que têm uma palavra começando pelo termo (índice composto em firestore.indexes.json).
  const termo = p.busca ? termoIndexado(p.busca) : "";
  if (termo) base = base.where("nomeBusca", "array-contains", termo);
  base = base.orderBy(FieldPath.documentId());

  const tamanho = p.limite + FOLGA_LEITURA;
  const times: ReturnType<typeof timeDaVitrine>[] = [];
  let ultimoLido = p.cursor;
  let acabou = false;
  // Times lidos com `nomeBusca` ausente ou desatualizado (time antigo, ou renomeado por uma versão antiga do app).
  // `lido`: a versão lida. A gravação só vale se o time não mudou desde então (um nome trocado no meio não é sobrescrito
  // pelas palavras do nome antigo).
  const reindexar: { id: string; nomeBusca: string[]; lido: FirebaseFirestore.Timestamp | undefined }[] = [];
  for (let lote = 0; lote < MAX_LOTES && times.length < p.limite && !acabou; lote++) {
    const consulta = ultimoLido ? base.startAfter(ultimoLido) : base;
    const docs = (await consulta.limit(tamanho).get()).docs;
    let parouNoMeio = false;
    for (const doc of docs) {
      if (times.length >= p.limite) { parouNoMeio = true; break; }
      ultimoLido = doc.id;
      const d = doc.data();
      if (!nomeBuscaEmDia(d)) reindexar.push({ id: doc.id, nomeBusca: palavrasDoNome(texto(d.nome, 40)), lido: doc.updateTime });
      if (!entraNaLista(doc.id, d, uid, p.timeId) || !passaNosFiltros(d, p.modalidade, p.busca)) continue;
      const chave = texto(d.chave, 6) || (await garantirChave(doc.id));
      if (!chave) continue;
      times.push(timeDaVitrine(doc.id, d, chave));
    }
    if (docs.length < tamanho && !parouNoMeio) acabou = true;
  }
  // Conserto de passagem (falha não atrapalha a resposta): na próxima busca, o índice já acha esses times.
  if (reindexar.length) {
    await Promise.allSettled(
      reindexar.filter((r) => r.lido !== undefined).map((r) => db.doc(`times/${r.id}`).update({ nomeBusca: r.nomeBusca }, { lastUpdateTime: r.lido as FirebaseFirestore.Timestamp })),
    );
  }
  return { ok: true, body: { times, proximoCursor: acabou || !ultimoLido ? null : ultimoLido } };
};

/**
 * Depois de criar ou renomear o time, o app pede para atualizar `nomeBusca` (só quem é do elenco; o servidor calcula a
 * partir do nome gravado, o app não manda as palavras). Sem mudança, não grava nada. Em transação: se o nome mudar entre
 * a leitura e a gravação (outra renomeação, outro pedido), ela é refeita com o nome novo, e um pedido atrasado nunca
 * grava as palavras de um nome antigo.
 */
export const indexarNome = async (db: Firestore, uid: string, p: PedidoIndexar): Promise<Resultado> => {
  const ref = db.doc(`times/${p.timeId}`);
  return db.runTransaction(async (tx): Promise<Resultado> => {
    const time = await tx.get(ref);
    if (!time.exists) return negar(404, "nao-encontrado", "Este time não existe mais.");
    const membros = time.get("membros");
    if (!Array.isArray(membros) || !membros.includes(uid)) return negar(403, "nao-membro", "Só quem é do time atualiza isso.");
    const d = { nome: time.get("nome"), nomeBusca: time.get("nomeBusca") };
    if (nomeBuscaEmDia(d)) return { ok: true, body: { atualizado: false } };
    tx.update(ref, { nomeBusca: palavrasDoNome(texto(d.nome, 40)) });
    return { ok: true, body: { atualizado: true } };
  });
};

/** O dono escolhe se o time aparece em "Explorar adversários" (gravado só aqui: o app não grava esse campo). */
export const definirVitrine = async (db: Firestore, uid: string, p: PedidoVitrine): Promise<Resultado> => {
  const ref = db.doc(`times/${p.timeId}`);
  const time = await ref.get();
  if (!time.exists) return negar(404, "nao-encontrado", "Este time não existe mais.");
  if (time.get("donoId") !== uid) return negar(403, "nao-dono", "Só o dono muda isso.");
  await ref.update({ ocultoNaBusca: !p.visivel });
  return { ok: true, body: { visivel: p.visivel } };
};
