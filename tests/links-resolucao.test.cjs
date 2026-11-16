// Resolução do link curto (?formato=id) e leitura limitada das imagens do cartão.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));

let banco = null; // trocado em cada teste
const stubs = {
  'firebase-admin/firestore': { getFirestore: () => banco, FieldPath: { documentId: () => '__id__' } },
  '../_lib/auth': { getFirebaseApp: () => ({}) },
  '../_lib/version': { resolvePolicy: () => ({ policy: { storeUrl: null } }) },
  '../_lib/cartaoLink': { gerarCartao: async () => Buffer.from('png') },
};
function carregar(arquivo) {
  const m = { exports: {} };
  const req = createRequire(arquivo);
  const local = (n) => {
    if (n in stubs) return stubs[n];
    if (n.startsWith('.')) { const alvo = path.resolve(path.dirname(arquivo), n) + '.ts'; if (fs.existsSync(alvo)) return carregar(alvo); }
    return req(n);
  };
  const src = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext('(function(require,module,exports){' + src + '\n})', { filename: arquivo })(local, m, m.exports);
  return m.exports;
}
const handler = carregar(path.join(root, 'api/turma/[id].ts')).default;
const cartao = carregar(path.join(root, 'api/_lib/cartaoLink.ts'));

/** Firestore falso: documentos por caminho e consulta por intervalo de id; `falhar` faz toda leitura dar erro. */
const fakeDb = (docs, { falhar = false } = {}) => ({
  collection: (nome) => {
    let inicio = '', fim = '￿';
    const q = {
      orderBy: () => q, startAt: (v) => { inicio = v; return q; }, endAt: (v) => { fim = v; return q; }, limit: () => q, select: () => q,
      get: async () => { if (falhar) throw new Error('UNAVAILABLE'); return { docs: Object.keys(docs).filter((k) => k.startsWith(nome + '/')).map((k) => k.slice(nome.length + 1)).filter((i) => i >= inicio && i <= fim).map((id) => ({ id })) }; },
      doc: (id) => ({ get: async () => { if (falhar) throw new Error('UNAVAILABLE'); const d = docs[`${nome}/${id}`]; return { exists: Boolean(d), data: () => d, get: (k) => d?.[k] }; } }),
    };
    return q;
  },
});

async function pedir(query) {
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, redirect(c, u) { this.statusCode = c; this.body = u; return this; } };
  await handler({ method: 'GET', query, headers: { host: 'link.tugyntec.com.br' } }, res);
  return res;
}

const CT = 'ct_e2b8902acd29dc786a9ef7e3';
const CAMP = { nome: 'Copa', status: 'inscricoes', formato: 'mata', modalidade: 'society', cidade: 'Palmas', estado: 'TO', maxTimes: 8, aprovados: 2, inscricaoCentavos: 0 };

test('código existente vira o id (cache curto na CDN)', async () => {
  banco = fakeDb({ 'codigosConvite/K7P2QX': { turmaId: 'turmaAbc123' }, [`campeonatosTimes/${CT}`]: CAMP });
  const t = await pedir({ id: 'K7P2QX', formato: 'id' });
  assert.equal(t.statusCode, 200); assert.deepEqual(t.body, { id: 'turmaAbc123' });
  const c = await pedir({ id: 'e2b8902acd', tipo: 'campeonato', formato: 'id' });
  assert.equal(c.statusCode, 200); assert.deepEqual(c.body, { id: CT });
});

test('código que não existe: 404 (o app mostra "não é mais válido")', async () => {
  banco = fakeDb({});
  const t = await pedir({ id: 'AAAAAA', formato: 'id' });
  assert.equal(t.statusCode, 404);
  const c = await pedir({ id: '0000000000', tipo: 'campeonato', formato: 'id' });
  assert.equal(c.statusCode, 404);
});

test('banco indisponível: 503 sem cache, nunca 404 (o app oferece tentar de novo)', async () => {
  banco = fakeDb({}, { falhar: true });
  for (const q of [{ id: 'K7P2QX', formato: 'id' }, { id: 'e2b8902acd', tipo: 'campeonato', formato: 'id' }]) {
    const r = await pedir(q);
    assert.equal(r.statusCode, 503, JSON.stringify(q));
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.deepEqual(r.body, { error: 'indisponivel' });
  }
});

const resposta = (partes, cabecalhos = {}) => {
  let i = 0, cancelado = false;
  return {
    headers: { get: (k) => cabecalhos[k.toLowerCase()] ?? null },
    body: { getReader: () => ({ read: async () => (cancelado || i >= partes.length ? { done: true } : { done: false, value: partes[i++] }), cancel: async () => { cancelado = true; } }) },
    lidas: () => i,
  };
};

test('imagem: lê até o limite; acima dele para no meio do download; Content-Length grande nem começa', async () => {
  const kb = new Uint8Array(1024);
  assert.equal((await cartao.lerAteLimite(resposta([kb, kb]), 4096)).length, 2048);
  const grande = resposta(Array.from({ length: 100 }, () => kb));
  assert.equal(await cartao.lerAteLimite(grande, 4096), null);
  assert.ok(grande.lidas() <= 5, 'parou logo depois de passar do limite');
  const declarado = resposta([kb], { 'content-length': String(10 * 1024 * 1024) });
  const controle = new AbortController();
  assert.equal(await cartao.lerAteLimite(declarado, 4096, controle), null);
  assert.equal(declarado.lidas(), 0); assert.equal(controle.signal.aborted, true);
});
