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
const E = require(path.join(root, 'api/_lib/explorarTimes.ts'));
const A = require(path.join(root, 'api/_lib/amistosos.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const PALMAS = { city: 'Palmas', state: 'TO', cityId: 'to-palmas' };

/** Firestore de mentira: guarda os filtros e devolve os times que passam neles, em ordem de id. */
function bancoFalso(times) {
  const gravados = [];
  const consultas = [];
  // Versão de cada documento (como o updateTime do Firestore): muda a cada gravação.
  const versoes = {};
  const versao = (id) => versoes[id] ?? 0;
  const gravar = (id, dados, condicao) => {
    if (condicao?.lastUpdateTime !== undefined && condicao.lastUpdateTime !== versao(id)) throw Object.assign(new Error('mudou'), { code: 9 });
    gravados.push({ id, dados });
    Object.assign(times[id], dados);
    versoes[id] = versao(id) + 1;
  };
  const pegar = (obj, campo) => campo.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const consulta = (filtros = [], depois = '', limite = 1000) => ({
    where: (campo, op, valor) => consulta([...filtros, op === '==' ? [campo, valor] : [campo, valor, op]], depois, limite),
    orderBy: () => consulta(filtros, depois, limite),
    startAfter: (id) => consulta(filtros, id, limite),
    limit: (n) => consulta(filtros, depois, n),
    get: async () => {
      consultas.push({ filtros, depois, limite });
      const docs = Object.entries(times)
        .filter(([id, d]) => filtros.every(([c, v, op]) => (op === 'array-contains' ? (pegar(d, c) ?? []).includes(v) : pegar(d, c) === v)) && (!depois || id > depois))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limite)
        .map(([id, d]) => ({ id, data: () => ({ ...d }), updateTime: versao(id) }));
      return { docs };
    },
  });
  const ref = (id) => ({
    id,
    get: async () => ({ exists: Boolean(times[id]), get: (c) => times[id]?.[c] }),
    update: async (dados, condicao) => gravar(id, dados, condicao),
  });
  let transacoes = 0;
  return {
    gravados, consultas, versoes,
    transacoes: () => transacoes,
    collection: () => consulta(),
    doc: (p) => ref(p.split('/')[1]),
    // Transação simples: lê e grava no fim (o bastante para conferir que a gravação passa por ela).
    runTransaction: async (fn) => {
      transacoes += 1;
      const pendentes = [];
      const r = await fn({ get: (d) => d.get(), update: (d, dados) => pendentes.push([d.id, dados]) });
      for (const [id, dados] of pendentes) gravar(id, dados);
      return r;
    },
  };
}

test('pedido: valida time, região, modalidade, gênero, limite e página', () => {
  assert.deepEqual(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1' }), {
    ok: true, value: { action: 'time_explorar', timeId: 'eu_1', regiao: 'cidade', modalidade: '', genero: '', limite: 20, cursor: '', busca: '' },
  });
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', regiao: 'pais' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', modalidade: 'praia' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', genero: 'x' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', limite: 50 }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', cursor: '../x' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_vitrine', timeId: 'eu_1', visivel: 'sim' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', busca: 'x'.repeat(41) }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_explorar', timeId: 'eu_1', busca: '  São  JOSÉ ' }).value.busca, 'sao jose');
  assert.ok(A.ehAcaoDeAmistoso({ action: 'time_explorar' }) && A.ehAcaoDeAmistoso({ action: 'time_vitrine' }));
});

test('região: id da cidade; times antigos pelo nome + estado; estado inteiro', () => {
  assert.deepEqual(E.filtrosDaRegiao(PALMAS, 'cidade'), [['cidade.cityId', 'to-palmas']]);
  assert.deepEqual(E.filtrosDaRegiao({ city: 'Palmas', state: 'TO' }, 'cidade'), [['cidade.city', 'Palmas'], ['cidade.state', 'TO']]);
  assert.deepEqual(E.filtrosDaRegiao(PALMAS, 'estado'), [['cidade.state', 'TO']]);
  assert.equal(E.filtrosDaRegiao(null, 'cidade'), null);
});

test('lista: só dados públicos, sem os meus times, o de referência e os ocultos', async () => {
  const times = {
    eu_1: { nome: 'Meu', donoId: 'eu', membros: ['eu'], modalidade: 'society', cidade: PALMAS },
    ana_1: { nome: 'Unidos', donoId: 'ana', membros: ['ana', 'bia'], modalidade: 'society', genero: 'masculino', cidade: PALMAS, chave: 'ABC234', jogadores: { ana: { nome: 'Ana' } } },
    bia_1: { nome: 'Oculto', donoId: 'bia', membros: ['bia'], modalidade: 'society', cidade: PALMAS, chave: 'ABC235', ocultoNaBusca: true },
    car_1: { nome: 'Comigo', donoId: 'car', membros: ['car', 'eu'], modalidade: 'society', cidade: PALMAS, chave: 'ABC236' },
    dan_1: { nome: 'Futsal', donoId: 'dan', membros: ['dan'], modalidade: 'futsal', cidade: PALMAS, chave: 'ABC237' },
    eva_1: { nome: 'Sem chave', donoId: 'eva', membros: ['eva'], modalidade: 'society', cidade: PALMAS },
  };
  const db = bancoFalso(times);
  const geradas = [];
  const r = await E.explorarTimes(db, 'eu', { action: 'time_explorar', timeId: 'eu_1', regiao: 'cidade', modalidade: 'society', genero: '', limite: 20, cursor: '', busca: '' }, async (id) => { geradas.push(id); return 'NOVA22'; });
  assert.ok(r.ok);
  assert.deepEqual(r.body.times.map((t) => t.nome), ['Unidos', 'Sem chave']);
  assert.deepEqual(geradas, ['eva_1']);
  assert.deepEqual(Object.keys(r.body.times[0]).sort(), ['chave', 'cidade', 'cor', 'corSecundaria', 'escudoUrl', 'faixaEtaria', 'genero', 'jogadores', 'modalidade', 'modalidades', 'nome', 'sigla', 'timeId'].sort());
  assert.equal(r.body.times[0].jogadores, 2);
  assert.equal(r.body.proximoCursor, null);
  // A modalidade é conferida depois da leitura (times antigos não têm a lista `modalidades`).
  assert.deepEqual(db.consultas[0].filtros, [['cidade.cityId', 'to-palmas']]);
});

test('só o elenco pergunta; time sem cidade é recusado', async () => {
  const db = bancoFalso({ eu_1: { donoId: 'eu', membros: ['eu'] }, x_1: { membros: ['x'], cidade: PALMAS } });
  const pedido = (timeId) => ({ action: 'time_explorar', timeId, regiao: 'cidade', modalidade: '', genero: '', limite: 5, cursor: '', busca: '' });
  assert.equal((await E.explorarTimes(db, 'eu', pedido('x_1'), async () => null)).status, 403);
  assert.equal((await E.explorarTimes(db, 'eu', pedido('eu_1'), async () => null)).status, 409);
});

test('paginação: o cursor é o último lido e a última página não tem cursor', async () => {
  const times = { eu_1: { membros: ['eu'], cidade: PALMAS } };
  for (let i = 0; i < 30; i += 1) times[`t${String(i).padStart(2, '0')}_1`] = { nome: `T${i}`, membros: ['o'], cidade: PALMAS, chave: 'ABC234' };
  const db = bancoFalso(times);
  const pedido = (cursor) => ({ action: 'time_explorar', timeId: 'eu_1', regiao: 'cidade', modalidade: '', genero: '', limite: 12, cursor, busca: '' });
  const p1 = await E.explorarTimes(db, 'eu', pedido(''), async () => null);
  assert.equal(p1.body.times.length, 12);
  assert.equal(p1.body.proximoCursor, 't11_1');
  const p2 = await E.explorarTimes(db, 'eu', pedido(p1.body.proximoCursor), async () => null);
  assert.equal(p2.body.times[0].nome, 'T12');
  const p3 = await E.explorarTimes(db, 'eu', pedido(p2.body.proximoCursor), async () => null);
  assert.equal(p3.body.times.length, 6);
  assert.equal(p3.body.proximoCursor, null);
});

test('vitrine: só o dono tira o time da lista', async () => {
  const db = bancoFalso({ eu_1: { donoId: 'eu', membros: ['eu', 'ana'] } });
  assert.equal((await E.definirVitrine(db, 'ana', { action: 'time_vitrine', timeId: 'eu_1', visivel: false })).status, 403);
  assert.ok((await E.definirVitrine(db, 'eu', { action: 'time_vitrine', timeId: 'eu_1', visivel: false })).ok);
  assert.deepEqual(db.gravados, [{ id: 'eu_1', dados: { ocultoNaBusca: true } }]);
});

test('modalidade: entra quem joga ela em qualquer posição da lista; times antigos pela principal', async () => {
  const times = {
    eu_1: { membros: ['eu'], cidade: PALMAS },
    a_1: { nome: 'Só futsal', membros: ['a'], modalidade: 'futsal', cidade: PALMAS, chave: 'AAA234' },
    b_1: { nome: 'Society e futsal', membros: ['b'], modalidade: 'society', modalidades: ['society', 'futsal'], cidade: PALMAS, chave: 'BBB234' },
    c_1: { nome: 'Só society', membros: ['c'], modalidade: 'society', cidade: PALMAS, chave: 'CCC234' },
  };
  const r = await E.explorarTimes(bancoFalso(times), 'eu', { action: 'time_explorar', timeId: 'eu_1', regiao: 'cidade', modalidade: 'futsal', genero: '', limite: 20, cursor: '', busca: '' }, async () => null);
  assert.deepEqual(r.body.times.map((t) => t.nome), ['Só futsal', 'Society e futsal']);
  assert.deepEqual(r.body.times[1].modalidades, ['society', 'futsal']);
  assert.equal(r.body.times[1].modalidade, 'society');
});

test('palavras do nome: começos de 2 a 12 letras de cada palavra, sem acento; a busca casa pelo começo das palavras', () => {
  assert.deepEqual(E.palavrasDoNome('Real Unidos'), ['re', 'rea', 'real', 'un', 'uni', 'unid', 'unido', 'unidos']);
  assert.deepEqual(E.palavrasDoNome('São-Paulo FC'), ['sa', 'sao', 'pa', 'pau', 'paul', 'paulo', 'fc']);
  assert.equal(E.palavrasDoNome('Associaçãoatleticabrasil').at(-1), 'associacaoat');
  assert.equal(E.termoIndexado('real uni'), 'real');
  assert.equal(E.termoIndexado('a b'), '');
  assert.ok(E.nomeCasaComBusca('Real Unidos', 'uni'));
  assert.ok(E.nomeCasaComBusca('Real Unidos', 'unidos real'));
  assert.ok(!E.nomeCasaComBusca('Real Unidos', 'nidos'));
  assert.ok(E.nomeCasaComBusca('A B Clube', 'a b'));
});

test('busca pelo nome: usa o índice (nomeBusca); times sem o campo ganham ele quando uma listagem os lê', async () => {
  const times = { eu_1: { membros: ['eu'], cidade: PALMAS } };
  for (let i = 0; i < 40; i += 1) times[`t${String(i).padStart(2, '0')}_1`] = { nome: i % 10 === 0 ? `União ${i}` : `Time ${i}`, membros: ['o'], cidade: PALMAS, chave: 'ABC234' };
  const db = bancoFalso(times);
  const pedido = { action: 'time_explorar', timeId: 'eu_1', regiao: 'cidade', modalidade: '', genero: '', limite: 3, cursor: '', busca: 'uniao' };
  // Antes de indexar, a busca não acha (o campo ainda não existe), mas também não varre a cidade inteira.
  assert.deepEqual((await E.explorarTimes(db, 'eu', pedido, async () => null)).body.times, []);
  assert.deepEqual(db.consultas.at(-1).filtros.at(-1), ['nomeBusca', 'uniao', 'array-contains']);
  // A lista sem busca lê os times e grava o campo nos que não têm (o de referência também).
  const l1 = await E.explorarTimes(db, 'eu', { ...pedido, limite: 20, busca: '' }, async () => null);
  await E.explorarTimes(db, 'eu', { ...pedido, limite: 20, busca: '', cursor: l1.body.proximoCursor }, async () => null);
  assert.ok(db.gravados.length >= 40);
  assert.deepEqual(times.t10_1.nomeBusca, ['un', 'uni', 'unia', 'uniao', '10']);
  db.consultas.length = 0;
  const r = await E.explorarTimes(db, 'eu', pedido, async () => null);
  assert.deepEqual(r.body.times.map((t) => t.nome), ['União 0', 'União 10', 'União 20']);
  assert.equal(db.consultas.length, 1, 'um lote só: o índice já traz só os candidatos');
  assert.ok(r.body.proximoCursor);
  const r2 = await E.explorarTimes(db, 'eu', { ...pedido, cursor: r.body.proximoCursor }, async () => null);
  assert.deepEqual(r2.body.times.map((t) => t.nome), ['União 30']);
  assert.equal(r2.body.proximoCursor, null);
  // Renomeado (por uma versão antiga do app): o índice ainda acha pelo nome antigo, mas o nome atual não casa; sai da
  // lista e o campo é corrigido na hora.
  times.t20_1.nome = 'Bairro FC';
  const r3 = await E.explorarTimes(db, 'eu', { ...pedido, limite: 20 }, async () => null);
  assert.deepEqual(r3.body.times.map((t) => t.nome), ['União 0', 'União 10', 'União 30']);
  assert.ok(times.t20_1.nomeBusca.includes('bairro') && !times.t20_1.nomeBusca.includes('uniao'));
});

test('time_indexar: só quem é do elenco; calcula pelo nome gravado; sem mudança, não grava', async () => {
  const times = { ana_1: { nome: 'Real Unidos', membros: ['ana', 'bia'] } };
  const db = bancoFalso(times);
  assert.equal(A.parseAmistosoBody({ action: 'time_indexar', timeId: '../x' }).ok, false);
  assert.ok(A.ehAcaoDeAmistoso({ action: 'time_indexar' }));
  assert.equal((await E.indexarNome(db, 'eu', { action: 'time_indexar', timeId: 'ana_1' })).status, 403);
  assert.equal((await E.indexarNome(db, 'bia', { action: 'time_indexar', timeId: 'nada_1' })).status, 404);
  assert.deepEqual((await E.indexarNome(db, 'bia', { action: 'time_indexar', timeId: 'ana_1' })).body, { atualizado: true });
  assert.deepEqual(times.ana_1.nomeBusca, E.palavrasDoNome('Real Unidos'));
  assert.deepEqual((await E.indexarNome(db, 'bia', { action: 'time_indexar', timeId: 'ana_1' })).body, { atualizado: false });
  assert.equal(db.gravados.length, 1);
  assert.ok(db.transacoes() >= 3, 'leitura e gravação na mesma transação');
});

test('conserto de passagem: só grava se o time não mudou desde a leitura (um nome novo não é sobrescrito pelo antigo)', async () => {
  const times = { eu_1: { membros: ['eu'], cidade: PALMAS }, leo_1: { nome: 'Leões', membros: ['leo'], cidade: PALMAS, chave: 'ABC234' } };
  const db = bancoFalso(times);
  // Entre a leitura da listagem e a gravação, o time vira "Tigres" (e é indexado com o nome novo).
  const updateOriginal = db.doc('times/leo_1').update;
  const doc = db.doc;
  db.doc = (p) => {
    const r = doc(p);
    if (p === 'times/leo_1') {
      return { ...r, update: async (dados, condicao) => {
        times.leo_1.nome = 'Tigres';
        await updateOriginal({ nomeBusca: E.palavrasDoNome('Tigres') });
        return r.update(dados, condicao);
      } };
    }
    return r;
  };
  await E.explorarTimes(db, 'eu', { action: 'time_explorar', timeId: 'eu_1', regiao: 'cidade', modalidade: '', genero: '', limite: 20, cursor: '', busca: '' }, async () => null);
  assert.deepEqual(times.leo_1.nomeBusca, E.palavrasDoNome('Tigres'));
});

test('folga de leitura: sem filtro de modalidade lê só 1 a mais que a página; com o filtro, 10 a mais', async () => {
  const times = { eu_1: { membros: ['eu'], cidade: PALMAS } };
  for (let i = 0; i < 30; i += 1) times[`t${String(i).padStart(2, '0')}_1`] = { nome: `Time ${i}`, membros: ['o'], cidade: PALMAS, chave: 'ABC234', modalidade: 'futsal' };
  const db = bancoFalso(times);
  const pedido = { action: 'time_explorar', timeId: 'eu_1', regiao: 'estado', modalidade: '', genero: '', limite: 20, cursor: '', busca: '' };
  const r = await E.explorarTimes(db, 'eu', pedido, async () => null);
  assert.equal(r.body.times.length, 20);
  assert.equal(db.consultas[0].limite, 21);
  assert.ok(r.body.proximoCursor, 'o 21º diz que há mais');
  db.consultas.length = 0;
  await E.explorarTimes(db, 'eu', { ...pedido, modalidade: 'futsal' }, async () => null);
  assert.equal(db.consultas[0].limite, 30);
});
