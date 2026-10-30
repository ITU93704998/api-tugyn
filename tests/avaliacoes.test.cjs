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
const a = require(path.join(root, 'api/_lib/avaliacoes.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const DIA = 24 * 3600_000;
const AGORA = Date.parse('2026-11-10T15:00:00Z');
const ts_ = (ms) => ({ toMillis: () => ms });
const NOTAS = { convivencia: 5, comprometimento: 4, fairPlay: 3 };

test('valida o corpo', () => {
  assert.deepEqual(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: 't1', notas: NOTAS }).value, { avaliadoId: 'u2', turmaId: 't1', notas: NOTAS });
  assert.equal(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: 't1', notas: { ...NOTAS, fairPlay: 6 } }).ok, false);
  assert.equal(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: 't1', notas: { ...NOTAS, fairPlay: 0 } }).ok, false);
  assert.equal(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: 't1', notas: { ...NOTAS, fairPlay: 2.5 } }).ok, false);
  assert.equal(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: 't1', notas: { ...NOTAS, extra: 1 } }).ok, false);
  assert.equal(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: 't1', notas: { convivencia: 5, comprometimento: 4 } }).ok, false);
  assert.equal(a.parseAvaliacaoBody({ avaliadoId: 'u2', turmaId: '../x', notas: NOTAS }).ok, false);
  assert.equal(a.parseAvaliacaoBody({ turmaId: 't1', notas: NOTAS }).ok, false);
});

const base = {
  uid: 'a', avaliadoId: 'b', agoraMs: AGORA,
  turma: { participantes: ['a', 'b'], status: 'ativa' },
  perfilAvaliado: { name: 'Beto' }, bloqueio: false, anterior: null,
};

test('autorização: casos permitidos e negados', () => {
  assert.deepEqual(a.autorizarAvaliacao(base), { ok: true, anteriores: null });
  assert.equal(a.autorizarAvaliacao({ ...base, avaliadoId: 'a' }).code, 'mesmo_atleta');
  assert.equal(a.autorizarAvaliacao({ ...base, perfilAvaliado: null }).code, 'atleta_nao_encontrado');
  assert.equal(a.autorizarAvaliacao({ ...base, perfilAvaliado: { status: 'suspended' } }).code, 'atleta_nao_encontrado');
  assert.equal(a.autorizarAvaliacao({ ...base, bloqueio: true }).code, 'bloqueado');
  assert.equal(a.autorizarAvaliacao({ ...base, turma: null }).code, 'sem_turma_em_comum');
  assert.equal(a.autorizarAvaliacao({ ...base, turma: { participantes: ['a', 'b'], status: 'encerrada' } }).code, 'sem_turma_em_comum');
  assert.equal(a.autorizarAvaliacao({ ...base, turma: { participantes: ['a', 'c'] } }).code, 'sem_turma_em_comum');
  assert.equal(a.autorizarAvaliacao({ ...base, turma: { participantes: ['b', 'c'] } }).code, 'sem_turma_em_comum');
});

test('uma vez por semana, e a edição devolve as notas anteriores', () => {
  const recente = { notas: NOTAS, atualizadoEm: ts_(AGORA - 6 * DIA) };
  const negado = a.autorizarAvaliacao({ ...base, anterior: recente });
  assert.equal(negado.code, 'aguarde_semana');
  assert.equal(negado.status, 429);
  assert.equal(negado.proximaEm, AGORA + DIA);

  const antiga = { notas: NOTAS, atualizadoEm: ts_(AGORA - 7 * DIA) };
  assert.deepEqual(a.autorizarAvaliacao({ ...base, anterior: antiga }), { ok: true, anteriores: NOTAS });
});

test('resumo: nova soma +1; edição só troca a diferença; remoção desfaz', () => {
  assert.deepEqual(a.deltaDoResumo(NOTAS, null), { convivencia: 5, comprometimento: 4, fairPlay: 3, total: 1 });
  assert.deepEqual(a.deltaDoResumo({ convivencia: 3, comprometimento: 4, fairPlay: 5 }, NOTAS), { convivencia: -2, comprometimento: 0, fairPlay: 2, total: 0 });
  assert.deepEqual(a.deltaDeRemocao(NOTAS), { convivencia: -5, comprometimento: -4, fairPlay: -3, total: -1 });
  assert.equal(a.notasDe({ notas: { convivencia: 9, comprometimento: 4, fairPlay: 3 } }), null);
  assert.equal(a.idDaAvaliacao('a', 'b'), 'a__b');
});
