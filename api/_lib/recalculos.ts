import { FieldValue, type Firestore, type Timestamp } from "firebase-admin/firestore";
import { somarEstatisticas } from "./estatisticas";
import { isSafeUid } from "./validation";

/**
 * Recálculo do resumo geral do perfil (`users/{uid}.estatisticas`) com pendência DURÁVEL.
 *
 * O app grava `recalculosPendentes/{turmaId}.pendentes.{uid} = hora do servidor` NA MESMA TRANSAÇÃO da partida (as regras
 * deixam só o organizador). Se o app fechar, a rede cair ou o servidor falhar, a pendência fica lá e uma rotina do servidor
 * a processa depois. O recálculo é idempotente (refaz a soma do zero), então repetir é seguro.
 *
 * A pendência de um jogador só é apagada se continua com a MESMA hora que foi lida antes do recálculo: se outra partida
 * marcou o jogador de novo no meio do caminho, a nova marca fica para a próxima rodada.
 */

export const PENDENCIAS = "recalculosPendentes";
/** Quantos jogadores são recalculados ao mesmo tempo (cada um = 1 consulta + 1 leitura por turma + 1 escrita). */
const RECALCULOS_SIMULTANEOS = 8;

/**
 * Refaz o resumo geral de um usuário a partir das turmas em que ele está hoje (o mesmo que o próprio perfil soma) e grava em
 * `users/{uid}.estatisticas`. Conta não encontrada (excluída) é ignorada: não cria documento.
 */
export const recalcularUsuario = async (db: Firestore, uid: string): Promise<void> => {
  const turmas = await db
    .collection("turmas")
    .where("participantes", "array-contains", uid)
    .select("status", "ativo")
    .get();
  const participantes = turmas.empty
    ? []
    : await db.getAll(...turmas.docs.map((t) => db.doc(`turmas/${t.id}/participantes/${uid}`)));
  const total = somarEstatisticas(
    turmas.docs.map((t) => t.data()),
    participantes.map((p) => (p.exists ? p.data() : null)),
  );
  try {
    await db.doc(`users/${uid}`).update({ estatisticas: { ...total, atualizadoEm: FieldValue.serverTimestamp() } });
  } catch (erro) {
    if ((erro as { code?: unknown })?.code === 5) return; // NOT_FOUND: conta excluída
    throw erro;
  }
};

/** Recalcula vários, alguns por vez. Falha de um não impede os outros; devolve QUEM falhou (para tentar de novo). */
export const recalcularVarios = async (
  db: Firestore,
  uids: string[],
  recalcular: typeof recalcularUsuario = recalcularUsuario,
): Promise<string[]> => {
  const falhos: string[] = [];
  for (let i = 0; i < uids.length; i += RECALCULOS_SIMULTANEOS) {
    const lote = uids.slice(i, i + RECALCULOS_SIMULTANEOS);
    const resultados = await Promise.allSettled(lote.map((uid) => recalcular(db, uid)));
    resultados.forEach((r, j) => {
      if (r.status === "rejected") falhos.push(lote[j]);
    });
  }
  return falhos;
};

const millis = (valor: unknown): number | null => {
  const ms = (valor as Timestamp | undefined)?.toMillis?.();
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
};

/**
 * Apaga as pendências que já foram atendidas. `lidas`: uid → hora da marca lida ANTES do recálculo. Só apaga quem continua
 * com a mesma marca; o documento some quando fica vazio.
 */
const limparAtendidas = async (db: Firestore, turmaId: string, lidas: Map<string, number>): Promise<void> => {
  if (!lidas.size) return;
  const ref = db.doc(`${PENDENCIAS}/${turmaId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const pendentes = (snap.get("pendentes") ?? {}) as Record<string, unknown>;
    const apagar = [...lidas].filter(([uid, ms]) => millis(pendentes[uid]) === ms).map(([uid]) => uid);
    if (!apagar.length) return;
    if (apagar.length === Object.keys(pendentes).length) tx.delete(ref);
    else tx.update(ref, Object.fromEntries(apagar.map((uid) => [`pendentes.${uid}`, FieldValue.delete()])));
  });
};

/** Lê as marcas atuais de uma turma (só uids seguros). */
const marcasDe = (dados: Record<string, unknown> | undefined): Map<string, number> => {
  const pendentes = (dados?.pendentes ?? {}) as Record<string, unknown>;
  const marcas = new Map<string, number>();
  for (const [uid, valor] of Object.entries(pendentes)) {
    const ms = millis(valor);
    if (isSafeUid(uid) && ms !== null) marcas.set(uid, ms);
  }
  return marcas;
};

/**
 * Pedido do app logo depois do envio (rota `turma-gestao`, ação `estatisticas`): recalcula os jogadores pedidos que são
 * membros e limpa as pendências deles. Devolve quem falhou (continua pendente para a rotina).
 */
export const recalcularDaPartida = async (
  db: Firestore,
  turmaId: string,
  jogadores: string[],
  recalcular: typeof recalcularUsuario = recalcularUsuario,
): Promise<string[]> => {
  const antes = await db.doc(`${PENDENCIAS}/${turmaId}`).get();
  const marcas = marcasDe(antes.exists ? antes.data() : undefined);
  const falhos = await recalcularVarios(db, jogadores, recalcular);
  const atendidas = new Map([...marcas].filter(([uid]) => jogadores.includes(uid) && !falhos.includes(uid)));
  await limparAtendidas(db, turmaId, atendidas);
  return falhos;
};

export interface ResultadoPendencias {
  turmas: number;
  recalculados: number;
  falhas: number;
  /** Idade da pendência mais antiga atendida/encontrada (ms): é a métrica de atraso. */
  atrasoMaximoMs: number;
  /** Jogadores ignorados por não serem mais membros da turma. */
  ignorados: number;
}

/**
 * Rotina do servidor: processa as turmas com pendência mais antigas primeiro (até `limite`). Só recalcula quem ainda é
 * membro da turma (o resto é limpo sem recálculo). Uma falha de um jogador deixa só ele pendente.
 */
export const processarPendencias = async (
  db: Firestore,
  opcoes: { limite?: number; agora?: () => number; recalcular?: typeof recalcularUsuario; prazoMs?: number } = {},
): Promise<ResultadoPendencias> => {
  const agora = opcoes.agora ?? Date.now;
  const limite = Math.min(Math.max(opcoes.limite ?? 20, 1), 50);
  const fim = Date.now() + (opcoes.prazoMs ?? 20_000);
  const snap = await db.collection(PENDENCIAS).orderBy("atualizadoEm").limit(limite).get();
  const resultado: ResultadoPendencias = { turmas: snap.size, recalculados: 0, falhas: 0, atrasoMaximoMs: 0, ignorados: 0 };
  for (const doc of snap.docs) {
    if (Date.now() >= fim) break;
    try {
      const marcas = marcasDe(doc.data());
      for (const ms of marcas.values()) resultado.atrasoMaximoMs = Math.max(resultado.atrasoMaximoMs, agora() - ms);
      const turma = await db.doc(`turmas/${doc.id}`).get();
      const membros = new Set(turma.exists && Array.isArray(turma.get("participantes")) ? (turma.get("participantes") as unknown[]) : []);
      const alvo = [...marcas.keys()].filter((uid) => membros.has(uid));
      resultado.ignorados += marcas.size - alvo.length;
      const falhos = await recalcularVarios(db, alvo, opcoes.recalcular);
      resultado.recalculados += alvo.length - falhos.length;
      resultado.falhas += falhos.length;
      // Quem não é mais membro também sai da fila (o próprio perfil dele recalcula ao abrir).
      // Documento sem nenhuma marca válida não pode ficar na frente da fila para sempre.
      if (marcas.size === 0) await doc.ref.delete();
      else await limparAtendidas(db, doc.id, new Map([...marcas].filter(([uid]) => !falhos.includes(uid))));
    } catch {
      resultado.falhas++;
    }
  }
  if (snap.size) console.log(JSON.stringify({ evt: "estatisticas_pendencias", ...resultado }));
  // Atraso acima de 1 dia: a rotina não está dando conta (ou o recálculo está falhando sempre).
  if (resultado.atrasoMaximoMs > 24 * 3600_000) console.warn(JSON.stringify({ evt: "estatisticas_pendencias_atrasadas", atrasoMaximoMs: resultado.atrasoMaximoMs }));
  return resultado;
};
