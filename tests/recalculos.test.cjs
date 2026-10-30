// FIR-02: pendência durável do recálculo do perfil. Retry idempotente, sucesso parcial identificado, marca nova não se perde.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '..'), process.cwd()] }));
const root = path.resolve(__dirname, '..');
const REMOVE = Symbol('delete');
const ts_ = (ms) => ({ toMillis: () => ms });

function fixture() {
  const docs = new Map();
  const logs = [];
  const aplicar = (p, data) => {
    const atual = structuredClone(docs.get(p) ?? {});
    for (const [campo, valor] of Object.entries(data)) {
      const partes = campo.split('.');
      let alvo = atual;
      for (const parte of partes.slice(0, -1)) alvo = alvo[parte] ??= {};
      if (valor === REMOVE) delete alvo[partes.at(-1)];
      else alvo[partes.at(-1)] = valor;
    }
    docs.set(p, atual);
  };
  // structuredClone perde toMillis: guarda ms e recria.
  const ler = (p) => {
    const d = docs.get(p);
    if (!d) return undefined;
    const copia = { ...d };
    if (d.pendentes) copia.pendentes = Object.fromEntries(Object.entries(d.pendentes).map(([k, v]) => [k, typeof v === 'number' ? ts_(v) : v]));
    if (typeof d.atualizadoEm === 'number') copia.atualizadoEm = ts_(d.atualizadoEm);
    return copia;
  };
  const snap = (p) => ({ exists: docs.has(p), id: p.split('/').at(-1), ref: ref(p), data: () => ler(p), get: (f) => ler(p)?.[f] });
  const ref = (p) => ({ path: p, id: p.split('/').at(-1), get: async () => snap(p), delete: async () => { docs.delete(p); } });
  const db = {
    doc: ref,
    collection: (nome) => ({
      orderBy: (campo) => ({
        limit: (n) => ({
          get: async () => {
            const lista = [...docs.keys()].filter((k) => k.startsWith(nome + '/') && k.split('/').length === 2)
              .sort((a, b) => docs.get(a)[campo] - docs.get(b)[campo]).slice(0, n).map(snap);
            return { docs: lista, size: lista.length };
          },
        }),
      }),
    }),
    runTransaction: async (fn) => {
      const escritas = [];
      const r = await fn({
        get: async (rf) => snap(rf.path),
        update: (rf, data) => escritas.push(() => aplicar(rf.path, data)),
        delete: (rf) => escritas.push(() => docs.delete(rf.path)),
      });
      escritas.forEach((e) => e());
      return r;
    },
  };
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib/recalculos.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, {
    module, exports: module.exports, Date, Math, Number, JSON, Promise, Map, Set, Object, Array,
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    require(name) {
      if (name === 'firebase-admin/firestore') return { FieldValue: { delete: () => REMOVE, serverTimestamp: () => 'ts' } };
      if (name === './estatisticas') return { somarEstatisticas: () => ({}) };
      if (name === './validation') return { isSafeUid: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) };
      throw Error('mock ausente ' + name);
    },
  });
  return { r: module.exports, db, docs, logs };
}

test('pedido do app: recalcula, limpa só quem deu certo e devolve quem falhou', async () => {
  const f = fixture();
  f.docs.set('recalculosPendentes/T1', { pendentes: { ana: 100, bia: 100 }, atualizadoEm: 100 });
  const falhos = await f.r.recalcularDaPartida(f.db, 'T1', ['ana', 'bia'], async (_db, uid) => { if (uid === 'bia') throw Error('falhou'); });
  assert.deepEqual([...falhos], ['bia']);
  assert.deepEqual(Object.keys(f.docs.get('recalculosPendentes/T1').pendentes), ['bia'], 'bia continua pendente para a rotina');
});

test('marca nova no meio do recálculo não é apagada (outra partida marcou de novo)', async () => {
  const f = fixture();
  f.docs.set('recalculosPendentes/T1', { pendentes: { ana: 100 }, atualizadoEm: 100 });
  await f.r.recalcularDaPartida(f.db, 'T1', ['ana'], async () => {
    f.docs.get('recalculosPendentes/T1').pendentes.ana = 200; // nova partida enquanto recalculava
  });
  assert.equal(f.docs.get('recalculosPendentes/T1').pendentes.ana, 200);
});

test('rotina: processa as mais antigas, só membros, mede o atraso e apaga o documento vazio', async () => {
  const f = fixture();
  const agora = 10 * 3600_000;
  f.docs.set('turmas/T1', { participantes: ['ana', 'bia'] });
  f.docs.set('recalculosPendentes/T1', { pendentes: { ana: agora - 3600_000, bia: agora - 60_000, saiu: agora - 60_000 }, atualizadoEm: agora - 60_000 });
  f.docs.set('recalculosPendentes/T2', { pendentes: {}, atualizadoEm: agora - 7200_000 }); // sem marca válida: não trava a fila
  const recalculados = [];
  const res = await f.r.processarPendencias(f.db, { agora: () => agora, recalcular: async (_db, uid) => { recalculados.push(uid); } });
  assert.deepEqual(recalculados.sort(), ['ana', 'bia'], 'quem saiu da turma não é recalculado');
  assert.equal(res.recalculados, 2);
  assert.equal(res.ignorados, 1);
  assert.equal(res.atrasoMaximoMs, 3600_000);
  assert.equal(f.docs.has('recalculosPendentes/T1'), false);
  assert.equal(f.docs.has('recalculosPendentes/T2'), false);
  assert.ok(f.logs.some((l) => l.includes('estatisticas_pendencias')));
});

test('rotina: falha deixa pendente e tentar de novo é idempotente', async () => {
  const f = fixture();
  f.docs.set('turmas/T1', { participantes: ['ana'] });
  f.docs.set('recalculosPendentes/T1', { pendentes: { ana: 100 }, atualizadoEm: 100 });
  let tentativas = 0;
  const recalcular = async () => { if (++tentativas === 1) throw Error('Firestore ocupado'); };
  assert.equal((await f.r.processarPendencias(f.db, { recalcular })).falhas, 1);
  assert.ok(f.docs.has('recalculosPendentes/T1'));
  assert.equal((await f.r.processarPendencias(f.db, { recalcular })).recalculados, 1);
  assert.equal(f.docs.has('recalculosPendentes/T1'), false);
});
