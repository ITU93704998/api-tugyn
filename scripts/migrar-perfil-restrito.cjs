/**
 * Migração SEG-03: move `bio`, `sports` e `avaliacao` da raiz de `users/{uid}` para `users/{uid}/restrito/perfil`
 * (a parte que as regras escondem quando o perfil é privado) e apaga os três campos da raiz.
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave.json"
 *   node scripts/migrar-perfil-restrito.cjs            -> só simula e conta
 *   node scripts/migrar-perfil-restrito.cjs --aplicar  -> grava
 *
 * Pode rodar mais de uma vez: conta já migrada não tem mais nada na raiz e é pulada.
 * - `bio` e `sports`: se a parte restrita já tiver o campo (gravado pelo app novo), ele vale e o da raiz só é apagado.
 * - `avaliacao`: as somas da raiz são SOMADAS às da parte restrita (a API nova pode já ter somado avaliações lá).
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");

const APLICAR = process.argv.includes("--aplicar");
const CAMPOS = ["bio", "sports", "avaliacao"];
const NUMEROS_DA_AVALIACAO = ["convivencia", "comprometimento", "fairPlay", "total"];
const PAGINA = 300;

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const migrarUm = (ref) =>
  db.runTransaction(async (tx) => {
    const restritoRef = ref.collection("restrito").doc("perfil");
    const [perfil, restrito] = await Promise.all([tx.get(ref), tx.get(restritoRef)]);
    const raiz = perfil.data() ?? {};
    if (!CAMPOS.some((c) => c in raiz)) return false;

    const atual = restrito.exists ? restrito.data() : {};
    const novo = {};
    if ("bio" in raiz && !("bio" in atual) && typeof raiz.bio === "string") novo.bio = raiz.bio;
    if ("sports" in raiz && !("sports" in atual) && raiz.sports && typeof raiz.sports === "object") novo.sports = raiz.sports;
    if (raiz.avaliacao && typeof raiz.avaliacao === "object") {
      const soma = {};
      for (const n of NUMEROS_DA_AVALIACAO) {
        const v = raiz.avaliacao[n];
        if (typeof v === "number" && Number.isFinite(v) && v !== 0) soma[n] = FieldValue.increment(v);
      }
      if (Object.keys(soma).length) novo.avaliacao = soma;
    }

    if (APLICAR) {
      if (Object.keys(novo).length) tx.set(restritoRef, novo, { merge: true });
      tx.update(ref, Object.fromEntries(CAMPOS.filter((c) => c in raiz).map((c) => [c, FieldValue.delete()])));
    }
    return true;
  });

(async () => {
  let ultimo = null;
  let lidos = 0;
  let migrados = 0;
  for (;;) {
    let q = db.collection("users").orderBy(FieldPath.documentId()).limit(PAGINA);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      lidos += 1;
      if (await migrarUm(d.ref)) migrados += 1;
    }
    ultimo = snap.docs[snap.docs.length - 1];
  }
  console.log(`${APLICAR ? "Migrados" : "Precisam de migração (simulação)"}: ${migrados} de ${lidos} perfis.`);
  if (!APLICAR && migrados) console.log("Rode de novo com --aplicar para gravar.");
})().catch((erro) => {
  console.error("Falhou:", erro?.message ?? erro);
  process.exit(1);
});
