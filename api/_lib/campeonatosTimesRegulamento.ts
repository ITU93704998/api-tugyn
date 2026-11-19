import { createHash, randomBytes } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getFirebaseApp } from "./auth";
import { perfilDisponivel } from "./suspensao";
import { idDoCT } from "./campeonatosTimesServico";
import { agendarAvisosCT, avisoCT, textosCT, timeTodo } from "./campeonatosTimesAvisos";
import { COLECAO_CT, exigirCT, RecusaCT, textoCT, type Dados } from "./campeonatosTimesDominio";
import type { Aviso } from "./pushEnvio";

/**
 * Regulamento em PDF do campeonato entre times (opcional, além do texto). Fica no Firebase Storage, num caminho que o app
 * não lê direto (as regras do Storage negam tudo; só o servidor, com o Admin SDK, grava e lê). Quem pode abrir recebe um
 * link assinado que vale 10 minutos.
 *
 * - Enviar, trocar ou tirar: só o organizador, antes do início. Os times inscritos e os mesários recebem aviso.
 * - Abrir: o organizador, os mesários e os DONOS de time (de um time inscrito ou de um time da mesma modalidade, que pode
 *   se inscrever). Os atletas não abrem.
 *
 * Arquivos: cada envio grava um objeto NOVO, com nome aleatório, que nunca é reaproveitado. Assim, apagar um arquivo
 * antigo nunca atinge o arquivo em uso (mesmo com trocas simultâneas em dois aparelhos). Todo objeto que pode ficar sem
 * uso passa pela fila `FILA_PDF`: o envio entra nela ANTES de ir para o Storage e só sai quando o campeonato passa a
 * apontar para ele; o arquivo substituído entra nela na mesma transação da troca. A rotina diária (`limparRegulamentosCT`)
 * apaga o que sobrar sem referência — por exemplo, um envio recusado porque o campeonato começou no meio do caminho.
 */
export const MAX_BYTES_REGULAMENTO = 3 * 1024 * 1024;
/** Corpo do pedido com o PDF em base64 (cresce ~33%) e os outros campos. A Vercel aceita até 4,5 MB. */
export const MAX_CORPO_REGULAMENTO = 4_300_000;
const VALIDADE_LINK_MS = 10 * 60_000;
/** Fila de arquivos que podem estar sem uso. */
export const FILA_PDF = "regulamentosPdfPendentesCT";
/** Um envio em andamento nunca passa disso (a função da Vercel para antes): só depois a limpeza mexe no item. */
const ESPERA_LIMPEZA_MS = 60 * 60_000;
const MAX_TENTATIVAS_LIMPEZA = 8;

export interface RegulamentoPdf { caminho: string; bytes: number; nome: string; em: number; sha?: string }

const bucket = () => {
  const nome = process.env.FIREBASE_STORAGE_BUCKET;
  exigirCT(nome, "Servidor não configurado para regulamentos em PDF.", 503);
  return getStorage(getFirebaseApp()).bucket(nome);
};
const caminhoValido = (cid: unknown, caminho: unknown): caminho is string =>
  typeof cid === "string" && typeof caminho === "string" && caminho.startsWith(`campeonatosTimes/${cid}/regulamento-`) && /^campeonatosTimes\/ct_[a-f0-9]{24}\/regulamento-[a-f0-9]{24,32}\.pdf$/.test(caminho);
const lerRegulamento = (d: Dados): RegulamentoPdf | null => {
  const r = d.regulamentoPdf as Partial<RegulamentoPdf> | null | undefined;
  return r && typeof r.caminho === "string" && r.caminho.startsWith(`campeonatosTimes/`) ? { caminho: r.caminho, bytes: Number(r.bytes) || 0, nome: String(r.nome ?? "regulamento.pdf"), em: Number(r.em) || 0, ...(typeof r.sha === "string" ? { sha: r.sha } : {}) } : null;
};
/** O que a tela recebe: sem o caminho interno. */
export const regulamentoPublicoCT = (d: Dados) => { const r = lerRegulamento(d); return r ? { bytes: r.bytes, nome: r.nome, em: r.em } : null; };

/** Decodifica o PDF enviado (data URL ou base64 puro), conferindo o tamanho e a assinatura "%PDF-". */
export function lerPdfEnviado(bruto: unknown): Buffer {
  exigirCT(typeof bruto === "string" && bruto.length > 0, "Escolha o arquivo PDF.");
  const s = bruto as string;
  const base64 = s.startsWith("data:") ? (/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(s)?.[1] ?? "") : s;
  exigirCT(base64 && /^[A-Za-z0-9+/]+=*$/.test(base64), "Arquivo inválido. Envie um PDF.");
  exigirCT(base64.length <= Math.ceil(MAX_BYTES_REGULAMENTO / 3) * 4, "O PDF pode ter no máximo 3 MB.", 413);
  const pdf = Buffer.from(base64, "base64");
  exigirCT(pdf.length > 0 && pdf.length <= MAX_BYTES_REGULAMENTO, "O PDF pode ter no máximo 3 MB.", 413);
  exigirCT(pdf.subarray(0, 5).toString("latin1") === "%PDF-", "Arquivo inválido. Envie um PDF.");
  return pdf;
}

const nomeArquivo = (v: unknown): string => {
  const n = textoCT(v, 120, "Nome do arquivo").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
  return n ? (n.toLowerCase().endsWith(".pdf") ? n : `${n}.pdf`) : "regulamento.pdf";
};

/** Apaga um arquivo que comprovadamente não é mais usado e o item dele na fila (melhor esforço: o que falhar fica na fila). */
async function descartar(db: Firestore, caminho: string, itemId: string): Promise<void> {
  try {
    await bucket().file(caminho).delete({ ignoreNotFound: true });
    await db.doc(`${FILA_PDF}/${itemId}`).delete();
  } catch { /* fica na fila para a rotina diária */ }
}

/** Enviar/trocar (`pdf`) ou tirar (`remover: true`) o regulamento em PDF. */
export async function regulamentoPdfCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<Aviso[]> {
  const cid = idDoCT(body), ref = db.doc(`${COLECAO_CT}/${cid}`);
  const removendo = body.remover === true;
  const pdf = removendo ? null : lerPdfEnviado(body.pdf);
  const nome = removendo ? "" : nomeArquivo(body.nome);
  const sha = pdf ? createHash("sha256").update(new Uint8Array(pdf)).digest("hex").slice(0, 32) : null;
  const confere = (camp: Dados | undefined, perfil: Dados | undefined) => {
    exigirCT(camp, "Campeonato não encontrado.", 404);
    exigirCT(camp!.organizadorId === uid, "Somente o organizador pode mudar o regulamento.", 403);
    exigirCT(camp!.status === "inscricoes", "O regulamento só pode mudar antes do início.", 409);
    exigirCT(perfilDisponivel(perfil), "Perfil indisponível.", 403);
  };
  // Confere ANTES de gravar no Storage: quem não organiza não chega a enviar nada.
  const [cs0, perfil0] = await Promise.all([ref.get(), db.doc(`users/${uid}`).get()]);
  confere(cs0.data(), perfil0.data());
  const atual0 = lerRegulamento(cs0.data()!);
  if (removendo ? !atual0 : (sha !== null && atual0?.sha === sha)) return []; // nada muda (repetição de um pedido já feito)

  // Envio novo: entra na fila antes de existir no Storage, com nome que ninguém mais usa.
  const token = pdf ? randomBytes(16).toString("hex") : null;
  const caminho = token ? `campeonatosTimes/${cid}/regulamento-${token}.pdf` : null;
  const fila = (id: string) => db.doc(`${FILA_PDF}/${id}`);
  if (token && caminho && pdf) {
    await fila(token).set({ campeonatoId: cid, caminho, criadoEm: agora, tentativas: 0, leaseAte: null, origem: "envio" });
    await bucket().file(caminho).save(pdf, { resumable: false, contentType: "application/pdf", metadata: { cacheControl: "private, max-age=0", metadata: { campeonatoId: cid, uid } } });
  }

  let anterior: RegulamentoPdf | null = null, itemAnterior: string | null = null, sobrou = false, avisos: Aviso[] = [];
  try {
    await db.runTransaction(async (tx) => {
      anterior = null; itemAnterior = null; sobrou = false; avisos = [];
      const [cs, perfil, item] = await tx.getAll(ref, db.doc(`users/${uid}`), ...(token ? [fila(token)] : []));
      const camp = cs.data(); confere(camp, perfil.data());
      // A limpeza só pega itens com mais de 1 hora; se pegou este, o envio é velho demais para valer.
      if (token) exigirCT(item?.exists && !(Number(item.get("leaseAte") ?? 0) > Date.now()), "O envio demorou demais. Tente de novo.", 409);
      const atual = lerRegulamento(camp!);
      // Outro pedido gravou o mesmo PDF (ou já tirou) entretanto: o nosso arquivo sobra.
      if (removendo ? !atual : atual?.sha === sha) { sobrou = !!token; return; }
      const ativos = await tx.get(ref.collection("inscricoes").where("status", "in", ["aprovada", "pendente"]).limit(129));
      const mesarios = Array.isArray(camp!.mesarios) ? (camp!.mesarios as { uid?: unknown }[]).map((m) => m?.uid).filter((u): u is string => typeof u === "string") : [];
      const para = [...new Set([...ativos.docs.flatMap((s) => timeTodo(s.data() as never)), ...mesarios])].filter((u) => u !== uid);
      const lotes = Array.from({ length: Math.ceil(para.length / 500) }, (_, k) => para.slice(k * 500, k * 500 + 500));
      avisos = agendarAvisosCT(tx, db, lotes.map((lote, k) => avisoCT("dados", cid, `pdf_${token ?? `removido_${agora}`}_${k}`, lote, ...textosCT.dados(camp!, ["o regulamento em PDF"]), uid)), agora);
      tx.update(ref, { regulamentoPdf: caminho && pdf && sha ? { caminho, bytes: pdf.length, nome, em: agora, sha } satisfies RegulamentoPdf : null, atualizadoEm: agora }); // sem mexer na infoVersao: o formulário de edição aberto continua valendo
      if (token) tx.delete(fila(token)); // o arquivo novo está em uso: sai da fila
      if (atual) {
        // O substituído entra na fila na mesma transação (pronto para a próxima rotina, se a exclusão abaixo falhar).
        anterior = atual; itemAnterior = randomBytes(16).toString("hex");
        tx.set(fila(itemAnterior), { campeonatoId: cid, caminho: atual.caminho, criadoEm: agora - ESPERA_LIMPEZA_MS, tentativas: 0, leaseAte: null, origem: "troca" });
      }
    });
  } catch (e) {
    // Recusa dentro da transação = nada foi gravado: o arquivo enviado não tem referência e sai agora. Outras falhas (a
    // transação pode ter sido gravada sem resposta) ficam com a rotina diária, que confere a referência antes de apagar.
    if (e instanceof RecusaCT && token && caminho) await descartar(db, caminho, token);
    throw e;
  }
  if (sobrou && token && caminho) await descartar(db, caminho, token);
  const velho = anterior as RegulamentoPdf | null;
  if (velho && itemAnterior) await descartar(db, velho.caminho, itemAnterior);
  return avisos;
}

export interface ResultadoLimpezaPdf { apagados: number; mantidos: number; falhas: number; adiados: number; invalidos: number }

/** Rotina diária: apaga os arquivos da fila que ficaram sem referência (envios recusados ou interrompidos e trocas). */
export async function limparRegulamentosCT(db: Firestore, ate: number): Promise<ResultadoLimpezaPdf> {
  const r: ResultadoLimpezaPdf = { apagados: 0, mantidos: 0, falhas: 0, adiados: 0, invalidos: 0 };
  if (Date.now() > ate - 1500) return r;
  const s = await db.collection(FILA_PDF).where("criadoEm", "<=", Date.now() - ESPERA_LIMPEZA_MS).orderBy("criadoEm").limit(20).get();
  for (const item of s.docs) {
    if (Date.now() > ate - 1500) { r.adiados++; continue; }
    try {
      const job = await db.runTransaction(async (tx): Promise<Dados | null> => {
        const atual = await tx.get(item.ref);
        if (!atual.exists || Number(atual.get("leaseAte") ?? 0) > Date.now()) return null;
        const d = atual.data()!;
        // Defesa: a fila só apaga regulamentos do próprio campeonato, nunca outro caminho do bucket.
        if (!caminhoValido(d.campeonatoId, d.caminho)) { tx.delete(item.ref); r.invalidos++; return null; }
        const camp = await tx.get(db.doc(`${COLECAO_CT}/${d.campeonatoId}`));
        if (camp.exists && lerRegulamento(camp.data()!)?.caminho === d.caminho) { tx.delete(item.ref); r.mantidos++; return null; }
        // Lease: um envio atrasado que ainda tente usar este arquivo é recusado na transação dele.
        tx.update(item.ref, { leaseAte: Date.now() + 60_000 });
        return d;
      });
      if (!job) continue;
      await bucket().file(job.caminho as string).delete({ ignoreNotFound: true });
      await item.ref.delete(); r.apagados++;
    } catch {
      r.falhas++;
      // Reagenda com espera crescente (1 h, 2 h, 4 h… até 24 h); depois de várias falhas, desiste e registra.
      const tentativas = Number(item.get("tentativas") ?? 0) + 1;
      const espera = Math.min(24 * 3_600_000, 3_600_000 * 2 ** (tentativas - 1));
      try {
        if (tentativas >= MAX_TENTATIVAS_LIMPEZA) { console.warn(JSON.stringify({ evt: "regulamento_pdf_limpeza_desistiu", campeonatoId: item.get("campeonatoId") })); await item.ref.delete(); }
        else await item.ref.update({ tentativas, leaseAte: null, criadoEm: Date.now() - ESPERA_LIMPEZA_MS + espera });
      } catch { /* tenta na próxima rodada */ }
    }
  }
  return r;
}

/** Pode abrir o PDF: organizador, mesário, dono de time inscrito ou dono de um time da mesma modalidade. */
export async function podeAbrirRegulamentoCT(db: Firestore, uid: string, cid: string, camp: Dados): Promise<boolean> {
  if (camp.organizadorId === uid) return true;
  if (Array.isArray(camp.mesarios) && (camp.mesarios as { uid?: unknown }[]).some((m) => m?.uid === uid)) return true;
  const [inscritos, times] = await Promise.all([
    db.collection(`${COLECAO_CT}/${cid}/inscricoes`).where("donoId", "==", uid).limit(1).get(),
    db.collection("times").where("donoId", "==", uid).limit(30).get(),
  ]);
  return !inscritos.empty || times.docs.some((t) => t.get("modalidade") === camp.modalidade);
}

/** Link assinado (10 minutos) para abrir o PDF. */
export async function linkRegulamentoPdfCT(db: Firestore, uid: string, body: Dados, agora = Date.now()): Promise<{ url: string; expiraEm: number }> {
  const cid = idDoCT(body);
  const cs = await db.doc(`${COLECAO_CT}/${cid}`).get();
  exigirCT(cs.exists, "Campeonato não encontrado.", 404);
  const camp = cs.data()!;
  const r = lerRegulamento(camp);
  exigirCT(r, "Este campeonato não tem regulamento em PDF.", 404);
  if (!await podeAbrirRegulamentoCT(db, uid, cid, camp)) throw new RecusaCT(403, "O regulamento em PDF fica disponível para o organizador, os mesários e os donos de times.");
  const expiraEm = agora + VALIDADE_LINK_MS;
  const nomeSeguro = r!.nome.replace(/[^\w.\- ]/g, "_");
  const [url] = await bucket().file(r!.caminho).getSignedUrl({ version: "v4", action: "read", expires: expiraEm, responseType: "application/pdf", responseDisposition: `inline; filename="${nomeSeguro}"` });
  return { url, expiraEm };
}

/** Exclusão do campeonato: apaga os PDFs dele (melhor esforço; itens que sobrarem na fila são resolvidos pela rotina). */
export async function apagarRegulamentosCT(cid: string): Promise<void> {
  try { await bucket().deleteFiles({ prefix: `campeonatosTimes/${cid}/` }); } catch { /* sem bucket configurado ou falha: só sobra o arquivo */ }
}
