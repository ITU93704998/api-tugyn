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
const s = require(path.join(root, 'api/_lib/suspensao.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const SUSPENSA = { status: 'suspended' };

test('conta ativa (ou sem perfil) faz todas as ações', () => {
  for (const acao of s.ACOES_DA_API) {
    assert.equal(s.acaoPermitida({ status: 'active' }, acao), true, acao);
    assert.equal(s.acaoPermitida({}, acao), true, acao);
    assert.equal(s.acaoPermitida(null, acao), true, acao);
  }
});

test('conta suspensa só exclui a conta e apaga as próprias imagens', () => {
  const liberadas = s.ACOES_DA_API.filter((acao) => s.acaoPermitida(SUSPENSA, acao));
  assert.deepEqual(liberadas.sort(), ['apagar-midia', 'excluir-conta']);
  for (const acao of ['avaliar', 'desafiar', 'push', 'turma-gestao', 'upload', 'contratos-admin', 'contatos-admin']) {
    assert.equal(s.acaoPermitida(SUSPENSA, acao), false, acao);
  }
});

test('só o valor exato "suspended" suspende', () => {
  assert.equal(s.contaSuspensa({ status: 'Suspended' }), false);
  assert.equal(s.contaSuspensa({ status: ['suspended'] }), false);
  assert.equal(s.contaSuspensa(SUSPENSA), true);
});

test('conta em exclusão (marcador excluindoEm): indisponível e com as mesmas ações que a suspensa', () => {
  const excluindo = { status: 'active', excluindoEm: { seconds: 1 } };
  assert.equal(s.contaEmExclusao(excluindo), true);
  assert.equal(s.perfilDisponivel(excluindo), false);
  assert.equal(s.perfilDisponivel(SUSPENSA), false);
  assert.equal(s.perfilDisponivel(null), false);
  assert.equal(s.perfilDisponivel({ status: 'active' }), true);
  assert.equal(s.acaoPermitida(excluindo, 'avaliar'), false);
  assert.equal(s.acaoPermitida(excluindo, 'excluir-conta'), true);
});

test('toda rota com login declara uma ação conhecida', () => {
  const pasta = path.join(root, 'api');
  const arquivos = [];
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) andar(p);
      else if (e.name.endsWith('.ts') && e.name !== 'auth.ts') arquivos.push(p);
    }
  };
  andar(pasta);
  let chamadas = 0;
  for (const arquivo of arquivos) {
    const fonte = fs.readFileSync(arquivo, 'utf8');
    for (const m of fonte.matchAll(/requireUser\(([^)]*)\)/g)) {
      chamadas += 1;
      const acao = /,\s*"([^"]+)"\s*$/.exec(m[1])?.[1];
      assert.ok(acao && s.ACOES_DA_API.includes(acao), `${path.relative(root, arquivo)}: requireUser(${m[1]})`);
    }
  }
  assert.ok(chamadas >= 9, `esperava ao menos 9 rotas com login, achei ${chamadas}`);
});
