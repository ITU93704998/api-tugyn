// Mudar as datas do campeonato entre times (organizador, antes do início): regras do prazo e quem recebe o aviso.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const antes = require.extensions['.ts'];
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, f);
const S = require('../api/_lib/campeonatosTimesServico.ts');
if (antes) require.extensions['.ts'] = antes; else delete require.extensions['.ts'];

const DIA = 86_400_000, NOW = Date.UTC(2026, 10, 16, 15);
const ID = 'ct_' + 'b'.repeat(24), CT = `campeonatosTimes/${ID}`;

/** Firestore falso só com o que a ação usa: docs, consulta de inscrições por status e transação simples. */
function banco(docs) {
  const mapa = new Map(Object.entries(docs));
  const snap = (p) => ({ exists: mapa.has(p), id: p.split('/').pop(), data: () => mapa.get(p), get: (k) => mapa.get(p)?.[k] });
  const consulta = (pasta, filtro) => ({
    where: (campo, op, valor) => consulta(pasta, (d) => (op === 'in' ? valor.includes(d[campo]) : d[campo] === valor)),
    limit: () => consulta(pasta, filtro),
    _ler: () => { const docsQ = [...mapa].filter(([p, d]) => p.startsWith(pasta + '/') && !p.slice(pasta.length + 1).includes('/') && (!filtro || filtro(d))).map(([p]) => snap(p)); return { docs: docsQ, size: docsQ.length, empty: !docsQ.length }; },
  });
  const ref = (p) => ({ path: p, id: p.split('/').pop(), collection: (n) => consulta(`${p}/${n}`) });
  return {
    mapa,
    doc: ref,
    collection: (n) => consulta(n),
    async runTransaction(fn) {
      const escritas = [];
      const r = await fn({
        get: async (alvo) => (alvo._ler ? alvo._ler() : snap(alvo.path)),
        getAll: async (...refs) => refs.map((x) => snap(x.path)),
        update: (alvo, v) => escritas.push(() => mapa.set(alvo.path, { ...mapa.get(alvo.path), ...v })),
        set: (alvo, v) => escritas.push(() => mapa.set(alvo.path, v)),
      });
      escritas.forEach((e) => e());
      return r;
    },
  };
}

const base = (extra = {}) => banco({
  'users/org': { name: 'Org' }, 'users/d1': { name: 'Dono' },
  [CT]: { nome: 'Copa', status: 'inscricoes', organizadorId: 'org', inscricoesAte: NOW - DIA, dataInicio: null, envolvidos: ['org', 'saiu', 'a1', 'd1', 'd2'], mesarios: [{ uid: 'mes' }], locais: [], ...extra },
  [`${CT}/inscricoes/t1`]: { status: 'aprovada', donoId: 'd1', timeId: 't1', jogadores: [{ id: 'a1' }, { id: 'a2' }] },
  [`${CT}/inscricoes/t2`]: { status: 'pendente', donoId: 'd2', timeId: 't2', jogadores: [] },
  [`${CT}/inscricoes/t3`]: { status: 'cancelada', donoId: 'saiu', timeId: 't3', jogadores: [] },
});

test('datas: com as inscrições encerradas, dá para mudar só o início', async () => {
  const db = base();
  const avisos = await S.administrarCT(db, 'org', { acao: 'alterarDatas', campeonatoId: ID, inscricoesAte: NOW - DIA, dataInicio: NOW + 3 * DIA }, NOW);
  assert.equal(db.mapa.get(CT).inscricoesAte, NOW - DIA);
  assert.equal(db.mapa.get(CT).dataInicio, NOW + 3 * DIA);
  assert.equal(avisos.length, 1);
});

test('datas: o aviso vai para quem está no campeonato agora (não para quem já saiu) e nunca para o organizador', async () => {
  const db = base();
  const [aviso] = await S.administrarCT(db, 'org', { acao: 'alterarDatas', campeonatoId: ID, inscricoesAte: NOW + 5 * DIA, dataInicio: null }, NOW);
  assert.deepEqual([...aviso.recipientUids].sort(), ['a1', 'a2', 'd1', 'd2', 'mes']);
});

test('datas: prazo novo no passado, início antes das inscrições ou depois do início são recusados', async () => {
  await assert.rejects(S.administrarCT(base(), 'org', { acao: 'alterarDatas', campeonatoId: ID, inscricoesAte: NOW - 2 * DIA, dataInicio: null }, NOW), /Prazo de inscrição/);
  await assert.rejects(S.administrarCT(base(), 'org', { acao: 'alterarDatas', campeonatoId: ID, inscricoesAte: NOW + 5 * DIA, dataInicio: NOW + 2 * DIA }, NOW), /Início do campeonato/);
  await assert.rejects(S.administrarCT(base({ status: 'em_andamento' }), 'org', { acao: 'alterarDatas', campeonatoId: ID, inscricoesAte: NOW + 5 * DIA, dataInicio: null }, NOW), /antes do início/);
  await assert.rejects(S.administrarCT(base(), 'd1', { acao: 'alterarDatas', campeonatoId: ID, inscricoesAte: NOW + 5 * DIA, dataInicio: null }, NOW), /organizador/);
});
