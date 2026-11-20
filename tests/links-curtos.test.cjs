// Links curtos (link.tugyntec.com.br) e cartão da prévia: códigos, caminhos, resolução e rotas do vercel.json.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const curto = require(path.join(root, 'api/_lib/linkCurto.ts'));
const camp = require(path.join(root, 'api/_lib/campeonatoLink.ts'));
const cartao = require(path.join(root, 'api/_lib/cartaoLink.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const ID = 'ct_e2b8902acd29dc786a9ef7e3';

test('código do campeonato: os 10 primeiros do id; caminhos bonitos de cada tipo', () => {
  assert.equal(curto.codigoDoCampeonato(ID), 'e2b8902acd');
  assert.equal(curto.caminhoPublico('campeonato', ID), '/campeonato/e2b8902acd');
  assert.equal(curto.caminhoPublico('campeonato', 'e2b8902acd'), '/campeonato/e2b8902acd');
  assert.equal(curto.caminhoPublico('turma', 'K7P2QX'), '/turma/K7P2QX');
  assert.equal(curto.caminhoPublico('time', 'AbCdEfGh12345678'), '/time/AbCdEfGh12345678');
  assert.equal(curto.caminhoPublico('convite', 'AbCdEfGh12345678'), '/convocacao/AbCdEfGh12345678');
  assert.ok(curto.CODIGO_TURMA.test('K7P2QX'));
  assert.ok(!curto.CODIGO_TURMA.test('K7P2QO'), 'sem letras ambíguas (O, I, L, 0, 1)');
});

/** Firestore falso: consulta por intervalo do id e documento único. */
const fakeDb = (ids, docs = {}) => ({
  collection: (nome) => {
    let inicio = '', fim = '￿', lim = Infinity;
    const q = {
      orderBy: () => q, startAt: (v) => { inicio = v; return q; }, endAt: (v) => { fim = v; return q; },
      limit: (n) => { lim = n; return q; }, select: () => q,
      get: async () => ({ docs: ids.filter((i) => i >= inicio && i <= fim).sort().slice(0, lim).map((id) => ({ id })) }),
      doc: (id) => ({ get: async () => ({ exists: Boolean(docs[`${nome}/${id}`]), get: (k) => docs[`${nome}/${id}`]?.[k] }) }),
    };
    return q;
  },
});

test('campeonato pelo código: um só resolve; ambíguo, inexistente ou malformado não abre nada', async () => {
  assert.equal(await curto.campeonatoPorCodigo(fakeDb([ID, 'ct_ffffffffff29dc786a9ef7e3']), 'e2b8902acd'), ID);
  assert.equal(await curto.campeonatoPorCodigo(fakeDb([ID, 'ct_e2b8902acdffffffffffffff']), 'e2b8902acd'), null);
  assert.equal(await curto.campeonatoPorCodigo(fakeDb([ID]), '0000000000'), null);
  assert.equal(await curto.campeonatoPorCodigo(fakeDb([ID]), 'E2B8902ACD'), null);
});

test('turma pelo código de convite', async () => {
  const db = fakeDb([], { 'codigosConvite/K7P2QX': { turmaId: 'turmaAbc123' } });
  assert.equal(await curto.turmaPorCodigo(db, 'K7P2QX'), 'turmaAbc123');
  assert.equal(await curto.turmaPorCodigo(db, 'AAAAAA'), null);
  assert.equal(await curto.turmaPorCodigo(db, 'k7p2qx'), null);
});

test('cartão do campeonato: chamada conforme a situação', () => {
  const base = { nome: 'Copa do Feriado', status: 'inscricoes', formato: 'Mata-mata', modalidade: 'Society', cidade: 'Palmas', estado: 'TO', inscricoesAte: Date.UTC(2026, 10, 20, 15), dataInicio: null, inscricaoCentavos: 5000, maxTimes: 8, aprovados: 4, banner: '' };
  const agora = Date.UTC(2026, 10, 16);
  const c = camp.cartaoDoCampeonato(base, agora);
  assert.equal(c.detalhes, 'Mata-mata · Society · Palmas, TO');
  assert.match(c.destaque, /^Inscrições até 20\/11 · 4 vagas · R\$\s50,00$/);
  assert.equal(camp.cartaoDoCampeonato({ ...base, inscricaoCentavos: 0, aprovados: 7 }, agora).destaque, 'Inscrições até 20/11 · 1 vaga · Grátis');
  assert.equal(camp.cartaoDoCampeonato(base, Date.UTC(2026, 10, 21)).destaque, 'Inscrições encerradas · começa em breve');
  assert.equal(camp.cartaoDoCampeonato({ ...base, status: 'cancelado' }, agora).destaque, 'Campeonato cancelado');
  assert.equal(c.patrocinadores, '');
  assert.equal(camp.cartaoDoCampeonato({ ...base, patrocinadores: ['Arena', 'Farmácia Vida'] }, agora).patrocinadores, 'Arena · Farmácia Vida');
  assert.equal(camp.listaDeNomes(['A', 'B', 'C']), 'A, B e C');
  const doc = camp.campeonatoDoDocumento({ nome: 'Copa', status: 'inscricoes', patrocinadores: [{ nome: ' Arena ', publicId: 'x' }, { nome: '' }, null] });
  assert.equal(doc.patrocinadores.join('|'), 'Arena');
});

test('árvore do cartão: texto cortado, sem escudo ocupa a largura; com escudo sem imagem usa a sigla', () => {
  const textos = (no) => typeof no === 'string' ? [no] : (no.props.children ?? []).flatMap(textos);
  const longo = cartao.arvoreDoCartao({ rotulo: 'Time', titulo: 'x'.repeat(80), detalhes: '', destaque: '' }, { logo: 'data:', fundo: null, escudo: null });
  const medir = require(path.join(root, 'api/_lib/medirTexto.ts'));
  // Título longo: até duas linhas, cada uma dentro da largura útil (sem taça, 1072).
  const linhasTitulo = textos(longo).filter((t) => /^x+…?$/.test(t));
  assert.ok(linhasTitulo.length >= 1 && linhasTitulo.length <= 2);
  assert.ok(linhasTitulo.every((t) => medir.larguraDoTexto(t, 38) <= 1072));
  // Com a taça e letras largas: o título fica nos 690 da coluna e os patrocinadores cabem na faixa.
  const largo = cartao.arvoreDoCartao({ rotulo: '', titulo: 'W'.repeat(60), detalhes: 'W'.repeat(80), destaque: '', taca: null, patrocinadores: Array.from({ length: 6 }, () => 'W'.repeat(40)).join(' · ') }, { logo: 'data:', fundo: null, escudo: null });
  const tw = textos(largo).filter((t) => /^W+…$/.test(t));
  assert.ok(tw.length >= 2, 'título e detalhes cortados');
  assert.ok(textos(largo).filter((t) => t.startsWith('WWW') && t.includes('·')).every((t) => t.endsWith('…') && medir.larguraDoTexto(t, 26) <= 1072 - 40 - medir.larguraDoTexto('PATROCÍNIO', 20, 2) - 16));
  assert.equal(medir.caberEm('Copa', 30, 1000), 'Copa');
  assert.deepEqual([...medir.quebrarEmLinhas('Copa Tocantins de Futsal Amador', 40, 300, 2)].length, 2);
  const time = cartao.arvoreDoCartao({ rotulo: 'Time', titulo: 'Os Brabos', detalhes: 'Society', destaque: '5 jogadores', escudo: { url: '', cor: '#123456', sigla: 'BRA' } }, { logo: 'data:', fundo: null, escudo: null });
  assert.ok(textos(time).includes('BRA'));
});

test('imagem do Cloudinary só do próprio Cloudinary (o gerador não busca outro endereço)', async () => {
  assert.equal(await cartao.imagemComoDataUri('https://exemplo.com/a.png'), null);
  assert.equal(await cartao.imagemComoDataUri('http://res.cloudinary.com/x/image/upload/a.png'), null);
  assert.equal(await cartao.imagemComoDataUri(''), null);
});

test('vercel.json: caminhos curtos e a imagem chegam à função das páginas; links antigos continuam', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const de = (s) => v.rewrites.find((r) => r.source === s)?.destination;
  assert.equal(de('/campeonato/:id'), '/api/turma/:id?tipo=campeonato');
  assert.equal(de('/turma/:id'), '/api/turma/:id');
  assert.equal(de('/time/:linkId'), '/api/turma/:linkId?tipo=time');
  assert.equal(de('/convocacao/:codigo'), '/api/turma/:codigo?tipo=convite');
  assert.equal(de('/imagem/:tipo(turma|time|convite|campeonato)/:id'), '/api/turma/:id?tipo=:tipo&formato=imagem');
  assert.equal(de('/api/campeonato/:id'), '/api/turma/:id?tipo=campeonato');
  assert.equal(de('/api/time/c/:codigo'), '/api/turma/:codigo?tipo=convite');
});
