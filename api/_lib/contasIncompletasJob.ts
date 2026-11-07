import type { Auth, UserRecord } from "firebase-admin/auth";
import { type DocumentReference, type Firestore, Timestamp } from "firebase-admin/firestore";
import { COLECAO_EXCLUSOES } from "./exclusaoContaJob";
import { VERSOES_APP } from "./sistema";

/**
 * Rotina diária: apaga as contas do login (Firebase Auth) que ficaram SEM PERFIL porque o cadastro foi interrompido.
 *
 * O cadastro cria a conta no login ANTES da foto, do @ e do perfil. Se o app fecha ou trava no meio, o desfazer do app não
 * roda: sobra uma conta com e-mail e senha, sem `users/{uid}` (a pessoa vê "Perfil incompleto" e o e-mail fica "em uso").
 * A foto enviada nesse meio-tempo já é apagada pela etapa de reservas de imagem (a reserva vence sem perfil que a use).
 *
 * DUAS FASES, em rodadas diferentes (nunca apaga na mesma rodada em que identificou):
 *
 *  1. MARCAR. A conta precisa ter todos os sinais de cadastro interrompido (`contaIncompletaCandidata`). Numa transação,
 *     confere que não há perfil, exclusão em andamento nem marca, e grava `contasIncompletas/{uid}`. Depois REVOGA as
 *     sessões da conta (`revokeRefreshTokens`) e anota `revogadaEm`. A partir daí, nenhum app que ficou aberto consegue
 *     renovar o acesso: o token que ainda existir vence em até 1 h, e só uma entrada nova (com senha) dá acesso de novo,
 *     o que aparece em `lastSignInTime`.
 *  2. APAGAR (rodada seguinte, depois de `QUARENTENA_MS`). Relê a conta no Auth AGORA e exige de novo todos os sinais, sem
 *     custom claim, sem entrada nem renovação depois da marca. Numa transação, confere de novo que não há perfil nem
 *     exclusão e marca `apagandoEm`; só então apaga a conta. Qualquer mudança (ganhou perfil ou permissão, entrou de
 *     novo, conta sumiu/desativada) PRESERVA a conta e retira a marca. Falha de leitura também preserva (fica para a
 *     próxima rodada).
 *
 * Limite conhecido: Auth e Firestore não têm transação conjunta. O que resta é o intervalo entre a última releitura da conta
 * e a exclusão (milissegundos), num momento em que a conta já não tem sessão válida há pelo menos `QUARENTENA_MS`: o
 * perfil não pode ser gravado pelo app nesse intervalo. A permissão de administrador é dada fora do app (script com a
 * chave de serviço): não dê a permissão a uma conta que aparece marcada em `contasIncompletas`.
 *
 * Varre o Auth em páginas de 1000 (listar é grátis); o cursor fica em `sistema/limpezaContasIncompletas` e a próxima rodada
 * continua de onde parou. Leituras do Firestore: só para as candidatas e as marcadas.
 */

export const DOC_LIMPEZA_CONTAS = "sistema/limpezaContasIncompletas";
export const COLECAO_MARCADAS = "contasIncompletas";
/** Conta mais nova que isso pode estar no meio do cadastro (ou a pessoa ainda pode voltar ao app). */
export const IDADE_MIN_MS = 24 * 3600_000;
/** Teto de idade: limita as leituras diárias (sem perfil há mais tempo que isso já não é cadastro de agora). */
export const IDADE_MAX_MS = 60 * 24 * 3600_000;
/** No cadastro o app entra na conta no mesmo instante em que a cria. Entrada bem depois = conta usada de outro jeito. */
export const ENTRADA_NA_CRIACAO_MS = 10 * 60_000;
/** Entre marcar (e revogar as sessões) e apagar: mais que a validade de um token de acesso (1 h). */
export const QUARENTENA_MS = 2 * 3600_000;
const PAGINA = 1000;
/** Marcas novas por rodada (cada uma custa uma transação e uma chamada ao Auth). */
const MARCAS_POR_RODADA = 200;
const APAGAR_POR_RODADA = 200;

const ms = (data: string | null | undefined): number | null => {
  if (!data) return null;
  const t = Date.parse(data);
  return Number.isFinite(t) ? t : null;
};

/** Sinais do próprio registro do Auth (sem ler o Firestore). */
export const contaIncompletaCandidata = (u: UserRecord, agora: number): boolean => {
  if (u.disabled || u.emailVerified) return false;
  if (u.customClaims && Object.keys(u.customClaims).length > 0) return false; // administradores e afins
  const provedores = (u.providerData ?? []).map((p) => p.providerId);
  if (provedores.length !== 1 || provedores[0] !== "password") return false;
  const criada = ms(u.metadata?.creationTime);
  const entrou = ms(u.metadata?.lastSignInTime);
  if (criada === null || entrou === null) return false; // nunca entrou: criada fora do app (console, script)
  const idade = agora - criada;
  if (idade < IDADE_MIN_MS || idade > IDADE_MAX_MS) return false;
  if (entrou - criada > ENTRADA_NA_CRIACAO_MS) return false; // entrou de novo depois do cadastro
  const renovou = ms(u.metadata?.lastRefreshTime);
  if (renovou !== null && agora - renovou < IDADE_MIN_MS) return false; // app aberto nas últimas 24 h
  return true;
};

/** Nada aconteceu na conta depois da marca: nem entrada, nem renovação do acesso. */
export const semUsoDesde = (u: UserRecord, marcadaEm: number): boolean => {
  const entrou = ms(u.metadata?.lastSignInTime);
  const renovou = ms(u.metadata?.lastRefreshTime);
  return entrou !== null && entrou <= marcadaEm && (renovou === null || renovou <= marcadaEm);
};

export interface ResultadoLimpezaContas {
  marcadas: number;
  apagadas: number;
  preservadas: number;
  falhas: number;
  /** A varredura não chegou ao fim nesta rodada (continua na próxima pelo cursor salvo). */
  restantes: boolean;
}

type AuthDaLimpeza = Pick<Auth, "listUsers" | "getUser" | "deleteUser" | "revokeRefreshTokens">;

const naoExiste = (erro: unknown): boolean => (erro as { code?: unknown } | null)?.code === "auth/user-not-found";
const millis = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : null);
const log = (evt: string, extra: Record<string, unknown>) => console.log(JSON.stringify({ evt, ...extra }));

export const limparContasIncompletas = async (
  db: Firestore,
  auth: AuthDaLimpeza,
  prazoAte: number,
  agora: () => number = Date.now,
): Promise<ResultadoLimpezaContas> => {
  const r: ResultadoLimpezaContas = { marcadas: 0, apagadas: 0, preservadas: 0, falhas: 0, restantes: false };
  const perfil = (uid: string) => db.doc(`users/${uid}`);
  const exclusao = (uid: string) => db.doc(`${COLECAO_EXCLUSOES}/${uid}`);
  const marca = (uid: string) => db.doc(`${COLECAO_MARCADAS}/${uid}`);
  const desmarcar = async (ref: DocumentReference) => {
    await ref.delete();
    r.preservadas += 1;
  };

  // ── Fase 2: apagar as marcadas há mais que a quarentena ────────────────────
  const vencidas = await db
    .collection(COLECAO_MARCADAS)
    .where("marcadaEm", "<=", Timestamp.fromMillis(agora() - QUARENTENA_MS))
    .orderBy("marcadaEm")
    .limit(APAGAR_POR_RODADA)
    .get();
  for (const doc of vencidas.docs) {
    if (agora() >= prazoAte) {
      r.restantes = true;
      return r;
    }
    const uid = doc.id;
    try {
      const marcadaEm = millis(doc.get("marcadaEm"));
      if (marcadaEm === null || millis(doc.get("revogadaEm")) === null) {
        await desmarcar(doc.ref); // marca incompleta (as sessões não chegaram a ser revogadas): não apaga
        continue;
      }
      let conta: UserRecord;
      try {
        conta = await auth.getUser(uid);
      } catch (erro) {
        if (!naoExiste(erro)) throw erro;
        await doc.ref.delete(); // a conta já não existe
        continue;
      }
      if (!contaIncompletaCandidata(conta, agora()) || !semUsoDesde(conta, marcadaEm)) {
        await desmarcar(doc.ref);
        log("conta_incompleta_preservada", { uid, motivo: "conta_mudou" });
        continue;
      }
      const pode = await db.runTransaction(async (tx) => {
        const [p, e, m] = await Promise.all([tx.get(perfil(uid)), tx.get(exclusao(uid)), tx.get(marca(uid))]);
        if (!m.exists) return false;
        if (p.exists || e.exists) {
          tx.delete(m.ref);
          return false;
        }
        tx.update(m.ref, { apagandoEm: Timestamp.fromMillis(agora()) });
        return true;
      });
      if (!pode) {
        r.preservadas += 1;
        log("conta_incompleta_preservada", { uid, motivo: "perfil_ou_exclusao" });
        continue;
      }
      try {
        await auth.deleteUser(uid);
      } catch (erro) {
        if (!naoExiste(erro)) throw erro;
      }
      r.apagadas += 1;
      await doc.ref.delete();
      await db.doc(`${VERSOES_APP}/${uid}`).delete().catch(() => undefined);
    } catch (erro) {
      // Preserva: a marca continua e a próxima rodada confere tudo de novo.
      r.falhas += 1;
      console.warn(JSON.stringify({ evt: "conta_incompleta_falhou", uid, message: (erro as Error)?.message ?? String(erro) }));
    }
  }
  if (r.apagadas) log("contas_incompletas_apagadas", { quantidade: r.apagadas });

  // ── Fase 1: varrer o Auth e marcar as candidatas ───────────────────────────
  const estadoRef = db.doc(DOC_LIMPEZA_CONTAS);
  const estado = await estadoRef.get();
  let token: string | undefined = (estado.exists && (estado.get("pageToken") as string | undefined)) || undefined;
  for (;;) {
    if (agora() >= prazoAte || r.marcadas >= MARCAS_POR_RODADA) {
      await estadoRef.set({ pageToken: token ?? null, em: Timestamp.fromMillis(agora()) }, { merge: true });
      r.restantes = true;
      return r;
    }
    const pagina = await auth.listUsers(PAGINA, token);
    const candidatas = pagina.users.filter((u) => contaIncompletaCandidata(u, agora())).map((u) => u.uid);
    let cortou = false;
    if (candidatas.length) {
      const docs = await db.getAll(...candidatas.flatMap((uid) => [perfil(uid), exclusao(uid), marca(uid)]));
      const livres = candidatas.filter((_, i) => !docs[3 * i].exists && !docs[3 * i + 1].exists && !docs[3 * i + 2].exists);
      for (const uid of livres) {
        if (r.marcadas >= MARCAS_POR_RODADA || agora() >= prazoAte) {
          cortou = true; // o resto desta página fica para a próxima rodada (o cursor não avança)
          break;
        }
        try {
          const marcou = await db.runTransaction(async (tx) => {
            const [p, e, m] = await Promise.all([tx.get(perfil(uid)), tx.get(exclusao(uid)), tx.get(marca(uid))]);
            if (p.exists || e.exists || m.exists) return false;
            tx.create(marca(uid), { marcadaEm: Timestamp.fromMillis(agora()) });
            return true;
          });
          if (!marcou) continue;
          await auth.revokeRefreshTokens(uid);
          await marca(uid).update({ revogadaEm: Timestamp.fromMillis(agora()) });
          r.marcadas += 1;
        } catch (erro) {
          // Sem `revogadaEm` a fase 2 retira a marca sem apagar.
          r.falhas += 1;
          console.warn(JSON.stringify({ evt: "conta_incompleta_falhou", uid, fase: "marcar", message: (erro as Error)?.message ?? String(erro) }));
        }
      }
    }
    if (cortou) continue; // o início do laço salva o cursor DESTA página e encerra
    token = pagina.pageToken;
    if (!token) {
      // Chegou ao fim do Auth: a próxima rodada recomeça do início.
      await estadoRef.set({ pageToken: null, em: Timestamp.fromMillis(agora()), voltaCompletaEm: Timestamp.fromMillis(agora()) }, { merge: true });
      return r;
    }
  }
};
