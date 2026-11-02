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
const { isValidLinkId, timeDoDocumento, renderizarPaginaTime, fotoPequena, conviteDoDocumento, renderizarPaginaConvite } = require(path.join(root, 'api/_lib/timeLink.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const documento = () => ({
  nome: 'Os Brabos',
  cor: '#17212F',
  donoId: 'uid-dono',
  linkId: 'AbCdEfGh12345678',
  membros: ['uid-dono', 'uid-ana'],
  jogadores: {
    'uid-ana': { nome: 'Ana Souza', foto: 'https://res.cloudinary.com/demo/image/upload/v1/ana.jpg', userName: 'ana.souza' },
    'uid-dono': { nome: 'Zeca', foto: 'https://outro.site/foto.jpg', userName: 'zeca' },
  },
  convidados: ['uid-bruno'],
  convites: { 'uid-bruno': { nome: 'Bruno Convidado', userName: 'bruno' } },
  recusados: ['uid-carla'],
});

test('aceita só linkId de 16 letras e números', () => {
  assert.equal(isValidLinkId('AbCdEfGh12345678'), true);
  for (const v of ['curto', 'AbCdEfGh1234567_', '../AbCdEfGh12345', 'AbCdEfGh123456789', null, 123]) assert.equal(isValidLinkId(v), false);
});

test('mostra só elenco aceito, dono primeiro, sem @, uid nem convocados', () => {
  const time = timeDoDocumento(documento());
  assert.deepEqual(time.jogadores.map((j) => [j.nome, j.dono]), [['Zeca', true], ['Ana Souza', false]]);
  const html = renderizarPaginaTime({ time, lojaIos: null, lojaAndroid: null, plataforma: 'outra' });
  assert.match(html, /Os Brabos/);
  assert.match(html, /2 jogadores/);
  for (const segredo of ['uid-', 'ana.souza', 'Bruno', 'carla', 'AbCdEfGh12345678']) assert.equal(html.includes(segredo), false, segredo);
});

test('foto só do Cloudinary (recortada); cor inválida usa a do app', () => {
  assert.match(fotoPequena('https://res.cloudinary.com/demo/image/upload/v1/ana.jpg'), /upload\/c_fill,g_face,w_96,h_96,q_auto,f_jpg\/v1\/ana\.jpg$/);
  assert.equal(fotoPequena('https://outro.site/foto.jpg'), '');
  assert.equal(fotoPequena('javascript:alert(1)'), '');
  const time = timeDoDocumento({ ...documento(), cor: 'red;background:url(x)' });
  assert.equal(time.cor, '#FE7552');
});

test('escapa HTML vindo do usuário', () => {
  const time = timeDoDocumento({ ...documento(), nome: '<script>alert(1)</script>' });
  const html = renderizarPaginaTime({ time, lojaIos: null, lojaAndroid: null, plataforma: 'outra' });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('documento inválido ou time inexistente não quebra a página', () => {
  assert.equal(timeDoDocumento(null), null);
  assert.equal(timeDoDocumento({ nome: '' }), null);
  assert.deepEqual(timeDoDocumento({ nome: 'X', jogadores: { a: null, b: { nome: 5 } } }).jogadores, []);
  assert.match(renderizarPaginaTime({ time: null, lojaIos: null, lojaAndroid: null, plataforma: 'outra' }), /Time não encontrado/);
});

test('mostra escudo, sigla, modalidade, categoria, cidade, número e posição', () => {
  const time = timeDoDocumento({
    ...documento(),
    sigla: 'BRA', modalidade: 'futsal', genero: 'misto', faixaEtaria: 'veterano', cidade: { city: 'Recife', state: 'PE', cityId: '1' },
    escudoUrl: 'https://res.cloudinary.com/demo/image/upload/v9/turmas/uid-dono/escudo/esc_1.png',
    camisas: { 'uid-ana': { numero: 10, posicao: 'pivo' }, 'uid-dono': { numero: 'x', posicao: '<b>' } },
  });
  assert.equal(time.detalhes, 'Futsal · Misto Veterano · Recife, PE');
  assert.match(time.escudo, /upload\/c_pad,w_256,h_256,q_auto,f_png\/v9\//);
  const ana = time.jogadores.find((j) => j.nome === 'Ana Souza');
  assert.deepEqual([ana.numero, ana.posicao], [10, 'Pivô']);
  const dono = time.jogadores.find((j) => j.dono);
  assert.deepEqual([dono.numero, dono.posicao], [null, '']);
  const html = renderizarPaginaTime({ time, lojaIos: null, lojaAndroid: null, plataforma: 'outra' });
  assert.match(html, /\(BRA\)/);
  assert.equal(html.includes('cityId'), false);
  assert.equal(timeDoDocumento({ ...documento(), sigla: 'x<y' }).sigla, '');
});

test("prévia do WhatsApp usa o escudo (JPG 600x600 com fundo branco); sem escudo, o ícone", () => {
  const comEscudo = timeDoDocumento({ ...documento(), escudoUrl: "https://res.cloudinary.com/demo/image/upload/v9/turmas/uid-dono/escudo/esc_1.png" });
  const html = renderizarPaginaTime({ time: comEscudo, lojaIos: null, lojaAndroid: null, plataforma: "outra", iconUrl: "https://api/x.png" });
  assert.ok(html.includes('og:image" content="https://res.cloudinary.com/demo/image/upload/c_pad,b_white,w_600,h_600,q_auto,f_jpg/v9/'));
  assert.match(html, /og:image:width" content="600"/);
  const semEscudo = renderizarPaginaTime({ time: timeDoDocumento(documento()), lojaIos: null, lojaAndroid: null, plataforma: "outra", iconUrl: "https://api/x.png" });
  assert.ok(semEscudo.includes('og:image" content="https://api/x.png"'));
});

test("link de convocação: vale 1 hora, abre o app com o código e mostra o escudo", () => {
  const criadoEm = { toMillis: () => 1_000_000 };
  const convite = conviteDoDocumento({ nome: "Os Brabos", cor: "#17212F", sigla: "BRA", detalhes: "Futsal · Misto", criadoEm, timeId: "uid-dono_1", donoId: "uid-dono",
    escudoUrl: "https://res.cloudinary.com/demo/image/upload/v9/turmas/uid-dono/escudo/esc_1.png" });
  assert.equal(convite.expiraEmMs, 1_000_000 + 3_600_000);
  const base = { convite, codigo: "Cod1234567890abc", lojaIos: null, lojaAndroid: null, plataforma: "outra" };
  const valido = renderizarPaginaConvite({ ...base, agoraMs: 1_000_000 + 60_000 });
  assert.ok(valido.includes("tugyn://time-convite/Cod1234567890abc"));
  assert.match(valido, /og:image" content="[^"]*f_jpg/);
  assert.ok(valido.includes("Convocação: Os Brabos (BRA)"));
  for (const segredo of ["uid-dono_1", "timeId", "donoId"])assert.equal(valido.includes(segredo), false, segredo);
  const vencido = renderizarPaginaConvite({ ...base, agoraMs: 1_000_000 + 3_600_001 });
  assert.equal(vencido.includes("time-convite"), false);
  assert.match(vencido, /expirou/);
  assert.match(renderizarPaginaConvite({ ...base, convite: null, agoraMs: 0 }), /Link não encontrado/);
  assert.equal(conviteDoDocumento({ nome: "<b>x</b>", criadoEm }).nome, "<b>x</b>");
  assert.equal(renderizarPaginaConvite({ ...base, convite: conviteDoDocumento({ nome: "<b>x</b>", criadoEm }), agoraMs: 0 }).includes("<b>x"), false);
});
