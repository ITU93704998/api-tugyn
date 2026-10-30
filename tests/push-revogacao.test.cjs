// NOT-04: logout sem internet. Revogação sem login pela chave do cadastro e lease de 30 dias do token.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '..'), process.cwd()] }));
const root = path.resolve(__dirname, '..');
const token = 'ExpoPushToken[aaaaaaaaaaa1]';
function load(file, overrides = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const defaults = { 'node:crypto': require('node:crypto'), './validation': { isSafeUid: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) } };
  vm.runInNewContext(js, {
    module, exports: module.exports, Date, Buffer, process, AbortController, setTimeout, clearTimeout, fetch, console: { log() {}, warn() {}, error() {} },
    require(name) { if (name in overrides) return overrides[name]; if (name in defaults) return defaults[name]; throw Error('Missing mock '+name); },
  });
  return module.exports;
}
const push = load('api/_lib/push.ts');

test('chave de revogação: aleatória, só o hash é guardado e a comparação exige a chave certa', () => {
  const a = push.novaRevogacao(), b = push.novaRevogacao();
  assert.match(a.revogacao, /^[a-f0-9]{64}$/);
  assert.notEqual(a.revogacao, b.revogacao);
  assert.notEqual(a.revogacao, a.revogacaoHash);
  assert.equal(push.revogacaoConfere(a.revogacao, a.revogacaoHash), true);
  assert.equal(push.revogacaoConfere(b.revogacao, a.revogacaoHash), false);
  assert.equal(push.revogacaoConfere(a.revogacao, undefined), false, 'cadastro antigo sem chave não é revogável sem login');
});

test('pedido de revogar exige token e chave válidos', () => {
  const { revogacao } = push.novaRevogacao();
  assert.equal(push.parsePushBody({ action: 'revogar', token, revogacao }).ok, true);
  assert.equal(push.parsePushBody({ action: 'revogar', token, revogacao: 'x' }).ok, false);
  assert.equal(push.parsePushBody({ action: 'revogar', token: 'abc', revogacao }).ok, false);
});

test('lease: token não renovado há 30 dias não recebe aviso', () => {
  const agora = 100 * 24 * 3600_000;
  assert.equal(push.tokenNoPrazo(agora - 29 * 24 * 3600_000, agora), true);
  assert.equal(push.tokenNoPrazo(agora - 31 * 24 * 3600_000, agora), false);
  assert.equal(push.tokenNoPrazo(undefined, agora), true, 'registro antigo sem data continua (todos os cadastros gravam updatedAt)');
});

function rota() {
  const docs = new Map();
  const ref = p => ({ path: p, id: p.split('/').at(-1), get: async () => snap(p), set: async d => { docs.set(p, d); }, delete: async () => { docs.delete(p); } });
  const snap = p => ({ exists: docs.has(p), get: f => docs.get(p)?.[f], data: () => docs.get(p) });
  const db = {
    doc: ref,
    collection: () => ({ where: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
    runTransaction: async fn => fn({ get: async r => snap(r.path), delete: r => docs.delete(r.path) }),
  };
  let logado = null;
  const route = load('api/push.ts', {
    'firebase-admin/firestore': { getFirestore: () => db },
    './_lib/appCheck': { verificarAppCheck: async () => true },
    './_lib/auth': { getFirebaseApp: () => ({}), requireUser: async (req, res) => logado ?? (res.status(401).json({ error: 'login' }), null) },
    './_lib/rateLimit': { dentroDoLimite: async () => true },
    './_lib/push': push,
    './_lib/pushEnvio': {},
  });
  const chamar = async body => {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
    await route.default({ method: 'POST', headers: {}, body }, res);
    return res;
  };
  return { docs, chamar, logar: uid => { logado = { uid }; }, sair: () => { logado = null; } };
}

test('cadastro devolve a chave; depois do logout, só a chave do cadastro ATUAL apaga o token (sem login)', async () => {
  const r = rota();
  const caminho = 'pushTokens/'+push.tokenDocId(token);
  r.logar('contaA');
  const cadastroA = await r.chamar({ action: 'registrar', token, platform: 'android' });
  assert.equal(cadastroA.code, 200);
  const chaveA = cadastroA.body.revogacao;
  assert.match(chaveA, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(r.docs.get(caminho)).includes(chaveA), false, 'a chave em si não é guardada');
  assert.ok(r.docs.get(caminho).expiresAt instanceof Date);
  // O mesmo aparelho entra na conta B: a chave antiga de A não apaga mais o cadastro de B.
  r.logar('contaB');
  await r.chamar({ action: 'registrar', token, platform: 'android' });
  r.sair();
  const velha = await r.chamar({ action: 'revogar', token, revogacao: chaveA });
  assert.equal(velha.code, 200);
  assert.equal(r.docs.get(caminho).uid, 'contaB');
  // B sai sem internet; ao reconectar, a fila manda a chave de B, sem login.
  r.logar('contaB');
  const chaveB = (await r.chamar({ action: 'registrar', token, platform: 'android' })).body.revogacao;
  r.sair();
  const res = await r.chamar({ action: 'revogar', token, revogacao: chaveB });
  assert.equal(res.code, 200);
  assert.equal(r.docs.has(caminho), false);
  // Ações normais continuam exigindo login.
  assert.equal((await r.chamar({ action: 'remover', token })).code, 401);
});
