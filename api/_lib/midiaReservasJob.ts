import { randomBytes } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { getAuth } from "firebase-admin/auth";
import { type DocumentReference, FieldValue, type Firestore, type QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { getFirebaseApp } from "./auth";
import { type Bucket, getAccount } from "./config";
import { percorrerComPrazo } from "./desafios";
import { type CheckResult, type TipoDeImagem, checarIntervalo, timestampMillis } from "./mediaCooldown";
import {
  GUARDAR_TEMPORARIA_MS,
  ID_FIXO_DO_AVATAR,
  RESERVA_MS,
  type Reserva,
  anteriorParaApagar,
  chaveDaReserva,
  nomeDoEnvio,
  proximoPasso,
  referenciaAponta,
  reservaAtiva,
} from "./midiaReservas";
import { isSafeUid } from "./validation";

/** Reservas de troca de imagem (protocolo em `midiaReservas.ts`). Só o servidor lê e grava (as regras negam tudo ao app). */
export const COLECAO_RESERVAS = "midiaReservas";
const LOTE_DE_LIMPEZA = 20;
/** Reservas da mesma chave lidas na transação (vencidas somem na rotina; uma por 10 min no máximo). */
const MAX_DA_CHAVE = 50;

const alvoDe = (db: Firestore, tipo: TipoDeImagem, uid: string, turmaId?: string | null): DocumentReference =>
  tipo === "fotoPerfil" ? db.doc(`users/${uid}`) : db.doc(`turmas/${turmaId}`);

const referenciaDe = (tipo: TipoDeImagem, alvo: Record<string, unknown> | null) =>
  tipo === "fotoPerfil"
    ? { url: (alvo?.profileImage as string | undefined) ?? null, publicId: (alvo?.profileImagePublicId as string | undefined) ?? null }
    : { url: (alvo?.bannerUrl as string | undefined) ?? null, publicId: null };

export type ReservaFeita = { ok: true; reservaId: string; nome: string; pasta: string } | ({ ok: false } & Exclude<CheckResult, { allowed: true }>);

/**
 * Reserva a troca numa transação: confere o prazo de 7 dias e a propriedade no documento-alvo e recusa (409) se já houver
 * uma troca em andamento no mesmo alvo. O `public_id` sai daqui, gravado na reserva antes do envio.
 */
export const reservarTrocaDeImagem = async (
  db: Firestore,
  c: { uid: string; tipo: TipoDeImagem; turmaId?: unknown; bucket: Bucket; pasta: string },
): Promise<ReservaFeita> => {
  if (c.tipo === "bannerTurma" && !isSafeUid(c.turmaId)) {
    return { ok: false, allowed: false, status: 400, error: "Identificador da turma inválido." };
  }
  const turmaId = c.tipo === "bannerTurma" ? (c.turmaId as string) : null;
  const chave = chaveDaReserva(c.uid, c.tipo, turmaId ?? undefined);
  const agora = Date.now();
  const nome = nomeDoEnvio(c.tipo, randomBytes(6).toString("hex"), agora);
  const reservaRef = db.collection(COLECAO_RESERVAS).doc();

  return db.runTransaction(async (tx): Promise<ReservaFeita> => {
    const alvoSnap = await tx.get(alvoDe(db, c.tipo, c.uid, turmaId));
    const daChave = await tx.get(db.collection(COLECAO_RESERVAS).where("chave", "==", chave).limit(MAX_DA_CHAVE));
    const alvo = alvoSnap.exists ? (alvoSnap.data() ?? null) : null;
    const prazo = checarIntervalo(c.uid, c.tipo, alvo, agora);
    if (!prazo.allowed) return { ok: false, ...prazo };
    const ativa = daChave.docs
      .map((d) => timestampMillis(d.get("expiraEm")) ?? 0)
      .filter((expira, i) => reservaAtiva({ estado: daChave.docs[i].get("estado"), expiraEmMs: expira }, agora));
    if (ativa.length) {
      return {
        ok: false,
        allowed: false,
        status: 409,
        error: "Já existe um envio desta imagem em andamento. Aguarde alguns minutos e tente de novo.",
        retryAfterSeconds: Math.max(1, Math.ceil((Math.max(...ativa) - agora) / 1000)),
      };
    }
    tx.create(reservaRef, {
      chave,
      uid: c.uid,
      tipo: c.tipo,
      turmaId,
      bucket: c.bucket,
      publicId: `${c.pasta}/${nome}`,
      url: null,
      estado: "reservada",
      anterior: referenciaDe(c.tipo, alvo),
      criadaEm: FieldValue.serverTimestamp(),
      expiraEm: Timestamp.fromMillis(agora + RESERVA_MS),
    });
    return { ok: true, reservaId: reservaRef.id, nome, pasta: c.pasta };
  });
};

/** Depois do envio: guarda a URL (ou marca a falha; a rotina apaga o que possa ter chegado ao Cloudinary). Melhor esforço. */
export const registrarEnvio = async (db: Firestore, reservaId: string, url: string | null): Promise<void> => {
  const ref = db.doc(`${COLECAO_RESERVAS}/${reservaId}`);
  const dados = url ? { estado: "enviada", url, enviadaEm: FieldValue.serverTimestamp() } : { estado: "falhou", expiraEm: Timestamp.now() };
  await ref.update(dados).catch((erro: unknown) => {
    console.warn(JSON.stringify({ evt: "midia_reserva_registro_falhou", reservaId, message: (erro as Error)?.message ?? String(erro) }));
  });
};

const apagarDoCloudinary = async (bucket: string, publicId: string): Promise<void> => {
  const conta = getAccount(bucket as Bucket);
  if (!conta) throw new Error(`bucket_${bucket}_sem_credenciais`);
  const r = (await cloudinary.uploader.destroy(publicId, { ...conta, resource_type: "image", invalidate: true })) as { result?: string };
  if (r?.result !== "ok" && r?.result !== "not found") throw new Error(`cloudinary_destroy_${r?.result ?? "sem_resposta"}`);
};

/**
 * Promove a foto confirmada para o id fixo `profile` (sobrescreve e invalida SÓ agora, depois da confirmação) e troca a
 * referência para ela se o perfil ainda aponta para o envio. O temporário fica `GUARDAR_TEMPORARIA_MS` e a rotina apaga.
 * Idempotente: rodar de novo refaz a cópia e não muda nada se a referência já tiver sido trocada.
 */
const promoverFoto = async (db: Firestore, reservaRef: DocumentReference, r: Reserva): Promise<{ url: string; publicId: string } | null> => {
  const perfilRef = db.doc(`users/${r.uid}`);
  if (!referenciaAponta((await perfilRef.get()).get("profileImage"), r.publicId)) {
    await reservaRef.update({ estado: "promovida", expiraEm: Timestamp.now() });
    return null;
  }
  const conta = getAccount("usuarios");
  if (!conta || !r.url) throw new Error(conta ? "reserva_sem_url" : "bucket_usuarios_sem_credenciais");
  const pasta = r.publicId.slice(0, r.publicId.lastIndexOf("/"));
  const final = (await cloudinary.uploader.upload(r.url, {
    ...conta,
    folder: pasta,
    public_id: ID_FIXO_DO_AVATAR,
    overwrite: true,
    invalidate: true,
    unique_filename: false,
    use_filename: false,
    resource_type: "image",
    tags: ["uid_" + r.uid],
  })) as { secure_url: string; public_id: string };

  const trocou = await db.runTransaction(async (tx) => {
    const perfil = await tx.get(perfilRef);
    const aponta = perfil.exists && referenciaAponta(perfil.get("profileImage"), r.publicId);
    // O id fixo NÃO mexe no prazo: `profileImageChangedAt` já foi gravado na confirmação.
    if (aponta) tx.update(perfilRef, { profileImage: final.secure_url, profileImagePublicId: final.public_id });
    tx.update(reservaRef, { estado: "promovida", expiraEm: Timestamp.fromMillis(Date.now() + GUARDAR_TEMPORARIA_MS) });
    return aponta;
  });
  if (!trocou) return null;
  await getAuth(getFirebaseApp())
    .updateUser(r.uid, { photoURL: final.secure_url })
    .catch((erro: unknown) => console.warn(JSON.stringify({ evt: "midia_foto_auth_falhou", message: (erro as Error)?.message ?? String(erro) })));
  const anterior = anteriorParaApagar(r);
  if (anterior) await apagarDoCloudinary(anterior.bucket, anterior.publicId).catch(() => undefined); // a rotina não repete: melhor esforço
  return { url: final.secure_url, publicId: final.public_id };
};

export type Confirmacao =
  | { ok: true; url: string; publicId: string; promovida: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 503; error: string; retryAfterSeconds?: number };

/**
 * Confirma a troca da foto de perfil: numa transação, confere a reserva (dona, enviada, no prazo) e o prazo de 7 dias, grava a
 * referência + `profileImageChangedAt` e marca a reserva como confirmada. Depois promove para o id fixo; se a promoção falhar,
 * a foto já vale (pelo id temporário) e a rotina diária termina.
 */
export const confirmarFotoDePerfil = async (db: Firestore, uid: string, reservaId: unknown): Promise<Confirmacao> => {
  if (!isSafeUid(reservaId)) return { ok: false, status: 400, error: "Reserva inválida." };
  const reservaRef = db.doc(`${COLECAO_RESERVAS}/${reservaId}`);
  const perfilRef = db.doc(`users/${uid}`);
  const confirmado = await db.runTransaction(async (tx): Promise<Confirmacao & { reserva?: Reserva }> => {
    const [reservaSnap, perfil] = await tx.getAll(reservaRef, perfilRef);
    const r = reservaSnap.exists ? (reservaSnap.data() as Reserva & { expiraEm?: unknown }) : null;
    if (!r || r.uid !== uid || r.tipo !== "fotoPerfil") return { ok: false, status: 404, error: "Envio não encontrado." };
    if (r.estado === "confirmada" || r.estado === "promovida") return { ok: true, url: String(r.url), publicId: r.publicId, promovida: false, reserva: r };
    const expira = timestampMillis(r.expiraEm) ?? 0;
    if (r.estado !== "enviada" || !r.url || expira <= Date.now()) {
      return { ok: false, status: 409, error: "Este envio expirou. Escolha a foto de novo." };
    }
    if (!perfil.exists) return { ok: false, status: 404, error: "Perfil não encontrado." };
    const prazo = checarIntervalo(uid, "fotoPerfil", perfil.data() ?? null);
    if (!prazo.allowed) return { ok: false, status: prazo.status, error: prazo.error, retryAfterSeconds: prazo.retryAfterSeconds };
    tx.update(perfilRef, {
      profileImage: r.url,
      profileImagePublicId: r.publicId,
      profileImageChangedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Vence já: se a promoção abaixo falhar, a próxima rotina a encontra e termina.
    tx.update(reservaRef, { estado: "confirmada", confirmadaEm: FieldValue.serverTimestamp(), expiraEm: Timestamp.now() });
    return { ok: true, url: r.url, publicId: r.publicId, promovida: false, reserva: r };
  });
  if (!confirmado.ok || !confirmado.reserva) return confirmado;
  const { reserva, ...resposta } = confirmado;
  try {
    const final = await promoverFoto(db, reservaRef, { ...reserva, url: resposta.url });
    if (final) return { ok: true, url: final.url, publicId: final.publicId, promovida: true };
  } catch (erro) {
    console.warn(JSON.stringify({ evt: "midia_promocao_adiada", reservaId, message: (erro as Error)?.message ?? String(erro) }));
  }
  return resposta;
};

/** Resolve uma reserva vencida (ver `proximoPasso`). Lança se não der: a reserva continua e a próxima rotina tenta de novo. */
const resolverReserva = async (db: Firestore, doc: QueryDocumentSnapshot): Promise<void> => {
  const r = doc.data() as Reserva;
  if (!r.publicId || !r.tipo || !isSafeUid(r.uid)) {
    await doc.ref.delete(); // registro inválido: nada a apagar no Cloudinary
    return;
  }
  const alvo = await alvoDe(db, r.tipo, r.uid, r.turmaId).get();
  const url = alvo.get(r.tipo === "fotoPerfil" ? "profileImage" : "bannerUrl");
  const passo = proximoPasso(r, referenciaAponta(url, r.publicId));
  if (passo === "promover") {
    await promoverFoto(db, doc.ref, { ...r, url: r.url || (url as string) });
    return; // fica como "promovida" até a rotina de amanhã apagar o temporário
  }
  if (passo === "concluir") {
    const anterior = anteriorParaApagar(r);
    if (anterior) await apagarDoCloudinary(anterior.bucket, anterior.publicId);
  } else {
    await apagarDoCloudinary(r.bucket, r.publicId);
  }
  await doc.ref.delete();
};

/** Rotina diária: resolve as reservas vencidas em lotes com cursor, até o prazo. */
export const limparReservasDeMidia = async (db: Firestore, prazoMs: number) => {
  let resolvidas = 0;
  let falhas = 0;
  const corte = Timestamp.now();
  const { restantes } = await percorrerComPrazo<QueryDocumentSnapshot>({
    lote: LOTE_DE_LIMPEZA,
    prazoMs,
    buscar: async (depoisDe, limite) => {
      let consulta = db.collection(COLECAO_RESERVAS).where("expiraEm", "<=", corte).orderBy("expiraEm");
      if (depoisDe) consulta = consulta.startAfter(depoisDe);
      return (await consulta.limit(limite).get()).docs;
    },
    processar: async (doc) => {
      try {
        await resolverReserva(db, doc);
        resolvidas += 1;
      } catch (erro) {
        falhas += 1;
        console.warn(JSON.stringify({ evt: "midia_reserva_pendente", reservaId: doc.id, message: (erro as Error)?.message ?? String(erro) }));
      }
    },
  });
  return { resolvidas, falhas, restantes };
};
