const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '..'), process.cwd()] }));
const root = path.resolve(__dirname, '..');
const REMOVE = Symbol('delete');
const clone = value => value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
const tick = () => new Promise(resolve => setImmediate(resolve));
const tokenA = 'ExpoPushToken[aaaaaaaaaaa1]';
const tokenB = 'ExpoPushToken[bbbbbbbbbbb2]';
function load(file, overrides = {}, logs = []) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const defaults = {
    'node:crypto': require('node:crypto'),
    'firebase-admin/firestore': { FieldValue: { delete: () => REMOVE } },
    './validation': {},
  };
  vm.runInNewContext(js, {
    module, exports: module.exports, Date, Buffer, process, AbortController, setTimeout, clearTimeout, fetch,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    require(name) { if (name in overrides) return overrides[name]; if (name in defaults) return defaults[name]; throw Error('Missing mock '+name); },
  });
  return module.exports;
}
const push = load('api/_lib/push.ts');
function fixture(send) {
  const records = new Map();
  const logs = [];
  let clock = 1_000_000;
  let calls = 0;
  let beforeTokenRead = async () => {};
  let failCommit = () => false;
  let failDelete = false;
  function snapshot(key) {
    const value = clone(records.get(key)?.data);
    return { exists: !!value, id: key.split('/').at(-1), ref: ref(key), data: () => clone(value), get: field => value?.[field] };
  }
  function set(key, data, merge = false) {
    const old = records.get(key);
    const next = merge ? { ...old?.data } : {};
    for (const [field, value] of Object.entries(data)) { if (value === REMOVE) delete next[field]; else next[field] = clone(value); }
    records.set(key, { data: next, version: (old?.version ?? 0) + 1 });
  }
  function ref(key) {
    return { path: key, id: key.split('/').at(-1), get: async () => snapshot(key), delete: async () => { if (failDelete) throw Error('delete failed'); records.delete(key); } };
  }
  const db = {
    doc: ref,
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const reads = new Map(), writes = [];
        const result = await fn({
          get: async document => { reads.set(document.path, records.get(document.path)?.version ?? 0); return snapshot(document.path); },
          set: (document, data) => writes.push([document.path, data, false]),
          update: (document, data) => writes.push([document.path, data, true]),
        });
        if ([...reads].some(([key, version]) => (records.get(key)?.version ?? 0) !== version)) continue;
        if (failCommit(writes)) throw Error('commit failed');
        for (const [key, data, merge] of writes) set(key, data, merge);
        return result;
      }
      throw Error('too much contention');
    },
    collection(name) {
      const filters = []; let maximum = Infinity; let order;
      const query = {
        where(field, op, value) { filters.push([field, op, value]); return query; },
        orderBy(field) { order = field; return query; },
        limit(value) { maximum = value; return query; },
        async get() {
          if (name === 'pushTokens') await beforeTokenRead();
          let keys = [...records.keys()].filter(key => key.startsWith(name+'/'));
          keys = keys.filter(key => filters.every(([field, op, value]) => op === 'in' ? value.includes(records.get(key).data[field]) : typeof records.get(key).data[field] === 'number' && records.get(key).data[field] <= value));
          if (order) keys.sort((a,b) => records.get(a).data[order] - records.get(b).data[order]);
          const docs = keys.slice(0, maximum).map(snapshot);
          return { docs, size: docs.length };
        },
      };
      return query;
    },
  };
  set('pushTokens/'+push.tokenDocId(tokenA), { token: tokenA, uid: 'recipient' });
  const api = load('api/_lib/pushEnvio.ts', { './push': push }, logs);
  const options = { now: () => clock, send: async messages => { calls++; return send ? send(messages, calls) : messages.map(message => ({ token: message.to, ok: true, invalid: false })); } };
  const aviso = { evento: 'pedido_entrada', turmaId: 'turma', dedupeKey: 'same-event', dedupeMs: 600_000, recipientUids: ['recipient'], dedupeUid: 'recipient', draft: { title: 'Title', body: 'Body', data: { tipo: 'pedido_entrada', turmaId: 'turma' } } };
  return {
    db, api, options, aviso, logs,
    send: () => api.enviarAviso(db, aviso, options),
    recover: () => api.recuperarAvisosPendentes(db, options),
    job: () => records.get('pushDedupe/same-event')?.data,
    seed: data => set('pushDedupe/same-event', data),
    addToken: () => set('pushTokens/'+push.tokenDocId(tokenB), { token: tokenB, uid: 'recipient' }),
    advance: milliseconds => { clock += milliseconds; },
    get calls() { return calls; },
    beforeRead: callback => { beforeTokenRead = callback; },
    failCommit: callback => { failCommit = callback; },
    failDelete: () => { failDelete = true; },
  };
}
test('20 simultaneous calls reserve the same event atomically and invoke Expo once', async () => {
  const f = fixture(async messages => { await tick(); return messages.map(message => ({ token: message.to, ok: true, invalid: false })); });
  const results = await Promise.all(Array.from({ length: 20 }, () => f.send()));
  assert.equal(f.calls, 1);
  assert.equal(results.reduce((sum,result) => sum + result.enviados, 0), 1);
  assert.equal(f.job().state, 'done');
  assert.equal(f.job().nextAttemptAt, undefined);
});
test('failure to commit the reservation prevents any provider call', async () => {
  const f = fixture(); f.failCommit(() => true);
  await assert.rejects(f.send()); assert.equal(f.calls, 0);
});
test('expired lease is recovered before dispatch and fences out the old worker', async () => {
  const f = fixture(); let unblock; let reads = 0;
  const gate = new Promise(resolve => { unblock = resolve; });
  f.beforeRead(async () => { if (++reads === 1) await gate; });
  const old = f.send(); await tick();
  f.advance(f.api.PUSH_LEASE_MS+1);
  await f.send(); unblock(); await old;
  assert.equal(f.calls, 1); assert.equal(f.job().state, 'done');
});
test('crash between Expo acceptance and checkpoint becomes uncertain, never automatically resent', async () => {
  const f = fixture();
  f.failCommit(writes => writes.some(([,data]) => data.state === 'done'));
  await assert.rejects(f.send());
  assert.equal(f.calls, 1); assert.equal(f.job().state, 'sending');
  f.failCommit(() => false); f.advance(f.api.PUSH_LEASE_MS+1);
  const recovery = await f.recover();
  assert.equal(recovery.incertos, 1); assert.equal(f.job().state, 'uncertain');
  f.advance(900_000); await f.send(); assert.equal(f.calls, 1);
});
test('token lookup failure is durably queued and safely recovered', async () => {
  const f = fixture(); f.beforeRead(async () => { throw Error('firestore unavailable'); });
  assert.equal((await f.send()).pendente, true); assert.equal(f.calls, 0);
  f.beforeRead(async () => {}); f.advance(30_000); await f.recover();
  assert.equal(f.calls, 1); assert.equal(f.job().state, 'done');
});
test('partial success retries only rejected devices and retains the event identifier', async () => {
  const batches = [], ids = [];
  const f = fixture(async (messages, call) => {
    batches.push(messages.map(message => message.to)); ids.push(messages[0].data.notificationId);
    return messages.map(message => ({ token: message.to, ok: call > 1 || message.to === tokenA, invalid: false, retryable: true }));
  });
  f.addToken(); assert.equal((await f.send()).pendente, true);
  await f.send(); assert.equal(f.calls, 1); // Backoff cannot be bypassed by another app request.
  f.advance(30_000); await f.recover();
  assert.deepEqual(batches.map(batch => [...batch]), [[tokenA,tokenB],[tokenB]]);
  assert.equal(ids[0], ids[1]); assert.equal(f.job().state, 'done');
});
test('ambiguous transport result is quarantined and logs contain no token, UID or body', async () => {
  const f = fixture(async messages => messages.map(message => ({ token: message.to, ok: false, invalid: false, uncertain: true })));
  assert.equal((await f.send()).motivo, 'envio-incerto');
  f.advance(60_001); await f.recover(); await f.send(); assert.equal(f.calls, 1);
  const logs = JSON.stringify(f.logs);
  for (const privateValue of [tokenA, 'recipient', 'same-event', 'Title', 'Body']) assert.equal(logs.includes(privateValue), false);
});
test('known transient rejection has exponential backoff and a three-attempt limit', async () => {
  const f = fixture(async messages => messages.map(message => ({ token: message.to, ok: false, invalid: false, retryable: true })));
  await f.send(); f.advance(30_000); await f.recover();
  f.advance(30_000); await f.recover(); assert.equal(f.calls, 2);
  f.advance(30_000); await f.recover(); assert.equal(f.calls, 3); assert.equal(f.job().state, 'failed');
  assert.equal(f.job().nextAttemptAt, undefined);
});
test('cleanup failure after checkpoint cannot resend an accepted notification', async () => {
  const f = fixture(async messages => messages.map(message => ({ token: message.to, ok: message.to === tokenA, invalid: message.to === tokenB })));
  f.addToken(); f.failDelete(); await f.send(); await f.send(); await f.recover();
  assert.equal(f.calls, 1); assert.equal(f.job().state, 'done');
});
test('legacy dedupe documents still suppress events within their original window', async () => {
  const f = fixture(); f.seed({ at: f.options.now() });
  assert.equal((await f.send()).motivo, 'repetido'); assert.equal(f.calls, 0);
});
test('an unsent event past its business deadline is expired instead of sent late', async () => {
  const f = fixture(); f.beforeRead(async () => { throw Error('unavailable'); });
  await f.send(); f.beforeRead(async () => {}); f.advance(600_001); await f.recover();
  assert.equal(f.calls, 0); assert.equal(f.job().state, 'expired');
});
test('Expo transport classifies timeouts and missing tickets as ambiguous', async () => {
  const messages = push.buildMessages([tokenA], { title: 'Title', body: 'Body', data: { tipo: 'pedido_entrada', turmaId: 't' } });
  const timeout = await push.sendExpoPush(messages, { fetchImpl: async () => { throw Error('timeout'); } });
  assert.equal(timeout[0].uncertain, true);
  const malformed = await push.sendExpoPush(messages, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  assert.equal(malformed[0].uncertain, true);
  const rejected = await push.sendExpoPush(messages, { fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(rejected[0].retryable, true);
});
test('recovery HTTP endpoint refuses public and Firebase-user requests', async () => {
  const f = fixture();
  const route = load('api/push.ts', {
    'firebase-admin/firestore': { getFirestore: () => f.db },
    './_lib/appCheck': {}, './_lib/auth': { getFirebaseApp: () => ({}) }, './_lib/rateLimit': {}, './_lib/push': push,
    './_lib/pushEnvio': f.api,
  });
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'local-test-secret-at-least-16';
  try {
    for (const authorization of [undefined, 'Bearer firebase-user-token', 'Bearer wrong-secret']) {
      const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
      await route.default({ method: 'GET', headers: { authorization } }, res);
      assert.equal(res.code, 401);
    }
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
    await route.default({ method: 'GET', headers: { authorization: 'Bearer '+process.env.CRON_SECRET } }, res);
    assert.equal(res.code, 200);
  } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});
