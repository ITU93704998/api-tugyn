// Rotina diária: contas do login sem perfil (cadastro interrompido). Fase 1 marca e revoga as sessões; fase 2 (rodada
// seguinte) reconfere tudo e só então apaga. Qualquer mudança no meio preserva a conta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));

class Timestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  toMillis() { return this.ms; }
}

const mod = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib/contasIncompletasJob.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    module: mod,
    exports: mod.exports,
    require: (n) => {
      if (n === 'firebase-admin/firestore') return { Timestamp };
      if (n === './exclusaoContaJob') return { COLECAO_EXCLUSOES: 'exclusoesConta' };
      if (n === './sistema') return { VERSOES_APP: 'versoesApp' };
      throw Error('Dependência inesperada ' + n);
    },
    console: { log() {}, warn() {} },
    Date,
    Promise,
  },
);
const J = mod.exports;

const H = 3600_000;
const DIA = 24 * H;
const T0 = Date.parse('2026-11-07T12:00:00Z');
const iso = (t) => new Date(t).toUTCString();
/** Conta de cadastro interrompido há 2 dias (entrou só na criação, nunca mais abriu o app). */
const conta = (uid, extra = {}, meta = {}) => ({
  uid,
  disabled: false,
  emailVerified: false,
  customClaims: undefined,
  providerData: [{ providerId: 'password' }],
  ...extra,
  metadata: { creationTime: iso(T0 - 2 * DIA), lastSignInTime: iso(T0 - 2 * DIA + 1000), lastRefreshTime: iso(T0 - 2 * DIA + 2000), ...meta },
});

test('candidata: só com todos os sinais de cadastro interrompido', () => {
  const c = (u) => J.contaIncompletaCandidata(u, T0);
  assert.equal(c(conta('a')), true);
  assert.equal(c(conta('b', { customClaims: { admin: true } })), false, 'administrador');
  assert.equal(c(conta('c', { disabled: true })), false, 'desativada');
  assert.equal(c(conta('d', { emailVerified: true })), false, 'e-mail confirmado');
  assert.equal(c(conta('e', { providerData: [{ providerId: 'google.com' }] })), false, 'outro provedor');
  assert.equal(c(conta('f', {}, { lastSignInTime: null })), false, 'nunca entrou (console/script)');
  assert.equal(c(conta('g', {}, { lastSignInTime: iso(T0 - 30 * H) })), false, 'entrou de novo depois');
  assert.equal(c(conta('h', {}, { creationTime: iso(T0 - 20 * H), lastSignInTime: iso(T0 - 20 * H) })), false, 'menos de 24 h');
  assert.equal(c(conta('i', {}, { lastRefreshTime: iso(T0 - 2 * H) })), false, 'app aberto há pouco');
  assert.equal(c(conta('j', {}, { creationTime: iso(T0 - 61 * DIA), lastSignInTime: iso(T0 - 61 * DIA) })), false, 'velha demais');
});

/** Firestore em memória: docs por caminho, consultas da coleção de marcas, getAll e transações. */
const banco = (inicial = {}) => {
  const dados = new Map(Object.entries(inicial));
  const ref = (p) => ({
    path: p,
    id: p.split('/').pop(),
    get ref() { return ref(p); },
    get: async () => snap(p),
    set: async (v, o) => { dados.set(p, o?.merge ? { ...(dados.get(p) ?? {}), ...v } : { ...v }); },
    update: async (v) => { if (!dados.has(p)) throw Error('sem doc ' + p); dados.set(p, { ...dados.get(p), ...v }); },
    delete: async () => { dados.delete(p); },
  });
  const snap = (p) => ({ exists: dados.has(p), id: p.split('/').pop(), ref: ref(p), get: (k) => dados.get(p)?.[k], data: () => dados.get(p) });
  const db = {
    dados,
    doc: ref,
    getAll: async (...refs) => refs.map((r) => snap(r.path)),
    collection: (nome) => {
      const q = { filtros: [], n: Infinity };
      const api = {
        where: (campo, _op, valor) => { q.filtros.push((d) => d[campo] && d[campo].toMillis() <= valor.toMillis()); return api; },
        orderBy: () => api,
        limit: (n) => { q.n = n; return api; },
        get: async () => ({
          docs: [...dados.keys()].filter((k) => k.startsWith(nome + '/') && q.filtros.every((f) => f(dados.get(k)))).slice(0, q.n).map(snap),
        }),
      };
      return api;
    },
    /** Antes do commit de cada transação, roda `antesDoCommit` (simula mudança concorrente). */
    antesDaTransacao: null,
    runTransaction: async (fn) => {
      if (db.antesDaTransacao) await db.antesDaTransacao();
      const ops = [];
      const tx = {
        get: async (r) => snap(r.path),
        create: (r, v) => ops.push(() => { if (dados.has(r.path)) throw Error('já existe'); dados.set(r.path, { ...v }); }),
        update: (r, v) => ops.push(() => dados.set(r.path, { ...dados.get(r.path), ...v })),
        delete: (r) => ops.push(() => dados.delete(r.path)),
      };
      const out = await fn(tx);
      ops.forEach((o) => o());
      return out;
    },
  };
  return db;
};

const autenticacao = (contas) => {
  const porUid = new Map(contas.map((c) => [c.uid, c]));
  const a = {
    porUid,
    apagadas: [],
    revogadas: [],
    listUsers: async () => ({ users: [...porUid.values()], pageToken: undefined }),
    getUser: async (uid) => { const c = porUid.get(uid); if (!c) throw Object.assign(Error('x'), { code: 'auth/user-not-found' }); return c; },
    revokeRefreshTokens: async (uid) => { a.revogadas.push(uid); },
    deleteUser: async (uid) => { a.apagadas.push(uid); porUid.delete(uid); },
  };
  return a;
};

const rodar = (db, auth, agora) => J.limparContasIncompletas(db, auth, Infinity, () => agora);
const resumo = (r) => ({ ...r });

test('1ª rodada só marca e revoga as sessões (não apaga); a seguinte apaga a que continua igual', async () => {
  const db = banco({ 'users/comPerfil': {}, 'exclusoesConta/excluindo': {} });
  const auth = autenticacao([conta('orfa'), conta('comPerfil'), conta('excluindo'), conta('admin', { customClaims: { admin: true } })]);
  const r1 = await rodar(db, auth, T0);
  assert.deepEqual(resumo(r1), { marcadas: 1, apagadas: 0, preservadas: 0, falhas: 0, restantes: false });
  assert.deepEqual(auth.revogadas, ['orfa']);
  assert.deepEqual(auth.apagadas, []);
  assert.ok(db.dados.get('contasIncompletas/orfa').revogadaEm, 'marca com a revogação anotada');

  const r2 = await rodar(db, auth, T0 + DIA);
  assert.equal(r2.apagadas, 1);
  assert.deepEqual(auth.apagadas, ['orfa']);
  assert.equal(db.dados.has('contasIncompletas/orfa'), false, 'marca removida depois de apagar');
});

test('antes da quarentena (2 h) a marcada não é apagada', async () => {
  const db = banco();
  const auth = autenticacao([conta('orfa')]);
  await rodar(db, auth, T0);
  await rodar(db, auth, T0 + 1 * H);
  assert.deepEqual(auth.apagadas, []);
});

test('ganhou perfil entre a marca e a exclusão (até dentro da transação final): preserva e tira a marca', async () => {
  const db = banco();
  const auth = autenticacao([conta('orfa')]);
  await rodar(db, auth, T0);
  db.antesDaTransacao = async () => { db.dados.set('users/orfa', { nome: 'x' }); }; // perfil chega logo antes da conferência final
  const r = await rodar(db, auth, T0 + DIA);
  assert.equal(r.apagadas, 0);
  assert.equal(r.preservadas, 1);
  assert.deepEqual(auth.apagadas, []);
  assert.equal(db.dados.has('contasIncompletas/orfa'), false);
});

test('ganhou permissão de administrador, entrou de novo ou renovou o acesso depois da marca: preserva', async () => {
  for (const mudar of [
    (c) => { c.customClaims = { admin: true }; },
    (c) => { c.metadata.lastSignInTime = iso(T0 + 3 * H); },
    (c) => { c.metadata.lastRefreshTime = iso(T0 + 3 * H); },
    (c) => { c.disabled = true; },
  ]) {
    const db = banco();
    const auth = autenticacao([conta('orfa')]);
    await rodar(db, auth, T0);
    mudar(auth.porUid.get('orfa'));
    const r = await rodar(db, auth, T0 + DIA + 2 * H);
    assert.equal(r.apagadas, 0);
    assert.deepEqual(auth.apagadas, []);
    assert.equal(db.dados.has('contasIncompletas/orfa'), false);
  }
});

test('falha ao ler a conta preserva (a marca fica para a próxima rodada); marca sem revogação não apaga', async () => {
  const db = banco();
  const auth = autenticacao([conta('orfa')]);
  await rodar(db, auth, T0);
  const getUser = auth.getUser;
  auth.getUser = async () => { throw Object.assign(Error('rede'), { code: 'auth/internal-error' }); };
  const r = await rodar(db, auth, T0 + DIA);
  assert.equal(r.falhas >= 1, true);
  assert.deepEqual(auth.apagadas, []);
  assert.equal(db.dados.has('contasIncompletas/orfa'), true);
  auth.getUser = getUser;

  const db2 = banco({ 'contasIncompletas/semRevogar': { marcadaEm: Timestamp.fromMillis(T0) } });
  const auth2 = autenticacao([conta('semRevogar')]);
  const r2 = await rodar(db2, auth2, T0 + DIA);
  assert.deepEqual(auth2.apagadas, []);
  assert.equal(r2.preservadas, 1);
});

test('revogação falhou: não conta como marcada e a fase 2 não apaga', async () => {
  const db = banco();
  const auth = autenticacao([conta('orfa')]);
  auth.revokeRefreshTokens = async () => { throw Error('x'); };
  const r = await rodar(db, auth, T0);
  assert.equal(r.marcadas, 0);
  assert.equal(r.falhas, 1);
  const r2 = await rodar(db, autenticacao([conta('orfa')]), T0 + DIA);
  assert.equal(r2.apagadas, 0);
});

test('prazo: guarda o cursor e a próxima rodada continua dele', async () => {
  let relogio = T0;
  const db = banco({ 'sistema/limpezaContasIncompletas': { pageToken: 'salvo' } });
  const tokens = [];
  const auth = autenticacao([]);
  auth.listUsers = async (_n, t) => { tokens.push(t); relogio += 5000; return { users: [], pageToken: 'seguinte' }; };
  const r = await J.limparContasIncompletas(db, auth, T0 + 4000, () => relogio);
  assert.equal(r.restantes, true);
  assert.deepEqual(tokens, ['salvo']);
  assert.equal(db.dados.get('sistema/limpezaContasIncompletas').pageToken, 'seguinte');
});
