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
const L = require(path.join(root, 'api/_lib/campeonatoLink.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const NOW = Date.UTC(2026, 10, 15, 15);
const ID = 'ct_' + 'a'.repeat(24);
const doc = (extra = {}) => ({ nome: 'Copa Palmas', status: 'inscricoes', formato: 'mata', modalidade: 'society', cidade: 'Palmas', estado: 'TO', inscricoesAte: NOW + 3 * 86400000, dataInicio: NOW + 5 * 86400000, inscricaoCentavos: 15000, maxTimes: 8, aprovados: 3, organizadorId: 'uid-secreto', organizadorNome: 'Fulano', bannerUrl: 'https://res.cloudinary.com/demo/image/upload/v1/banner.jpg', ...extra });
const pagina = (c, id = ID) => L.renderizarPaginaCampeonato({ campeonato: c, id, agoraMs: NOW, lojaIos: 'https://apps.apple.com/app/x', lojaAndroid: null, plataforma: 'ios', iconUrl: null, paginaUrl: null });

test('campeonato-link: id só no formato do servidor', () => {
  assert.equal(L.isValidCampeonatoId(ID), true);
  for (const v of ['ct_abc', 'CT_' + 'a'.repeat(24), 'ct_' + 'g'.repeat(24), '../x', 1]) assert.equal(L.isValidCampeonatoId(v), false);
});
test('campeonato-link: mostra só dados públicos (sem organizador nem ids) e abre o app no campeonato', () => {
  const html = pagina(L.campeonatoDoDocumento(doc()));
  assert.match(html, /Copa Palmas/); assert.match(html, /Mata-mata/); assert.match(html, /Palmas, TO/);
  assert.match(html, /5 vagas de 8/); assert.match(html, /R\$\s?150,00/);
  assert.match(html, new RegExp(`href="tugyn://campeonato/${ID}"`));
  assert.match(html, /og:image" content="https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/c_fill,g_auto,w_1200,h_630,q_auto,f_jpg\/v1\/banner\.jpg"/);
  assert.doesNotMatch(html, /uid-secreto|Fulano/);
});
test('campeonato-link: teste, exclusão e documento inválido viram "não encontrado"; banner de fora é ignorado', () => {
  assert.equal(L.campeonatoDoDocumento(doc({ testeTugyn: true })), null);
  assert.equal(L.campeonatoDoDocumento(doc({ excluindo: true })), null);
  assert.equal(L.campeonatoDoDocumento(doc({ status: 'hackeado' })), null);
  assert.equal(L.campeonatoDoDocumento(doc({ bannerUrl: 'https://evil.example/x.jpg' })).banner, '');
  assert.match(pagina(null), /Campeonato não encontrado/);
});
test('campeonato-link: situação de cada fase e nome escapado', () => {
  const sit = (extra) => L.situacaoDoCampeonato(L.campeonatoDoDocumento(doc(extra)), NOW).texto;
  assert.match(sit({ inscricoesAte: NOW - 1 }), /Inscrições encerradas/);
  assert.match(sit({ status: 'em_andamento' }), /em andamento/);
  assert.match(sit({ status: 'cancelado' }), /cancelado/);
  assert.doesNotMatch(pagina(L.campeonatoDoDocumento(doc({ nome: '<script>x</script>' }))), /<script>x/);
});

test('campeonato-link: taça escolhida no lugar do escudo, sem o rótulo "Campeonato entre times"', () => {
  const comTaca = pagina(L.campeonatoDoDocumento(doc({ trofeuDesenho: 'calice|asas|coroa|pedestal|pedra|prata||escudo||17212F' })));
  assert.doesNotMatch(comTaca, /Campeonato entre times/);
  assert.match(comTaca, /aria-label="Troféu do campeonato"><svg[^>]*viewBox="0 -12 240 300" width="70" height="88"/);
  assert.match(comTaca, /#F4F7FA/, 'prata');
  // Desenho inválido ou ausente: taça clássica dourada; nada do texto enviado entra na página.
  const classica = pagina(L.campeonatoDoDocumento(doc({ trofeuDesenho: '<script>|x' })));
  assert.match(classica, /#FBE08A/);
  assert.doesNotMatch(classica, /<script>\|x/);
  assert.equal(L.cartaoDoCampeonato(L.campeonatoDoDocumento(doc()), NOW).rotulo, '');
});
