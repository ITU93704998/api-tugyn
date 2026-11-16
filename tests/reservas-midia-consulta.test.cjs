// Reserva de troca de imagem: registros antigos não escondem a reserva ativa; a mesma imagem repetida reaproveita o envio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const antes = require.extensions['.ts'];
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f);
const J = require('../api/_lib/midiaReservasJob.ts');
if (antes) require.extensions['.ts'] = antes; else delete require.extensions['.ts'];
const { Timestamp } = require('firebase-admin/firestore');

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);
/** Firestore falso: consulta com ==, in e > aplicados ANTES do limite (como o Firestore), e transação simples. */
function banco(docs) {
  const mapa = new Map(Object.entries(docs));
  const snap = (p) => ({ exists: mapa.has(p), id: p.split('/').pop(), data: () => mapa.get(p), get: (k) => mapa.get(p)?.[k] });
  const consulta = (pasta, filtros = [], max = Infinity) => ({
    where: (c, op, v) => consulta(pasta, [...filtros, (d) => (op === '==' ? d[c] === v : op === 'in' ? v.includes(d[c]) : ms(d[c]) > ms(v))], max),
    limit: (n) => consulta(pasta, filtros, n),
    doc: () => ({ path: `${pasta}/nova${mapa.size}`, id: `nova${mapa.size}` }),
    _ler: () => { const ds = [...mapa].filter(([p, d]) => p.startsWith(pasta + '/') && filtros.every((f) => f(d))).slice(0, max).map(([p]) => snap(p)); return { docs: ds, size: ds.length }; },
  });
  return {
    mapa,
    doc: (p) => ({ path: p }),
    collection: (n) => consulta(n),
    async runTransaction(fn) {
      const escritas = [];
      const r = await fn({ get: async (a) => (a._ler ? a._ler() : snap(a.path)), create: (a, v) => escritas.push([a.path, v]) });
      escritas.forEach(([p, v]) => mapa.set(p, v));
      return r;
    },
  };
}

const AGORA = Date.now();
const vencidas = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`midiaReservas/v${String(i).padStart(2, '0')}`,
  { chave: 'escudo_u1_1', estado: 'reservada', expiraEm: Timestamp.fromMillis(AGORA - 3600_000) }]));
const pedido = (extra = {}) => ({ uid: 'u1', tipo: 'escudoTime', timeId: 'u1_1', bucket: 'turmas', pasta: 'turmas/u1/escudo', ...extra });

test('60 reservas vencidas ainda "reservada" não escondem a reserva ativa', async () => {
  const chave = vencidas['midiaReservas/v00'].chave;
  const db = banco({ 'times/u1_1': { donoId: 'u1' }, ...vencidas, 'midiaReservas/zz_ativa': { chave, estado: 'reservada', expiraEm: Timestamp.fromMillis(AGORA + 300_000) } });
  const r = await J.reservarTrocaDeImagem(db, pedido());
  assert.equal(r.ok, false, 'a reserva ativa deveria impedir');
  assert.equal(r.status, 409);
});

test('mesma imagem já enviada (o app desistiu de esperar): reaproveita o envio, sem novo upload', async () => {
  const db0 = banco({ 'times/u1_1': { donoId: 'u1' } });
  const primeira = await J.reservarTrocaDeImagem(db0, pedido({ assinatura: 'abc' }));
  assert.equal(primeira.ok, true);
  const [id, reserva] = [...db0.mapa].find(([p]) => p.startsWith('midiaReservas/'));
  db0.mapa.set(id, { ...reserva, estado: 'enviada', url: 'https://res.cloudinary.com/x/image/upload/v1/turmas/u1/escudo/esc_1.png' });
  const igual = await J.reservarTrocaDeImagem(db0, pedido({ assinatura: 'abc' }));
  assert.deepEqual(igual.reaproveitada, { url: 'https://res.cloudinary.com/x/image/upload/v1/turmas/u1/escudo/esc_1.png', publicId: reserva.publicId });
  // Outra imagem: segue para um envio novo (escudo já enviado não bloqueia).
  const outra = await J.reservarTrocaDeImagem(db0, pedido({ assinatura: 'def' }));
  assert.equal(outra.ok, true);
  assert.equal(outra.reaproveitada, undefined);
});
