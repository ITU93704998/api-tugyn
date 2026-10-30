/**
 * Roda (só leitura) TODAS as consultas que o app, a API, as rotinas e o painel de anúncios fazem, com o Query Explain do
 * Firestore, e mostra para cada uma: se precisa de índice que não existe, qual índice foi usado, documentos lidos e
 * entradas de índice lidas. Use em HOMOLOGAÇÃO, com dados parecidos com os reais (turma pequena e turma grande).
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave-homologacao.json"
 *   node scripts/medir-consultas.cjs --uid=<uid de um usuário> --turma=<id de uma turma dele>
 *
 * Não grava nada. O Admin SDK ignora as regras de segurança, mas exige os mesmos índices que o app: consulta sem índice
 * falha aqui com FAILED_PRECONDITION e o link para criar o índice (copie-o para `firestore.indexes.json`).
 * Custo: cada consulta é cobrada como uma leitura normal (o `analyze` executa a consulta).
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { FieldPath, getFirestore, Timestamp } = require("firebase-admin/firestore");

const opcao = (nome) => process.argv.find((a) => a.startsWith(`--${nome}=`))?.split("=")[1];
const uid = opcao("uid");
const turma = opcao("turma");
if (!uid || !turma) {
  console.error("Uso: node scripts/medir-consultas.cjs --uid=<uid> --turma=<turmaId>");
  process.exit(2);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const agora = Date.now();
const pad = (n) => String(n).padStart(2, "0");
const dia = (ms) => {
  const d = new Date(ms - 3 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const hoje = dia(agora);
const temporada = `t${hoje.slice(0, 4)}_${Math.floor((Number(hoje.slice(5, 7)) - 1) / 2) + 1}`;
const inicioDoMes = `${hoje.slice(0, 7)}-01`;
const partidas = db.collection(`turmas/${turma}/partidas`);
const desafios = db.collection("desafios");

/** [rótulo, consulta]. Mesmas consultas do código (ver o arquivo de origem no rótulo). */
const consultas = [
  ["app turmaStore: minhas turmas", db.collection("turmas").where("participantes", "array-contains", uid)],
  ["app useParticipantes: aprovados", db.collection(`turmas/${turma}/participantes`).where("status", "==", "aprovado")],
  ["app useParticipantes: pendentes", db.collection(`turmas/${turma}/participantes`).where("status", "==", "pendente")],
  ["app partidasLoader: ranking da temporada", partidas.where("temporada", "==", temporada).orderBy(FieldPath.documentId()).limit(20)],
  ["app partidasLoader: mês atual", partidas.where("diaDoJogo", ">=", inicioDoMes).where("diaDoJogo", "<", "9999-12-31").orderBy("diaDoJogo", "desc").orderBy(FieldPath.documentId(), "desc").limit(20)],
  ["app partidasLoader: todas", partidas.orderBy("diaDoJogo", "desc").orderBy(FieldPath.documentId(), "desc").limit(20)],
  ["app jogoDoDia: limpeza de dias antigos", db.collection(`turmas/${turma}/jogos`).orderBy(FieldPath.documentId()).endBefore(hoje.replaceAll("-", "")).limit(20)],
  ["app desafios: abertos", desafios.where("participantes", "array-contains", uid).where("status", "in", ["pendente", "aceito"]).limit(25)],
  ["app desafios: histórico", desafios.where("participantes", "array-contains", uid).where("status", "in", ["recusado", "cancelado", "expirado", "finalizado"]).orderBy("criadoEm", "desc").limit(30)],
  ["app cadastro: username", db.collection("users").where("userName", "==", "__medicao__")],
  ["api desafios: partidas enviadas no dia", partidas.where("salvadoEm", ">=", Timestamp.fromMillis(agora - 86_400_000)).where("salvadoEm", "<", Timestamp.fromMillis(agora)).limit(50)],
  ["api desafios (cron): vencidos", desafios.where("status", "in", ["pendente", "aceito"]).where("apurarEm", "<=", Timestamp.now()).orderBy("apurarEm").limit(50)],
  ["api desafios (cron): reavisos", desafios.where("reavisarTentativas", "in", [1]).limit(20)],
  ["api turma-gestao: turmas do jogador", db.collection("turmas").where("participantes", "array-contains", uid).select("status", "ativo")],
  ["api exclusão: turmas com pedido", db.collection("turmas").where("pendingParticipants", "array-contains", uid)],
  ["api exclusão: turmas criadas", db.collection("turmas").where("creatorId", "==", uid)],
  ["api exclusão: ex-membro (collection group)", db.collectionGroup("participantes").where("id", "==", uid)],
  ["api exclusão: avaliações feitas", db.collection("avaliacoes").where("avaliadorId", "==", uid)],
  ["api exclusão: usernames", db.collection("usernames").where("uid", "==", uid)],
  ["api push: tokens do usuário", db.collection("pushTokens").where("uid", "in", [uid])],
  ["api push (cron): outbox vencida", db.collection("pushDedupe").where("nextAttemptAt", "<=", agora).orderBy("nextAttemptAt").limit(10)],
  ["api push (cron): recibos vencidos", db.collection("pushRecibos").where("verificarApos", "<=", agora).orderBy("verificarApos").limit(20)],
  ["api estatísticas (cron): pendências", db.collection("recalculosPendentes").orderBy("atualizadoEm").limit(20)],
  ["api solicitações: repetida", db.collection("solicitacoes").where("whatsappDigitos", "==", "0").where("status", "==", "pendente").limit(1)],
  ["painel: solicitações pendentes", db.collection("solicitacoes").where("status", "==", "pendente").limit(50)],
  ["painel/api: contratos recentes", db.collection("contratos").orderBy("criadoEm", "desc").limit(50)],
  ["api contratos: por código", db.collection("contratos").where("codigo", "==", "__medicao__").limit(1)],
  ["painel: estatísticas de anúncios por dia", db.collection("adStats").where("day", ">=", hoje)],
  ["painel: estatísticas por campanha", db.collection("adStats").where("campaignId", "==", "__medicao__")],
];

(async () => {
  let faltando = 0;
  for (const [rotulo, consulta] of consultas) {
    try {
      const { metrics } = await consulta.explain({ analyze: true });
      const plano = metrics.planSummary?.indexesUsed ?? [];
      const exec = metrics.executionStats;
      const indice = plano.map((i) => `${i.query_scope ?? ""} ${i.properties ?? ""}`.trim()).join(" + ") || "?";
      console.log(
        `ok   ${rotulo}\n     resultados=${exec?.resultsReturned ?? "?"} leituras=${exec?.readOperations ?? "?"} ` +
          `entradas de índice=${exec?.debugStats?.index_entries_scanned ?? "?"} docs lidos=${exec?.debugStats?.documents_scanned ?? "?"} ` +
          `tempo=${exec?.executionDuration ? `${Number(exec.executionDuration.seconds ?? 0) * 1000 + Math.round(Number(exec.executionDuration.nanoseconds ?? 0) / 1e6)}ms` : "?"}\n     índice: ${indice}`,
      );
    } catch (erro) {
      const msg = String(erro?.message ?? erro);
      if (erro?.code === 9 || /FAILED_PRECONDITION|requires an index/i.test(msg)) {
        faltando++;
        console.log(`FALTA ÍNDICE  ${rotulo}\n     ${msg.split("\n")[0]}`);
      } else {
        console.log(`ERRO ${rotulo}: ${msg.split("\n")[0]}`);
      }
    }
  }
  console.log(`\n${consultas.length} consultas; ${faltando} sem índice.`);
  process.exit(faltando ? 1 : 0);
})();
