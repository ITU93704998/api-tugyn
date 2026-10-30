/**
 * Concorrência nas rotas que decidem e gravam (avaliações e desafios), no EMULADOR do Firestore com o Admin SDK.
 *
 * Cada caso muda o banco (bloqueio, saída da turma, exclusão da conta) DEPOIS de o pedido começar e ANTES da transação: é a
 * janela em que a versão antiga já tinha lido a autorização. A decisão certa é a que enxerga a mudança.
 *
 * Rodar (da pasta das regras, que tem o firebase-tools):
 *   cd "...\teste-regras\firestore-rules"
 *   npx firebase emulators:exec --only firestore --project demo-teste "node \"<caminho>\apiTugyn\tests-emulador\concorrencia.emulador.cjs\""
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("Rode dentro do emulador (firebase emulators:exec). Nunca contra o banco real.");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { initializeApp } = require(require.resolve("firebase-admin/app", { paths: [root] }));
const { getFirestore, FieldValue } = require(require.resolve("firebase-admin/firestore", { paths: [root] }));
const { avaliar } = require(path.join(root, "api/avaliacoes.ts"));
const { criar, responder } = require(path.join(root, "api/desafios.ts"));

initializeApp({ projectId: "demo-teste" });
const db = getFirestore();

/** Mesmo banco, mas roda `mudanca` uma vez logo antes da 1ª transação (a janela entre o pedido e a transação). */
const comMudancaAntesDaTransacao = (mudanca) => {
  let feita = false;
  return new Proxy(db, {
    get(alvo, prop) {
      if (prop === "runTransaction") {
        return async (fn, opcoes) => {
          if (!feita) {
            feita = true;
            await mudanca();
          }
          return alvo.runTransaction(fn, opcoes);
        };
      }
      const valor = alvo[prop];
      return typeof valor === "function" ? valor.bind(alvo) : valor;
    },
  });
};

const limpar = async () => {
  for (const col of await db.listCollections()) await db.recursiveDelete(col);
};

const semear = async () => {
  await limpar();
  await db.doc("users/ana").set({ name: "Ana", userName: "ana", status: "active", isPublic: true });
  await db.doc("users/beto").set({ name: "Beto", userName: "beto", status: "active", isPublic: true });
  await db.doc("turmas/t1").set({ nome: "Pelada", participantes: ["ana", "beto"], status: "ativa", creatorId: "ana" });
};

const NOTAS = { convivencia: 5, comprometimento: 4, fairPlay: 3 };
const pedidoAvaliacao = { avaliadoId: "beto", turmaId: "t1", notas: NOTAS };
const pedidoDesafio = { action: "criar", tipo: "temporada", desafiadoId: "beto", turmaId: "t1", temporada: "proxima" };

const existe = async (p) => (await db.doc(p).get()).exists;
const casos = [];
const caso = (nome, fn) => casos.push({ nome, fn });

// ── Avaliações ────────────────────────────────────────────────────────────────
caso("avaliação sem mudança no meio: grava a avaliação e o resumo", async () => {
  const r = await avaliar(db, "ana", pedidoAvaliacao);
  assert.equal(r.ok, true);
  assert.equal((await db.doc("users/beto/restrito/perfil").get()).get("avaliacao.total"), 1);
});
caso("avaliação: bloqueio criado no meio é respeitado", async () => {
  const r = await avaliar(comMudancaAntesDaTransacao(() => db.doc("users/beto/blocked/ana").set({ blockedUid: "ana" })), "ana", pedidoAvaliacao);
  assert.equal(r.code, "bloqueado");
  assert.equal(await existe("avaliacoes/ana__beto"), false);
  assert.equal(await existe("users/beto/restrito/perfil"), false);
});
caso("avaliação: avaliado saiu da turma no meio", async () => {
  const r = await avaliar(comMudancaAntesDaTransacao(() => db.doc("turmas/t1").update({ participantes: ["ana"] })), "ana", pedidoAvaliacao);
  assert.equal(r.code, "sem_turma_em_comum");
  assert.equal(await existe("avaliacoes/ana__beto"), false);
});
caso("avaliação: avaliado começou a excluir a conta no meio (marcador)", async () => {
  const r = await avaliar(comMudancaAntesDaTransacao(() => db.doc("users/beto").update({ excluindoEm: FieldValue.serverTimestamp() })), "ana", pedidoAvaliacao);
  assert.equal(r.code, "atleta_nao_encontrado");
  assert.equal(await existe("users/beto/restrito/perfil"), false);
});
caso("avaliação: perfil do avaliado apagado no meio não deixa resumo órfão", async () => {
  const r = await avaliar(comMudancaAntesDaTransacao(() => db.recursiveDelete(db.doc("users/beto"))), "ana", pedidoAvaliacao);
  assert.equal(r.ok, false);
  assert.equal(await existe("users/beto/restrito/perfil"), false);
});
caso("avaliação: quem avalia começou a excluir a conta no meio", async () => {
  const r = await avaliar(comMudancaAntesDaTransacao(() => db.doc("users/ana").update({ excluindoEm: FieldValue.serverTimestamp() })), "ana", pedidoAvaliacao);
  assert.equal(r.code, "conta_indisponivel");
  assert.equal(await existe("avaliacoes/ana__beto"), false);
});

// ── Desafios ──────────────────────────────────────────────────────────────────
caso("desafio sem mudança no meio: cria o desafio e as vagas", async () => {
  const r = await criar(db, "ana", pedidoDesafio);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await existe("desafiosVagas/beto"), true);
});
caso("desafio: bloqueio criado no meio é respeitado", async () => {
  const r = await criar(comMudancaAntesDaTransacao(() => db.doc("users/ana/blocked/beto").set({ blockedUid: "beto" })), "ana", pedidoDesafio);
  assert.equal(r.code, "bloqueado");
  assert.equal((await db.collection("desafios").get()).size, 0);
  assert.equal(await existe("desafiosVagas/ana"), false);
});
caso("desafio: desafiado saiu da turma no meio", async () => {
  const r = await criar(comMudancaAntesDaTransacao(() => db.doc("turmas/t1").update({ participantes: ["ana"] })), "ana", pedidoDesafio);
  assert.equal(r.code, "sem_turma_em_comum");
  assert.equal((await db.collection("desafios").get()).size, 0);
});
caso("desafio: desafiado começou a excluir a conta no meio", async () => {
  const r = await criar(comMudancaAntesDaTransacao(() => db.doc("users/beto").update({ excluindoEm: FieldValue.serverTimestamp() })), "ana", pedidoDesafio);
  assert.equal(r.code, "atleta_nao_encontrado");
  assert.equal((await db.collection("desafios").get()).size, 0);
});
caso("desafio: quem desafia começou a excluir a conta no meio", async () => {
  const r = await criar(comMudancaAntesDaTransacao(() => db.doc("users/ana").update({ excluindoEm: FieldValue.serverTimestamp() })), "ana", pedidoDesafio);
  assert.equal(r.code, "conta_indisponivel");
});

const desafioPendente = async () => {
  const r = await criar(db, "ana", pedidoDesafio);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.body.desafioId;
};
caso("aceite: bloqueio criado no meio retira o convite", async () => {
  const id = await desafioPendente();
  const r = await responder(comMudancaAntesDaTransacao(() => db.doc("users/beto/blocked/ana").set({ blockedUid: "ana" })), "beto", id, true);
  assert.equal(r.code, "convite_invalido");
  assert.equal((await db.doc(`desafios/${id}`).get()).get("status"), "cancelado");
});
caso("aceite: quem desafiou saiu da turma no meio", async () => {
  const id = await desafioPendente();
  const r = await responder(comMudancaAntesDaTransacao(() => db.doc("turmas/t1").update({ participantes: ["beto"] })), "beto", id, true);
  assert.equal(r.code, "convite_invalido");
});
caso("aceite: quem desafiou começou a excluir a conta no meio", async () => {
  const id = await desafioPendente();
  const r = await responder(comMudancaAntesDaTransacao(() => db.doc("users/ana").update({ excluindoEm: FieldValue.serverTimestamp() })), "beto", id, true);
  assert.equal(r.code, "convite_invalido");
});
caso("aceite sem mudança no meio: aceito", async () => {
  const id = await desafioPendente();
  const r = await responder(db, "beto", id, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await db.doc(`desafios/${id}`).get()).get("status"), "aceito");
});

// Concorrência "de verdade": avaliação e bloqueio disparados juntos, várias vezes. Qualquer ordem vale, mas o resultado
// tem de ser coerente com ALGUMA ordem: avaliação gravada ⇔ resumo gravado (nunca um sem o outro).
caso("avaliação e bloqueio ao mesmo tempo: avaliação e resumo sempre juntos", async () => {
  for (let i = 0; i < 15; i++) {
    await semear();
    await Promise.allSettled([
      avaliar(db, "ana", pedidoAvaliacao),
      db.doc("users/beto/blocked/ana").set({ blockedUid: "ana" }),
    ]);
    assert.equal(await existe("avaliacoes/ana__beto"), await existe("users/beto/restrito/perfil"), `rodada ${i}`);
  }
});

(async () => {
  let falhas = 0;
  for (const c of casos) {
    await semear();
    try {
      await c.fn();
      console.log(`✔ ${c.nome}`);
    } catch (erro) {
      falhas += 1;
      console.log(`✖ ${c.nome}\n   ${erro?.message ?? erro}`);
    }
  }
  console.log(`\n${casos.length - falhas} de ${casos.length} casos ok`);
  process.exit(falhas ? 1 : 0);
})();
