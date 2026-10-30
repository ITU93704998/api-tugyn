// NOT-03: tickets aceitos pelo Expo são guardados e os recibos consultados depois (token morto apagado, credencial inválida alertada).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '..'), process.cwd()] }));
const root = path.resolve(__dirname, '..');
const REMOVE = Symbol('delete');
const tokenA = 'ExpoPushToken[aaaaaaaaaaa1]';
const tokenB = 'ExpoPushToken[bbbbbbbbbbb2]';
function load(file, overrides = {}, logs = []) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const defaults = { 'node:crypto': require('node:crypto'), 'firebase-admin/firestore': { FieldValue: { delete: () => REMOVE } }, './validation': {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, Date, Buffer, process, AbortController, setTimeout, clearTimeout, fetch,
    console: { log: (...args) => logs.push(['log', ...args]), warn: (...args) => logs.push(['warn', ...args]), error: (...args) => logs.push(['error', ...args]) },
    require(name) { if (name in overrides) return overrides[name]; if (name in defaults) return defaults[name]; throw Error('Missing mock '+name); },
  });
  return module.exports;
}
const push = load('api/_lib/push.ts');

function fixture() {
  const records = new Map();
  const logs = [];
  let clock = 1_000_000;
  const set = (key, data, merge = false) => {
    const next = merge ? { ...records.get(key) } : {};
    for (const [field, value] of Object.entries(data)) { if (value === REMOVE) delete next[field]; else next[field] = value; }
    records.set(key, next);
  };
  const snapshot = key => { const value = records.get(key); return { exists: !!value, id: key.split('/').at(-1), ref: ref(key), data: () => value && { ...value }, get: field => value?.[field] }; };
  const ref = key => ({ path: key, id: key.split('/').at(-1), get: async () => snapshot(key), delete: async () => { records.delete(key); }, update: async data => set(key, data, true) });
  const db = {
    doc: ref,
    async runTransaction(fn) {
      const writes = [];
      const result = await fn({
        get: async document => snapshot(document.path),
        set: (document, data) => writes.push(() => set(document.path, data)),
        update: (document, data) => writes.push(() => set(document.path, data, true)),
        delete: document => writes.push(() => records.delete(document.path)),
      });
      writes.forEach(write => write());
      return result;
    },
    collection(name) {
      const filters = []; let maximum = Infinity; let order;
      const query = {
        where(field, op, value) { filters.push([field, op, value]); return query; },
        orderBy(field) { order = field; return query; },
        limit(value) { maximum = value; return query; },
        async get() {
          let keys = [...records.keys()].filter(key => key.startsWith(name+'/'));
          keys = keys.filter(key => filters.every(([field, op, value]) => op === 'in' ? value.includes(records.get(key)[field]) : typeof records.get(key)[field] === 'number' && records.get(key)[field] <= value));
          if (order) keys.sort((a, b) => records.get(a)[order] - records.get(b)[order]);
          const docs = keys.slice(0, maximum).map(snapshot);
          return { docs, size: docs.length };
        },
      };
      return query;
    },
  };
  set('pushTokens/'+push.tokenDocId(tokenA), { token: tokenA, uid: 'recipient', updatedAt: 0 });
  set('pushTokens/'+push.tokenDocId(tokenB), { token: tokenB, uid: 'recipient', updatedAt: 0 });
  const api = load('api/_lib/pushEnvio.ts', { './push': push }, logs);
  let ticket = 0;
  const options = { now: () => clock, send: async messages => messages.map(message => ({ token: message.to, ok: true, invalid: false, ticketId: `tk-${++ticket}` })) };
  const aviso = { evento: 'pedido_entrada', turmaId: 'turma', dedupeKey: 'evento', dedupeMs: 600_000, recipientUids: ['recipient'], dedupeUid: 'recipient', draft: { title: 'Title', body: 'Body', data: { tipo: 'pedido_entrada', turmaId: 'turma' } } };
  return {
    api, logs, records,
    send: () => api.enviarAviso(db, aviso, options),
    check: fetchReceipts => api.consultarRecibos(db, { now: () => clock, fetchReceipts }),
    recibos: () => [...records].filter(([key]) => key.startsWith('pushRecibos/')).map(([, data]) => data),
    token: value => records.get('pushTokens/'+push.tokenDocId(value)),
    touch: value => set('pushTokens/'+push.tokenDocId(value), { updatedAt: clock }, true),
    advance: ms => { clock += ms; },
  };
}

test('tickets aceitos ficam guardados (hash do token, nunca o token) para consulta após 15 min', async () => {
  const f = fixture();
  assert.equal((await f.send()).enviados, 2);
  const [recibo] = f.recibos();
  assert.deepEqual(Object.keys(recibo.tickets).sort(), ['tk-1', 'tk-2']);
  assert.deepEqual(Object.values(recibo.tickets).sort(), [push.tokenDocId(tokenA), push.tokenDocId(tokenB)].sort());
  assert.equal(recibo.verificarApos - recibo.enviadoEm, f.api.RECIBO_ESPERA_MS);
  assert.equal(JSON.stringify(recibo).includes(tokenA), false);
  assert.equal(JSON.stringify(recibo).includes('evento'), false);
  let chamadas = 0;
  await f.check(async () => { chamadas++; return new Map(); });
  assert.equal(chamadas, 0, 'não consulta antes de 15 minutos');
});

test('DeviceNotRegistered no recibo apaga o token; recibo ok e pendente seguem o fluxo', async () => {
  const f = fixture();
  await f.send();
  f.advance(15 * 60_000);
  const counts = await f.check(async ids => { assert.deepEqual([...ids].sort(), ['tk-1', 'tk-2']); return new Map([['tk-1', { ok: false, error: 'DeviceNotRegistered' }]]); });
  assert.equal(counts.tokensRemovidos, 1);
  assert.equal(counts.aguardando, 1);
  assert.equal(f.token(tokenA), undefined);
  assert.ok(f.token(tokenB));
  const [recibo] = f.recibos();
  assert.deepEqual(Object.keys(recibo.tickets), ['tk-2']);
  f.advance(15 * 60_000);
  const final = await f.check(async () => new Map([['tk-2', { ok: true }]]));
  assert.equal(final.entregues, 1);
  assert.equal(f.recibos().length, 0, 'lote concluído é apagado');
});

test('token registrado de novo depois do envio não é apagado', async () => {
  const f = fixture();
  await f.send();
  f.advance(15 * 60_000);
  f.touch(tokenA);
  await f.check(async () => new Map([['tk-1', { ok: false, error: 'DeviceNotRegistered' }], ['tk-2', { ok: true }]]));
  assert.ok(f.token(tokenA));
});

test('credencial APNs/FCM inválida gera alerta sem dados pessoais; transporte falho tenta de novo e desiste após 24 h', async () => {
  const f = fixture();
  await f.send();
  f.advance(15 * 60_000);
  assert.equal((await f.check(async () => null)).falhas, 1);
  assert.equal(f.recibos().length, 1, 'falha de transporte mantém o lote');
  f.advance(15 * 60_000);
  await f.check(async () => new Map([['tk-1', { ok: false, error: 'InvalidCredentials' }]]));
  const alerta = f.logs.find(([nivel, linha]) => nivel === 'error' && String(linha).includes('push_credenciais_invalidas'));
  assert.ok(alerta);
  assert.ok(f.token(tokenA), 'credencial inválida não apaga token');
  f.advance(24 * 3600_000);
  const fim = await f.check(async () => new Map());
  assert.equal(fim.semRecibo, 1);
  assert.equal(f.recibos().length, 0);
  const logs = JSON.stringify(f.logs);
  for (const privado of [tokenA, 'recipient', 'Title', 'Body']) assert.equal(logs.includes(privado), false);
});

test('transporte do Expo: guarda o id do ticket e lê recibos prontos', async () => {
  const messages = push.buildMessages([tokenA, tokenB], { title: 'T', body: 'B', data: { tipo: 'pedido_entrada', turmaId: 't' } });
  const results = await push.sendExpoPush(messages, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ status: 'ok', id: 'abc-123' }, { status: 'ok', id: 'id inválido/..' }] }) }) });
  assert.equal(results[0].ticketId, 'abc-123');
  assert.equal(results[1].ticketId, undefined);
  let corpo;
  const recibos = await push.fetchExpoReceipts(['a', 'b', 'c'], { fetchImpl: async (url, init) => { corpo = JSON.parse(init.body); return { ok: true, json: async () => ({ data: { a: { status: 'ok' }, b: { status: 'error', message: `token ${tokenA}`, details: { error: 'DeviceNotRegistered' } } } }) }; } });
  assert.deepEqual(corpo, { ids: ['a', 'b', 'c'] });
  assert.equal(JSON.stringify(recibos.get('a')), JSON.stringify({ ok: true }));
  assert.equal(JSON.stringify(recibos.get('b')), JSON.stringify({ ok: false, error: 'DeviceNotRegistered' }), 'só o código, nunca a mensagem com o token');
  assert.equal(recibos.has('c'), false, 'ainda não pronto');
  assert.equal(await push.fetchExpoReceipts(['a'], { fetchImpl: async () => ({ ok: false, status: 503 }) }), null);
  assert.equal(await push.fetchExpoReceipts(['a'], { fetchImpl: async () => { throw Error('rede'); } }), null);
});
