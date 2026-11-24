/**
 * Preenche `nomeBusca` (as palavras do nome para a busca de "Explorar adversários") nos times que ainda não têm, ou que
 * estão com o campo desatualizado (time renomeado por uma versão antiga do app). Depois disso, a busca pelo nome acha
 * todos os times; os novos e os renomeados pela versão nova do app já são indexados na hora (`time_indexar`).
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave.json"
 *   node scripts/indexar-nomes-times.cjs            -> só simula e conta
 *   node scripts/indexar-nomes-times.cjs --aplicar  -> grava
 *
 * Grava SÓ o campo `nomeBusca` (não mexe em `atualizadoEm` nem em nada mais), e só se o time não mudou desde a leitura
 * (`lastUpdateTime`): um time renomeado enquanto o script roda não recebe as palavras do nome antigo (fica para a
 * próxima rodada ou para o próprio app). Pode rodar mais de uma vez: time em dia é pulado. A regra das palavras é a mesma de `api/_lib/explorarTimes.ts` (`palavrasDoNome`): mudou lá, muda aqui.
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");

const APLICAR = process.argv.includes("--aplicar");
const PREFIXO_MIN = 2;
const PREFIXO_MAX = 12;
const MAX_PALAVRAS_BUSCA = 60;
const PAGINA = 300;

const normalizarTexto = (v) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const palavrasDoNome = (nome) => {
  const saida = new Set();
  for (const p of normalizarTexto(nome).split(/[^a-z0-9]+/).filter(Boolean)) {
    for (let n = PREFIXO_MIN; n <= Math.min(p.length, PREFIXO_MAX); n++) saida.add(p.slice(0, n));
  }
  return [...saida].slice(0, MAX_PALAVRAS_BUSCA);
};
const emDia = (atual, certo) => Array.isArray(atual) && atual.length === certo.length && certo.every((p, i) => atual[i] === p);

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

(async () => {
  let lidos = 0;
  let atualizar = 0;
  let mudaram = 0;
  let ultimo = null;
  for (;;) {
    let q = db.collection("times").orderBy(FieldPath.documentId()).select("nome", "nomeBusca").limit(PAGINA);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    const gravar = [];
    for (const doc of snap.docs) {
      lidos += 1;
      const nome = typeof doc.get("nome") === "string" ? doc.get("nome").slice(0, 40) : "";
      const certo = palavrasDoNome(nome);
      if (emDia(doc.get("nomeBusca"), certo)) continue;
      atualizar += 1;
      if (APLICAR) gravar.push({ ref: doc.ref, nomeBusca: certo, lido: doc.updateTime });
    }
    // De 25 em 25, cada um com a condição da versão lida (um lote falharia inteiro se um só time tivesse mudado).
    for (let i = 0; i < gravar.length; i += 25) {
      const r = await Promise.allSettled(gravar.slice(i, i + 25).map((g) => g.ref.update({ nomeBusca: g.nomeBusca }, { lastUpdateTime: g.lido })));
      mudaram += r.filter((x) => x.status === "rejected").length;
    }
    ultimo = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGINA) break;
  }
  console.log(`${lidos} times lidos; ${atualizar} ${APLICAR ? "precisavam de atualização" : "seriam atualizados (rode com --aplicar para gravar)"}.`);
  if (APLICAR) console.log(`${atualizar - mudaram} gravados; ${mudaram} mudaram durante a leitura ou falharam (rode de novo para conferir).`);
})().catch((erro) => {
  console.error("Falhou:", erro && erro.message ? erro.message : erro);
  process.exitCode = 1;
});
