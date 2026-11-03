const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { falhaDeInfraestrutura } = require(path.join(root, 'api/_lib/auth.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

test('erro interno ou de rede do Firebase Auth vira 503 (tentar de novo), não "sessão expirada"', () => {
  for (const codigo of ['auth/internal-error', 'auth/network-request-failed', 'app/network-error']) assert.equal(falhaDeInfraestrutura(codigo), true, codigo);
});

test('token ruim continua sendo 401', () => {
  for (const codigo of ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error', 'auth/user-disabled', undefined, 42]) assert.equal(falhaDeInfraestrutura(codigo), false, String(codigo));
});
