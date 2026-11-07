// Universal Links / App Links: arquivos de autorização do domínio (servidos por /api/version via rewrite).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));

const mod = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib/appLinks.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { module: mod, exports: mod.exports, require: () => ({}), console: { error() {} }, process: { env: {} }, JSON },
);
const L = mod.exports;
const json = (v) => JSON.parse(JSON.stringify(v));
const SHA = 'ab:cd:'.repeat(16).slice(0, -1); // 32 pares

const pedir = (resource, env) => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; }, send(v) { this.body = JSON.parse(v); return this; } };
  L.handleAppLinks({ method: 'GET', query: { resource } }, res, env);
  return res;
};

test('iOS: appID = Team ID + bundle, só os caminhos de turma e time, application/json', () => {
  const res = pedir('apple-app-site-association', { APPLE_TEAM_ID: 'abcde12345' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  const d = res.body.applinks.details[0];
  assert.deepEqual(d.appIDs, ['ABCDE12345.com.tugyn.tugynfut']);
  assert.deepEqual(json(d.components), [{ '/': '/api/turma/*' }, { '/': '/api/time/*' }]);
  // Só o formato moderno: nada do antigo misturado.
  assert.deepEqual(Object.keys(d).sort(), ['appIDs', 'components']);
  assert.deepEqual(Object.keys(res.body.applinks), ['details']);
});

test('Android: pacote do app e impressões digitais normalizadas (com ou sem ":")', () => {
  const sem = 'AB'.repeat(32);
  const res = pedir('assetlinks', { ANDROID_SHA256_FINGERPRINTS: `${SHA}, ${sem}` });
  assert.equal(res.statusCode, 200);
  const alvo = res.body[0].target;
  assert.equal(alvo.package_name, 'com.tugynfut.tugyn');
  assert.deepEqual(alvo.sha256_cert_fingerprints, [SHA.toUpperCase(), 'AB:'.repeat(31) + 'AB']);
  assert.deepEqual(res.body[0].relation, ['delegate_permission/common.handle_all_urls']);
});

test('sem configuração (ou inválida): 404, e os links continuam abrindo no navegador', () => {
  assert.equal(pedir('apple-app-site-association', {}).statusCode, 404);
  assert.equal(pedir('apple-app-site-association', { APPLE_TEAM_ID: 'curto' }).statusCode, 404);
  assert.equal(pedir('assetlinks', {}).statusCode, 404);
  assert.equal(pedir('assetlinks', { ANDROID_SHA256_FINGERPRINTS: 'xyz' }).statusCode, 404, 'uma impressão inválida recusa tudo');
});

test('vercel.json: os dois arquivos chegam na rota certa, sem redirecionamento', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const de = (s) => v.rewrites.find((r) => r.source === s)?.destination;
  assert.equal(de('/.well-known/apple-app-site-association'), '/api/version?resource=apple-app-site-association');
  assert.equal(de('/.well-known/assetlinks.json'), '/api/version?resource=assetlinks');
  assert.equal(v.redirects, undefined);
});
