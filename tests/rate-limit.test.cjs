// FIR-03: limitador barato sob abuso. Negado não grava, negado em memória não chama nada, Upstash lento cai no fallback, tudo falhando nega.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '..'), process.cwd()] }));
const root = path.resolve(__dirname, '..');

function carregar({ fetchImpl, falhaFirestore = false } = {}) {
  const docs = new Map();
  const contagem = { leituras: 0, escritas: 0, fetch: 0 };
  const db = {
    collection: () => ({ doc: (id) => ({ id }) }),
    runTransaction: async (fn) => {
      if (falhaFirestore) throw Error('firestore fora');
      return fn({
        get: async (ref) => { contagem.leituras++; const d = docs.get(ref.id); return { data: () => d }; },
        set: (ref, data) => { contagem.escritas++; docs.set(ref.id, data); },
      });
    },
  };
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib/rateLimit.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, {
    module, exports: module.exports, Date, Number, JSON, Error, AbortController, setTimeout, clearTimeout, process,
    fetch: async (...args) => { contagem.fetch++; return fetchImpl(...args); },
    console: { error() {}, log() {}, warn() {} },
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      if (name === 'firebase-admin/firestore') return { FieldValue: { serverTimestamp: () => 'ts' }, getFirestore: () => db };
      if (name === './auth') return { getFirebaseApp: () => ({}) };
      throw Error('mock ausente ' + name);
    },
  });
  return { rl: module.exports, contagem };
}

const comEnv = async (vars, fn) => {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('fallback Firestore: tentativa negada não grava e a seguinte nem lê', () => comEnv({ UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, async () => {
  const { rl, contagem } = carregar();
  for (let i = 0; i < 3; i++) assert.equal(await rl.dentroDoLimite('u1', 'acao', 3, 3600), true);
  assert.equal(contagem.escritas, 3);
  assert.equal(await rl.dentroDoLimite('u1', 'acao', 3, 3600), false);
  assert.equal(contagem.escritas, 3, 'negado sem escrita');
  const leituras = contagem.leituras;
  for (let i = 0; i < 50; i++) assert.equal(await rl.dentroDoLimite('u1', 'acao', 3, 3600), false);
  assert.equal(contagem.leituras, leituras, 'negado em memória: nenhuma leitura');
  assert.equal(await rl.dentroDoLimite('u2', 'acao', 3, 3600), true, 'outro usuário não é afetado');
}));

test('Upstash lento: timeout curto e fallback; Upstash negando também vai para a memória', () => comEnv({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }, async () => {
  const lento = carregar({ fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(Error('abort'), { name: 'AbortError' })))) });
  const inicio = Date.now();
  assert.equal(await lento.rl.dentroDoLimite('u', 'a', 5, 60), true);
  assert.ok(Date.now() - inicio < lento.rl.UPSTASH_TIMEOUT_MS + 500, 'não espera o Redis lento');
  assert.equal(lento.contagem.escritas, 1, 'usou o fallback');

  const negando = carregar({ fetchImpl: async () => ({ ok: true, json: async () => [{ result: 99 }, { result: 1 }] }) });
  assert.equal(await negando.rl.dentroDoLimite('u', 'a', 5, 60), false);
  assert.equal(await negando.rl.dentroDoLimite('u', 'a', 5, 60), false);
  assert.equal(negando.contagem.fetch, 1, 'a segunda negação não chama o Redis');
}));

test('tudo fora do ar: continua negando (fail-closed)', () => comEnv({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }, async () => {
  const { rl } = carregar({ fetchImpl: async () => { throw Error('rede'); }, falhaFirestore: true });
  assert.equal(await rl.dentroDoLimite('u', 'a', 5, 60), false);
}));
