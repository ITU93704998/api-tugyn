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
const M = require(path.join(root, 'api/_lib/modalidadesTime.ts'));
const L = require(path.join(root, 'api/_lib/timeLink.ts'));
const D = require(path.join(root, 'api/_lib/campeonatosTimesDominio.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

test('modalidades do time: a principal primeiro, sem repetir; times antigos só pela principal', () => {
  assert.deepEqual(M.modalidadesDoTime({ modalidade: 'futsal' }), ['futsal']);
  assert.deepEqual(M.modalidadesDoTime({ modalidade: 'futsal', modalidades: ['society', 'futsal', 'praia', 'society'] }), ['futsal', 'society']);
  assert.deepEqual(M.modalidadesDoTime({}), ['society']);
  assert.equal(M.rotuloModalidades({ modalidade: 'society', modalidades: ['society', 'futsal'] }), 'Society · Futsal');
  assert.ok(M.jogaModalidade({ modalidade: 'society', modalidades: ['society', 'futsal'] }, 'futsal'));
  assert.ok(!M.jogaModalidade({ modalidade: 'society' }, 'futsal'));
  assert.deepEqual(M.modalidadesEmComum({ modalidade: 'society', modalidades: ['society', 'futsal'] }, { modalidade: 'futsal', modalidades: ['futsal', 'campo'] }), ['futsal']);
});

test('posição por modalidade: com o mapa, só ele (desmarcada fica sem); sem o mapa, a antiga onde existe; treinador vale para todas', () => {
  const camisa = { posicao: 'meia', posicoes: { society: 'meia', futsal: 'ala' } };
  assert.equal(M.posicaoNaModalidade(camisa, 'futsal'), 'ala');
  // Com o mapa, campo sem posição é campo sem posição (não volta a "meia").
  assert.equal(M.posicaoNaModalidade(camisa, 'campo'), '');
  assert.equal(M.posicaoNaModalidade({ posicao: 'goleiro', posicoes: { society: 'goleiro' } }, 'futsal'), '');
  assert.equal(M.posicaoNaModalidade({ posicao: 'meia' }, 'campo'), 'meia');
  assert.equal(M.posicaoNaModalidade({ posicao: 'meia' }, 'futsal'), '');
  assert.equal(M.posicaoNaModalidade({ posicao: 'goleiro' }, 'futsal'), 'goleiro');
  assert.equal(M.posicaoNaModalidade({ posicao: 'treinador', posicoes: { futsal: 'ala' } }, 'futsal'), 'treinador');
  assert.equal(M.posicaoNaModalidade({ posicoes: { futsal: 'volante' } }, 'futsal'), '');
  assert.equal(M.posicaoNaModalidade(null, 'society'), '');
});

test('página pública do time: todas as modalidades e a posição da principal', () => {
  const t = L.timeDoDocumento({
    nome: 'Real', cor: '#123456', donoId: 'dono', modalidade: 'futsal', modalidades: ['futsal', 'society'],
    jogadores: { ana: { nome: 'Ana' } }, camisas: { ana: { posicao: 'meia', posicoes: { society: 'meia', futsal: 'pivo' } } },
  });
  assert.match(t.detalhes, /^Futsal · Society/);
  assert.equal(t.jogadores[0].posicao, 'Pivô');
});

test('campeonato: o time entra se joga a modalidade, e o atleta vai com a posição dela', () => {
  const time = { donoId: 'dono', modalidade: 'society', modalidades: ['society', 'futsal'], genero: 'masculino', faixaEtaria: 'livre', membros: ['a'],
    jogadores: { a: { nome: 'Ana' } }, camisas: { a: { posicao: 'meia', posicoes: { society: 'meia', futsal: 'ala' } } } };
  const camp = { modalidade: 'futsal', genero: 'livre', minJogadores: 1, maxJogadores: 10 };
  const [atleta] = D.elencoCT(time, camp, 'dono', ['a']);
  assert.equal(atleta.posicao, 'ala');
  assert.throws(() => D.elencoCT({ ...time, modalidades: ['society'] }, camp, 'dono', ['a']), /modalidade/);
});
