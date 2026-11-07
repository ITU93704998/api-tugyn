// Exclusão de imagens (api/delete.ts): banners de anúncio podem ser apagados por QUALQUER administrador,
// menos a imagem do contrato e a que outra campanha ainda usa. As demais imagens continuam só da própria pasta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));

const transpilar = (arquivo) => ts.transpileModule(fs.readFileSync(path.join(root, arquivo), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function carregar(arquivo, deps) {
  const module = { exports: {} };
  vm.runInNewContext(transpilar(arquivo), { exports: module.exports, module, require: (n) => { if (!(n in deps)) throw Error(n); return deps[n]; }, console: { log() {}, error() {} }, process, URL });
  return module.exports;
}
const BUCKETS = ['usuarios', 'times', 'arenas', 'anuncios', 'turmas'];
const validacao = carregar('api/_lib/validation.ts', { './config': { BUCKETS } });

function rota({ admin = true, uid = 'admin-novo', campanhas = [], falharLeitura = false, publicados = null } = {}) {
  const apagadas = [];
  const mod = carregar('api/delete.ts', {
    cloudinary: { v2: { uploader: { destroy: async (id) => { apagadas.push(id); return { result: 'ok' }; } } } },
    'firebase-admin/firestore': {
      getFirestore: () => ({
        collection: (nome) => {
          assert.equal(nome, 'adCampaigns');
          return { select: () => ({ get: async () => { if (falharLeitura) throw Error('x'); return { docs: campanhas.map((imageUrl) => ({ get: () => imageUrl })) }; } }) };
        },
        doc: (caminho) => {
          assert.equal(caminho, 'adsConfig/atual');
          return { get: async () => ({ exists: publicados !== null, data: () => publicados }) };
        },
      }),
    },
    './_lib/appCheck': { verificarAppCheck: async () => true },
    './_lib/auth': { getFirebaseApp: () => ({}), requireUser: async () => ({ uid, admin }) },
    './_lib/cors': { handleCors: () => false },
    './_lib/config': { getAccount: () => ({ cloud_name: 'tugyn' }), isAdminOnlyBucket: (b) => b === 'anuncios' },
    './_lib/publicacaoAnuncios': { COLECAO_CAMPANHAS: 'adCampaigns', DOC_ANUNCIOS_PUBLICADOS: 'adsConfig/atual' },
    './_lib/rateLimit': { dentroDoLimite: async () => true },
    './_lib/validation': validacao,
  });
  async function pedir(body) {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
    await mod.default({ method: 'POST', body, headers: {} }, res);
    return res;
  }
  return { pedir, apagadas };
}

const BANNER = 'anuncios/admin-antigo/banners/abc123';
const URL_BANNER = `https://res.cloudinary.com/tugyn/image/upload/v17000/${BANNER}.webp`;

test('banner enviado por outro administrador (ou pela mesma pessoa em outra conta) agora é apagado', async () => {
  const r = rota({ campanhas: ['https://res.cloudinary.com/tugyn/image/upload/v1/anuncios/x/banners/outro.webp'] });
  const res = await r.pedir({ bucket: 'anuncios', public_id: BANNER });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(r.apagadas, [BANNER]);
});

test('imagem que outra campanha ainda usa: 409 e nada é apagado', async () => {
  const r = rota({ campanhas: [URL_BANNER] });
  const res = await r.pedir({ bucket: 'anuncios', public_id: BANNER });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(r.apagadas, []);
  // Com transformação no caminho também é reconhecida.
  assert.equal(validacao.urlUsaImagem(`https://res.cloudinary.com/tugyn/image/upload/c_fill,w_300/v1/${BANNER}.jpg`, BANNER), true);
  assert.equal(validacao.urlUsaImagem(`https://res.cloudinary.com/tugyn/image/upload/v1/${BANNER}2.jpg`, BANNER), false);
});

test('imagem do contrato não é apagada; caminho estranho é recusado; falha ao conferir não apaga', async () => {
  const r = rota();
  assert.equal((await r.pedir({ bucket: 'anuncios', public_id: 'anuncios/adm/contratos/c1' })).statusCode, 403);
  assert.equal((await r.pedir({ bucket: 'anuncios', public_id: 'anuncios/../turmas/x/y' })).statusCode, 400);
  assert.equal((await r.pedir({ bucket: 'anuncios', public_id: 'usuarios/adm/perfil/x' })).statusCode, 400);
  assert.equal((await rota({ falharLeitura: true }).pedir({ bucket: 'anuncios', public_id: BANNER })).statusCode, 503);
  assert.deepEqual(r.apagadas, []);
});

test('quem não é administrador continua sem apagar banners; outras pastas seguem a regra da própria pasta', async () => {
  assert.equal((await rota({ admin: false }).pedir({ bucket: 'anuncios', public_id: BANNER })).statusCode, 403);
  const r = rota({ admin: false, uid: 'u1' });
  assert.equal((await r.pedir({ bucket: 'usuarios', public_id: 'usuarios/outro/perfil/x' })).statusCode, 403);
  assert.equal((await r.pedir({ bucket: 'usuarios', public_id: 'usuarios/u1/perfil/x' })).statusCode, 200);
  assert.deepEqual(r.apagadas, ['usuarios/u1/perfil/x']);
});

test('URL sem extensão, com transformações, query string ou assinatura também conta como em uso; id parecido não', async () => {
  const u = (resto) => `https://res.cloudinary.com/tugyn/image/upload/${resto}`;
  const usa = (url) => validacao.urlUsaImagem(url, BANNER, 'tugyn');
  assert.equal(usa(u(`f_auto/v1/${BANNER}`)), true, 'sem extensão');
  assert.equal(usa(u(BANNER)), true, 'sem versão nem extensão');
  assert.equal(usa(u(`c_fill,w_300/f_auto,q_auto/v17/${BANNER}.webp?_a=x#y`)), true, 'transformações, query e fragmento');
  assert.equal(usa(u(`s--Ab12Cd--/v1/${BANNER}.png`)), true, 'URL assinada');
  assert.equal(usa(u(`v1/${BANNER}2`)), false, 'id com o mesmo começo');
  assert.equal(usa(u(`v1/x/${BANNER}`)), false, 'outra pasta na frente (outro id)');
  assert.equal(usa(`https://res.cloudinary.com/outra-conta/image/upload/v1/${BANNER}`), false, 'outra conta do Cloudinary');
  assert.equal(usa(`https://cdn.exemplo.com/${BANNER}`), true, 'endereço desconhecido que contém o id: na dúvida, em uso');
  const r = rota({ campanhas: [u(`f_auto/v1/${BANNER}`)] });
  const res = await r.pedir({ bucket: 'anuncios', public_id: BANNER });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(r.apagadas, []);
});

test('campanha excluída sem republicar: imagem ainda nos anúncios publicados não é apagada (409 publicada)', async () => {
  const r = rota({ publicados: { version: 1, ads: [{ id: 'a1', imagem: { url: `https://res.cloudinary.com/tugyn/image/upload/v9/${BANNER}` } }] } });
  const res = await r.pedir({ bucket: 'anuncios', public_id: BANNER });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'publicada');
  assert.deepEqual(r.apagadas, []);
  const livre = rota({ publicados: { version: 1, ads: [{ imageUrl: 'https://res.cloudinary.com/tugyn/image/upload/v9/anuncios/x/banners/outro.webp' }] } });
  assert.equal((await livre.pedir({ bucket: 'anuncios', public_id: BANNER })).statusCode, 200);
});
