const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));
function load(file, dependencies) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, module, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, Date, Intl, console: { log() {}, error() {} }, process });
  return module.exports;
}

const SERVER_TS = { servidor: true };
const DIA = 86_400_000;
const AGORA = Date.parse('2026-11-05T15:00:00Z');

/** Firestore em memória: só o que o módulo usa (where ==, >=, <, array-contains; limit; count; collectionGroup). */
function fakeDb(initial, { falharContagem } = {}) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  let seq = 0;
  const valor = v => (v instanceof Date ? v.getTime() : v && typeof v.toMillis === 'function' ? v.toMillis() : v);
  const passa = (doc, [campo, op, alvo]) => {
    const v = valor(doc[campo]);
    const a = valor(alvo);
    if (op === '==') return v === a;
    if (op === '>=') return v !== undefined && v >= a;
    if (op === '<') return v !== undefined && v < a;
    if (op === 'array-contains') return Array.isArray(v) && v.includes(a);
    throw Error(op);
  };
  const docRef = key => ({
    key,
    get: async () => {
      const d = docs.get(key);
      return { id: key.split('/').pop(), exists: !!d, data: () => (d ? { ...d } : undefined) };
    },
  });
  const consulta = (casa, nome) => {
    const filtros = [];
    let max = Infinity;
    const lista = () => [...docs].filter(([k, v]) => casa(k) && filtros.every(f => passa(v, f))).slice(0, max);
    const q = {
      where: (c, op, v) => { filtros.push([c, op, v]); return q; },
      limit: n => { max = n; return q; },
      get: async () => ({ docs: lista().map(([k, v]) => ({ id: k.split('/').pop(), data: () => ({ ...v }) })) }),
      count: () => ({ get: async () => { if (falharContagem === nome) throw Error('índice'); return { data: () => ({ count: lista().length }) }; } }),
      add: async data => { const key = `${nome}/auto${++seq}`; docs.set(key, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === SERVER_TS ? AGORA : v]))); return docRef(key); },
    };
    return q;
  };
  const db = {
    doc: docRef,
    collection: nome => consulta(k => k.startsWith(nome + '/') && k.split('/').length === 2, nome),
    collectionGroup: nome => consulta(k => { const p = k.split('/'); return p.length >= 2 && p[p.length - 2] === nome; }, nome),
  };
  return { db, docs };
}

const iso = msv => new Date(msv).toUTCString();
const contaAuth = (uid, extra = {}) => ({
  uid,
  email: `${uid}@x.com`,
  emailVerified: true,
  displayName: uid,
  disabled: false,
  providerData: [{ providerId: 'password' }],
  metadata: { creationTime: iso(AGORA - 40 * DIA), lastSignInTime: iso(AGORA - 3 * DIA), lastRefreshTime: iso(AGORA - 2 * 3600_000) },
  ...extra,
});

function fixture(options = {}) {
  const { db, docs } = fakeDb({
    'users/joao': { name: 'João Silva', name_lower: 'joão silva', userName: 'joaozinho', userName_lower: 'joaozinho', profileImage: 'https://x/j.jpg', location: { city: 'Recife', state: 'PE' }, status: 'active', createdAt: AGORA - 40 * DIA },
    'users/joana': { name: 'Joana', name_lower: 'joana', userName: 'jo_ana', userName_lower: 'jo_ana', status: 'suspended' },
    'users/pedro': { name: 'Pedro', name_lower: 'pedro', userName: 'pedrao', userName_lower: 'pedrao', status: 'active' },
    'turmas/t1': { nome: 'Quinta', creatorId: 'joao', participantes: ['joao', 'pedro'], status: 'ativa', ultimaAtividade: AGORA - 2 * DIA },
    'turmas/t2': { nome: 'Futsal', creatorId: 'pedro', participantes: ['joao'], status: 'encerrada', ativo: false, modalidade: 'futsal', ultimaAtividade: AGORA - 60 * DIA },
    'turmas/t1/partidas/p1': { totalGols: 3 },
    'turmas/t1/partidas/p2': { totalGols: 1 },
    'times/x': { nome: 'Leões', donoId: 'joao', membros: ['joao'] },
    'reports/r1': { status: 'open', targetId: 'joao' },
    'reports/r2': { status: 'resolved', targetId: 'joao' },
    'revisoes/joana': { status: 'aberta', criadoEm: AGORA - DIA },
    'desafios/d1': {},
    ...(options.docs ?? {}),
  }, options);
  const contas = options.contas ?? [contaAuth('joao'), contaAuth('joana'), contaAuth('pedro', { metadata: { creationTime: iso(AGORA - DIA), lastSignInTime: iso(AGORA - DIA) } })];
  let listagens = 0;
  const auth = {
    getUserByEmail: async email => { const c = contas.find(u => u.email === email); if (!c) throw Object.assign(Error('x'), { code: 'auth/user-not-found' }); return c; },
    getUser: async uid => { if (options.authFora) throw Object.assign(Error('x'), { code: 'auth/internal-error' }); const c = contas.find(u => u.uid === uid); if (!c) throw Object.assign(Error('x'), { code: 'auth/user-not-found' }); return c; },
    listUsers: async (max, token) => {
      listagens++;
      await new Promise(r => setTimeout(r, 5));
      if (options.falharLista) throw Object.assign(Error('x'), { code: 'auth/internal-error' });
      const ini = token ? Number(token) : 0;
      const tamanho = options.pagina ?? max;
      const fim = ini + tamanho;
      return { users: contas.slice(ini, fim), pageToken: fim < contas.length ? String(fim) : undefined };
    },
  };
  const consultas = [];
  const mod = load('adminUsuarios.ts', {
    'firebase-admin/auth': { getAuth: () => auth },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => SERVER_TS } },
    './auth': { getFirebaseApp: () => ({}), requireUser: async (_, res) => { if (options.anonymous) { res.status(401).json({ error: 'x' }); return null; } return { uid: 'admin-uid', admin: !options.nonAdmin }; } },
    './cors': { handleCors: () => false },
    './moderacao': { consultar: async (_db, tipo, id, comDenuncias) => { consultas.push([tipo, id, comDenuncias]); return { tipo, id, situacao: 'ativa', historico: [], denuncias: [] }; } },
    './rateLimit': { dentroDoLimite: async () => !options.limited },
    './validation': { isSafeUid: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) },
  });
  mod.limparEstatisticasGuardadas();
  async function request(body, method = 'POST') {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = JSON.parse(JSON.stringify(v)); return this; } };
    await mod.handleAdminUsuarios({ method, body, headers: {}, query: {} }, res);
    return res;
  }
  const acessos = () => [...docs].filter(([k]) => k.startsWith('adminAcessos/')).map(([, v]) => v);
  return { request, docs, acessos, consultas, mod, listagens: () => listagens };
}

test('anônimo, não-admin, limite e método errado não consultam nada', async () => {
  for (const [options, status] of [[{ anonymous: true }, 401], [{ nonAdmin: true }, 403], [{ limited: true }, 429]]) {
    const f = fixture(options);
    const r = await f.request({ action: 'ficha', id: 'joao' });
    assert.equal(r.statusCode, status);
    assert.equal(f.acessos().length, 0);
  }
  const f = fixture();
  assert.equal((await f.request({}, 'GET')).statusCode, 405);
  assert.equal((await f.request({ action: 'apagar' })).statusCode, 400);
  for (const termo of [undefined, '', 'a', 'x'.repeat(81), 5]) assert.equal((await f.request({ action: 'buscar', termo })).statusCode, 400);
  assert.equal((await f.request({ action: 'ficha', id: '../x' })).statusCode, 400);
});

test('tipo de busca: e-mail, uid e texto', () => {
  const { mod } = fixture();
  assert.equal(mod.tipoDeBusca('ana@x.com'), 'email');
  assert.equal(mod.tipoDeBusca('@ana'), 'texto');
  assert.equal(mod.tipoDeBusca('aB3dE5fG7hI9jK1lM3nO5pQ7rS9t'), 'uid');
  assert.equal(mod.tipoDeBusca('joão silva'), 'texto');
  assert.equal(mod.parseTermo('  jo\u0000ão '), 'jo ão');
});

test('busca por texto: começo do @ ou do nome, sem repetir, sem e-mail e sem registro', async () => {
  const f = fixture();
  const r = await f.request({ action: 'buscar', termo: '@JO' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.deepEqual(r.body.usuarios.map(u => u.uid).sort(), ['joana', 'joao']);
  const joao = r.body.usuarios.find(u => u.uid === 'joao');
  assert.deepEqual(joao, { uid: 'joao', nome: 'João Silva', username: 'joaozinho', foto: 'https://x/j.jpg', cidade: 'Recife / PE', status: 'active', criadoEm: AGORA - 40 * DIA });
  assert.equal(r.body.usuarios.find(u => u.uid === 'joana').status, 'suspended');
  assert.ok(!JSON.stringify(r.body).includes('@x.com'));
  assert.equal(f.acessos().length, 0);
  assert.deepEqual((await f.request({ action: 'buscar', termo: 'ninguém' })).body.usuarios, []);
});

test('busca por e-mail: exata, registrada (sem guardar o e-mail), mesmo sem resultado', async () => {
  const f = fixture();
  const r = await f.request({ action: 'buscar', termo: 'Pedro@X.com' });
  assert.deepEqual(r.body.usuarios.map(u => u.uid), ['pedro']);
  assert.deepEqual(f.acessos(), [{ adminUid: 'admin-uid', alvoId: 'pedro', tipo: 'busca-email', em: AGORA }]);
  const vazio = await f.request({ action: 'buscar', termo: 'nao@existe.com' });
  assert.deepEqual(vazio.body.usuarios, []);
  assert.equal(f.acessos().length, 2);
  assert.ok(!JSON.stringify(f.acessos()).includes('existe.com'));
});

test('ficha: perfil, conta, turmas, times, revisão, moderação e registro do acesso', async () => {
  const f = fixture();
  const r = await f.request({ action: 'ficha', id: 'joao' });
  assert.equal(r.statusCode, 200);
  const b = r.body;
  assert.equal(b.perfil.nome, 'João Silva');
  assert.equal(b.perfil.existe, true);
  assert.equal(b.conta.email, 'joao@x.com');
  assert.deepEqual(b.conta.provedores, ['password']);
  assert.equal(b.conta.ultimaAtividade, Date.parse(iso(AGORA - 2 * 3600_000)));
  assert.deepEqual(b.turmas, [
    { id: 't1', nome: 'Quinta', organizador: true, situacao: 'ativa', modalidade: 'futebol' },
    { id: 't2', nome: 'Futsal', organizador: false, situacao: 'encerrada', modalidade: 'futsal' },
  ]);
  assert.deepEqual(b.times, [{ id: 'x', nome: 'Leões', dono: true }]);
  assert.equal(b.revisao, null);
  assert.deepEqual(f.consultas, [['user', 'joao', true]]);
  assert.deepEqual(f.acessos(), [{ adminUid: 'admin-uid', alvoId: 'joao', tipo: 'ficha', em: AGORA }]);

  const joana = (await f.request({ action: 'ficha', id: 'joana' })).body;
  assert.deepEqual(joana.revisao, { status: 'aberta', em: AGORA - DIA });
});

test('ficha: conta excluída do Auth ainda mostra o perfil; sem perfil nem conta é 404; Auth fora do ar é 503', async () => {
  const f = fixture({ docs: { 'users/orfao': { name: 'Órfão', status: 'active' } } });
  const r = await f.request({ action: 'ficha', id: 'orfao' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.conta, null);
  const nada = await f.request({ action: 'ficha', id: 'fantasma' });
  assert.equal(nada.statusCode, 404);
  assert.equal(f.acessos().length, 1);
  assert.equal((await fixture({ authFora: true }).request({ action: 'ficha', id: 'joao' })).statusCode, 503);
});

test('resumo das contas: ativos e cadastros por dia no fuso de Brasília', () => {
  const { mod } = fixture();
  const dias = mod.ultimos30Dias(AGORA);
  assert.equal(dias.length, 30);
  assert.equal(dias[29], '2026-11-05');
  assert.equal(dias[0], '2026-10-07');
  // 01:00 UTC do dia 5 = 22:00 do dia 4 em Brasília.
  const r = mod.resumirContas([
    { criadaEm: Date.parse('2026-11-05T01:00:00Z'), ultimoUso: AGORA - 3600_000 },
    { criadaEm: AGORA - 10 * DIA, ultimoUso: AGORA - 5 * DIA },
    { criadaEm: AGORA - 100 * DIA, ultimoUso: AGORA - 20 * DIA },
    { criadaEm: AGORA - 200 * DIA, ultimoUso: 0 },
  ], AGORA);
  assert.equal(r.total, 4);
  assert.deepEqual({ ...r.ativos }, { dia: 1, semana: 2, mes: 3 });
  assert.deepEqual({ semana: r.cadastros.semana, mes: r.cadastros.mes }, { semana: 1, mes: 2 });
  assert.equal(r.cadastros.porDia.find(d => d.dia === '2026-11-04').total, 1);
  assert.equal(r.cadastros.porDia.find(d => d.dia === '2026-11-05').total, 0);
  assert.equal(r.cadastros.porDia.reduce((s, d) => s + d.total, 0), 2);
});

test('estatísticas: contagens, contas paginadas, contagem que falha vira null e cache', async () => {
  const f = fixture({ pagina: 2, falharContagem: 'desafios' });
  const r = await f.request({ action: 'estatisticas' });
  assert.equal(r.statusCode, 200);
  const b = r.body;
  assert.deepEqual(b.contas, { total: 3, completo: true });
  assert.deepEqual(b.perfis, { total: 3, suspensos: 1 });
  assert.equal(b.turmas.total, 2);
  assert.equal(b.turmas.ativas, 1);
  assert.equal(b.times, 1);
  assert.equal(b.partidas, 2);
  assert.equal(b.desafios, null);
  assert.deepEqual(b.moderacao, { denunciasAbertas: 1, revisoesAbertas: 1 });
  assert.equal(b.cadastros.porDia.length, 30);
  assert.equal(f.listagens(), 2);
  // Guardadas: a 2ª chamada (mesmo pedindo atualizar, com menos de 1 min) não lê o Auth de novo.
  await f.request({ action: 'estatisticas', atualizar: true });
  assert.equal(f.listagens(), 2);
  assert.equal(f.acessos().length, 0);
});

const UID_LONGO = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9t';

test('PA-01: busca acha nome acentuado gravado sem acento (cadastro) e com acento (edição antiga)', async () => {
  const f = fixture({ docs: {
    'users/ze': { name: 'José Atleta', name_lower: 'jose atleta', userName: 'atleta', userName_lower: 'atleta', status: 'active' },
    'users/mario': { name: 'Mário', name_lower: 'mário', userName: 'mm10', userName_lower: 'mm10', status: 'active' },
  } });
  const ids = async termo => (await f.request({ action: 'buscar', termo })).body.usuarios.map(u => u.uid);
  assert.ok((await ids('José')).includes('ze'));
  assert.ok((await ids('jose')).includes('ze'));
  assert.ok((await ids('Mário')).includes('mario'));
  assert.equal(f.mod.semAcentos('JOÃO Ávila'), 'joao avila');
});

test('PA-02: uid de conta só no Auth (sem perfil) aparece na busca', async () => {
  const f = fixture({ contas: [contaAuth(UID_LONGO, { displayName: 'Sem Perfil' })] });
  const r = await f.request({ action: 'buscar', termo: UID_LONGO });
  assert.deepEqual(r.body.usuarios.map(u => [u.uid, u.nome]), [[UID_LONGO, 'Sem Perfil']]);
  const curto = await f.request({ action: 'buscar', termo: 'pedro' });
  assert.ok(curto.body.usuarios.some(u => u.uid === 'pedro'));
});

test('PA-03: pedidos simultâneos dividem um cálculo; falha devolve o anterior marcado como desatualizado', async () => {
  const opcoes = {};
  const f = fixture(opcoes);
  const rs = await Promise.all([1, 2, 3].map(() => f.request({ action: 'estatisticas' })));
  assert.ok(rs.every(r => r.statusCode === 200));
  assert.equal(f.listagens(), 1);
  const real = Date.now;
  try {
    Date.now = () => real() + 2 * 60_000;
    opcoes.falharLista = true;
    const r = await f.request({ action: 'estatisticas', atualizar: true });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.desatualizado, true);
    assert.equal(r.body.contas.total, 3);
  } finally {
    Date.now = real;
  }
  assert.equal((await fixture({ falharLista: true }).request({ action: 'estatisticas' })).statusCode, 503);
});

test('PA-05: cadastros da semana e do mês são a soma das barras do gráfico', () => {
  const { mod } = fixture();
  // 06/10 às 17h de Brasília: fica fora das 30 datas do gráfico (a 1ª é 07/10) e fora do cartão.
  const r = mod.resumirContas([
    { criadaEm: Date.parse('2026-10-06T20:00:00Z'), ultimoUso: 0 },
    { criadaEm: Date.parse('2026-10-29T12:00:00Z'), ultimoUso: 0 },
    { criadaEm: Date.parse('2026-11-05T12:00:00Z'), ultimoUso: 0 },
  ], Date.parse('2026-11-05T15:00:00Z'));
  const soma = r.cadastros.porDia.reduce((s, d) => s + d.total, 0);
  assert.equal(r.cadastros.mes, soma);
  assert.equal(r.cadastros.mes, 2);
  assert.equal(r.cadastros.semana, 1);
});

test('PA-06: turma antiga sem status e com ativo true conta como ativa', async () => {
  const f = fixture({ docs: { 'turmas/t3': { nome: 'Antiga', participantes: [], ativo: true }, 'turmas/t4': { nome: 'Inativa', status: 'ativa', ativo: false } } });
  const b = (await f.request({ action: 'estatisticas' })).body;
  assert.equal(b.turmas.total, 4);
  assert.equal(b.turmas.ativas, 2);
});

test('ficha avisa quando passa do limite de turmas', async () => {
  const docs = {};
  for (let i = 0; i < 51; i++) docs['turmas/x' + i] = { nome: 'T' + i, participantes: ['pedro'] };
  const b = (await fixture({ docs }).request({ action: 'ficha', id: 'pedro' })).body;
  assert.equal(b.turmas.length, 50);
  assert.equal(b.turmasAlemDoLimite, true);
  assert.equal(b.timesAlemDoLimite, false);
});
