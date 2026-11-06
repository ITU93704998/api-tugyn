// Mapa de usuários do painel: totais por estado e cidade, sem nomes nem coordenadas.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const anterior = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const M = require(path.join(root, 'api/_lib/mapaUsuarios.ts'));
if (anterior) require.extensions['.ts'] = anterior;
else delete require.extensions['.ts'];

const loc = (city, state, cityId) => ({ location: { city, state, cityId } });

test('localização: usa o cityId gravado, deduz a UF dele e gera o id pela cidade', () => {
  assert.deepEqual(M.localizacaoDoPerfil(loc('Palmas', 'TO', 'palmas_to')), { id: 'palmas_to', cidade: 'Palmas', uf: 'TO' });
  assert.deepEqual(M.localizacaoDoPerfil(loc('São Paulo', 'sp')), { id: 'sao_paulo_sp', cidade: 'São Paulo', uf: 'SP' });
  assert.deepEqual(M.localizacaoDoPerfil(loc('', 'Tocantins', 'palmas_to')), { id: 'palmas_to', cidade: '', uf: 'TO' }, 'UF por extenso: vem do id');
  assert.deepEqual(M.localizacaoDoPerfil(loc('', 'GO')), { id: '', cidade: '', uf: 'GO' }, 'só o estado');
  assert.equal(M.localizacaoDoPerfil(loc('Lisboa', 'PT')), null);
  assert.equal(M.localizacaoDoPerfil({}), null);
  assert.deepEqual(M.localizacaoDoPerfil(loc('Palmas', 'TO', 'goiania_go')), { id: 'palmas_to', cidade: 'Palmas', uf: 'TO' }, 'id de outro estado é ignorado');
});

test('agregar: soma por estado e cidade, deixa de fora suspensos e em exclusão', () => {
  const m = M.agregar([
    loc('Palmas', 'TO', 'palmas_to'), loc('Palmas', 'TO', 'palmas_to'), loc('Gurupi', 'TO'),
    loc('', 'GO'), {}, { ...loc('Palmas', 'TO'), status: 'suspended' }, { ...loc('Palmas', 'TO'), excluindoEm: 1 },
  ], 123);
  assert.equal(m.perfis, 5);
  assert.equal(m.ignorados, 2);
  assert.equal(m.semLocalizacao, 1);
  assert.equal(m.comLocalizacao, 4);
  assert.deepEqual(m.porEstado, { TO: 3, GO: 1 });
  assert.deepEqual(m.cidades.map((c) => [c.id, c.total]), [['palmas_to', 2], ['gurupi_to', 1]]);
  assert.equal(m.geradoEm, 123);
  assert.ok(!JSON.stringify(m).includes('uid'), 'sem identificadores');
});

test('agregar: guarda as maiores cidades e soma o resto em outrasCidades', () => {
  const perfis = [];
  for (let i = 0; i < M.CIDADES_MAX + 5; i++) perfis.push(loc(`Cidade ${i}`, 'MG'));
  perfis.push(loc('Cidade 0', 'MG'));
  const m = M.agregar(perfis, 1);
  assert.equal(m.cidades.length, M.CIDADES_MAX);
  assert.equal(m.cidades[0].id, 'cidade_0_mg');
  assert.equal(m.outrasCidades, 5);
  assert.equal(m.porEstado.MG, M.CIDADES_MAX + 6);
});

test('rota: mapa e gerar-mapa ficam na rota de administradores, com limite de 3 por hora', () => {
  const src = fs.readFileSync(path.join(root, 'api/_lib/adminUsuarios.ts'), 'utf8');
  assert.match(src, /body\.action === "mapa"/);
  assert.match(src, /dentroDoLimite\(user\.uid, "admin-mapa", 3, 3600\)/);
  assert.ok(src.indexOf('if (!user.admin)') < src.indexOf('body.action === "mapa"'));
});

// ── Geração: banco simulado com transações (aplica as gravações no fim, como o Firestore) ──
function fakeDb(qtd, inicial = {}, { falharPagina, aoLerPagina } = {}) {
  const docs = new Map(Object.entries(inicial));
  const perfis = new Map();
  for (let i = 0; i < qtd; i++) perfis.set('u' + String(i).padStart(6, '0'), i % 2 ? loc('Palmas', 'TO', 'palmas_to') : loc('Recife', 'PE'));
  const ids = [...perfis.keys()].sort();
  const estado = { lidos: 0, paginas: 0 };
  const limpo = (d) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'salvoEm' || k === 'atualizadoEm' ? 'TS' : v)));
  const snap = (key) => ({ exists: docs.has(key), data: () => (docs.has(key) ? JSON.parse(JSON.stringify(docs.get(key))) : undefined) });
  const db = {
    doc: (key) => ({ key, get: async () => snap(key) }),
    runTransaction: async (fn) => {
      const pendentes = [];
      const t = {
        getAll: async (...refs) => refs.map((r) => snap(r.key)),
        get: async (r) => snap(r.key),
        set: (r, d) => pendentes.push(() => docs.set(r.key, limpo(d))),
        update: (r, d) => pendentes.push(() => docs.set(r.key, { ...docs.get(r.key), ...limpo(d) })),
        delete: (r) => pendentes.push(() => docs.delete(r.key)),
      };
      const r = await fn(t);
      pendentes.forEach((p) => p());
      return r;
    },
    collection: () => {
      let depois = '';
      let max = Infinity;
      const q = {
        orderBy: () => q,
        select: () => q,
        limit: (n) => { max = n; return q; },
        startAfter: (id) => { depois = id; return q; },
        get: async () => {
          estado.paginas++;
          if (falharPagina === estado.paginas) throw Error('Firestore lento');
          if (aoLerPagina) aoLerPagina(estado.paginas, docs);
          const lista = ids.filter((id) => id > depois).slice(0, max);
          estado.lidos += lista.length;
          return { size: lista.length, docs: lista.map((id) => ({ id, data: () => perfis.get(id) })) };
        },
      };
      return q;
    },
  };
  return { db, docs, estado };
}
const T0 = 1_800_000_000_000;
const pode = () => async () => true;

test('MAP-01: gera e publica; mapa recente volta sem varrer; reserva de outra geração dá 409', async () => {
  const { db, docs, estado } = fakeDb(2500);
  const r = await M.gerarMapa(db, 'adm', { podeIniciar: pode(), agora: () => T0 });
  assert.equal(r.tipo, 'pronto');
  assert.equal(r.mapa.perfis, 2500);
  assert.deepEqual(r.mapa.porEstado, { PE: 1250, TO: 1250 });
  assert.equal(estado.lidos, 2500);
  assert.equal(docs.has(M.DOC_GERACAO), false, 'reserva liberada');
  assert.equal(docs.get(M.DOC_MAPA).geradoPor, 'adm');

  // Outro administrador 5 min depois: devolve o salvo, sem ler perfis e sem gastar o limite.
  let pediu = false;
  const recente = await M.gerarMapa(db, 'outro', { podeIniciar: async () => (pediu = true), agora: () => T0 + 5 * 60_000 });
  assert.equal(recente.tipo, 'recente');
  assert.equal(estado.lidos, 2500);
  assert.equal(pediu, false);

  // Reserva ativa de outra instância: 409, nada lido.
  docs.set(M.DOC_GERACAO, { id: 'x', reservaAte: T0 + 60 * 60_000 + 30_000, iniciadoEm: T0 });
  await assert.rejects(M.gerarMapa(db, 'adm', { podeIniciar: pode(), agora: () => T0 + 60 * 60_000 }), (e) => e instanceof M.RecusaMapa && e.status === 409);
  assert.equal(estado.lidos, 2500);
});

test('MAP-01: geração antiga não publica por cima da nova (reserva tomada no meio)', async () => {
  const novo = { geradoEm: T0 + 999, perfis: 7, comLocalizacao: 7, semLocalizacao: 0, ignorados: 0, porEstado: { SP: 7 }, cidades: [], outrasCidades: 0, parcial: false };
  const { db, docs } = fakeDb(1500, {}, {
    aoLerPagina: (n, d) => {
      if (n === 1) {
        d.set(M.DOC_GERACAO, { id: 'outra', reservaAte: 0 });
        d.set(M.DOC_MAPA, novo);
      }
    },
  });
  const r = await M.gerarMapa(db, 'adm', { podeIniciar: pode(), agora: () => T0 });
  assert.equal(r.tipo, 'pronto');
  assert.equal(r.mapa.perfis, 7, 'devolve o mapa da geração vigente');
  assert.deepEqual(docs.get(M.DOC_MAPA).porEstado, { SP: 7 }, 'não sobrescreveu');
  assert.equal(docs.get(M.DOC_GERACAO).id, 'outra', 'não apagou a reserva alheia');
});

test('MAP-02: prazo guarda o progresso e o próximo clique continua sem reler; retomar não conta no limite', async () => {
  let agora = T0;
  const { db, docs, estado } = fakeDb(3500, {}, { aoLerPagina: () => { agora += 25_000; } });
  const r1 = await M.gerarMapa(db, 'adm', { podeIniciar: pode(), agora: () => agora });
  assert.equal(r1.tipo, 'andamento');
  assert.equal(r1.lidos, 2000);
  assert.equal(r1.mapa, null, 'nenhum mapa anterior');
  const g = docs.get(M.DOC_GERACAO);
  assert.equal(g.reservaAte, 0, 'reserva solta');
  assert.equal(g.cursor, 'u001999');
  assert.equal(docs.has(M.DOC_MAPA), false, 'parcial não é publicado');

  let pediu = false;
  const r2 = await M.gerarMapa(db, 'adm', { podeIniciar: async () => (pediu = true), agora: () => agora });
  assert.equal(r2.tipo, 'pronto');
  assert.equal(r2.mapa.perfis, 3500);
  assert.equal(r2.mapa.parcial, false);
  assert.equal(estado.lidos, 3500, 'cada perfil lido uma vez só');
  assert.equal(pediu, false);
  assert.equal(docs.has(M.DOC_GERACAO), false);
});

test('MAP-02: falha no meio guarda o que já foi somado (checkpoint)', async () => {
  const { db, docs, estado } = fakeDb(2500, {}, { falharPagina: 2 });
  await assert.rejects(M.gerarMapa(db, 'adm', { podeIniciar: pode(), agora: () => T0 }), /Firestore lento/);
  assert.equal(docs.get(M.DOC_GERACAO).cursor, 'u000999');
  assert.equal(docs.get(M.DOC_GERACAO).reservaAte, 0);
  const r = await M.gerarMapa(db, 'adm', { podeIniciar: pode(), agora: () => T0 + 1000 });
  assert.equal(r.tipo, 'pronto');
  assert.equal(r.mapa.perfis, 2500);
  assert.equal(estado.lidos, 2500);
});

test('MAP-02: progresso velho (mais de 1 h) recomeça; limite negado devolve a reserva', async () => {
  const velho = { id: 'v', reservaAte: 0, iniciadoEm: T0 - 2 * 60 * 60_000, cursor: 'u000999', paginas: 1, acumulado: JSON.stringify({ perfis: 999, semLocalizacao: 0, ignorados: 0, porEstado: { SP: 999 }, cidades: {}, outras: 0 }) };
  const a = fakeDb(1200, { [M.DOC_GERACAO]: velho });
  await assert.rejects(M.gerarMapa(a.db, 'adm', { podeIniciar: async () => false, agora: () => T0 }), (e) => e.status === 429);
  assert.equal(a.docs.has(M.DOC_GERACAO), false);
  assert.equal(a.estado.lidos, 0);
  const b = fakeDb(1200, { [M.DOC_GERACAO]: velho });
  const r = await M.gerarMapa(b.db, 'adm', { podeIniciar: pode(), agora: () => T0 });
  assert.equal(r.mapa.perfis, 1200);
  assert.equal(r.mapa.porEstado.SP, undefined);
  assert.equal(M.lerAcumulado('{x'), null);
});
