import { createHash } from "node:crypto";
import { isSafeUid } from "./validation";

/**
 * Notificações push (pedido de entrada na turma e aceite). Este arquivo reúne a parte PURA: validar o que o app manda, decidir quem pode
 * disparar cada aviso e quem recebe (sempre pelo que está no Firestore, nunca pelo que o app diz), montar a mensagem e falar com o serviço
 * de push da Expo. Nada aqui lê o Firestore: quem lê é a rota (`api/push.ts`).
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_CHUNK_SIZE = 100;
export const EXPO_TIMEOUT_MS = 8000;
export const MAX_TOKENS_PER_USER = 5;
/** O mesmo aviso (mesmo evento, turma e pessoa) não se repete dentro deste tempo. */
export const DEDUPE_MS = 10 * 60_000;
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

export type PushRequest =
  | { action: "registrar"; token: string; platform: PushPlatform }
  | { action: "remover"; token: string }
  | { action: "notificar"; evento: "pedido_entrada"; turmaId: string }
  | { action: "notificar"; evento: "pedido_aceito"; turmaId: string; userId: string };

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
  if (b.action === "notificar") {
    if (!isSafeUid(b.turmaId)) return { ok: false, error: "Turma inválida." };
    if (b.evento === "pedido_entrada") return { ok: true, value: { action: "notificar", evento: "pedido_entrada", turmaId: b.turmaId } };
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
}
export interface ParticipanteForPush {
  status?: unknown;
  nome?: unknown;
}

export interface PushDraft {
  title: string;
  body: string;
  data: { tipo: "pedido_entrada" | "pedido_aceito"; turmaId: string };
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
  /** Só o CÓDIGO do erro (ex.: "InvalidCredentials", "DeviceNotRegistered"), para diagnóstico. Nunca texto livre: ele pode conter o token. */
  error?: string;
}

/** Envia em lotes de 100. Nunca lança e nunca escreve o token em log. */
export const sendExpoPush = async (messages: readonly ExpoMessage[], options: { fetchImpl?: typeof fetch; accessToken?: string } = {}): Promise<PushResult[]> => {
  const doFetch = options.fetchImpl ?? fetch;
  const results: PushResult[] = [];
  for (let start = 0; start < messages.length; start += EXPO_CHUNK_SIZE) {
    const chunk = messages.slice(start, start + EXPO_CHUNK_SIZE);
    const failAll = (error: string): void => {
      for (const message of chunk) results.push({ token: message.to, ok: false, invalid: false, error });
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPO_TIMEOUT_MS);
    try {
      const response = await doFetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}) },
        body: JSON.stringify(chunk),
        signal: controller.signal,
      });
      if (!response.ok) {
        failAll(`http-${response.status}`);
        continue;
      }
      const json = (await response.json()) as { data?: unknown };
      const tickets: Array<{ status?: unknown; details?: { error?: unknown } } | undefined> = Array.isArray(json?.data) ? json.data : [];
      chunk.forEach((message, index) => {
        const ticket = tickets[index];
        const ok = ticket?.status === "ok";
        const code = typeof ticket?.details?.error === "string" ? ticket.details.error : "sem-resposta";
        results.push({ token: message.to, ok, invalid: !ok && code === "DeviceNotRegistered", ...(ok ? {} : { error: code }) });
      });
    } catch {
      failAll("rede");
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
};
