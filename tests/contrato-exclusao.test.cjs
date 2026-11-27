const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
// Compila apenas em memória. Nenhuma credencial, rede, Cloudinary ou Firestore real é usado.
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const cloud = require('cloudinary').v2;
const contratos = require('../api/_lib/contratos.ts');
const publicacao = require('../api/_lib/publicacaoAnuncios.ts');
const exclusao = require('../api/_lib/contratoExclusao.ts');
const fase2 = require('../api/_lib/contratosFase2.ts');
process.env.CLOUDINARY_NAME_ANUNCIOS = 'fake'; process.env.CLOUDINARY_KEY_ANUNCIOS = 'fake'; process.env.CLOUDINARY_SECRET_ANUNCIOS = 'fake';

const chamadas = [];
let falharDestroy = false;
const falhas = { batch: 0 };
cloud.uploader.destroy = async (id, o) => { chamadas.push(['destroy', id, o.type, o.resource_type]); if (falharDestroy) throw new Error('rede'); return { result: 'ok' }; };
cloud.api.delete_resources_by_tag = async (tag, o) => { chamadas.push(['tag', tag, o.resource_type]); return {}; };
cloud.api.delete_resources_by_prefix = async (p, o) => { chamadas.push(['prefixo', p, o.type, o.resource_type]); return {}; };
const campanhasExcluidas = [];
publicacao.excluirCampanha = async (db, id, publicar) => { campanhasExcluidas.push([id, publicar]); return { existia: true, imagemEmUso: false, publicacao: { ads: [] } }; };

function dbFake(inicial) {
  const docs = new Map(Object.entries(inicial));
  const ref = (path) => ({
    path, id: path.split('/').pop(),
    get: async () => ({ exists: docs.has(path), data: () => structuredClone(docs.get(path)), get: (k) => docs.get(path)?.[k] }),
    delete: async () => { docs.delete(path); },
    update: async (v) => { docs.set(path, { ...docs.get(path), ...v }); },
    collection: (sub) => colecao(path + '/' + sub),
  });
  const consulta = (prefixo, filtro) => ({
    get: async () => {
      const lista = [...docs.keys()].filter((k) => k.startsWith(prefixo + '/') && !k.slice(prefixo.length + 1).includes('/') && (!filtro || docs.get(k)[filtro[0]] === filtro[1]));
      return { docs: lista.map((k) => ({ ref: ref(k), data: () => structuredClone(docs.get(k)) })) };
    },
  });
  const colecao = (nome) => ({ doc: (id) => ref(nome + '/' + id), where: (campo, _op, valor) => consulta(nome, [campo, valor]), get: consulta(nome).get });
  return { docs, db: { doc: ref, collection: colecao, batch: () => { const ops = []; return { delete: (r) => ops.push(r.path), commit: async () => { if (falhas.batch > 0) { falhas.batch--; throw new Error('firestore fora'); } ops.forEach((p) => docs.delete(p)); } }; },
    runTransaction: async (f) => f({ get: (r) => r.get(), update: (r, v) => docs.set(r.path, { ...docs.get(r.path), ...v }) }) } };
}
const resposta = () => ({ code: 0, body: null, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } });

const CONTRATO = {
  status: 'aprovado', codigo: 'ABC234', tokenHash: 'h', tokenExpiresAt: Date.now() + 86400000, campanhaId: 'camp1',
  cliente: { nome: 'Padaria do Zé', email: 'ze@example.com', whatsapp: '11999999999' },
  pedido: { modelo: 'banner', telas: ['home'], escopo: 'cidade', cidade: null, inicioMs: 1, fimMs: 2, dias: 1 }, preco: { total: 1000, valorPorDia: 1000 },
  pagamento: { comprovante: { publicId: 'comprovantes/c1/comprovante-x.pdf', formato: 'pdf', bytes: 10, enviadoEm: 1 } },
  anuncio: { anunciante: 'Zé', linkUrl: 'https://ze.example.com', imagem: { url: 'https://x/y.jpg', publicId: 'anuncios/adm/contratos/ban1', largura: 1600, altura: 500, bytes: 1 } },
  documentoContrato: { publicId: 'contrato-modelo/contrato-M.pdf', sha256: 'a'.repeat(64), versao: 1, nome: 'c.pdf', bytes: 1, preenchivel: false, enviadoEm: 1 },
  historico: [],
};
const base = () => dbFake({
  'contratos/c1': structuredClone(CONTRATO),
  'contratos/c1/aceites/a1': { documentoContrato: { publicId: 'contratos-preenchidos/c1/contrato-p.pdf', preenchivel: true } },
  'contratos/outro': { ...structuredClone(CONTRATO), codigo: 'ZZZ999', campanhaId: 'camp2' },
  'contratoCodigos/ABC234': { contratoId: 'c1' },
  'solicitacoes/s1': { contratoId: 'c1', nome: 'Zé' },
  'solicitacoes/s2': { contratoId: 'outro' },
  'adStats/camp1_20261120': { campaignId: 'camp1' },
  'adStats/camp2_20261120': { campaignId: 'camp2' },
});

test('comprovante: aceita PDF de verdade e imagens; recusa PDF falso e outros tipos', () => {
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.7 conteúdo').toString('base64');
  assert.equal(contratos.validarComprovante(pdf).ok, true);
  assert.equal(contratos.validarComprovante(pdf).mime, 'application/pdf');
  assert.equal(contratos.validarComprovante('data:application/pdf;base64,' + Buffer.from('<html>').toString('base64')).ok, false);
  assert.equal(contratos.validarComprovante('data:image/gif;base64,R0lGODlh').ok, false);
  assert.match(contratos.validarComprovante('data:image/gif;base64,R0lGODlh').error, /PDF/);
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  assert.equal(contratos.validarComprovante(png).ok, true);
  assert.equal(contratos.validarImagem(pdf).ok, false, 'o banner continua só com imagem');
  assert.equal(contratos.recursoDoComprovante('pdf'), 'raw');
  assert.equal(contratos.recursoDoComprovante('jpg'), 'image');
});

test('arquivos do contrato: comprovante, banner e preenchidos; nunca o modelo compartilhado', () => {
  const doc = contratos.parseContrato(structuredClone(CONTRATO));
  const ids = exclusao.arquivosDoContrato(doc, [{ documentoContrato: { publicId: 'contratos-preenchidos/c1/p.pdf', preenchivel: true } }]).map((a) => a.publicId);
  assert.deepEqual(ids, ['comprovantes/c1/comprovante-x.pdf', 'anuncios/adm/contratos/ban1', 'contratos-preenchidos/c1/p.pdf']);
  assert.ok(!ids.includes('contrato-modelo/contrato-M.pdf'));
});

test('excluir: exige o código do pedido', async () => {
  const { db, docs } = base();
  const r = resposta();
  await exclusao.adminExcluirContrato(db, db.doc('contratos/c1'), 'errado', 'adm', Date.now(), r);
  assert.equal(r.code, 400);
  assert.ok(docs.has('contratos/c1'));
});

test('excluir: apaga campanha, números, arquivos e dados do cliente, sem tocar em outro contrato', async () => {
  chamadas.length = 0; campanhasExcluidas.length = 0; falharDestroy = false;
  const { db, docs } = base();
  const r = resposta();
  await exclusao.adminExcluirContrato(db, db.doc('contratos/c1'), ' abc234 ', 'adm', Date.now(), r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(campanhasExcluidas, [['camp1', true]]);
  for (const k of ['contratos/c1', 'contratos/c1/aceites/a1', 'contratoCodigos/ABC234', 'solicitacoes/s1', 'adStats/camp1_20261120']) assert.ok(!docs.has(k), k);
  for (const k of ['contratos/outro', 'solicitacoes/s2', 'adStats/camp2_20261120']) assert.ok(docs.has(k), k);
  assert.deepEqual(chamadas.filter((c) => c[0] === 'destroy').map((c) => [c[1], c[2], c[3]]), [
    ['comprovantes/c1/comprovante-x.pdf', 'authenticated', 'raw'],
    ['anuncios/adm/contratos/ban1', 'upload', 'image'],
    ['contratos-preenchidos/c1/contrato-p.pdf', 'authenticated', 'raw'],
  ]);
  assert.ok(chamadas.some((c) => c[0] === 'tag' && c[1] === 'contrato_c1'));
  assert.ok(chamadas.some((c) => c[0] === 'prefixo' && c[1] === 'contratos-preenchidos/c1/'));
  assert.ok(!chamadas.some((c) => String(c[1]).startsWith('contrato-modelo')), 'o modelo compartilhado fica');
});

test('excluir: se o Cloudinary falhar, bloqueia o contrato mas mantém campanha, números e dados; ao repetir, termina', async () => {
  falharDestroy = true; campanhasExcluidas.length = 0;
  const { db, docs } = base();
  const r = resposta();
  await exclusao.adminExcluirContrato(db, db.doc('contratos/c1'), 'ABC234', 'adm', Date.now(), r);
  falharDestroy = false;
  assert.equal(r.code, 502);
  assert.match(r.body.error, /link do cliente já foi desativado/);
  assert.deepEqual(campanhasExcluidas, [], 'a campanha continua no app');
  for (const k of ['contratos/c1', 'solicitacoes/s1', 'contratoCodigos/ABC234', 'adStats/camp1_20261120', 'contratos/c1/aceites/a1']) assert.ok(docs.has(k), k);
  assert.ok(docs.get('contratos/c1').excluindoEm, 'contrato bloqueado');
  assert.equal(docs.get('contratos/c1').tokenHash, 'excluindo', 'link do cliente desativado');
  // bloqueado: nenhuma ação muda o contrato
  await assert.rejects(require('../api/_lib/contratosComuns.ts').lerNaTransacao({ get: (ref) => ref.get() }, db.doc('contratos/c1')));
  const de_novo = resposta();
  await exclusao.adminExcluirContrato(db, db.doc('contratos/c1'), 'ABC234', 'adm', Date.now(), de_novo);
  assert.equal(de_novo.code, 200);
  assert.deepEqual(campanhasExcluidas, [['camp1', true]]);
  for (const k of ['contratos/c1', 'solicitacoes/s1', 'contratoCodigos/ABC234', 'adStats/camp1_20261120']) assert.ok(!docs.has(k), k);
});

test('excluir: se o Firestore falhar no fim, o contrato continua (bloqueado) e a repetição termina', async () => {
  falhas.batch = 1;
  const { db, docs } = base();
  const r = resposta();
  await exclusao.adminExcluirContrato(db, db.doc('contratos/c1'), 'ABC234', 'adm', Date.now(), r);
  assert.equal(r.code, 503);
  assert.match(r.body.error, /arquivos do contrato já foram apagados/);
  assert.ok(docs.has('contratos/c1') && docs.get('contratos/c1').excluindoEm);
  const de_novo = resposta();
  await exclusao.adminExcluirContrato(db, db.doc('contratos/c1'), 'ABC234', 'adm', Date.now(), de_novo);
  assert.equal(de_novo.code, 200);
  assert.ok(!docs.has('contratos/c1') && !docs.has('solicitacoes/s1'));
  falhas.batch = 0;
});

test('PDF do contrato: acha o arquivo em outro tipo de armazenamento e devolve null quando não existe', async () => {
  const conta = { cloud_name: 'x', api_key: 'k', api_secret: 's' };
  const original = cloud.api.resource;
  try {
    cloud.api.resource = async (id, o) => { if (o.type === 'upload' && o.resource_type === 'raw') return {}; throw { error: { http_code: 404 } }; };
    assert.deepEqual(await fase2.localizarPdf(conta, 'contrato-modelo/c.pdf'), { publicId: 'contrato-modelo/c.pdf', type: 'upload', resource_type: 'raw', formato: '' });
    cloud.api.resource = async (id, o) => { if (o.resource_type === 'image' && o.type === 'authenticated' && id === 'contrato-modelo/c') return {}; throw { error: { http_code: 404 } }; };
    assert.deepEqual(await fase2.localizarPdf(conta, 'contrato-modelo/c.pdf'), { publicId: 'contrato-modelo/c', type: 'authenticated', resource_type: 'image', formato: 'pdf' });
    cloud.api.resource = async () => { throw { error: { http_code: 404 } }; };
    assert.equal(await fase2.localizarPdf(conta, 'contrato-modelo/c.pdf'), null);
    cloud.api.resource = async () => { throw { error: { http_code: 420, message: 'limite' } }; };
    await assert.rejects(fase2.localizarPdf(conta, 'contrato-modelo/c.pdf'));
  } finally { cloud.api.resource = original; }
});
