import { FieldValue, type Firestore, Timestamp } from "firebase-admin/firestore";
import { campoDaTemporada, ehOrganizadorTemporario } from "./estatisticas";
import { isSafeUid } from "./validation";

/**
 * Envio da partida para a turma PELO SERVIDOR (`POST /api/turma-gestao`, action "partida").
 *
 * Antes o app gravava a partida e somava os números de cada membro direto no Firestore; as regras só conseguiam limitar o
 * tamanho de cada mudança (não têm laços para conferir a lista de jogadores). Um app modificado podia reenviar a mesma
 * partida somando gols de novo, dar gols a quem não jogou ou gravar uma lista que não bate com o placar.
 *
 * Aqui o servidor faz tudo numa transação:
 *  - valida a lista (só membros, um por pessoa, inteiros de 0 a 99) e DERIVA os totais dela;
 *  - compara com a versão já gravada da partida e aplica só a DIFERENÇA (reenviar o mesmo conteúdo = delta zero);
 *  - grava a partida, os números dos membros (geral e temporada), o resumo da turma e a pendência do recálculo do perfil.
 * Mesma conta do app (`sincronizarPartidaComTurma.ts`, `assinaturaPartida.ts`, `statsDelta.ts`, `prazoCorrecao.ts`).
 */

export const MAX_JOGADORES_PARTIDA = 100;
export const MAX_STAT_POR_PARTIDA = 99;
const NOME_MAX = 100;
const HORA_MS = 3_600_000;
const FUSO_BRASILIA_MS = -3 * HORA_MS;
const PRAZO_MINIMO_MS = 2 * HORA_MS;
const TETO_MS = 35 * HORA_MS;
const PARTIDA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIA_DO_JOGO = /^\d{4}-\d{2}-\d{2}$/;
const TEMPORADA = /^t\d{4}_[1-6]$/;
const CAMPOS_RESUMO = ["jogos", "gols", "assistencias"] as const;

export interface JogadorDoc {
  id: string;
  participanteId: string;
  nomeJogador: string;
  pago: boolean;
  gols_partida: number;
  assistencias: number;
  nivelHabilidade: number;
  vezesJogadas: number;
  timeJogando: number;
}

export interface PartidaEnviada {
  turmaId: string;
  partidaId: string;
  nome: string;
  data: string;
  jogadoresPorTime: number | string;
  metodoSorteio: string;
  gerado: boolean;
  modalidade: "futebol" | "futsal" | null;
  jogadores: JogadorDoc[];
}

export type Negado = { ok: false; status: 400 | 403 | 404 | 409; code: string; error: string };

type Dados = Record<string, unknown>;

const texto = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const inteiroEntre = (v: unknown, min: number, max: number, padrao: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : padrao;
const statValido = (v: unknown): boolean =>
  v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_STAT_POR_PARTIDA);
const numero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Corpo da requisição → partida validada (lista normalizada como o app grava), ou o motivo da recusa. */
export const parsePartidaEnviada = (body: Dados): { ok: true; value: PartidaEnviada } | Negado => {
  const recusa = (error: string): Negado => ({ ok: false, status: 400, code: "partida_invalida", error });
  if (!isSafeUid(body.turmaId)) return recusa("Turma inválida.");
  if (typeof body.partidaId !== "string" || !PARTIDA_ID.test(body.partidaId)) return recusa("Partida sem identificador válido.");
  const p = (typeof body.partida === "object" && body.partida !== null ? body.partida : {}) as Dados;
  if (!Array.isArray(body.jogadores) || body.jogadores.length > MAX_JOGADORES_PARTIDA * 2) return recusa("Lista de jogadores inválida.");

  const brutos = body.jogadores.filter((j): j is Dados => typeof j === "object" && j !== null);
  for (const j of brutos) {
    if (j.participanteId === undefined || j.participanteId === null || j.participanteId === "") continue;
    if (!isSafeUid(j.participanteId)) return recusa("Jogador com identificador inválido.");
    const nome = texto(j.nomeJogador, 80) || "jogador";
    if (!statValido(j.gols_partida)) return recusa(`Gols inválidos para ${nome}. Use números inteiros de 0 a ${MAX_STAT_POR_PARTIDA}.`);
    if (!statValido(j.assistencias)) return recusa(`Assistências inválidas para ${nome}. Use números inteiros de 0 a ${MAX_STAT_POR_PARTIDA}.`);
  }
  const jogadores = normalizarJogadores(brutos);
  if (jogadores.length === 0) return recusa("Nenhum jogador da turma nesta partida.");
  if (jogadores.length > MAX_JOGADORES_PARTIDA) return recusa(`A partida pode ter até ${MAX_JOGADORES_PARTIDA} jogadores da turma.`);
  // Somados, os números de quem aparece repetido também não passam do limite por jogador.
  if (jogadores.some((j) => j.gols_partida > MAX_STAT_POR_PARTIDA || j.assistencias > MAX_STAT_POR_PARTIDA)) {
    return recusa(`Cada jogador pode ter até ${MAX_STAT_POR_PARTIDA} gols e ${MAX_STAT_POR_PARTIDA} assistências por partida.`);
  }

  const jpt = p.jogadoresPorTime;
  const jogadoresPorTime =
    typeof jpt === "number" && Number.isInteger(jpt) && jpt >= 0 && jpt <= 50
      ? jpt
      : typeof jpt === "string" && /^\d{1,2}$/.test(jpt)
        ? jpt
        : 0;
  const data = texto(p.data, 40);
  return {
    ok: true,
    value: {
      turmaId: body.turmaId,
      partidaId: body.partidaId,
      nome: texto(p.nome, NOME_MAX),
      data: data && Number.isFinite(Date.parse(data)) ? data : "",
      jogadoresPorTime,
      metodoSorteio: texto(p.metodoSorteio, 40),
      gerado: p.gerado === true,
      modalidade: p.modalidade === "futsal" ? "futsal" : p.modalidade === "futebol" ? "futebol" : null,
      jogadores,
    },
  };
};

/** Só jogadores da turma (com `participanteId`), um por pessoa (repetidos somam), em ordem estável. Igual ao app. */
export const normalizarJogadores = (jogadores: Dados[]): JogadorDoc[] => {
  const porParticipante = new Map<string, JogadorDoc>();
  for (const j of jogadores) {
    const participanteId = j.participanteId;
    if (typeof participanteId !== "string" || !participanteId) continue;
    const existente = porParticipante.get(participanteId);
    if (existente) {
      existente.gols_partida += numero(j.gols_partida);
      existente.assistencias += numero(j.assistencias);
      continue;
    }
    porParticipante.set(participanteId, {
      id: texto(j.id, 128) || participanteId,
      participanteId,
      nomeJogador: texto(j.nomeJogador, 80),
      pago: j.pago === true,
      gols_partida: numero(j.gols_partida),
      assistencias: numero(j.assistencias),
      nivelHabilidade: typeof j.nivelHabilidade === "number" && Number.isFinite(j.nivelHabilidade) && j.nivelHabilidade >= 0 && j.nivelHabilidade <= 10 ? j.nivelHabilidade : 3,
      vezesJogadas: inteiroEntre(j.vezesJogadas, 0, 10_000, 0),
      timeJogando: inteiroEntre(j.timeJogando, 0, 100, 1),
    });
  }
  return [...porParticipante.values()].sort((a, b) => a.participanteId.localeCompare(b.participanteId));
};

/** Impressão digital do conteúdo (a mesma do app): reenvio sem mudança não grava nada. */
export const assinatura = (c: { nome: string; jogadoresPorTime: unknown; metodoSorteio: string; gerado: boolean; jogadores: JogadorDoc[] }): string =>
  JSON.stringify([
    c.nome, c.jogadoresPorTime, c.metodoSorteio, c.gerado,
    c.jogadores.map((j) => [j.participanteId, j.id, j.nomeJogador, j.pago, j.gols_partida, j.assistencias, j.nivelHabilidade, j.vezesJogadas, j.timeJogando]),
  ]);

export interface Delta {
  jogos: number;
  gols: number;
  assistencias: number;
}

const porParticipante = (jogadores: Array<{ participanteId?: unknown; gols_partida?: unknown; assistencias?: unknown }>) => {
  const totais = new Map<string, { gols: number; assistencias: number }>();
  for (const j of jogadores) {
    if (typeof j.participanteId !== "string" || !j.participanteId) continue;
    const atual = totais.get(j.participanteId) ?? { gols: 0, assistencias: 0 };
    // A versão gravada pode ser antiga ou ter vindo de um app modificado: números fora do formato contam como 0.
    atual.gols += inteiroEntre(j.gols_partida, 0, MAX_STAT_POR_PARTIDA, 0);
    atual.assistencias += inteiroEntre(j.assistencias, 0, MAX_STAT_POR_PARTIDA, 0);
    totais.set(j.participanteId, atual);
  }
  return totais;
};

/** Diferença por participante entre a versão gravada e a nova (só quem mudou). */
export const calcularDeltas = (anteriores: unknown[], atuais: JogadorDoc[]): Map<string, Delta> => {
  const antes = porParticipante(anteriores.filter((j): j is Dados => typeof j === "object" && j !== null));
  const agora = porParticipante(atuais);
  const deltas = new Map<string, Delta>();
  new Set([...antes.keys(), ...agora.keys()]).forEach((id) => {
    const a = antes.get(id);
    const b = agora.get(id);
    const d = { jogos: (b ? 1 : 0) - (a ? 1 : 0), gols: (b?.gols ?? 0) - (a?.gols ?? 0), assistencias: (b?.assistencias ?? 0) - (a?.assistencias ?? 0) };
    if (d.jogos || d.gols || d.assistencias) deltas.set(id, d);
  });
  return deltas;
};

const pad = (n: number) => String(n).padStart(2, "0");
export const diaDeBrasilia = (ms: number): string => {
  const b = new Date(ms + FUSO_BRASILIA_MS);
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
};
export const temporadaDoDia = (dia: string): string => `t${dia.slice(0, 4)}_${Math.floor((Number(dia.slice(5, 7)) - 1) / 2) + 1}`;

/** Até o meio-dia (Brasília) do dia seguinte ao jogo; no máximo 35 h depois do 1º envio. Igual ao app. */
export const calcularCorrigivelAte = (dataDoJogoMs: number, agora: number, salvadoEmMs?: number): number => {
  const base = Number.isFinite(dataDoJogoMs) ? dataDoJogoMs : agora;
  const dia = new Date(base + FUSO_BRASILIA_MS);
  const meioDiaSeguinte = Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate() + 1, 12) - FUSO_BRASILIA_MS;
  const teto = (salvadoEmMs ?? agora) + TETO_MS;
  return Math.min(meioDiaSeguinte > agora ? meioDiaSeguinte : agora + PRAZO_MINIMO_MS, teto);
};

const millis = (v: unknown): number | undefined => {
  const fn = (v as { toMillis?: unknown } | null)?.toMillis;
  return typeof fn === "function" ? (fn.call(v) as number) : undefined;
};

export type ResultadoEnvio =
  | { ok: true; atualizacao: boolean; alterado: boolean; participantesAlterados: string[]; corrigivelAte: number }
  | Negado;

/**
 * A transação do envio. Quem pode: o organizador ou o organizador temporário no prazo (`ehOrganizadorTemporario`).
 * Leituras: turma, partida, resumo, o participante de quem envia (temporário) e o de cada jogador antigo/novo.
 */
export const enviarPartida = async (db: Firestore, uid: string, p: PartidaEnviada, agora = Date.now()): Promise<ResultadoEnvio> => {
  const turmaRef = db.doc(`turmas/${p.turmaId}`);
  const partidaRef = db.doc(`turmas/${p.turmaId}/partidas/${p.partidaId}`);
  const resumoRef = db.doc(`turmas/${p.turmaId}/resumo/atual`);
  const participanteRef = (id: string) => db.doc(`turmas/${p.turmaId}/participantes/${id}`);

  return db.runTransaction(async (tx): Promise<ResultadoEnvio> => {
    const [turmaSnap, partidaSnap, resumoSnap] = await Promise.all([tx.get(turmaRef), tx.get(partidaRef), tx.get(resumoRef)]);
    if (!turmaSnap.exists) return { ok: false, status: 404, code: "turma_nao_encontrada", error: "Esta turma não existe mais." };
    const turma = (turmaSnap.data() ?? {}) as Dados;
    const armazenado = partidaSnap.exists ? ((partidaSnap.data() ?? {}) as Dados) : null;
    const anteriores = Array.isArray(armazenado?.jogadores) ? (armazenado.jogadores as unknown[]) : [];
    const deltas = calcularDeltas(anteriores, p.jogadores);

    const ids = [...new Set([...p.jogadores.map((j) => j.participanteId), ...deltas.keys(), ...(turma.creatorId === uid ? [] : [uid])])];
    const lidos = await Promise.all(ids.map((id) => tx.get(participanteRef(id))));
    const participantes = new Map(ids.map((id, i) => [id, lidos[i].exists ? ((lidos[i].data() ?? {}) as Dados) : null]));

    if (turma.creatorId !== uid && !ehOrganizadorTemporario(uid, turma, agora, participantes.get(uid) ?? null)) {
      return { ok: false, status: 403, code: "sem_permissao", error: "Só o organizador (ou o organizador temporário, no prazo) envia partidas desta turma." };
    }

    // Cada jogador da lista é um membro aprovado (ou já estava nesta partida antes: correção de quem saiu depois).
    const antesNaPartida = new Set(porParticipante(anteriores.filter((j): j is Dados => typeof j === "object" && j !== null)).keys());
    const fora = p.jogadores.find((j) => {
      const doc = participantes.get(j.participanteId);
      return !doc || (doc.status !== "aprovado" && !antesNaPartida.has(j.participanteId));
    });
    if (fora) {
      return { ok: false, status: 409, code: "jogador_fora", error: `${fora.nomeJogador || "Um jogador"} não é membro desta turma. Tire-o da lista e envie de novo.` };
    }

    const nome = p.nome || texto(armazenado?.nome, NOME_MAX) || `Partida ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(agora)}`;
    const data = p.data || texto(armazenado?.data, 40) || new Date(agora).toISOString();
    const conteudo = { nome, jogadoresPorTime: p.jogadoresPorTime, metodoSorteio: p.metodoSorteio, gerado: p.gerado, jogadores: p.jogadores };
    const mudouConteudo =
      !armazenado ||
      assinatura({
        nome: texto(armazenado.nome, NOME_MAX),
        jogadoresPorTime: armazenado.jogadoresPorTime ?? 0,
        metodoSorteio: texto(armazenado.metodoSorteio, 40),
        gerado: armazenado.gerado === true,
        jogadores: normalizarJogadores(anteriores.filter((j): j is Dados => typeof j === "object" && j !== null)),
      }) !== assinatura(conteudo);

    const salvadoEm = millis(armazenado?.salvadoEm);
    const prazoGravado = millis(armazenado?.corrigivelAte);
    const corrigivelAte = prazoGravado ?? calcularCorrigivelAte(Date.parse(data), agora, armazenado ? (salvadoEm ?? agora) : undefined);

    if (!mudouConteudo && deltas.size === 0) {
      return { ok: true, atualizacao: true, alterado: false, participantesAlterados: [], corrigivelAte };
    }
    if (armazenado && corrigivelAte <= agora) {
      return { ok: false, status: 409, code: "prazo_encerrado", error: "O prazo de correção desta partida terminou." };
    }

    const dados: Dados = {
      partidaId: p.partidaId,
      nome,
      data,
      turmaId: p.turmaId,
      jogadoresPorTime: p.jogadoresPorTime,
      metodoSorteio: p.metodoSorteio,
      gerado: p.gerado,
      totalJogadores: p.jogadores.length,
      // Totais DERIVADOS da lista: o placar nunca diverge dos números de cada jogador.
      totalGols: p.jogadores.reduce((s, j) => s + j.gols_partida, 0),
      totalAssistencias: p.jogadores.reduce((s, j) => s + j.assistencias, 0),
      atualizadoEm: FieldValue.serverTimestamp(),
      jogadores: p.jogadores,
      enviadaPor: uid,
    };

    const hoje = diaDeBrasilia(agora);
    const diaGravado = typeof armazenado?.diaDoJogo === "string" && DIA_DO_JOGO.test(armazenado.diaDoJogo) ? armazenado.diaDoJogo : null;
    const dataMs = Date.parse(data);
    const diaPelaData = Number.isFinite(dataMs) ? diaDeBrasilia(dataMs) : diaDeBrasilia(salvadoEm ?? agora);
    const diaDoJogo = diaGravado ?? (diaPelaData > hoje ? hoje : diaPelaData);
    if (!diaGravado) dados.diaDoJogo = diaDoJogo;

    const temporadaGravada = typeof armazenado?.temporada === "string" && TEMPORADA.test(armazenado.temporada) ? armazenado.temporada : null;
    const chaveTemporada =
      temporadaGravada ?? (armazenado ? campoDaTemporada(new Date(salvadoEm ?? agora)) : temporadaDoDia(diaDoJogo));
    if (!temporadaGravada) dados.temporada = chaveTemporada;
    if (typeof armazenado?.modalidade !== "string" && p.modalidade) dados.modalidade = p.modalidade;
    if (prazoGravado === undefined) dados.corrigivelAte = Timestamp.fromMillis(corrigivelAte);

    if (armazenado) tx.update(partidaRef, dados);
    else tx.set(partidaRef, { ...dados, salvadoEm: FieldValue.serverTimestamp() });

    // Números dos membros: só a diferença. Quem não existe mais (excluiu a conta) fica de fora.
    const membrosResumo = (resumoSnap.exists ? resumoSnap.get("membros") : null) as Dados | null;
    const resumoUpdate: Dados = {};
    const alterados: string[] = [];
    deltas.forEach((d, id) => {
      const atual = participantes.get(id);
      if (!atual) return;
      alterados.push(id);
      const update: Dados = { ultimaPartidaId: p.partidaId, atualizadoEm: FieldValue.serverTimestamp() };
      const temporada = `temporadas.${chaveTemporada}`;
      for (const campo of CAMPOS_RESUMO) {
        if (!d[campo]) continue;
        update[campo] = FieldValue.increment(d[campo]);
        update[`${temporada}.${campo}`] = FieldValue.increment(d[campo]);
      }
      if (d.jogos > 0) update.ultimoJogo = FieldValue.serverTimestamp();
      tx.update(participanteRef(id), update);
      // Resumo da turma com o valor final (lido nesta transação + diferença): nunca fica diferente dos participantes.
      const noResumo = membrosResumo?.[id];
      if (noResumo && typeof noResumo === "object") {
        for (const campo of CAMPOS_RESUMO) {
          if (d[campo]) resumoUpdate[`membros.${id}.${campo}`] = Math.max(0, numero(atual[campo]) + d[campo]);
        }
      }
    });
    if (Object.keys(resumoUpdate).length) tx.update(resumoRef, { ...resumoUpdate, atualizadoEm: FieldValue.serverTimestamp() });

    // Pendência durável do recálculo do perfil (o servidor processa logo depois; se falhar, a rotina tenta de novo).
    if (alterados.length) {
      tx.set(
        db.doc(`recalculosPendentes/${p.turmaId}`),
        { pendentes: Object.fromEntries(alterados.map((id) => [id, FieldValue.serverTimestamp()])), atualizadoEm: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    tx.update(turmaRef, { ultimaAtividade: FieldValue.serverTimestamp() });
    return { ok: true, atualizacao: Boolean(armazenado), alterado: true, participantesAlterados: alterados, corrigivelAte };
  });
};
