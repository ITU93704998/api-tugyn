const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));
function load(file, dependencies) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, module, require: name => { if (name === 'node:crypto') return crypto; if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, Date, console: { log() {}, error() {} }, process });
  return module.exports;
}
const contactCore = load('contactCore.ts', {});
const SERVER_TS = { servidor: true };

function fixture(options = {}) {
  const docs = new Map(Object.entries({
    'users/u1': { name: 'João', userName: 'joao', status: 'suspended', suspensaEm: 500 },
    'users/u2': { name: 'Bia', userName: 'bia', status: 'active' },
    ...(options.docs ?? {}),
  }).map(([k, v]) => [k, { ...v }]));
  const contas = { 'joao@x.com': 'u1', 'bia@x.com': 'u2' };
  const limites = [];
  const db = {
    doc: key => ({
      get: async () => { const d = docs.get(key); return { exists: !!d, get: f => d?.[f] }; },
      set: async data => { docs.set(key, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === SERVER_TS ? 1000 : v]))); },
    }),
  };
  const mod = load('revisao.ts', {
    'firebase-admin/auth': { getAuth: () => ({ getUserByEmail: async e => { if (options.authFalha) throw Error('fora'); if (!contas[e]) throw Object.assign(Error('x'), { code: 'auth/user-not-found' }); return { uid: contas[e], email: e }; } }) },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => SERVER_TS } },
    './auth': { getFirebaseApp: () => ({}) },
    './contactCore': contactCore,
    './rateLimit': { dentroDoLimite: async (_chave, acao) => { limites.push(acao); return !(options.limitado ?? []).includes(acao); } },
  });
  async function request(body, { method = 'POST', origin } = {}) {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = JSON.parse(JSON.stringify(v)); return this; }, send() { return this; } };
    await mod.handleRevisao({ method, body, headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', ...(origin ? { origin } : {}) }, query: {} }, res);
    return res;
  }
  return { request, docs, limites, mod };
}
const MSG = 'Não fiz o que disseram, foi outra pessoa usando meu celular.';

test('conta suspensa: grava o pedido com os dados da conta', async () => {
  const f = fixture();
  const r = await f.request({ email: ' Joao@X.com ', mensagem: MSG, origem: 'app' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true });
  const p = f.docs.get('revisoes/u1');
  assert.deepEqual([p.uid, p.email, p.nome, p.userName, p.status, p.origem, p.suspensaEm, p.pedidosAnteriores], ['u1', 'joao@x.com', 'João', 'joao', 'aberta', 'app', 500, 0]);
  assert.deepEqual(f.limites, ['revisao-ip', 'revisao-email']);
});

test('e-mail sem conta ou conta ativa: mesma resposta e nada gravado', async () => {
  const f = fixture();
  for (const email of ['ninguem@x.com', 'bia@x.com']) {
    const r = await f.request({ email, mensagem: MSG });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { ok: true });
  }
  assert.equal([...f.docs.keys()].some(k => k.startsWith('revisoes/')), false);
});

test('pedido aberto não é sobrescrito; depois da decisão, pode pedir de novo', async () => {
  const f = fixture({ docs: { 'revisoes/u1': { status: 'aberta', mensagem: 'primeiro pedido original' } } });
  await f.request({ email: 'joao@x.com', mensagem: MSG });
  assert.equal(f.docs.get('revisoes/u1').mensagem, 'primeiro pedido original');
  f.docs.set('revisoes/u1', { status: 'negada', pedidosAnteriores: 0 });
  await f.request({ email: 'joao@x.com', mensagem: MSG, origem: 'site' });
  const p = f.docs.get('revisoes/u1');
  assert.deepEqual([p.status, p.pedidosAnteriores, p.origem], ['aberta', 1, 'site']);
});

test('validação, robô, limite e falha do servidor', async () => {
  const f = fixture();
  assert.equal((await f.request({}, { method: 'GET' })).statusCode, 405);
  assert.equal((await f.request({ email: 'nao-e-email', mensagem: MSG })).statusCode, 400);
  for (const mensagem of [undefined, 'curta demais', 'x'.repeat(1001)]) assert.equal((await f.request({ email: 'joao@x.com', mensagem })).statusCode, 400);
  const robo = await f.request({ email: 'joao@x.com', mensagem: MSG, site: 'http://spam' });
  assert.equal(robo.statusCode, 200);
  assert.equal(f.docs.has('revisoes/u1'), false);
  assert.equal((await fixture({ limitado: ['revisao-ip'] }).request({ email: 'joao@x.com', mensagem: MSG })).statusCode, 429);
  assert.equal((await fixture({ limitado: ['revisao-email'] }).request({ email: 'joao@x.com', mensagem: MSG })).statusCode, 429);
  assert.equal((await fixture({ authFalha: true }).request({ email: 'joao@x.com', mensagem: MSG })).statusCode, 503);
  assert.equal(f.mod.parseMensagem('  linha 1\r\n\r\n\r\n\r\nlinha 2 com\u0000 texto suficiente '), 'linha 1\n\nlinha 2 com  texto suficiente');
});

test('CORS só para o site; o app (sem Origin) não precisa', async () => {
  const f = fixture();
  const site = await f.request({}, { method: 'OPTIONS', origin: 'https://tugyn.com.br' });
  assert.equal(site.statusCode, 204);
  assert.equal(site.headers['Access-Control-Allow-Origin'], 'https://tugyn.com.br');
  const outro = await f.request({}, { method: 'OPTIONS', origin: 'https://malicioso.com' });
  assert.equal(outro.headers['Access-Control-Allow-Origin'], undefined);
  assert.deepEqual([...f.mod.origensDoSite('https://a.com/, ftp://b, *')], ['https://a.com']);
});
