// Mapa de usuários do painel: totais por estado e cidade, sem nomes nem coordenadas.
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
const M = require(path.join(root, 'api/_lib/mapaUsuarios.ts'));
if (anterior) require.extensions['.ts'] = anterior;
else delete require.extensions['.ts'];

const loc = (city, state, cityId) => ({ location: { city, state, cityId } });

test('localização: usa o cityId gravado, deduz a UF dele e gera o id pela cidade', () => {
  assert.deepEqual(M.localizacaoDoPerfil(loc('Palmas', 'TO', 'palmas_to')), { id: 'palmas_to', cidade: 'Palmas', uf: 'TO' });
  assert.deepEqual(M.localizacaoDoPerfil(loc('São Paulo', 'sp')), { id: 'sao_paulo_sp', cidade: 'São Paulo', uf: 'SP' });
  assert.deepEqual(M.localizacaoDoPerfil(loc('', 'Tocantins', 'palmas_to')), { id: 'palmas_to', cidade: '', uf: 'TO' }, 'UF por extenso: vem do id');
  assert.deepEqual(M.localizacaoDoPerfil(loc('', 'GO')), { id: '', cidade: '', uf: 'GO' }, 'só o estado');
  assert.equal(M.localizacaoDoPerfil(loc('Lisboa', 'PT')), null);
  assert.equal(M.localizacaoDoPerfil({}), null);
  assert.deepEqual(M.localizacaoDoPerfil(loc('Palmas', 'TO', 'goiania_go')), { id: 'palmas_to', cidade: 'Palmas', uf: 'TO' }, 'id de outro estado é ignorado');
});

test('agregar: soma por estado e cidade, deixa de fora suspensos e em exclusão', () => {
  const m = M.agregar([
    loc('Palmas', 'TO', 'palmas_to'), loc('Palmas', 'TO', 'palmas_to'), loc('Gurupi', 'TO'),
    loc('', 'GO'), {}, { ...loc('Palmas', 'TO'), status: 'suspended' }, { ...loc('Palmas', 'TO'), excluindoEm: 1 },
  ], 123);
  assert.equal(m.perfis, 5);
  assert.equal(m.ignorados, 2);
  assert.equal(m.semLocalizacao, 1);
  assert.equal(m.comLocalizacao, 4);
  assert.deepEqual(m.porEstado, { TO: 3, GO: 1 });
  assert.deepEqual(m.cidades.map((c) => [c.id, c.total]), [['palmas_to', 2], ['gurupi_to', 1]]);
  assert.equal(m.geradoEm, 123);
  assert.ok(!JSON.stringify(m).includes('uid'), 'sem identificadores');
});

test('agregar: guarda as maiores cidades e soma o resto em outrasCidades', () => {
  const perfis = [];
  for (let i = 0; i < M.CIDADES_MAX + 5; i++) perfis.push(loc(`Cidade ${i}`, 'MG'));
  perfis.push(loc('Cidade 0', 'MG'));
  const m = M.agregar(perfis, 1);
  assert.equal(m.cidades.length, M.CIDADES_MAX);
  assert.equal(m.cidades[0].id, 'cidade_0_mg');
  assert.equal(m.outrasCidades, 5);
  assert.equal(m.porEstado.MG, M.CIDADES_MAX + 6);
});

test('rota: mapa e gerar-mapa ficam na rota de administradores, com limite de 3 por hora', () => {
  const src = fs.readFileSync(path.join(root, 'api/_lib/adminUsuarios.ts'), 'utf8');
  assert.match(src, /body\.action === "mapa"/);
  assert.match(src, /dentroDoLimite\(user\.uid, "admin-mapa", 3, 3600\)/);
  assert.ok(src.indexOf('if (!user.admin)') < src.indexOf('body.action === "mapa"'));
});
