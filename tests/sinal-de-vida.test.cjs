// Sinal de vida da rotina diária para o monitor externo (HEARTBEAT_URL).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const anterior = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const S = require(path.join(root, 'api/_lib/sinalDeVida.ts'));
if (anterior) require.extensions['.ts'] = anterior;
else delete require.extensions['.ts'];

const URL_OK = 'https://hc-ping.com/abc-123';

test('sinal de vida: sem endereço ou endereço inseguro não envia nada', () => {
  assert.equal(S.montarSinalDeVida(undefined, true, []), null);
  assert.equal(S.montarSinalDeVida('  ', true, []), null);
  assert.equal(S.montarSinalDeVida('http://hc-ping.com/abc', true, []), null, 'só https');
  assert.equal(S.montarSinalDeVida('https://user:senha@hc-ping.com/abc', true, []), null, 'sem credencial na URL');
  assert.equal(S.montarSinalDeVida('não é url', true, []), null);
});

test('sinal de vida: rotina completa vai no endereço; parcial vai em /fail com os códigos', () => {
  assert.deepEqual(S.montarSinalDeVida(URL_OK + '/', true, []), { url: URL_OK, corpo: 'ok' });
  const falha = S.montarSinalDeVida(URL_OK, false, ['push_recibos_falhas:3', 'etapa falhou: <x>']);
  assert.equal(falha.url, URL_OK + '/fail');
  assert.equal(falha.corpo, 'push_recibos_falhas:3\netapa_falhou:__x_');
  assert.equal(S.montarSinalDeVida(URL_OK, false, []).corpo, 'falha');
});

test('sinal de vida: erro de rede ou resposta ruim nunca derruba a rotina', async () => {
  const chamadas = [];
  await S.enviarSinalDeVida(false, ['x'], URL_OK, async (url, init) => { chamadas.push([url, init.body]); return { ok: false, status: 500 }; });
  assert.deepEqual(chamadas, [[URL_OK + '/fail', 'x']]);
  await S.enviarSinalDeVida(true, [], URL_OK, async () => { throw new Error('rede'); });
  await S.enviarSinalDeVida(true, [], undefined, async () => { throw new Error('não deveria chamar'); });
});
