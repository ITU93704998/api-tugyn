// Retenção por semana de cadastro e funil de ativação (painel › Estatísticas).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib/adminUsuarios.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module_ = { exports: {} };
const stub = new Proxy({}, { get: () => () => ({}) });
vm.runInNewContext(source, { exports: module_.exports, module: module_, require: () => stub, Date, Intl, console, Set, Map });
const M = module_.exports;
// Objetos criados no vm têm outro protótipo: compara pelo conteúdo.
const j = (v) => JSON.parse(JSON.stringify(v));

const DIA = 86_400_000;
// Quarta-feira, 25/11/2026, 15h UTC (12h em Brasília).
const AGORA = Date.parse('2026-11-25T15:00:00Z');

test('retenção: semanas começam na segunda (Brasília) e vêm da mais recente para a mais antiga', () => {
  assert.equal(M.segundaDaSemana('2026-11-25'), '2026-11-23');
  assert.equal(M.segundaDaSemana('2026-11-23'), '2026-11-23');
  assert.equal(M.segundaDaSemana('2026-11-22'), '2026-11-16', 'domingo pertence à semana anterior');
  const r = M.retencaoPorCoorte([], AGORA, 3);
  assert.deepEqual(j(r.map((c) => c.semana)), ['2026-11-23', '2026-11-16', '2026-11-09']);
  assert.deepEqual(j(r[0]), { semana: '2026-11-23', cadastros: 0, d1: null, d7: null, d30: null });
});

test('retenção: voltou depois de N dias = último uso pelo menos N dias depois da criação; só conta quem já tem N dias', () => {
  const criada = AGORA - 40 * DIA; // semana de 12/10
  const contas = [
    { criadaEm: criada, ultimoUso: criada + 2 * 3600_000 },       // só no primeiro dia
    { criadaEm: criada, ultimoUso: criada + 3 * DIA },            // voltou depois de 1 dia
    { criadaEm: criada, ultimoUso: criada + 35 * DIA },           // voltou depois de 30 dias
    { criadaEm: AGORA - 2 * DIA, ultimoUso: AGORA - DIA / 2 },     // semana atual: D1 sim, D7/D30 ainda não elegível
  ];
  const r = M.retencaoPorCoorte(contas, AGORA, 12);
  const antiga = r.find((c) => c.semana === M.segundaDaSemana(new Date(criada - 3 * 3600_000).toISOString().slice(0, 10)));
  assert.equal(antiga.cadastros, 3);
  assert.deepEqual(j(antiga.d1), { elegiveis: 3, voltaram: 2 });
  assert.deepEqual(j(antiga.d7), { elegiveis: 3, voltaram: 1 }, 'voltar 3 dias depois não é voltar depois de 7');
  assert.deepEqual(j(antiga.d30), { elegiveis: 3, voltaram: 1 });
  assert.equal(r[0].cadastros, 1);
  assert.deepEqual(j(r[0].d1), { elegiveis: 1, voltaram: 1 });
  assert.equal(r[0].d7, null);
  assert.equal(r[0].d30, null);
});

test('retenção: conta sem data ou fora das 12 semanas é ignorada', () => {
  const r = M.retencaoPorCoorte([{ criadaEm: 0, ultimoUso: AGORA }, { criadaEm: AGORA - 200 * DIA, ultimoUso: AGORA }], AGORA);
  assert.equal(r.reduce((s, c) => s + c.cadastros, 0), 0);
});

test('funil: janela de 90 a 7 dias atrás, mais recentes primeiro', () => {
  const contas = [
    { uid: 'nova', criadaEm: AGORA - 2 * DIA },
    { uid: 'a', criadaEm: AGORA - 10 * DIA },
    { uid: 'b', criadaEm: AGORA - 50 * DIA },
    { uid: 'velha', criadaEm: AGORA - 120 * DIA },
  ];
  assert.deepEqual(j(JSON.parse(JSON.stringify(M.contasDoFunil(contas, AGORA)))), { uids: ['a', 'b'], parcial: false });
});

test('funil: cada etapa só conta quem passou pelas anteriores', () => {
  const f = M.resumirFunil(['a', 'b', 'c', 'd'], new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd']), new Set(['a', 'd']), false);
  assert.deepEqual(j(JSON.parse(JSON.stringify(f))), { desdeDias: 90, ateDias: 7, contas: 4, perfil: 3, turma: 2, jogou: 1, parcial: false });
});

test('funil: turmas consultadas em lotes de até 30 contas (array-contains-any), nunca a coleção inteira', () => {
  const uids = Array.from({ length: 65 }, (_, i) => 'u' + i);
  const lotes = M.lotesDeUids(uids);
  assert.deepEqual(j(lotes.map((l) => l.length)), [30, 30, 5]);
  assert.deepEqual(j(M.lotesDeUids([])), []);
  const fonte = require('node:fs').readFileSync(require('node:path').join(root, 'api/_lib/adminUsuarios.ts'), 'utf8');
  assert.ok(!fonte.includes(`collection("turmas").select("participantes").get()`), "não ler todas as turmas");
  assert.ok(fonte.includes(`"array-contains-any", lote`), "consulta só as turmas das contas do lote");
  assert.ok(fonte.includes("calcularFunil(db, lidas, agora, !completo)"), "leitura parcial do Auth marca o funil como parcial");
});
