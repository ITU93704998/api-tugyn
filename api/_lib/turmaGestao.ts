import { parseJogadores } from "./estatisticas";
import type { PushDraft } from "./push";
import { isSafeUid } from "./validation";

/**
 * Transferir a organização e excluir a turma. Este arquivo é a parte PURA: validar o corpo e decidir quem pode
 * fazer o quê, sempre pelo que está no Firestore (nunca pelo que o app diz). Quem lê e grava é a rota (`api/turma-gestao.ts`).
 *
 *  - transferir: só o organizador, para um membro APROVADO que não seja ele mesmo.
 *  - excluir:    só o organizador e só quando ele é o único membro (não apaga gols e jogos de outras pessoas).
 *  - estatisticas:          depois de enviar uma partida, o organizador pede o recálculo do resumo geral dos jogadores dela.
 *  - estatisticas-proprias: o próprio usuário pede o recálculo do seu resumo (ao abrir o perfil).
 *  - temporario:  o organizador escolhe (ou encerra, com null) um membro aprovado como organizador temporário por 24 h.
 *  - trofeus:     o organizador (ou o temporário no prazo), depois de mexer num campeonato, pede a atualização da galeria
 *                 de troféus de quem jogou (o servidor calcula tudo pelo campeonato gravado; ver `trofeus.ts`).
 */

export type GestaoRequest =
  | { action: "transferir"; turmaId: string; novoOrganizadorId: string }
  | { action: "excluir"; turmaId: string }
  | { action: "temporario"; turmaId: string; membroId: string | null }
  | { action: "estatisticas"; turmaId: string; jogadores: string[] }
  | { action: "estatisticas-proprias" }
  | { action: "resumo"; turmaId: string }
  | { action: "trofeus"; turmaId: string; campeonatoId: string };

export type GestaoParse = { ok: true; value: GestaoRequest } | { ok: false; error: string };

export const parseGestaoBody = (body: unknown): GestaoParse => {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Corpo inválido." };
  const b = body as Record<string, unknown>;
  if (b.action === "estatisticas-proprias") return { ok: true, value: { action: "estatisticas-proprias" } };
  if (!isSafeUid(b.turmaId)) return { ok: false, error: "Turma inválida." };
  if (b.action === "estatisticas") {
    const jogadores = parseJogadores(b.jogadores);
    if (!jogadores) return { ok: false, error: "Jogadores inválidos." };
    return { ok: true, value: { action: "estatisticas", turmaId: b.turmaId, jogadores } };
  }
  if (b.action === "excluir") return { ok: true, value: { action: "excluir", turmaId: b.turmaId } };
  if (b.action === "resumo") return { ok: true, value: { action: "resumo", turmaId: b.turmaId } };
  if (b.action === "trofeus") {
    if (!isSafeUid(b.campeonatoId)) return { ok: false, error: "Campeonato inválido." };
    return { ok: true, value: { action: "trofeus", turmaId: b.turmaId, campeonatoId: b.campeonatoId } };
  }
  if (b.action === "temporario") {
    if (b.membroId !== null && !isSafeUid(b.membroId)) return { ok: false, error: "Membro inválido." };
    return { ok: true, value: { action: "temporario", turmaId: b.turmaId, membroId: b.membroId } };
  }
  if (b.action === "transferir") {
    if (!isSafeUid(b.novoOrganizadorId)) return { ok: false, error: "Membro inválido." };
    return { ok: true, value: { action: "transferir", turmaId: b.turmaId, novoOrganizadorId: b.novoOrganizadorId } };
  }
  return { ok: false, error: "Ação inválida." };
};

type Dados = Record<string, unknown> | null;

export type Negado = { ok: false; status: 403 | 404 | 409; code: string; error: string };

const listaDe = (valor: unknown): string[] => (Array.isArray(valor) ? valor.filter((v): v is string => typeof v === "string") : []);

const NOME_MAX = 80;
const texto = (valor: unknown, max: number): string => (typeof valor === "string" ? valor.trim().slice(0, max) : "");

export const exigirOrganizador = (uid: string, turma: Dados): Negado | null => {
  if (!turma) return { ok: false, status: 404, code: "turma_nao_encontrada", error: "Turma não encontrada." };
  if (turma.creatorId !== uid) {
    return { ok: false, status: 403, code: "nao_organizador", error: "Só o organizador pode fazer isso." };
  }
  return null;
};

export type Transferencia =
  | { ok: true; creatorName: string; creatorPhoto: string; draft: PushDraft }
  | Negado;

/** Pode passar a organização? Devolve o nome e a foto que vão para a turma (vindos do participante salvo). */
export const autorizarTransferencia = (
  uid: string,
  turmaId: string,
  novoId: string,
  turma: Dados,
  participanteNovo: Dados,
): Transferencia => {
  const negado = exigirOrganizador(uid, turma);
  if (negado) return negado;
  if (novoId === uid) return { ok: false, status: 409, code: "mesmo_organizador", error: "Você já é o organizador." };
  if (!listaDe(turma?.participantes).includes(novoId) || participanteNovo?.status !== "aprovado") {
    return { ok: false, status: 409, code: "nao_membro", error: "Escolha um membro aprovado da turma." };
  }
  const nomeTurma = texto(turma?.nome, NOME_MAX) || "sua turma";
  return {
    ok: true,
    creatorName: texto(participanteNovo?.nome, NOME_MAX),
    creatorPhoto: texto(participanteNovo?.urlPhoto, 400),
    draft: {
      title: `Você agora organiza a turma ${nomeTurma}`,
      body: "A organização foi passada para você. Toque para abrir a turma.",
      data: { tipo: "organizacao_transferida", turmaId },
    },
  };
};

export type Temporario =
  | { ok: true; membro: null }
  | { ok: true; membro: { uid: string; nome: string }; draft: PushDraft }
  | Negado;

/**
 * Pode escolher este organizador temporário? Só o organizador, numa turma não encerrada pela moderação, e só um membro
 * APROVADO que não seja ele mesmo. O nome vem do participante salvo (nunca do app). `membroId` null = encerrar.
 */
export const autorizarTemporario = (
  uid: string,
  turmaId: string,
  membroId: string | null,
  turma: Dados,
  participante: Dados,
): Temporario => {
  const negado = exigirOrganizador(uid, turma);
  if (negado) return negado;
  if (turma?.encerradaPor === "moderacao") {
    return { ok: false, status: 409, code: "turma_moderada", error: "Esta turma foi encerrada pela moderação." };
  }
  if (membroId === null) return { ok: true, membro: null };
  if (membroId === uid) return { ok: false, status: 409, code: "mesmo_organizador", error: "Você já é o organizador." };
  if (!listaDe(turma?.participantes).includes(membroId) || participante?.status !== "aprovado") {
    return { ok: false, status: 409, code: "nao_membro", error: "Escolha um membro aprovado da turma." };
  }
  const nome = texto(participante?.nome, NOME_MAX) || "Jogador";
  const nomeTurma = texto(turma?.nome, NOME_MAX) || "sua turma";
  return {
    ok: true,
    membro: { uid: membroId, nome },
    draft: {
      title: `Você é o organizador temporário de ${nomeTurma}`,
      body: "Por 24 horas, você cria as partidas da turma e envia os resultados pela sua conta. Toque para abrir a turma.",
      data: { tipo: "organizador_temporario", turmaId },
    },
  };
};

export type Exclusao = { ok: true; codigoConvite: string | null; bannerUrl: string } | Negado;

/** Pode excluir? Só o organizador, e só quando não há outros membros. */
export const autorizarExclusao = (uid: string, turma: Dados): Exclusao => {
  const negado = exigirOrganizador(uid, turma);
  if (negado) return negado;
  const outros = listaDe(turma?.participantes).filter((id) => id !== uid);
  if (outros.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "turma_com_membros",
      error: "A turma ainda tem outros membros. Transfira a organização ou remova os membros antes de excluir.",
    };
  }
  const codigo = texto(turma?.codigoConvite, 10);
  return { ok: true, codigoConvite: /^[A-HJKMNP-Z2-9]{6}$/.test(codigo) ? codigo : null, bannerUrl: texto(turma?.bannerUrl, 500) };
};

// ─── Banner ───────────────────────────────────────────────────────────────────

const CLOUDINARY_UPLOAD = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(.+)$/;

/**
 * Banner a apagar junto com a turma: só uploads únicos de banner (`turmas/<uid>/banner/...` ou o legado
 * `times/<uid>/banner/...`). O id fixo antigo (`times/<uid>/profile/profile`), que turmas chegaram a compartilhar, nunca é apagado.
 */
export const bannerParaApagar = (url: string): { bucket: "turmas" | "times"; publicId: string } | null => {
  const match = CLOUDINARY_UPLOAD.exec(url.split("?")[0]);
  if (!match) return null;
  const segmentos = match[1].split("/");
  const versao = segmentos.findIndex((s) => /^v\d+$/.test(s));
  const caminho = (versao >= 0 ? segmentos.slice(versao + 1) : segmentos).join("/").replace(/\.[A-Za-z0-9]+$/, "");
  const id = /^(turmas|times)\/([A-Za-z0-9_-]{1,128})\/banner\/[A-Za-z0-9_\-./]+$/.exec(caminho);
  if (!id || caminho.includes("..")) return null;
  return { bucket: id[1] as "turmas" | "times", publicId: caminho };
};
