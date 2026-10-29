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
const { somarEstatisticas, jogadoresParaRecalcular, parseJogadores, turmaAtiva, MAX_JOGADORES_RECALCULO } = require(path.join(root, 'api/_lib/estatisticas.ts'));
const { parseGestaoBody } = require(path.join(root, 'api/_lib/turmaGestao.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

test('soma todas as turmas aprovadas e conta as ativas', () => {
  const turmas = [{ status: 'ativa' }, { status: 'encerrada' }, { ativo: false }, {}, { status: 'ativa' }];
  const participantes = [
    { status: 'aprovado', gols: 3, assistencias: 1, jogos: 5, vitorias: 2 },
    { status: 'aprovado', gols: 2, assistencias: 2, jogos: 4, vitorias: 1 },
    { status: 'aprovado', gols: 1, jogos: 1 },
    { status: 'pendente', gols: 9, jogos: 9 }, // pedido pendente não conta
    null, // documento não existe
  ];
  assert.deepEqual(somarEstatisticas(turmas, participantes), {
    gols: 6, assistencias: 3, jogos: 10, vitorias: 3, turmas: 3, turmasAtivas: 1,
  });
});

test('dados estranhos não estragam a soma', () => {
  const total = somarEstatisticas([{}], [{ status: 'aprovado', gols: -4, assistencias: 'x', jogos: 2.7, vitorias: NaN }]);
  assert.deepEqual(total, { gols: 0, assistencias: 0, jogos: 2, vitorias: 0, turmas: 1, turmasAtivas: 1 });
  assert.deepEqual(somarEstatisticas([], []), { gols: 0, assistencias: 0, jogos: 0, vitorias: 0, turmas: 0, turmasAtivas: 0 });
  assert.equal(turmaAtiva({ status: 'encerrada' }), false);
  assert.equal(turmaAtiva({ ativo: false }), false);
  assert.equal(turmaAtiva({}), true);
});

test('recálculo da partida: só o organizador e só membros da turma', () => {
  const turma = { creatorId: 'dono', participantes: ['dono', 'ana', 'beto'] };
  assert.deepEqual(jogadoresParaRecalcular('dono', turma, ['ana', 'ana', 'estranho', 'beto']), { ok: true, jogadores: ['ana', 'beto'] });
  assert.equal(jogadoresParaRecalcular('ana', turma, ['ana']).code, 'nao_organizador');
  assert.equal(jogadoresParaRecalcular('dono', null, ['ana']).status, 404);
});

test('valida a lista de jogadores e as novas ações', () => {
  assert.deepEqual(parseJogadores(['a', 'b', 'a']), ['a', 'b']);
  assert.equal(parseJogadores([]), null);
  assert.equal(parseJogadores('a'), null);
  assert.equal(parseJogadores(['../x']), null);
  assert.equal(parseJogadores(Array.from({ length: MAX_JOGADORES_RECALCULO + 1 }, (_, i) => `u${i}`)), null);

  assert.deepEqual(parseGestaoBody({ action: 'estatisticas-proprias', uid: 'outro' }), { ok: true, value: { action: 'estatisticas-proprias' } });
  assert.deepEqual(parseGestaoBody({ action: 'estatisticas', turmaId: 't1', jogadores: ['ana'] }).value, { action: 'estatisticas', turmaId: 't1', jogadores: ['ana'] });
  assert.equal(parseGestaoBody({ action: 'estatisticas', turmaId: 't1' }).ok, false);
  assert.equal(parseGestaoBody({ action: 'estatisticas', jogadores: ['ana'] }).ok, false);
});
