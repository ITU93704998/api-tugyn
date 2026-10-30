/**
 * Suspende ou reativa uma conta (política em `api/_lib/suspensao.ts`). NÃO suspenda só editando `status` no console:
 * a API já bloqueia, mas a sessão do app e as regras do Firestore continuariam aceitando a conta.
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave.json"
 *   node scripts/moderar-conta.cjs suspender <uid>
 *   node scripts/moderar-conta.cjs reativar <uid>
 *
 * suspender, nesta ordem:
 *  1. `users/{uid}.status = "suspended"` (+ `suspensaEm`): a API recusa na hora; o perfil some para os outros;
 *  2. desativa a conta no Firebase Auth: não entra mais (o app mostra "conta suspensa");
 *  3. revoga as sessões: o token atual deixa de valer na API agora e o app é desconectado em até 1 h (as regras do
 *     Firestore aceitam o token já emitido até ele vencer);
 *  4. apaga os tokens de notificação da conta.
 * reativar: reativa no Auth e volta `status` para "active". A pessoa entra de novo normalmente.
 *
 * Pedido de exclusão de conta suspensa (LGPD), recebido pelo suporte: reative, peça para a pessoa excluir pelo app
 * (Configurações > Excluir conta) ou siga o procedimento de exclusão pelo suporte.
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const [acao, uid] = process.argv.slice(2);
if (!["suspender", "reativar"].includes(acao) || !uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
  console.error("Uso: node scripts/moderar-conta.cjs suspender|reativar <uid>");
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

(async () => {
  const perfil = db.doc(`users/${uid}`);
  if (!(await perfil.get()).exists) throw new Error(`users/${uid} não existe`);

  if (acao === "suspender") {
    await perfil.update({ status: "suspended", suspensaEm: FieldValue.serverTimestamp() });
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
    const tokens = await db.collection("pushTokens").where("uid", "==", uid).get();
    for (const t of tokens.docs) await t.ref.delete();
    console.log(`Conta ${uid} suspensa: status, Auth desativado, sessões revogadas e ${tokens.size} token(s) de aviso apagados.`);
  } else {
    await auth.updateUser(uid, { disabled: false });
    await perfil.update({ status: "active", suspensaEm: FieldValue.delete() });
    console.log(`Conta ${uid} reativada.`);
  }
})().catch((erro) => {
  console.error("Falhou:", erro?.message ?? erro);
  process.exit(1);
});
