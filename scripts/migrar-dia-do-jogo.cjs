/**
 * Migração: grava `diaDoJogo` ("AAAA-MM-DD", Brasília) e, se faltar, `temporada` nas partidas antigas
 * (`turmas/{t}/partidas/{p}`). Partidas, Presença e Ranking passaram a filtrar por esses campos (não mais por `salvadoEm`):
 * partida sem `diaDoJogo` some das listas por mês e de "todas"; sem `temporada`, some do ranking da temporada.
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave.json"
 *   node scripts/migrar-dia-do-jogo.cjs            -> só simula e conta
 *   node scripts/migrar-dia-do-jogo.cjs --aplicar  -> grava
 *
 * - `diaDoJogo`: o dia (Brasília) da `data` da partida; sem data válida, o do 1º envio (`salvadoEm`); nunca no futuro.
 * - `temporada` (só se faltar): a do 1º envio, como o app sempre fez com partida antiga, porque os números do perfil
 *   já foram somados nela. Ela pode não ser a temporada do `diaDoJogo` (jogo do fim do mês enviado no mês seguinte):
 *   o script CONTA esses casos; o ranking e o perfil continuam concordando entre si (os dois usam `temporada`).
 * Pode rodar mais de uma vez: partida que já tem os dois campos é pulada. Não mexe em `salvadoEm` nem no prazo.
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const APLICAR = process.argv.includes("--aplicar");
const FUSO_MS = 3 * 3600_000; // Brasília, UTC−3 o ano todo
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const TEMPORADA = /^t\d{4}_[1-6]$/;

const pad = (n) => String(n).padStart(2, "0");
const diaDeBrasilia = (ms) => {
  const d = new Date(ms - FUSO_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const temporadaDoDia = (dia) => `t${dia.slice(0, 4)}_${Math.floor((Number(dia.slice(5, 7)) - 1) / 2) + 1}`;

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

(async () => {
  const hoje = diaDeBrasilia(Date.now());
  let lidas = 0;
  let migradas = 0;
  let temporadaDiferente = 0;
  const turmas = await db.collection("turmas").select().get();
  for (const turma of turmas.docs) {
    const partidas = await turma.ref.collection("partidas").select("data", "salvadoEm", "diaDoJogo", "temporada").get();
    let lote = db.batch();
    let noLote = 0;
    for (const p of partidas.docs) {
      lidas += 1;
      const temDia = DIA.test(String(p.get("diaDoJogo") ?? ""));
      const temTemporada = TEMPORADA.test(String(p.get("temporada") ?? ""));
      if (temDia && temTemporada) continue;

      const salvadoEmMs = p.get("salvadoEm")?.toMillis?.() ?? Date.now();
      const dataMs = typeof p.get("data") === "string" ? Date.parse(p.get("data")) : NaN;
      const diaCalculado = diaDeBrasilia(Number.isFinite(dataMs) ? dataMs : salvadoEmMs);
      const dia = temDia ? p.get("diaDoJogo") : diaCalculado > hoje ? diaDeBrasilia(salvadoEmMs) : diaCalculado;
      const temporada = temTemporada ? p.get("temporada") : temporadaDoDia(diaDeBrasilia(salvadoEmMs));
      if (temporada !== temporadaDoDia(dia)) temporadaDiferente += 1;

      migradas += 1;
      if (APLICAR) {
        lote.update(p.ref, { ...(temDia ? {} : { diaDoJogo: dia }), ...(temTemporada ? {} : { temporada }) });
        if (++noLote === 400) {
          await lote.commit();
          lote = db.batch();
          noLote = 0;
        }
      }
    }
    if (APLICAR && noLote) await lote.commit();
  }
  console.log(`${APLICAR ? "Migradas" : "Precisam de migração (simulação)"}: ${migradas} de ${lidas} partidas.`);
  console.log(`Partidas antigas contando numa temporada diferente da do dia do jogo (mantidas, por já estarem somadas): ${temporadaDiferente}.`);
  if (!APLICAR && migradas) console.log("Rode de novo com --aplicar para gravar.");
})().catch((erro) => {
  console.error("Falhou:", erro?.message ?? erro);
  process.exit(1);
});
