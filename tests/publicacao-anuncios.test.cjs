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
const { excluirCampanha, publicarAnuncios } = require(path.join(root, 'api/_lib/publicacaoAnuncios.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const AGORA = Date.now();
const campanha = (over = {}) => ({ type: 'text', advertiser: 'Zé', placements: ['home'], title: 'Oi', linkUrl: 'https://a.com', startsAt: AGORA - 1000, endsAt: AGORA + 86_400_000, weight: 1, status: 'active', ...over });

/** Firestore de mentira: só o que a publicação usa (coleção inteira, documento, transação). */
const banco = (campanhas) => {
  const docs = new Map(Object.entries(campanhas).map(([id, data]) => [`adCampaigns/${id}`, data]));
  const gravados = [];
  const ref = (caminho) => ({ path: caminho, id: caminho.split('/').pop() });
  const db = {
    collection: (nome) => ({ nome, doc: (id = `auto${gravados.length}`) => ref(`${nome}/${id}`) }),
    doc: (caminho) => ref(caminho),
    runTransaction: async (fn) => {
      const tx = {
        get: async (alvo) => {
          if (alvo.nome) {
            const lista = [...docs.entries()].filter(([k]) => k.startsWith(`${alvo.nome}/`)).map(([k, data]) => ({ id: k.split('/').pop(), data: () => data }));
            return { docs: lista };
          }
          const data = docs.get(alvo.path);
          return { exists: data !== undefined, get: (campo) => data?.[campo] };
        },
        set: (r, data) => gravados.push(['set', r.path, data]),
        create: (r, data) => gravados.push(['create', r.path, data]),
        delete: (r) => { gravados.push(['delete', r.path]); docs.delete(r.path); },
      };
      return fn(tx);
    },
  };
  return { db, gravados };
};

test('publicar: monta adsConfig/atual com as campanhas ATUAIS do banco e registra quem publicou', async () => {
  const { db, gravados } = banco({ a: campanha(), pausada: campanha({ status: 'paused' }), lixo: { qualquer: 1 } });
  const r = await publicarAnuncios(db, 'admin1', AGORA);
  assert.deepEqual(r.ads.map((ad) => ad.id), ['a']);
  const config = gravados.find(([op, p]) => op === 'set' && p === 'adsConfig/atual');
  assert.equal(config[2].ads.length, 1);
  const trilha = gravados.find(([op, p]) => op === 'create' && p.startsWith('adsPublicacoes/'));
  assert.equal(trilha[2].uid, 'admin1');
  assert.equal(trilha[2].motivo, 'publicar');
  assert.deepEqual(trilha[2].ids, ['a']);
});

test('excluir: apaga e republica SEM ela na mesma transação; avisa se outra usa a mesma imagem', async () => {
  const img = 'https://res.cloudinary.com/demo/image/upload/anuncios/u/banners/x.jpg';
  const { db, gravados } = banco({ a: campanha({ type: 'banner', imageUrl: img, title: undefined }), b: campanha({ type: 'banner', imageUrl: img, title: undefined }), c: campanha() });
  const r = await excluirCampanha(db, 'a', true, 'admin1', AGORA);
  assert.equal(r.existia, true);
  assert.equal(r.imagemEmUso, true);
  assert.deepEqual(r.publicacao.ads.map((ad) => ad.id).sort(), ['b', 'c']);
  assert.ok(gravados.some(([op, p]) => op === 'delete' && p === 'adCampaigns/a'));
});

test('excluir sem republicar: só apaga; campanha que já não existe não quebra', async () => {
  const { db, gravados } = banco({ c: campanha() });
  const r = await excluirCampanha(db, 'sumiu', false, 'admin1', AGORA);
  assert.deepEqual(r, { existia: false, imagemEmUso: false, publicacao: null });
  assert.equal(gravados.length, 0);
});
