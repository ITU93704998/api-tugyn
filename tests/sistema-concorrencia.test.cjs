// Painel: salvar a configuração remota com base antiga (outro administrador salvou antes) é recusado, sem religar nada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p);
const sistema = require('../api/_lib/sistema.ts');
const admin = require('../api/_lib/adminSistema.ts');

const fake = (inicial) => {
  const docs = new Map(Object.entries(inicial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  let n = 0;
  const ref = (k) => ({ path: k, collection: (c) => ({ doc: () => ref(`${k}/${c}/h${++n}`) }) });
  const db = {
    doc: ref,
    runTransaction: async (f) => {
      const writes = [];
      const r = await f({
        get: async (x) => ({ exists: docs.has(x.path), data: () => JSON.parse(JSON.stringify(docs.get(x.path))) }),
        set: (x, v) => writes.push(() => docs.set(x.path, v)),
        create: (x, v) => writes.push(() => docs.set(x.path, v)),
      });
      writes.forEach((w) => w());
      return r;
    },
  };
  return { db, docs };
};
const cfg = (acompanhar, aviso = null) => sistema.normalizarConfig({ aviso, funcoes: { acompanharConfirmacoes: acompanhar } });

test('PN-01: base igual à gravada salva; base antiga recebe conflito e não religa a função desligada por outro', async () => {
  const { db, docs } = fake({ 'sistema/config': cfg(true) });
  // A desliga (base = ligado, que é o gravado).
  await admin.salvarConfig(db, 'adminA', cfg(false), cfg(true));
  assert.equal(docs.get('sistema/config').funcoes.acompanharConfirmacoes, false);
  // B abriu o painel antes (base = ligado) e só mudou o aviso: recusado.
  await assert.rejects(() => admin.salvarConfig(db, 'adminB', cfg(true, 'Manutenção'), cfg(true)), (e) => e instanceof admin.ConfigMudou);
  assert.equal(docs.get('sistema/config').funcoes.acompanharConfirmacoes, false, 'continua desligada');
  // B recarrega (base = desligado) e salva o aviso.
  await admin.salvarConfig(db, 'adminB', cfg(false, 'Manutenção'), cfg(false));
  assert.equal(docs.get('sistema/config').aviso, 'Manutenção');
  assert.equal(docs.get('sistema/config').funcoes.acompanharConfirmacoes, false);
});
