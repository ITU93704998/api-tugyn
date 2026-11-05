import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isSafeUid } from "./validation";

/**
 * Notificações push (pedido de entrada na turma e aceite). Este arquivo reúne a parte PURA: validar o que o app manda, decidir quem pode
 * disparar cada aviso e quem recebe (sempre pelo que está no Firestore, nunca pelo que o app diz), montar a mensagem e falar com o serviço
 * de push da Expo. Nada aqui lê o Firestore: quem lê é a rota (`api/push.ts`).
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_CHUNK_SIZE = 100;
export const EXPO_TIMEOUT_MS = 8000;
/** Conexões simultâneas com o Expo (o SDK oficial usa até 6): um envio grande não abre dezenas de chamadas de uma vez. */
export const EXPO_CONEXOES_MAX = 6;

/** Roda `fn` em cada item com no máximo `limite` ao mesmo tempo; o resultado sai na ordem dos itens. */
export const emParalelo = async <T, R>(itens: readonly T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const saida: R[] = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limite, 1), itens.length) }, trabalhador));
  return saida;
};
export const MAX_TOKENS_PER_USER = 5;
/** O mesmo aviso (mesmo evento, turma e pessoa) não se repete dentro deste tempo. */
export const DEDUPE_MS = 10 * 60_000;
/**
 * Avisos de time: a chave inclui a ocorrência (data da convocação, do pedido ou da entrada), então a MESMA ocorrência nunca é avisada
 * duas vezes nesta janela (o app reenvia o que ficou pendente por até 24 h), e uma ocorrência nova tem chave nova.
 */
export const DEDUPE_TIME_MS = 7 * 24 * 3600_000;
/** Os registros de "já avisei" duram isto (dá para ligar a política de expiração do Firestore no campo `expiresAt`). */
export const DEDUPE_TTL_MS = 30 * 24 * 3600_000;
/** Canal do Android que o app cria (precisa ser o mesmo nome). */
export const ANDROID_CHANNEL_ID = "avisos-turma";

const TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,100}\]$/;
export const PLATFORMS = ["ios", "android"] as const;
export type PushPlatform = (typeof PLATFORMS)[number];

export const isValidPushToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);

/** Id do documento do token: o próprio token embaralhado (o token em si nunca vai para o caminho nem para o log). */
export const tokenDocId = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 40);

/**
 * Chave de revogação: o servidor a gera no cadastro do aparelho e só guarda o hash. Com ela o app tira o aparelho do servidor depois do
 * logout feito sem internet (não há mais login para autenticar). Um novo cadastro troca a chave, então um pedido velho não apaga o novo dono.
 */
const REVOGACAO = /^[a-f0-9]{64}$/;
export const isValidRevogacao = (value: unknown): value is string => typeof value === "string" && REVOGACAO.test(value);
export const novaRevogacao = (): { revogacao: string; revogacaoHash: string } => {
  const revogacao = randomBytes(32).toString("hex");
  return { revogacao, revogacaoHash: hashRevogacao(revogacao) };
};
export const hashRevogacao = (revogacao: string): string => createHash("sha256").update(revogacao).digest("hex");
/** Compara em tempo constante a chave recebida com o hash guardado. */
export const revogacaoConfere = (revogacao: string, hashGuardado: unknown): boolean => {
  if (typeof hashGuardado !== "string" || !REVOGACAO.test(hashGuardado)) return false;
  return timingSafeEqual(new Uint8Array(Buffer.from(hashRevogacao(revogacao), "hex")), new Uint8Array(Buffer.from(hashGuardado, "hex")));
};
/** Token não renovado há mais que isso não recebe avisos (o app renova a cada 7 dias de uso): limita um cadastro esquecido. */
export const TOKEN_LEASE_MS = 30 * 24 * 3600_000;
/** O documento do token some sozinho (política de TTL em `expiresAt`) bem depois do lease. */
export const TOKEN_TTL_MS = 60 * 24 * 3600_000;
export const tokenNoPrazo = (updatedAt: unknown, nowMs: number): boolean => typeof updatedAt !== "number" || nowMs - updatedAt < TOKEN_LEASE_MS;

export type PushRequest =
  | { action: "registrar"; token: string; platform: PushPlatform }
  | { action: "remover"; token: string }
  | { action: "revogar"; token: string; revogacao: string }
  | { action: "notificar"; evento: "pedido_entrada"; turmaId: string }
  | { action: "notificar"; evento: "pedido_aceito"; turmaId: string; userId: string }
  | { action: "notificar"; evento: "partida_aberta"; turmaId: string }
  | { action: "notificar"; evento: "presenca_confirmada"; turmaId: string }
  | { action: "notificar"; evento: "time_convocacao"; timeId: string; userId: string }
  | { action: "notificar"; evento: "time_pedido"; timeId: string }
  | { action: "notificar"; evento: "time_aprovado"; timeId: string; userId: string };

/** Id de um time: `{uid do dono}_1` ou `_2`. */
const TIME_ID = /^[A-Za-z0-9_-]{1,128}_[12]$/;
export const isTimeId = (value: unknown): value is string => typeof value === "string" && TIME_ID.test(value);

export type ParseResult = { ok: true; value: PushRequest } | { ok: false; error: string };

export const parsePushBody = (body: unknown): ParseResult => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  if (b.action === "registrar") {
    if (!isValidPushToken(b.token)) return { ok: false, error: "Token inválido." };
    if (typeof b.platform !== "string" || !(PLATFORMS as readonly string[]).includes(b.platform)) return { ok: false, error: "Plataforma inválida." };
    return { ok: true, value: { action: "registrar", token: b.token, platform: b.platform as PushPlatform } };
  }
  if (b.action === "remover") {
    if (!isValidPushToken(b.token)) return { ok: false, error: "Token inválido." };
    return { ok: true, value: { action: "remover", token: b.token } };
  }
  if (b.action === "revogar") {
    if (!isValidPushToken(b.token)) return { ok: false, error: "Token inválido." };
    if (!isValidRevogacao(b.revogacao)) return { ok: false, error: "Chave inválida." };
    return { ok: true, value: { action: "revogar", token: b.token, revogacao: b.revogacao } };
  }
  if (b.action === "notificar" && typeof b.evento === "string" && b.evento.startsWith("time_")) {
    if (!isTimeId(b.timeId)) return { ok: false, error: "Time inválido." };
    if (b.evento === "time_pedido") return { ok: true, value: { action: "notificar", evento: "time_pedido", timeId: b.timeId } };
    if (b.evento === "time_convocacao" || b.evento === "time_aprovado") {
      if (!isSafeUid(b.userId)) return { ok: false, error: "Usuário inválido." };
      return { ok: true, value: { action: "notificar", evento: b.evento, timeId: b.timeId, userId: b.userId } };
    }
    return { ok: false, error: "Evento inválido." };
  }
  if (b.action === "notificar") {
    if (!isSafeUid(b.turmaId)) return { ok: false, error: "Turma inválida." };
    if (b.evento === "pedido_entrada") return { ok: true, value: { action: "notificar", evento: "pedido_entrada", turmaId: b.turmaId } };
    if (b.evento === "partida_aberta") return { ok: true, value: { action: "notificar", evento: "partida_aberta", turmaId: b.turmaId } };
    if (b.evento === "presenca_confirmada") return { ok: true, value: { action: "notificar", evento: "presenca_confirmada", turmaId: b.turmaId } };
    if (b.evento === "pedido_aceito") {
      if (!isSafeUid(b.userId)) return { ok: false, error: "Usuário inválido." };
      return { ok: true, value: { action: "notificar", evento: "pedido_aceito", turmaId: b.turmaId, userId: b.userId } };
    }
    return { ok: false, error: "Evento inválido." };
  }
  return { ok: false, error: "Ação inválida." };
};

/** Texto vindo de dados de usuário (nome): sem caracteres de controle, espaços compactados e com limite. */
export const sanitizeText = (value: unknown, max: number, fallback: string): string => {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
  return text || fallback;
};

export interface TurmaForPush {
  creatorId?: unknown;
  nome?: unknown;
  status?: unknown;
  ativo?: unknown;
  /** Membros aprovados (uids). */
  participantes?: unknown;
}
/** A partida do dia: `turmas/{id}/jogos/{AAAAMMDD}`. */
export interface JogoForPush {
  status?: unknown;
  criadoPor?: unknown;
  confirmados?: unknown;
  horario?: unknown;
}
export interface ParticipanteForPush {
  status?: unknown;
  nome?: unknown;
}

export interface PushDraft {
  title: string;
  body: string;
  data: {
    tipo:
      | "pedido_entrada"
      | "pedido_aceito"
      | "partida_aberta"
      | "presenca_confirmada"
      | "organizacao_transferida"
      | "organizador_temporario"
      | "desafio"
      | "time_convocacao"
      | "time_pedido"
      | "time_aprovado"
      | "time_amistoso"
      /** Notificação do painel para muitos usuários (Tugyn APP › Notificações): o toque só abre o app. */
      | "aviso_geral";
    /** Vazio nos avisos de desafio e de time. */
    turmaId: string;
    /** Só nos avisos de time: o toque abre o time (ou a convocação). */
    timeId?: string;
    /** Só nos avisos de desafio: o toque abre a aba destacando este desafio. */
    desafioId?: string;
    /** Identificador da ocorrência na outbox (não é uma chave idempotente do Expo). */
    notificationId?: string;
  };
}

export type Authorization =
  | { ok: true; recipientUid: string; dedupeKey: string; draft: PushDraft }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): Authorization => ({ ok: false, status, error });
const isActive = (turma: TurmaForPush): boolean => turma.status !== "encerrada" && turma.ativo !== false;
const NAME_MAX = 40;

/**
 * Quem pede entrada avisa o ORGANIZADOR. Quem chama é o próprio solicitante (uid vem do token) e o pedido precisa existir (pendente).
 * O destino é SEMPRE o `creatorId` gravado na turma.
 */
export const authorizeJoinRequest = (callerUid: string, turmaId: string, turma: TurmaForPush | null, participante: ParticipanteForPush | null): Authorization => {
  if (!turma) return fail(404, "Turma não encontrada.");
  if (!isActive(turma)) return fail(409, "Esta turma está encerrada.");
  if (!isSafeUid(turma.creatorId)) return fail(409, "Turma sem organizador.");
  if (turma.creatorId === callerUid) return fail(400, "O organizador não pede entrada na própria turma.");
  if (!participante || participante.status !== "pendente") return fail(409, "Não há pedido pendente.");
  return {
    ok: true,
    recipientUid: turma.creatorId,
    dedupeKey: `pedido_entrada_${turmaId}_${callerUid}`,
    draft: {
      title: "Novo pedido de entrada",
      body: `${sanitizeText(participante.nome, NAME_MAX, "Alguém")} quer entrar na turma ${sanitizeText(turma.nome, NAME_MAX, "sua turma")}.`,
      data: { tipo: "pedido_entrada", turmaId },
    },
  };
};

/** O ORGANIZADOR avisa quem foi aceito. Só o criador da turma pode disparar, e a pessoa precisa estar aprovada. */
export const authorizeJoinApproved = (callerUid: string, turmaId: string, targetUid: string, turma: TurmaForPush | null, participante: ParticipanteForPush | null): Authorization => {
  if (!turma) return fail(404, "Turma não encontrada.");
  if (turma.creatorId !== callerUid) return fail(403, "Só o organizador da turma pode fazer isso.");
  if (targetUid === callerUid) return fail(400, "Destino inválido.");
  if (!participante || participante.status !== "aprovado") return fail(409, "Este participante não está aprovado.");
  return {
    ok: true,
    recipientUid: targetUid,
    dedupeKey: `pedido_aceito_${turmaId}_${targetUid}`,
    draft: {
      title: `Você entrou na turma ${sanitizeText(turma.nome, NAME_MAX, "nova")}!`,
      body: "O organizador aceitou o seu pedido. Toque para abrir a turma.",
      data: { tipo: "pedido_aceito", turmaId },
    },
  };
};

/** Máximo de pessoas avisadas por partida aberta (a função da Vercel tem poucos segundos; turmas maiores avisam só as primeiras). */
export const MAX_BROADCAST_USERS = 150;
/** "Partida aberta" avisa UMA vez por turma e por dia, mesmo se o organizador cancelar e abrir de novo. */
export const DEDUPE_PARTIDA_MS = 24 * 3600_000;
export const QUERY_IN_LIMIT = 30;

/** O dia de HOJE em Brasília (UTC−3, fixo) como o app grava: `id` = AAAAMMDD (documento da partida), `dia` = AAAA-MM-DD. Quem calcula é o servidor, nunca o app. */
export const diaDeBrasilia = (nowMs: number): { id: string; dia: string } => {
  const d = new Date(nowMs - 3 * 3600_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return { id: `${y}${m}${day}`, dia: `${y}-${m}-${day}` };
};

export const chunk = <T,>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export type BroadcastAuthorization =
  | { ok: true; recipientUids: string[]; dedupeKey: string; draft: PushDraft }
  | { ok: false; status: number; error: string };

/**
 * O ORGANIZADOR abriu a partida de hoje: avisa os MEMBROS APROVADOS da turma (sem o organizador). Só vale se quem chama é o criador da turma e se a partida
 * de HOJE (dia calculado pelo servidor) existe, está aberta e foi aberta por ele. Quem recebe vem sempre da lista de membros da turma no Firestore.
 */
export const authorizeGameOpened = (callerUid: string, turmaId: string, diaId: string, turma: TurmaForPush | null, jogo: JogoForPush | null): BroadcastAuthorization => {
  if (!turma) return { ok: false, status: 404, error: "Turma não encontrada." };
  if (!isActive(turma)) return { ok: false, status: 409, error: "Esta turma está encerrada." };
  if (turma.creatorId !== callerUid) return { ok: false, status: 403, error: "Só o organizador da turma pode fazer isso." };
  if (!jogo || jogo.status !== "aberta") return { ok: false, status: 409, error: "A partida de hoje não está aberta." };
  if (jogo.criadoPor !== callerUid) return { ok: false, status: 409, error: "A partida de hoje não foi aberta por você." };
  const membros = Array.isArray(turma.participantes) ? turma.participantes : [];
  const recipientUids = [...new Set(membros.filter((uid): uid is string => isSafeUid(uid) && uid !== callerUid))].slice(0, MAX_BROADCAST_USERS);
  const horario = sanitizeText(jogo.horario, 5, "");
  return {
    ok: true,
    recipientUids,
    dedupeKey: `partida_aberta_${turmaId}_${diaId}`,
    draft: {
      title: `Partida de hoje: ${sanitizeText(turma.nome, NAME_MAX, "sua turma")}`,
      body: `O organizador abriu a partida de hoje${horario ? ` às ${horario}` : ""}. Toque para confirmar sua presença.`,
      data: { tipo: "partida_aberta", turmaId },
    },
  };
};

/** A confirmacao ja deve existir na partida de hoje; o destino vem sempre da turma. */
export const authorizeAttendanceConfirmed = (callerUid: string, turmaId: string, diaId: string, turma: TurmaForPush | null, jogo: JogoForPush | null): Authorization => {
  if (!turma) return fail(404, "Turma nao encontrada.");
  if (!isActive(turma)) return fail(409, "Esta turma esta encerrada.");
  if (!isSafeUid(turma.creatorId)) return fail(409, "Turma sem organizador.");
  if (turma.creatorId === callerUid) return fail(400, "O organizador nao precisa avisar a propria presenca.");
  if (!Array.isArray(turma.participantes) || !turma.participantes.includes(callerUid)) return fail(403, "Voce nao participa desta turma.");
  if (!jogo || jogo.status !== "aberta") return fail(409, "A partida de hoje nao esta aberta.");
  const confirmados = jogo.confirmados;
  if (typeof confirmados !== "object" || confirmados === null || Array.isArray(confirmados) || !Object.prototype.hasOwnProperty.call(confirmados, callerUid)) return fail(409, "Presenca nao confirmada.");
  const presenca = (confirmados as Record<string, unknown>)[callerUid];
  if (typeof presenca !== "object" || presenca === null || Array.isArray(presenca)) return fail(409, "Presenca invalida.");
  return {
    ok: true,
    recipientUid: turma.creatorId,
    dedupeKey: `presenca_confirmada_${turmaId}_${diaId}_${callerUid}`,
    draft: {
      title: "Presença confirmada",
      body: `${sanitizeText((presenca as { nome?: unknown }).nome, NAME_MAX, "Um jogador")} confirmou presença na partida de hoje da turma ${sanitizeText(turma.nome, NAME_MAX, "sua turma")}.`,
      data: { tipo: "presenca_confirmada", turmaId },
    },
  };
};

// ─── Times ────────────────────────────────────────────────────────────────────

/** O que os avisos de time leem do documento `times/{id}` (sempre do Firestore, nunca do app). */
export interface TimeForPush {
  nome?: unknown;
  donoId?: unknown;
  membros?: unknown;
  convidados?: unknown;
  solicitantes?: unknown;
  jogadores?: unknown;
  pedidos?: unknown;
  convites?: unknown;
  /** Quem o dono aprovou por último pelo link (gravado junto com a aprovação; as regras só deixam o dono gravar). */
  ultimoAprovado?: unknown;
  modalidade?: unknown;
  cidade?: unknown;
}

const MODALIDADE: Record<string, string> = { campo: "Campo", society: "Society", futsal: "Futsal" };

/** "Society · Palmas, TO" (igual ao cartão de convocação do app); só a modalidade se o time não tiver cidade. */
export const localDoTime = (time: TimeForPush): string => {
  const cidade = (time.cidade ?? {}) as { city?: unknown; state?: unknown };
  const lugar = [sanitizeText(cidade.city, 60, ""), sanitizeText(cidade.state, 20, "")].filter(Boolean).join(", ");
  return [MODALIDADE[String(time.modalidade)] ?? "Society", lugar].filter(Boolean).join(" · ");
};

const naLista = (lista: unknown, uid: string): boolean => Array.isArray(lista) && lista.includes(uid);
const itemEm = (mapa: unknown, uid: string): Record<string, unknown> | null => {
  const item = mapa && typeof mapa === "object" ? (mapa as Record<string, unknown>)[uid] : null;
  return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
};
/** Data (ms) gravada na ocorrência (Timestamp do Firestore ou número); 0 se faltar. */
const msEm = (mapa: unknown, uid: string, campo: string): number => {
  const v = itemEm(mapa, uid)?.[campo] as { toMillis?: () => number } | number | undefined;
  const ms = typeof v === "number" ? v : typeof v?.toMillis === "function" ? v.toMillis() : 0;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
};
const nomeEm = (mapa: unknown, uid: string, fallback: string): string => {
  const item = mapa && typeof mapa === "object" ? (mapa as Record<string, unknown>)[uid] : null;
  return sanitizeText(item && typeof item === "object" ? (item as { nome?: unknown }).nome : null, NAME_MAX, fallback);
};

/** O DONO convocou alguém: avisa o convocado. A convocação precisa estar no time (`convidados`). */
export const authorizeTimeConvocacao = (callerUid: string, timeId: string, targetUid: string, time: TimeForPush | null): Authorization => {
  if (!time) return fail(404, "Time não encontrado.");
  if (time.donoId !== callerUid) return fail(403, "Só o dono do time pode fazer isso.");
  if (targetUid === callerUid) return fail(400, "Destino inválido.");
  if (!naLista(time.convidados, targetUid)) return fail(409, "Não há convocação para esta pessoa.");
  const nomeTime = sanitizeText(time.nome, NAME_MAX, "um time");
  return {
    ok: true,
    recipientUid: targetUid,
    dedupeKey: `time_convocacao_${timeId}_${targetUid}_${msEm(time.convites, targetUid, "em")}`,
    draft: {
      title: `Convocação: ${nomeTime}`,
      body: `Você foi convocado para jogar no ${nomeTime} (${localDoTime(time)}). Toque para responder.`,
      data: { tipo: "time_convocacao", turmaId: "", timeId },
    },
  };
};

/** Quem pediu para entrar pelo link avisa o DONO. O pedido precisa estar no time (`solicitantes`). */
export const authorizeTimePedido = (callerUid: string, timeId: string, time: TimeForPush | null): Authorization => {
  if (!time) return fail(404, "Time não encontrado.");
  if (!isSafeUid(time.donoId)) return fail(409, "Time sem dono.");
  if (time.donoId === callerUid) return fail(400, "O dono não pede para entrar no próprio time.");
  if (!naLista(time.solicitantes, callerUid)) return fail(409, "Não há pedido para entrar.");
  return {
    ok: true,
    recipientUid: time.donoId,
    dedupeKey: `time_pedido_${timeId}_${callerUid}_${msEm(time.pedidos, callerUid, "em")}`,
    draft: {
      title: "Pedido para entrar no time",
      body: `${nomeEm(time.pedidos, callerUid, "Alguém")} quer entrar no ${sanitizeText(time.nome, NAME_MAX, "seu time")}. Toque para responder.`,
      data: { tipo: "time_pedido", turmaId: "", timeId },
    },
  };
};

/**
 * O DONO aprovou um pedido: avisa quem entrou. A pessoa precisa estar no elenco E ser a última aprovada pelo link: membro antigo
 * (ou quem entrou aceitando convocação) não recebe "você entrou". A chave leva a data da entrada: a mesma aprovação avisa uma vez só.
 */
export const authorizeTimeAprovado = (callerUid: string, timeId: string, targetUid: string, time: TimeForPush | null): Authorization => {
  if (!time) return fail(404, "Time não encontrado.");
  if (time.donoId !== callerUid) return fail(403, "Só o dono do time pode fazer isso.");
  if (targetUid === callerUid) return fail(400, "Destino inválido.");
  if (!naLista(time.membros, targetUid)) return fail(409, "Esta pessoa não está no elenco.");
  if (time.ultimoAprovado !== targetUid) return fail(409, "Não há aprovação recente para esta pessoa.");
  return {
    ok: true,
    recipientUid: targetUid,
    dedupeKey: `time_aprovado_${timeId}_${targetUid}_${msEm(time.jogadores, targetUid, "entrouEm")}`,
    draft: {
      title: `Você entrou no ${sanitizeText(time.nome, NAME_MAX, "time")}!`,
      body: "O dono aceitou o seu pedido. Toque para ver o elenco.",
      data: { tipo: "time_aprovado", turmaId: "", timeId },
    },
  };
};

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: PushDraft["data"];
  sound: "default";
  channelId: string;
  priority: "high";
}

export const buildMessages = (tokens: readonly string[], draft: PushDraft): ExpoMessage[] =>
  tokens.map((to) => ({ to, title: draft.title, body: draft.body, data: draft.data, sound: "default", channelId: ANDROID_CHANNEL_ID, priority: "high" }));

export interface PushResult {
  token: string;
  ok: boolean;
  /** O serviço disse que o aparelho não existe mais (app desinstalado, token trocado): o token deve ser apagado. */
  invalid: boolean;
  /** Rejeição explícita transitória: pode tentar novamente. */
  retryable?: boolean;
  /** Não sabemos se o serviço aceitou: nunca reenviar automaticamente. */
  uncertain?: boolean;
  /** Só o CÓDIGO do erro (ex.: "InvalidCredentials", "DeviceNotRegistered"), para diagnóstico. Nunca texto livre: ele pode conter o token. */
  error?: string;
  /** Id do ticket aceito: o recibo (entrega à Apple/Google) é consultado depois com ele. */
  ticketId?: string;
}

const TICKET_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Envia em lotes de 100, até `EXPO_CONEXOES_MAX` ao mesmo tempo (a função da Vercel tem poucos segundos). Mantém a ordem das mensagens. Nunca lança e nunca escreve o token em log. */
export const sendExpoPush = async (messages: readonly ExpoMessage[], options: { fetchImpl?: typeof fetch; accessToken?: string } = {}): Promise<PushResult[]> => {
  const doFetch = options.fetchImpl ?? fetch;
  const enviarLote = async (lote: readonly ExpoMessage[]): Promise<PushResult[]> => {
    const falhou = (error: string, flags: { retryable?: boolean; uncertain?: boolean } = {}): PushResult[] => lote.map((message) => ({ token: message.to, ok: false, invalid: false, error, ...flags }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPO_TIMEOUT_MS);
    try {
      const response = await doFetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}) },
        body: JSON.stringify(lote),
        signal: controller.signal,
      });
      if (!response.ok) return falhou(`http-${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
      const json = (await response.json()) as { data?: unknown };
      const tickets: Array<{ status?: unknown; id?: unknown; details?: { error?: unknown } } | undefined> = Array.isArray(json?.data) ? json.data : [];
      return lote.map((message, index) => {
        const ticket = tickets[index];
        if (!ticket || (ticket.status !== "ok" && ticket.status !== "error")) return { token: message.to, ok: false, invalid: false, uncertain: true, error: "sem-resposta" };
        const ok = ticket.status === "ok";
        const code = typeof ticket?.details?.error === "string" ? ticket.details.error : "sem-resposta";
        const ticketId = ok && typeof ticket.id === "string" && TICKET_ID.test(ticket.id) ? { ticketId: ticket.id } : {};
        return { token: message.to, ok, invalid: !ok && code === "DeviceNotRegistered", ...(ok ? ticketId : { error: code, retryable: code === "MessageRateExceeded" }) };
      });
    } catch {
      return falhou("rede", { uncertain: true });
    } finally {
      clearTimeout(timer);
    }
  };
  const partes = await emParalelo(chunk(messages, EXPO_CHUNK_SIZE), EXPO_CONEXOES_MAX, enviarLote);
  return partes.flat();
};

export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Máximo de ids por consulta de recibos aceito pelo Expo. */
export const EXPO_RECEIPTS_MAX = 1000;
export interface ReceiptResult {
  ok: boolean;
  /** Só o código (ex.: "DeviceNotRegistered", "InvalidCredentials"), nunca a mensagem livre. */
  error?: string;
}

/**
 * Consulta os recibos (o que a Apple/Google responderam ao Expo). Um id ausente na resposta ainda não tem recibo pronto.
 * Devolve null em falha de transporte (consultar de novo depois). Nunca lança.
 */
export const fetchExpoReceipts = async (ids: readonly string[], options: { fetchImpl?: typeof fetch; accessToken?: string } = {}): Promise<Map<string, ReceiptResult> | null> => {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPO_TIMEOUT_MS);
  try {
    const response = await doFetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}) },
      body: JSON.stringify({ ids: ids.slice(0, EXPO_RECEIPTS_MAX) }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: unknown };
    if (typeof json?.data !== "object" || json.data === null) return null;
    const recibos = new Map<string, ReceiptResult>();
    for (const id of ids) {
      const recibo = (json.data as Record<string, { status?: unknown; details?: { error?: unknown } } | undefined>)[id];
      if (recibo?.status === "ok") recibos.set(id, { ok: true });
      else if (recibo?.status === "error") recibos.set(id, { ok: false, error: typeof recibo.details?.error === "string" ? recibo.details.error : "sem-codigo" });
    }
    return recibos;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
