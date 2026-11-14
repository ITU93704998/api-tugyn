const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');

// Jogo de campeonato esquecido "ao vivo": cancelado depois de 6 h sem nenhuma ação (api/_lib/campeonatoAbandonado.ts).
class Timestamp { constructor(ms) { this.ms = ms; } static fromMillis(ms) { return new Timestamp(ms); } toMillis() { return this.ms; } }
const FieldValue = { serverTimestamp: () => ({ servidor: true }) };
function carregar() {
  const arquivo = path.resolve(__dirname, '../../api/_lib/campeonatoAbandonado.ts');
  const code = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const req = (n) => (n === 'firebase-admin/firestore' ? { FieldValue, Timestamp } : n === './validation' ? { isSafeUid: (s) => /^[A-Za-z0-9_-]{1,128}$/.test(s) } : require(n));
  new Function('module', 'exports', 'require', code)(module, module.exports, req);
  return module.exports;
}
const A = carregar();
const H = 3600_000;
const AGORA = 100 * H;
const vivo = (periodo = 't2') => ({ aoVivo: { periodo, rodando: true, inicioMs: 0, acumuladoMs: [0, 0] }, eventos: { e1: {} }, golsCasa: null, golsFora: null });

test('plano: ação recente mantém; parado com jogo em andamento cancela; sobra de jogo encerrado só apaga', () => {
  const camp = { jogos: { j1: vivo(), j2: vivo('fim'), j3: { aoVivo: null } } };
  assert.equal(A.planoDoAbandono(camp, 'j1', AGORA - 2 * H, AGORA), 'manter');
  assert.equal(A.planoDoAbandono(camp, 'j1', AGORA - 7 * H, AGORA), 'cancelar');
  assert.equal(A.planoDoAbandono(camp, 'j1', null, AGORA), 'cancelar');
  assert.equal(A.planoDoAbandono(camp, 'j2', AGORA - 7 * H, AGORA), 'apagar');
  assert.equal(A.planoDoAbandono(camp, 'j3', AGORA - 7 * H, AGORA), 'apagar');
  assert.equal(A.planoDoAbandono(null, 'j1', AGORA - 7 * H, AGORA), 'apagar');
  assert.equal(A.planoDoAbandono(camp, 'j1', AGORA - 6 * H + 1, AGORA), 'manter');
});

test('cancelamento zera o jogo como o "Zerar" do app', () => {
  assert.deepEqual(A.camposDoCancelamento('j1'), {
    'jogos.j1.aoVivo': null, 'jogos.j1.eventos': {}, 'jogos.j1.golsCasa': null, 'jogos.j1.golsFora': null,
    'jogos.j1.penaltis': null, 'jogos.j1.gols': {}, 'jogos.j1.assistencias': {},
  });
});

// Firestore falso: só o que a varredura usa (consulta de grupo, transação com getAll/update/delete).
function bancoFalso(docs) {
  const ref = (p) => ({ path: p });
  const snap = (p) => ({ exists: p in docs, data: () => docs[p], get: (k) => docs[p]?.[k], ref: ref(p) });
  return {
    docs,
    doc: ref,
    collectionGroup: (nome) => ({
      where: (campo, op, valor) => ({
        limit: () => ({
          get: async () => {
            const achados = Object.keys(docs).filter((p) => p.split('/').at(-2) === nome && docs[p][campo] instanceof Timestamp && docs[p][campo].ms < valor.ms);
            return { size: achados.length, docs: achados.map((p) => ({ ref: ref(p) })) };
          },
        }),
      }),
    }),
    runTransaction: async (fn) => fn({
      getAll: async (...refs) => refs.map((r) => snap(r.path)),
      update: (r, campos) => { for (const [k, v] of Object.entries(campos)) { if (k === 'atualizadoEm') continue; const [, id, campo] = k.split('.'); docs[r.path].jogos[id][campo] = v; } },
      delete: (r) => { delete docs[r.path]; },
    }),
  };
}

test('varredura: cancela o jogo parado, apaga a sobra e deixa o jogo ativo em paz', async () => {
  const C = 'turmas/t1/campeonatos/c1';
  const db = bancoFalso({
    [C]: { jogos: { j1: vivo(), j2: vivo('fim'), j3: vivo() } },
    [`${C}/aoVivo/j1`]: { atualizadoEm: Timestamp.fromMillis(AGORA - 8 * H) },
    [`${C}/aoVivo/j2`]: { atualizadoEm: Timestamp.fromMillis(AGORA - 9 * H) },
    [`${C}/aoVivo/j3`]: { atualizadoEm: Timestamp.fromMillis(AGORA - 1 * H) },
    'outra/coisa/aoVivo/x': { atualizadoEm: Timestamp.fromMillis(0) },
  });
  const r = await A.cancelarJogosAbandonados(db, AGORA);
  assert.deepEqual({ ...r }, { vistos: 3, cancelados: 1, apagados: 1 });
  assert.equal(db.docs[C].jogos.j1.aoVivo, null);
  assert.deepEqual(db.docs[C].jogos.j1.eventos, {});
  assert.equal(db.docs[C].jogos.j2.aoVivo.periodo, 'fim');
  assert.equal(db.docs[C].jogos.j3.aoVivo.periodo, 't2');
  assert.ok(!(`${C}/aoVivo/j1` in db.docs) && !(`${C}/aoVivo/j2` in db.docs));
  assert.ok(`${C}/aoVivo/j3` in db.docs);
  assert.ok('outra/coisa/aoVivo/x' in db.docs);
});
