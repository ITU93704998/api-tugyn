import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import { motivoInvalido, validarCampeonato } from "./trofeus";
import { temResultado } from "./campeonato/classificacao";

/**
 * Partes dos cards do perfil que não vêm das turmas nem dos campeonatos entre times:
 *
 *  - Amistosos (card Times): os gols de cada jogador ficam no resumo do time (`times/{id}/resumo/geral.jogadores.{uid}`),
 *    marcados pelo dono. Amistoso não registra assistência nem quem jogou, então só os gols entram. Os times de que a
 *    pessoa saiu são achados pela lista `artilheirosIds` do resumo (gravada a cada marcação; os resumos antigos ganham a
 *    lista quando alguém do elenco abre o próprio card).
 *  - Campeonatos da turma (card Turmas): só os ENCERRADOS das turmas de que a pessoa participa hoje, conferidos com a
 *    mesma validação da galeria de troféus (um campeonato que não confere não soma nada).
 *
 * Quem chama: `estatisticasAtletaCT` (resultado guardado por 1 h em `estatisticasAtletasCT/{uid}`).
 */

const LIMITE_TIMES = 20;
/** Resumos em que a pessoa marcou gol (times atuais e antigos) lidos de uma vez. */
const LIMITE_RESUMOS = 40;
/** Resumo já conferido pela migração da lista de artilheiros. */
const VERSAO_ARTILHEIROS = 1;
/** Perfis conferidos por resumo em cada tentativa e no cálculo inteiro (a migração continua na próxima abertura). */
const LOTE_MIGRACAO = 50;
const ORCAMENTO_MIGRACAO = 100;
const LIMITE_TURMAS = 20;
const LIMITE_CAMPEONATOS_POR_TURMA = 15;
const UID = /^[A-Za-z0-9_-]{1,128}$/;

type Dados = Record<string, unknown>;
const obj = (v: unknown): Dados => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dados) : {});
const inteiro = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 100_000) : 0);
const texto = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export interface TimeDoAtleta {
  timeId: string;
  nome: string;
  sigla: string;
  cor: string | null;
  escudo: string | null;
  /** A pessoa está no elenco hoje (só esses podem ser o time do card). */
  atual: boolean;
}

/** Dados públicos do time para o card (os mesmos da tela pública do time). */
export const timeDoDocumento = (timeId: string, d: Dados, atual: boolean): TimeDoAtleta => ({
  timeId,
  nome: texto(d.nome, 60) || "Time",
  sigla: texto(d.sigla, 3).toUpperCase(),
  cor: /^#[0-9A-Fa-f]{6}$/.test(String(d.cor ?? "")) ? String(d.cor) : null,
  escudo: /^https:\/\//i.test(String(d.escudoUrl ?? "")) ? texto(d.escudoUrl, 500) : null,
  atual,
});

/**
 * Times atuais da pessoa e os gols dela nos amistosos de cada time (atuais e antigos). Devolve também os times que só
 * apareceram pelos amistosos (para o card mostrar escudo e nome) e `incompleto` quando alguma busca chegou ao limite.
 */
export async function amistososDoAtleta(db: Firestore, uid: string): Promise<{ times: Map<string, TimeDoAtleta>; gols: Map<string, number>; incompleto: boolean }> {
  const [atuais, comGols] = await Promise.all([
    db.collection("times").where("membros", "array-contains", uid).limit(LIMITE_TIMES).get(),
    // Inclui os resumos dos times atuais em que a pessoa já marcou: por isso o limite é maior que o de times.
    db.collectionGroup("resumo").where("artilheirosIds", "array-contains", uid).limit(LIMITE_RESUMOS).get(),
  ]);
  const incompleto = atuais.size >= LIMITE_TIMES || comGols.size >= LIMITE_RESUMOS;
  const times = new Map<string, TimeDoAtleta>();
  for (const t of atuais.docs) times.set(t.id, timeDoDocumento(t.id, t.data(), true));
  const gols = new Map<string, number>();
  const somar = (timeId: string, resumo: Dados | undefined) => {
    const n = inteiro(obj(obj(resumo?.jogadores)[uid]).gols);
    if (n) gols.set(timeId, n);
  };
  const resumoDoTime = new Map<string, DocumentSnapshot>();
  for (const r of comGols.docs) {
    const timeId = r.ref.parent.parent?.id ?? "";
    if (timeId && r.ref.id === "geral") resumoDoTime.set(timeId, r);
  }

  // Resumo dos times atuais: o que a busca acima já trouxe não é lido de novo. O resumo antigo (sem a lista de
  // artilheiros) ganha a lista uma vez, para os ex-jogadores desse time acharem os próprios gols depois.
  const idsAtuais = atuais.docs.map((t) => t.id);
  const resumos = await Promise.all(idsAtuais.map((id) => resumoDoTime.get(id) ?? db.doc(`times/${id}/resumo/geral`).get()));
  const migrar: DocumentReference[] = [];
  resumos.forEach((r, i) => {
    if (!r.exists) return;
    const d = r.data() ?? {};
    somar(idsAtuais[i], d);
    if (faltamNaLista(d).length) migrar.push(r.ref);
  });
  // Um resumo por vez, com teto de perfis lidos no cálculo inteiro (raro: só resumos antigos).
  let orcamento = ORCAMENTO_MIGRACAO;
  for (const ref of migrar) {
    if (orcamento <= 0) break;
    orcamento -= await completarArtilheiros(db, ref, Math.min(LOTE_MIGRACAO, orcamento));
  }

  // Times de que a pessoa saiu: os gols continuam no resumo; o nome e o escudo vêm do documento do time (apagado = fora).
  const exTimes = [...resumoDoTime].filter(([timeId]) => !times.has(timeId));
  const docs = await Promise.all(exTimes.map(([timeId]) => db.doc(`times/${timeId}`).get()));
  docs.forEach((t, i) => {
    if (!t.exists) return;
    const [timeId, r] = exTimes[i];
    times.set(timeId, timeDoDocumento(timeId, t.data() ?? {}, false));
    somar(timeId, r.data());
  });
  return { times, gols, incompleto };
}

/**
 * Contas com gol no resumo que a migração ainda não conferiu (em ordem, depois de `artilheirosAte`). Resumo concluído
 * (`artilheirosVersao`) não tem mais nada a conferir.
 */
const faltamNaLista = (d: Dados): string[] => {
  if (d.artilheirosVersao === VERSAO_ARTILHEIROS) return [];
  const jogadores = obj(d.jogadores);
  const lista = new Set(Array.isArray(d.artilheirosIds) ? (d.artilheirosIds as unknown[]).filter((u): u is string => typeof u === "string") : []);
  const ate = typeof d.artilheirosAte === "string" ? d.artilheirosAte : "";
  return Object.keys(jogadores).filter((u) => UID.test(u) && u > ate && !lista.has(u) && inteiro(obj(jogadores[u]).gols) > 0).sort();
};

/**
 * Migração do resumo antigo para a lista de artilheiros, em lotes: guarda até onde conferiu (`artilheirosAte`) e só marca
 * `artilheirosVersao` quando não falta ninguém. Só entram contas que existem e não estão sendo excluídas: a exclusão tira a
 * conta da lista e mantém os gols (com o nome) no histórico do time, e a migração não pode colocá-la de volta.
 * Tudo numa transação que lê os perfis: se a exclusão marcar o perfil (`excluindoEm`, gravado antes de tirar a conta da
 * lista) no meio, a transação é refeita e vê o marcador. Devolve quantos perfis leu.
 */
async function completarArtilheiros(db: Firestore, ref: DocumentReference, lote: number): Promise<number> {
  try {
    return await db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists) return 0;
      const todos = faltamNaLista(r.data() ?? {});
      if (!todos.length) return 0;
      const vez = todos.slice(0, lote);
      const perfis = await tx.getAll(...vez.map((u) => db.doc(`users/${u}`)));
      const ativos = vez.filter((_, i) => perfis[i].exists && !perfis[i].get("excluindoEm"));
      const concluiu = vez.length === todos.length;
      tx.update(ref, {
        ...(ativos.length ? { artilheirosIds: FieldValue.arrayUnion(...ativos) } : {}),
        ...(concluiu ? { artilheirosVersao: VERSAO_ARTILHEIROS, artilheirosAte: FieldValue.delete() } : { artilheirosAte: vez[vez.length - 1] }),
      });
      return vez.length;
    });
  } catch {
    // Sem a migração, só os gols em ex-times desse resumo ficam de fora até a próxima tentativa.
    return lote;
  }
}

export interface NumerosCampeonatosTurma { campeonatos: number; gols: number; assistencias: number; jogos: number }

/** Soma da pessoa nos campeonatos ENCERRADOS das turmas de que ela participa hoje (só os que passam na validação). */
export async function campeonatosTurmaDoAtleta(db: Firestore, uid: string): Promise<NumerosCampeonatosTurma & { incompleto: boolean }> {
  const total = { campeonatos: 0, gols: 0, assistencias: 0, jogos: 0 };
  const turmas = await db.collection("turmas").where("participantes", "array-contains", uid).limit(LIMITE_TURMAS).get();
  let incompleto = turmas.size >= LIMITE_TURMAS;
  await Promise.all(turmas.docs.map(async (turma) => {
    if (turma.get("encerradaPor") === "moderacao") return;
    const camps = await turma.ref.collection("campeonatos").where("status", "==", "encerrado").limit(LIMITE_CAMPEONATOS_POR_TURMA).get();
    if (camps.size >= LIMITE_CAMPEONATOS_POR_TURMA) incompleto = true;
    for (const c of camps.docs) {
      const d = c.data();
      if (motivoInvalido(c.id, d)) continue;
      const camp = validarCampeonato(c.id, d);
      const meuTime = Object.entries(camp.times).find(([, t]) => t.elenco.some((j) => j.id === uid))?.[0];
      if (!meuTime) continue;
      total.campeonatos++;
      for (const j of Object.values(camp.jogos)) {
        if (!temResultado(j) || (j.casa !== meuTime && j.fora !== meuTime)) continue;
        total.jogos++;
        total.gols += inteiro(j.gols[uid]);
        total.assistencias += inteiro(j.assistencias[uid]);
      }
    }
  }));
  return { ...total, incompleto };
}
