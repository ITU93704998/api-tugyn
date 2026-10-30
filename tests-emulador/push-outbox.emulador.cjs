/** Uses a local Firestore emulator and a mocked Expo transport. Never sends a real push. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw Error('A local FIRESTORE_EMULATOR_HOST is mandatory. Never run against production.');
const root = path.resolve(__dirname, '..');
const dependencyRoot = process.env.PUSH_TEST_API_ROOT || root;
const apiRequire = createRequire(path.join(dependencyRoot, 'package.json'));
const ts = apiRequire('typescript');
require.extensions['.ts'] = (module, filename) => {
  module.paths.unshift(path.join(dependencyRoot, 'node_modules'));
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { initializeApp, deleteApp } = apiRequire('firebase-admin/app');
const { getFirestore } = apiRequire('firebase-admin/firestore');
const { enviarAviso, recuperarAvisosPendentes, PUSH_LEASE_MS } = require(path.join(root, 'api/_lib/pushEnvio.ts'));
const { tokenDocId } = require(path.join(root, 'api/_lib/push.ts'));
const app = initializeApp({ projectId: 'demo-push-outbox' }, 'not01-'+randomUUID());
const db = getFirestore(app);
const namespace = 'not01-'+randomUUID();
const uid = namespace+'-recipient';
const token = 'ExpoPushToken['+randomUUID().replaceAll('-','')+']';
const tokenRef = db.doc('pushTokens/'+tokenDocId(token));
const references = [tokenRef];
let clock = Date.now();
let calls = 0;
const options = { now: () => clock, send: async messages => {
  calls++;
  await new Promise(resolve => setTimeout(resolve, 20));
  return messages.map(message => ({ token: message.to, ok: true, invalid: false }));
} };
const aviso = suffix => ({ evento: 'pedido_entrada', turmaId: 'local-test', dedupeKey: namespace+'-'+suffix, dedupeMs: 600_000, recipientUids: [uid], dedupeUid: uid, draft: { title: 'Emulator test', body: 'No real push', data: { tipo: 'pedido_entrada', turmaId: 'local-test' } } });
async function run() {
  try {
    await tokenRef.set({ token, uid });
    const concurrent = aviso('concurrent');
    const concurrentRef = db.doc('pushDedupe/'+concurrent.dedupeKey); references.push(concurrentRef);
    const results = await Promise.all(Array.from({ length: 16 }, () => enviarAviso(db, concurrent, options)));
    assert.equal(calls, 1); assert.equal(results.reduce((sum,value) => sum+value.enviados, 0), 1);
    assert.equal((await concurrentRef.get()).get('state'), 'done');
    console.log('PASS: 16 concurrent real Firestore transactions call Expo exactly once in this test.');

    const crash = aviso('crash'); const crashRef = db.doc('pushDedupe/'+crash.dedupeKey); references.push(crashRef);
    const crashOptions = { ...options, send: async messages => { calls++; throw Error('simulated process loss after dispatch'); } };
    await enviarAviso(db, crash, crashOptions);
    assert.equal((await crashRef.get()).get('state'), 'uncertain');
    clock += PUSH_LEASE_MS+1;
    await recuperarAvisosPendentes(db, options); await enviarAviso(db, crash, options);
    assert.equal(calls, 2);
    console.log('PASS: ambiguous dispatch is not automatically retried.');

    const recovery = aviso('recover'); const recoveryRef = db.doc('pushDedupe/'+recovery.dedupeKey); references.push(recoveryRef);
    let block; const barrier = new Promise(resolve => { block = resolve; }); let stopped = false;
    const delayed = new Proxy(db, { get(target, prop) {
      if (prop === 'collection') return name => {
        const query = target.collection(name);
        if (name !== 'pushTokens') return query;
        return new Proxy(query, { get(collection, field) {
          if (field === 'where') return (...args) => {
            const filtered = collection.where(...args);
            return { get: async () => { if (!stopped) { stopped = true; await barrier; } return filtered.get(); } };
          };
          const value = collection[field]; return typeof value === 'function' ? value.bind(collection) : value;
        } });
      };
      const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const old = enviarAviso(delayed, recovery, options);
    for (let i=0; !stopped && i<100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stopped, true); clock += PUSH_LEASE_MS+1;
    await recuperarAvisosPendentes(db, options); block(); await old;
    assert.equal(calls, 3); assert.equal((await recoveryRef.get()).get('state'), 'done');
    console.log('PASS: expired preparatory lease is recovered and the old owner is fenced out.');
  } finally {
    for (const reference of references) await reference.delete();
    await db.terminate(); await deleteApp(app);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
