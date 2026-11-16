import type { Firestore, Transaction } from "firebase-admin/firestore";
import { COLECAO_AVISOS, avisoPendente, enviarAviso, type Aviso } from "./pushEnvio";
import type { Dados, InscricaoCT } from "./campeonatosTimesDominio";

/**
 * Avisos (push) dos campeonatos entre times. Mesmo padrão dos amistosos: o aviso nasce na MESMA transação da ação
 * (`agendarAvisosCT`, na fila `pushDedupe`) e a API manda logo depois (`dispararAvisosCT`); se o envio falhar ou a função
 * cair, a rotina de recuperação da fila envia depois. A chave de cada aviso identifica a OCORRÊNCIA (ex.: a versão do
 * jogo), então um retry da mesma ação não manda duas vezes e um fato novo (placar corrigido) gera aviso novo.
 * O toque abre o campeonato (`tipo: "campeonato_times"`, `campeonatoId`). Nunca avisa quem fez a ação.
 */
export type EventoCT =
  | "pedido" | "aprovada" | "recusada" | "removida" | "desistiu" | "transferido" | "iniciado" | "cancelado"
  | "jogo_marcado" | "resultado" | "suspenso" | "encerrado" | "mesario" | "prazo" | "lembrete";

const DIA = 24 * 3600_000;
/** Janela da fila: um aviso igual (mesma chave) não sai de novo dentro dela. */
const DEDUPE_CT: Record<EventoCT, number> = {
  pedido: 10 * 60_000, aprovada: 7 * DIA, recusada: 7 * DIA, removida: 7 * DIA, desistiu: 7 * DIA, transferido: 7 * DIA,
  iniciado: 30 * DIA, cancelado: 30 * DIA, jogo_marcado: 2 * DIA, resultado: 7 * DIA, suspenso: 7 * DIA, encerrado: 30 * DIA,
  mesario: 7 * DIA, prazo: 30 * DIA, lembrete: 3 * DIA,
};
const SEGURO = /[^A-Za-z0-9_-]/g;
const curto = (v: unknown, max = 40): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Um aviso para uma lista de pessoas (sem repetição e sem quem agiu). Null quando não sobra ninguém. */
export function avisoCT(evento: EventoCT, campeonatoId: string, ocorrencia: string, para: readonly (string | null | undefined)[], titulo: string, texto: string, quemAgiu = ""): Aviso | null {
  const recipientUids = [...new Set(para.filter((u): u is string => typeof u === "string" && u.length > 0 && u !== quemAgiu))].slice(0, 500);
  if (!recipientUids.length) return null;
  const dedupeKey = `ct_${evento}_${campeonatoId}_${ocorrencia}`.replace(SEGURO, "_").slice(0, 400);
  return {
    evento: "campeonato_times", turmaId: "", dedupeKey, dedupeMs: DEDUPE_CT[evento], recipientUids, dedupeUid: recipientUids[0],
    draft: { title: titulo.slice(0, 80), body: texto.slice(0, 220), data: { tipo: "campeonato_times", turmaId: "", campeonatoId } },
  };
}

/** Grava os avisos na fila dentro da transação (chamar DEPOIS de todas as leituras). */
export function agendarAvisosCT(tx: Transaction, db: Firestore, avisos: readonly (Aviso | null)[], agora: number): Aviso[] {
  const validos = avisos.filter((a): a is Aviso => Boolean(a));
  for (const a of validos) tx.set(db.doc(`${COLECAO_AVISOS}/${a.dedupeKey}`), avisoPendente(a, agora));
  return validos;
}

/** Melhor esforço, depois da ação salva: o que falhar fica na fila para a recuperação. */
export async function dispararAvisosCT(db: Firestore, avisos: readonly Aviso[] | void): Promise<void> {
  for (const a of avisos ?? []) {
    try { await enviarAviso(db, a); }
    catch (erro) { console.warn("[campeonatos-times] aviso fica na fila:", (erro as Error)?.message ?? "erro"); }
  }
}

// ── Destinatários ──
export const atletasDe = (i: Pick<InscricaoCT, "jogadores"> | undefined | null): string[] => (Array.isArray(i?.jogadores) ? i!.jogadores.map((j) => j.id) : []);
/** Dono e atletas de uma inscrição. */
export const timeTodo = (i: Pick<InscricaoCT, "jogadores" | "donoId"> | undefined | null): string[] => (i ? [i.donoId, ...atletasDe(i)] : []);

// ── Textos ──
const nomeCT = (camp: Dados): string => curto(camp.nome, 50) || "Campeonato";
const quandoTexto = (ms: number): string =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ms).replace(".", "");

export const textosCT = {
  pedido: (camp: Dados, time: string) => ["Novo pedido de inscrição", `${curto(time)} quer participar de ${nomeCT(camp)}. Analise o elenco.`] as const,
  aprovadaDono: (camp: Dados, time: string) => ["Inscrição aprovada!", `${curto(time)} está confirmado em ${nomeCT(camp)}.`] as const,
  aprovadaAtleta: (camp: Dados, time: string) => ["Você foi inscrito num campeonato", `${curto(time)} vai disputar ${nomeCT(camp)} com você no elenco.`] as const,
  recusada: (camp: Dados, time: string, motivo: string) => ["Inscrição recusada", `O pedido de ${curto(time)} em ${nomeCT(camp)} foi recusado${motivo ? `: ${curto(motivo, 120)}` : "."}`] as const,
  removida: (camp: Dados, time: string) => ["Time removido do campeonato", `${curto(time)} foi removido de ${nomeCT(camp)} pelo organizador.`] as const,
  desistiu: (camp: Dados, time: string) => ["Time desistiu da inscrição", `${curto(time)} cancelou a inscrição em ${nomeCT(camp)}. A vaga ficou livre.`] as const,
  transferidoAtleta: (camp: Dados, de: string, para: string) => ["Você foi transferido", `Em ${nomeCT(camp)}, você agora joga por ${curto(para)} (antes: ${curto(de)}).`] as const,
  transferidoDono: (camp: Dados, atleta: string, de: string, para: string) => ["Transferência no campeonato", `${curto(atleta)} passou de ${curto(de)} para ${curto(para)} em ${nomeCT(camp)}.`] as const,
  iniciado: (camp: Dados) => ["O campeonato começou!", `A tabela de ${nomeCT(camp)} saiu. Veja os jogos do seu time.`] as const,
  cancelado: (camp: Dados, motivo: string) => ["Campeonato cancelado", `${nomeCT(camp)} foi cancelado pelo organizador${motivo ? `: ${curto(motivo, 120)}` : "."}`] as const,
  jogoMarcado: (camp: Dados, casa: string, fora: string, quando: number | null, local: string) =>
    ["Jogo marcado", `${curto(casa, 30)} x ${curto(fora, 30)}${quando ? ` · ${quandoTexto(quando)}` : ""}${local ? ` · ${curto(local, 40)}` : ""} (${nomeCT(camp)})`] as const,
  resultado: (camp: Dados, casa: string, gc: number, gf: number, fora: string, wo: boolean) =>
    [wo ? "W.O. registrado" : "Resultado lançado", `${curto(casa, 30)} ${gc} x ${gf} ${curto(fora, 30)}${wo ? " (W.O.)" : ""} · ${nomeCT(camp)}`] as const,
  suspenso: (camp: Dados, motivo: "vermelho" | "amarelos") =>
    ["Você está suspenso", `${motivo === "vermelho" ? "Pelo cartão vermelho" : "Pelo 3º cartão amarelo"}, você cumpre suspensão no próximo jogo de ${nomeCT(camp)}.`] as const,
  campeao: (camp: Dados, time: string) => ["É campeão! 🏆", `${curto(time)} venceu ${nomeCT(camp)}. O troféu já está no time.`] as const,
  encerrado: (camp: Dados, campeao: string) => ["Campeonato encerrado", `${nomeCT(camp)} terminou. Campeão: ${curto(campeao)}.`] as const,
  mesario: (camp: Dados) => ["Você é mesário", `O organizador de ${nomeCT(camp)} te convidou para lançar os placares e marcar os jogos.`] as const,
  prazo: (camp: Dados, aprovados: number, max: number) =>
    ["Inscrições encerradas", aprovados >= max ? `${nomeCT(camp)} tem os ${max} times. Já dá para iniciar.` : `${nomeCT(camp)} tem ${aprovados} de ${max} times aprovados. Analise os pedidos para iniciar.`] as const,
  lembrete: (camp: Dados, casa: string, fora: string, quando: number, local: string) =>
    ["Seu jogo é amanhã", `${curto(casa, 30)} x ${curto(fora, 30)} · ${quandoTexto(quando)}${local ? ` · ${curto(local, 40)}` : ""} (${nomeCT(camp)})`] as const,
};
