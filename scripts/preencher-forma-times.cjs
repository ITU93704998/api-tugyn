/**
 * Preenche `forma` (as letras V/E/D dos 5 últimos amistosos com placar, o mais recente primeiro) nos times que já tinham
 * jogos antes de o servidor passar a gravar o campo. Depois disso, a aba Times mostra a sequência de todos os times; os
 * resultados novos já atualizam o campo na hora (`formaComResultado` em `api/_lib/amistosos.ts`).
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave.json"
 *   node scripts/preencher-forma-times.cjs            -> só simula e conta
 *   node scripts/preencher-forma-times.cjs --aplicar  -> grava
 *
 * Por time: 1 leitura do time (só os campos usados) + até 5 amistosos encerrados. Grava SÓ `forma`, e só se o time não
 * mudou desde a leitura (`lastUpdateTime`): um resultado confirmado enquanto o script roda não é sobrescrito (o servidor
 * já gravou a sequência certa). Pode rodar mais de uma vez: time em dia é pulado.
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");

const APLICAR = process.argv.includes("--aplicar");
const PAGINA = 200;
const MAX_FORMA = 5;
const MAX_GOLS = 99;

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const golsValidos = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_GOLS;
const formaDoTime = async (timeId) => {
  const jogos = await db.collection(`times/${timeId}/amistosos`).orderBy("finalizadoEm", "desc").limit(MAX_FORMA).get();
  return jogos.docs.flatMap((j) => {
    const d = j.data();
    const r = d.resultado;
    if (d.status !== "finalizado" || !r || !golsValidos(r.golsDe) || !golsValidos(r.golsPara)) return [];
    const meus = d.de && d.de.timeId === timeId ? r.golsDe : r.golsPara;
    const deles = d.de && d.de.timeId === timeId ? r.golsPara : r.golsDe;
    return [meus > deles ? "V" : meus === deles ? "E" : "D"];
  });
};
const igual = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

(async () => {
  let lidos = 0, atualizar = 0, mudaram = 0;
  let ultimo = null;
  for (;;) {
    let q = db.collection("times").orderBy(FieldPath.documentId()).select("forma").limit(PAGINA);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      lidos += 1;
      const forma = await formaDoTime(doc.id);
      if (igual(doc.get("forma"), forma) || (!forma.length && doc.get("forma") === undefined)) continue;
      atualizar += 1;
      if (APLICAR) {
        await doc.ref.update({ forma }, { lastUpdateTime: doc.updateTime }).catch(() => { mudaram += 1; });
      }
    }
    ultimo = snap.docs[snap.docs.length - 1].id;
    if (snap.size < PAGINA) break;
  }
  console.log(`${lidos} times lidos; ${atualizar} ${APLICAR ? "precisavam da sequência" : "seriam atualizados (rode com --aplicar para gravar)"}.`);
  if (APLICAR) console.log(`${atualizar - mudaram} gravados; ${mudaram} mudaram durante a leitura ou falharam (rode de novo para conferir).`);
})().catch((erro) => {
  console.error("Falhou:", erro && erro.message ? erro.message : erro);
  process.exitCode = 1;
});
