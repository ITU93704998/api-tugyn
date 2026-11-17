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

test('editarInfo: muda sobre, regulamento e premiação antes do início', async () => {
  const db = base();
  const avisos = await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: ' Copa nova ', regrasTexto: 'Regra 1', premiacao: { valorCentavos: 50000, trofeus: true, medalhas: false, texto: 'Troféu' } }, NOW);
  const c = db.mapa.get(CT);
  assert.equal(c.descricao, 'Copa nova');
  assert.equal(c.regrasTexto, 'Regra 1');
  assert.deepEqual(c.premiacao, { valorCentavos: 50000, trofeus: true, medalhas: false, texto: 'Troféu' });
  // Regulamento e premiação mudaram: um aviso para quem está no campeonato agora (sem o organizador).
  assert.equal(avisos.length, 1);
  assert.deepEqual([...avisos[0].recipientUids].sort(), ['a1', 'a2', 'd1', 'd2', 'mes']);
  assert.match(avisos[0].draft.body, /a premiação e o regulamento/);
});

test('editarInfo: recusado depois do início, para quem não organiza e com texto grande demais', async () => {
  const ok = { acao: 'editarInfo', campeonatoId: ID, descricao: 'x', regrasTexto: '', premiacao: {} };
  await assert.rejects(S.administrarCT(base({ status: 'em_andamento' }), 'org', ok, NOW), /antes do início/);
  await assert.rejects(S.administrarCT(base(), 'd1', ok, NOW), /organizador/);
  await assert.rejects(S.administrarCT(base(), 'org', { ...ok, regrasTexto: 'a'.repeat(5001) }, NOW), /Regulamento/);
});

test('editarInfo: muda o valor da inscrição e mantém quando não vem', async () => {
  const db = base({ inscricaoCentavos: 5000 });
  await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'x', regrasTexto: '', premiacao: {} }, NOW);
  assert.equal(db.mapa.get(CT).inscricaoCentavos, 5000);
  await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'x', regrasTexto: '', premiacao: {}, inscricaoCentavos: 12000 }, NOW);
  assert.equal(db.mapa.get(CT).inscricaoCentavos, 12000);
  await assert.rejects(S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'x', regrasTexto: '', premiacao: {}, inscricaoCentavos: -1 }, NOW), /Valor da inscrição/);
});

test('papel em Meus campeonatos: organizador (com pedidos), mesário e jogador', () => {
  const d = { organizadorId: 'org', pendentes: 2, mesarios: [{ uid: 'mes' }] };
  assert.deepEqual(S.papelCT(d, 'org'), { papel: 'organizador', pendentes: 2 });
  assert.deepEqual(S.papelCT(d, 'mes'), { papel: 'mesario' });
  assert.deepEqual(S.papelCT(d, 'a1'), { papel: 'jogador' });
});

test('edição: salvar mantendo um início que já passou hoje não apaga a data nem avisa', async () => {
  const inicio = NOW - 3 * 3_600_000;
  const db = base({ inscricoesAte: NOW - DIA, dataInicio: inicio });
  const avisos = await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'x', regrasTexto: '', premiacao: {}, inscricoesAte: NOW - DIA, dataInicio: inicio }, NOW);
  assert.equal(db.mapa.get(CT).dataInicio, inicio);
  assert.equal(avisos.length, 0);
});

test('edição: dados e datas numa gravação só, com a versão subindo', async () => {
  const db = base();
  const avisos = await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, infoVersaoEsperada: 0, descricao: 'Nova', regrasTexto: '', premiacao: {}, inscricaoCentavos: 3000, inscricoesAte: NOW + 5 * DIA, dataInicio: null }, NOW);
  const c = db.mapa.get(CT);
  assert.equal(c.descricao, 'Nova'); assert.equal(c.inscricaoCentavos, 3000); assert.equal(c.inscricoesAte, NOW + 5 * DIA); assert.equal(c.infoVersao, 1);
  // Um aviso das datas e outro do valor da inscrição.
  assert.deepEqual(avisos.map((x) => x.dedupeKey.split('_')[1]).sort(), ['dados', 'datas']);
});

test('edição: formulário aberto numa versão antiga é recusado e não desfaz a outra edição', async () => {
  const db = base({ descricao: 'Original' });
  await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, infoVersaoEsperada: 0, descricao: 'De A', regrasTexto: '', premiacao: {} }, NOW);
  await assert.rejects(S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, infoVersaoEsperada: 0, descricao: 'Original', regrasTexto: '', premiacao: {}, inscricaoCentavos: 9000 }, NOW), /outro aparelho/);
  assert.equal(db.mapa.get(CT).descricao, 'De A');
});

test('edição: textos no limite do servidor (2000, 5000, 1000) são gravados inteiros', async () => {
  const db = base();
  await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'd'.repeat(2000), regrasTexto: 'r'.repeat(5000), premiacao: { texto: 'p'.repeat(1000) } }, NOW);
  const c = db.mapa.get(CT);
  assert.equal(c.descricao.length, 2000); assert.equal(c.regrasTexto.length, 5000); assert.equal(c.premiacao.texto.length, 1000);
});

test('edição: aviso cita o valor novo da inscrição; mudar só o Sobre não avisa', async () => {
  const db = base({ inscricaoCentavos: 5000 });
  const [aviso] = await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'x', regrasTexto: '', premiacao: {}, inscricaoCentavos: 12000 }, NOW);
  assert.match(aviso.draft.body, /valor da inscrição \(agora R\$\s?120,00\)/);
  const so = await S.administrarCT(db, 'org', { acao: 'editarInfo', campeonatoId: ID, descricao: 'Outro texto', regrasTexto: '', premiacao: {}, inscricaoCentavos: 12000 }, NOW);
  assert.equal(so.length, 0);
});
