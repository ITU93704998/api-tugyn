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
  vm.runInNewContext(source, { exports: module.exports, module, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, Date, console: { log() {}, error() {} }, process });
  return module.exports;
}

const SERVER_TS = { servidor: true };
const DELETE = { apagar: true };

/** Firestore em memória: só o que o módulo usa. */
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  let seq = 0;
  const aplicar = (key, patch) => {
    const atual = docs.get(key);
    if (!atual) throw Object.assign(Error('not found'), { code: 5 });
    for (const [k, v] of Object.entries(patch)) {
      if (v === DELETE) delete atual[k];
      else atual[k] = v === SERVER_TS ? 1000 : v;
    }
  };
  const docRef = key => ({
    key,
    get: async () => {
      const d = docs.get(key);
      return { exists: !!d, data: () => (d ? { ...d } : undefined), get: f => d?.[f] };
    },
    update: async patch => aplicar(key, patch),
    delete: async () => { docs.delete(key); },
  });
  const collection = name => {
    const filtros = [];
    const q = {
      where: (campo, _op, valor) => { filtros.push([campo, valor]); return q; },
      limit: () => q,
      get: async () => ({
        docs: [...docs].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 && filtros.every(([c, val]) => v[c] === val))
          .map(([k, v]) => ({ ref: docRef(k), data: () => ({ ...v }), get: f => v[f] })),
      }),
      add: async data => { const key = `${name}/auto${++seq}`; docs.set(key, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === SERVER_TS ? 1000 : v]))); return docRef(key); },
    };
    return q;
  };
  const db = {
    doc: docRef,
    collection,
    batch: () => { const ops = []; return { update: (ref, patch) => ops.push([ref.key, patch]), commit: async () => { for (const [k, p] of ops) aplicar(k, p); } }; },
  };
  return { db, docs };
}

function fixture(options = {}) {
  const { db, docs } = fakeDb({
    'users/alvo': { name: 'João', userName: 'joao', profileImage: 'https://x/foto.jpg', status: 'active' },
    'users/outroAdmin': { name: 'Admin 2' },
    'turmas/t1': { nome: 'Pelada de Quinta', creatorName: 'Ana', status: 'ativa', ativo: true },
    'turmas/t2': { nome: 'Fechada pelo dono', status: 'encerrada', ativo: false },
    'reports/a': { targetType: 'user', targetId: 'alvo', status: 'open', reason: 'spam' },
    'reports/b': { targetType: 'user', targetId: 'alvo', status: 'reviewing', reason: 'harassment' },
    'reports/c': { targetType: 'user', targetId: 'alvo', status: 'dismissed', reason: 'other' },
    'reports/d': { targetType: 'turma', targetId: 't1', status: 'open', reason: 'spam' },
    'pushTokens/p1': { uid: 'alvo' },
    'pushTokens/p2': { uid: 'outro' },
    ...(options.docs ?? {}),
  });
  const authCalls = [];
  const auth = {
    getUser: async uid => {
      if (options.semConta) throw Object.assign(Error('x'), { code: 'auth/user-not-found' });
      return { uid, customClaims: uid === 'outroAdmin' ? { admin: true } : {} };
    },
    updateUser: async (uid, data) => { if (options.semConta) throw Object.assign(Error('x'), { code: 'auth/user-not-found' }); authCalls.push(['update', uid, { ...data }]); },
    revokeRefreshTokens: async uid => { if (options.semConta) throw Object.assign(Error('x'), { code: 'auth/user-not-found' }); authCalls.push(['revoke', uid]); },
  };
  const mod = load('moderacao.ts', {
    'firebase-admin/auth': { getAuth: () => auth },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => SERVER_TS, delete: () => DELETE } },
    './auth': { getFirebaseApp: () => ({}), requireUser: async (_, res) => { if (options.anonymous) { res.status(401).json({ error: 'x' }); return null; } return { uid: 'admin-uid', admin: !options.nonAdmin }; } },
    './cors': { handleCors: () => false },
    './rateLimit': { dentroDoLimite: async () => !options.limited },
    './validation': { isSafeUid: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) },
  });
  async function request(body, method = 'POST') {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = JSON.parse(JSON.stringify(v)); return this; } };
    await mod.handleModeracao({ method, body, headers: {}, query: {} }, res);
    return res;
  }
  const logs = () => [...docs].filter(([k]) => k.startsWith('moderacaoLog/')).map(([, v]) => v);
  return { request, docs, authCalls, logs, mod };
}

test('anônimo, não-admin e limite de pedidos não mudam nada', async () => {
  for (const [options, status] of [[{ anonymous: true }, 401], [{ nonAdmin: true }, 403], [{ limited: true }, 429]]) {
    const f = fixture(options);
    const r = await f.request({ action: 'suspender', id: 'alvo', motivo: 'assédio' });
    assert.equal(r.statusCode, status);
    assert.equal(f.docs.get('users/alvo').status, 'active');
    assert.equal(f.authCalls.length, 0);
  }
});

test('só POST; id, ação e motivo validados', async () => {
  const f = fixture();
  assert.equal((await f.request({}, 'GET')).statusCode, 405);
  assert.equal((await f.request({ action: 'suspender', id: '../x', motivo: 'assédio' })).statusCode, 400);
  assert.equal((await f.request({ action: 'apagar', id: 'alvo', motivo: 'assédio' })).statusCode, 400);
  assert.equal((await f.request({ action: 'consultar', tipo: 'partida', id: 'alvo' })).statusCode, 400);
  for (const motivo of [undefined, '', 'ab', 'x'.repeat(501), 5]) assert.equal((await f.request({ action: 'suspender', id: 'alvo', motivo })).statusCode, 400);
  assert.equal(f.docs.get('users/alvo').status, 'active');
  assert.equal(f.mod.parseMotivo('  foto\u0000 ofensiva \n '), 'foto  ofensiva');
});

test('suspender: status, Auth, sessões, tokens, denúncias resolvidas e registro', async () => {
  const f = fixture();
  const r = await f.request({ action: 'suspender', id: 'alvo', motivo: 'assédio repetido' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.body.situacao, 'suspensa');
  assert.equal(r.body.historico[0].acao, 'suspender');
  assert.equal(f.docs.get('users/alvo').status, 'suspended');
  assert.deepEqual(f.authCalls, [['update', 'alvo', { disabled: true }], ['revoke', 'alvo']]);
  assert.equal(f.docs.has('pushTokens/p1'), false);
  assert.equal(f.docs.has('pushTokens/p2'), true);
  assert.equal(f.docs.get('reports/a').status, 'resolved');
  assert.equal(f.docs.get('reports/b').status, 'resolved');
  assert.equal(f.docs.get('reports/a').nota, 'Conta suspensa: assédio repetido');
  assert.equal(f.docs.get('reports/a').atualizadoPor, 'admin-uid');
  assert.equal(f.docs.get('reports/c').status, 'dismissed', 'denúncia já descartada não muda');
  assert.equal(f.docs.get('reports/d').status, 'open', 'denúncia de outro alvo não muda');
  assert.deepEqual(f.logs().map(l => [l.acao, l.alvoId, l.adminUid, l.motivo, l.denunciasResolvidas]), [['suspender', 'alvo', 'admin-uid', 'assédio repetido', 2]]);
});

test('suspender de novo não quebra; reativar desfaz', async () => {
  const f = fixture();
  await f.request({ action: 'suspender', id: 'alvo', motivo: 'assédio' });
  assert.equal((await f.request({ action: 'suspender', id: 'alvo', motivo: 'assédio' })).statusCode, 200);
  const r = await f.request({ action: 'reativar', id: 'alvo', motivo: 'recurso aceito' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.situacao, 'ativa');
  assert.equal(f.docs.get('users/alvo').status, 'active');
  assert.equal('suspensaEm' in f.docs.get('users/alvo'), false);
  assert.deepEqual(f.authCalls.at(-1), ['update', 'alvo', { disabled: false }]);
  assert.equal(f.logs().length, 3);
});

test('não suspende a si mesmo, administrador nem usuário inexistente', async () => {
  const f = fixture({ docs: { 'users/admin-uid': { name: 'Eu' } } });
  assert.equal((await f.request({ action: 'suspender', id: 'admin-uid', motivo: 'teste' })).statusCode, 400);
  assert.equal((await f.request({ action: 'suspender', id: 'outroAdmin', motivo: 'teste' })).statusCode, 409);
  assert.equal((await f.request({ action: 'suspender', id: 'ninguem', motivo: 'teste' })).statusCode, 404);
  assert.equal(f.authCalls.length, 0);
  assert.equal(f.logs().length, 0);
});

test('perfil sem conta no Auth ainda é suspenso pelo status', async () => {
  const f = fixture({ semConta: true });
  assert.equal((await f.request({ action: 'suspender', id: 'alvo', motivo: 'spam' })).statusCode, 200);
  assert.equal(f.docs.get('users/alvo').status, 'suspended');
});

test('encerrar turma marca a moderação e resolve as denúncias da turma; só ela reabre', async () => {
  const f = fixture();
  const r = await f.request({ action: 'encerrarTurma', id: 't1', motivo: 'conteúdo ofensivo' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.situacao, 'encerrada');
  assert.equal(r.body.pelaModeracao, true);
  assert.equal(f.docs.get('turmas/t1').encerradaPor, 'moderacao');
  assert.equal(f.docs.get('turmas/t1').ativo, false);
  assert.equal(f.docs.get('reports/d').status, 'resolved');
  assert.equal(f.docs.get('reports/a').status, 'open', 'denúncia de usuário não muda');

  assert.equal((await f.request({ action: 'reabrirTurma', id: 't2', motivo: 'engano' })).statusCode, 409, 'encerrada pelo dono');
  const reaberta = await f.request({ action: 'reabrirTurma', id: 't1', motivo: 'engano' });
  assert.equal(reaberta.body.situacao, 'ativa');
  assert.equal('encerradaPor' in f.docs.get('turmas/t1'), false);
  assert.equal(f.docs.get('turmas/t1').status, 'ativa');
});

test('consultar devolve a situação e o histórico só do tipo pedido', async () => {
  const f = fixture();
  const u = await f.request({ action: 'consultar', tipo: 'user', id: 'alvo' });
  assert.equal(u.statusCode, 200);
  assert.deepEqual({ nome: u.body.nome, detalhe: u.body.detalhe, situacao: u.body.situacao, existe: u.body.existe }, { nome: 'João', detalhe: '@joao', situacao: 'ativa', existe: true });
  const t = await f.request({ action: 'consultar', tipo: 'turma', id: 't1' });
  assert.deepEqual({ nome: t.body.nome, detalhe: t.body.detalhe, situacao: t.body.situacao }, { nome: 'Pelada de Quinta', detalhe: 'Ana', situacao: 'ativa' });
  const nada = await f.request({ action: 'consultar', tipo: 'user', id: 'ninguem' });
  assert.equal(nada.body.existe, false);
  assert.equal(f.logs().length, 0, 'consultar não grava nada');
});

test('consultar com denuncias devolve as denúncias recebidas, sem quem denunciou', async () => {
  const f = fixture({ docs: {
    'reports/a': { targetType: 'user', targetId: 'alvo', status: 'open', reason: 'spam', details: 'manda link', reporterId: 'r1', createdAt: 1000 },
    'reports/b': { targetType: 'user', targetId: 'alvo', status: 'resolved', reason: 'harassment', nota: 'suspensa', reporterId: 'r2', createdAt: 3000 },
  } });
  const sem = await f.request({ action: 'consultar', tipo: 'user', id: 'alvo' });
  assert.equal(sem.body.denuncias, undefined, 'sem pedir, não lê as denúncias');
  const com = await f.request({ action: 'consultar', tipo: 'user', id: 'alvo', denuncias: true });
  assert.deepEqual(com.body.denuncias.map(d => [d.motivo, d.status, d.em]), [['harassment', 'resolved', 3000], ['spam', 'open', 1000], ['other', 'dismissed', 0]]);
  assert.equal(com.body.denuncias[1].detalhes, 'manda link');
  assert.ok(com.body.denuncias.every(d => !('reporterId' in d)), 'não expõe quem denunciou');
  const turma = await f.request({ action: 'consultar', tipo: 'turma', id: 't1', denuncias: true });
  assert.deepEqual(turma.body.denuncias.map(d => d.motivo), ['spam'], 'só as do tipo pedido');
});

test('pedido de revisão: reativar aceita, manter suspensão nega; sem pedido aberto, manter é recusado', async () => {
  const f = fixture({ docs: { 'revisoes/alvo': { uid: 'alvo', status: 'aberta', mensagem: 'foi engano' } } });
  await f.request({ action: 'suspender', id: 'alvo', motivo: 'assédio' });
  const negada = await f.request({ action: 'manterSuspensao', id: 'alvo', motivo: 'provas claras' });
  assert.equal(negada.statusCode, 200);
  assert.equal(negada.body.situacao, 'suspensa');
  assert.deepEqual([f.docs.get('revisoes/alvo').status, f.docs.get('revisoes/alvo').nota, f.docs.get('revisoes/alvo').decididaPor], ['negada', 'provas claras', 'admin-uid']);
  assert.ok(negada.body.historico.some(m => m.acao === 'manterSuspensao' && m.motivo === 'provas claras'));
  assert.equal((await f.request({ action: 'manterSuspensao', id: 'alvo', motivo: 'de novo' })).statusCode, 409, 'nada em aberto');

  f.docs.set('revisoes/alvo', { uid: 'alvo', status: 'aberta' });
  await f.request({ action: 'reativar', id: 'alvo', motivo: 'recurso aceito' });
  assert.equal(f.docs.get('revisoes/alvo').status, 'aceita');
  assert.equal((await f.request({ action: 'manterSuspensao', id: 'alvo', motivo: 'ativa' })).statusCode, 409, 'conta ativa');
});
