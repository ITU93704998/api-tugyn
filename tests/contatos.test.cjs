const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));
function load(file, dependencies) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, module, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, Date, console, process });
  return module.exports;
}
const core = load('contactCore.ts', {});
const contacts = { supportEmail: 'suporte@example.com', commercialEmail: 'ads@example.com' };
function fixture(options = {}) {
  let data = options.data === undefined ? { ...contacts, version: 2, updatedBy: 'private-uid', secret: 'never-public' } : options.data;
  let reads = 0, writes = 0;
  const snap = () => ({ exists: !!data, data: () => data });
  const db = {
    doc: name => ({ get: async () => { reads++; if (options.failure) throw Error('unavailable'); return name === 'adsConfig/contratos' ? { data: () => ({ contato: { email: 'legacy@example.com' } }) } : snap(); } }),
    runTransaction: async callback => callback({ get: async () => snap(), set: (_, next) => { writes++; data = next; } }),
  };
  const handler = load('contatos.ts', {
    './contactCore': core,
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'timestamp' } },
    './auth': { getFirebaseApp: () => ({}), requireUser: async (_, res) => { if (options.anonymous) { res.status(401).json({ error: 'unauthorized' }); return null; } return { uid: 'admin-uid', admin: !options.nonAdmin }; } },
    './cors': { handleCors: () => false },
    './rateLimit': { dentroDoLimite: async () => !options.limited },
  });
  async function request(method, body) {
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; } };
    await handler.handleContacts({ method, body, headers: {} }, res);
    return res;
  }
  return { request, counts: () => ({ reads, writes }) };
}
test('rejects mail headers, URLs, malformed domains and multiple addresses', () => {
  for (const email of ['a@example.com\r\nBcc:x@y.com', 'mailto:a@example.com', 'a@-example.com', '.a@example.com', 'a..b@example.com', 'a@example.com,b@example.com', 'a@localhost', 'a?subject=x@example.com', 'a%0d@example.com', 'a b@example.com']) assert.equal(core.validEmail(email), false, email);
  assert.equal(core.validEmail('suporte+app@example.com.br'), true);
});
test('public GET exposes only addresses and deduplicates cached reads', async () => {
  const f = fixture();
  const responses = await Promise.all([f.request('GET'), f.request('GET')]);
  assert.deepEqual(responses[0].body, contacts);
  assert.equal(responses[0].headers['Access-Control-Allow-Origin'], '*');
  assert.equal(f.counts().reads, 1);
});
test('first load preserves legacy commercial contact', async () => {
  const response = await fixture({ data: null }).request('GET');
  assert.equal(response.body.commercialEmail, 'legacy@example.com');
});
test('anonymous and non-admin cannot read admin state or write', async () => {
  for (const options of [{ anonymous: true }, { nonAdmin: true }]) {
    const f = fixture(options);
    assert.equal((await f.request('POST', { action: 'save', version: 2, contacts })).statusCode, options.anonymous ? 401 : 403);
    assert.equal(f.counts().writes, 0);
    assert.equal((await f.request('POST', { action: 'read' })).statusCode, options.anonymous ? 401 : 403);
  }
});
test('rejects extra fields and invalid addresses without writing', async () => {
  for (const invalid of [{ ...contacts, uid: 'forged' }, { ...contacts, supportEmail: 'wrong' }]) {
    const f = fixture();
    assert.equal((await f.request('POST', { action: 'save', contacts: invalid, version: 2 })).statusCode, 400);
    assert.equal(f.counts().writes, 0);
  }
});
test('save increments revision and prevents overwriting a newer revision', async () => {
  const f = fixture();
  const saved = await f.request('POST', { action: 'save', contacts, version: 2 });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.version, 3);
  assert.equal(saved.headers['Cache-Control'], 'no-store');
  assert.equal((await f.request('POST', { action: 'save', contacts, version: 2 })).statusCode, 409);
  assert.equal(f.counts().writes, 1);
});
test('rate-limited admin cannot write', async () => {
  const f = fixture({ limited: true });
  assert.equal((await f.request('POST', { action: 'save', contacts, version: 2 })).statusCode, 429);
  assert.equal(f.counts().writes, 0);
});
test('read failure returns non-cacheable 503 instead of replacing cached client data', async () => {
  const response = await fixture({ failure: true }).request('GET');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});
