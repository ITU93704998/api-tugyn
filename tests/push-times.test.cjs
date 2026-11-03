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
const { parsePushBody, authorizeTimeConvocacao, authorizeTimePedido, authorizeTimeAprovado } = require(path.join(root, 'api/_lib/push.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const time = () => ({
  nome: 'Os Brabos',
  donoId: 'dono',
  membros: ['dono', 'ana'],
  convidados: ['bruno'],
  solicitantes: ['carla'],
  jogadores: { dono: { nome: 'Zeca' }, ana: { nome: 'Ana', entrouEm: { toMillis: () => 3000 } } },
  pedidos: { carla: { nome: 'Carla', em: { toMillis: () => 2000 } } },
  convites: { bruno: { nome: 'Bruno', em: { toMillis: () => 1000 } } },
  ultimoAprovado: 'ana',
});

test('eventos de time: valida o id do time e ignora destinatário/nome inventados', () => {
  assert.deepEqual(parsePushBody({ action: 'notificar', evento: 'time_pedido', timeId: 'dono_1', userId: 'vitima', nome: 'x' }), {
    ok: true,
    value: { action: 'notificar', evento: 'time_pedido', timeId: 'dono_1' },
  });
  assert.deepEqual(parsePushBody({ action: 'notificar', evento: 'time_convocacao', timeId: 'dono_2', userId: 'bruno' }).value, {
    action: 'notificar', evento: 'time_convocacao', timeId: 'dono_2', userId: 'bruno',
  });
  for (const timeId of ['dono_3', '../x_1', 'dono', '', null]) assert.equal(parsePushBody({ action: 'notificar', evento: 'time_pedido', timeId }).ok, false, String(timeId));
  assert.equal(parsePushBody({ action: 'notificar', evento: 'time_aprovado', timeId: 'dono_1' }).ok, false);
  assert.equal(parsePushBody({ action: 'notificar', evento: 'time_outro', timeId: 'dono_1' }).ok, false);
});

test('convocação: só o dono, só para quem está convocado; o toque abre o time', () => {
  const ok = authorizeTimeConvocacao('dono', 'dono_1', 'bruno', time());
  assert.equal(ok.ok, true);
  assert.equal(ok.recipientUid, 'bruno');
  assert.equal(ok.draft.body, 'Você foi convocado para jogar no Os Brabos (Society). Toque para responder.');
  const comCidade = authorizeTimeConvocacao('dono', 'dono_1', 'bruno', { ...time(), modalidade: 'futsal', cidade: { city: 'Palmas', state: 'TO', lat: 1 } });
  assert.equal(comCidade.draft.body, 'Você foi convocado para jogar no Os Brabos (Futsal · Palmas, TO). Toque para responder.');
  assert.deepEqual(ok.draft.data, { tipo: 'time_convocacao', turmaId: '', timeId: 'dono_1' });
  assert.equal(authorizeTimeConvocacao('ana', 'dono_1', 'bruno', time()).status, 403);
  assert.equal(authorizeTimeConvocacao('dono', 'dono_1', 'estranho', time()).status, 409);
  assert.equal(authorizeTimeConvocacao('dono', 'dono_1', 'bruno', null).status, 404);
  assert.equal(ok.dedupeKey, 'time_convocacao_dono_1_bruno_1000');
});

test('pedido pelo link: quem pediu avisa o dono (nome vem do pedido gravado)', () => {
  const ok = authorizeTimePedido('carla', 'dono_1', time());
  assert.equal(ok.recipientUid, 'dono');
  assert.match(ok.draft.body, /Carla quer entrar no Os Brabos/);
  assert.equal(ok.dedupeKey, 'time_pedido_dono_1_carla_2000');
  assert.equal(authorizeTimePedido('estranho', 'dono_1', time()).status, 409);
  assert.equal(authorizeTimePedido('dono', 'dono_1', time()).status, 400);
});

test('aprovado: só o dono, só para quem já está no elenco', () => {
  const ok = authorizeTimeAprovado('dono', 'dono_1', 'ana', time());
  assert.equal(ok.recipientUid, 'ana');
  assert.match(ok.draft.title, /Você entrou no Os Brabos/);
  assert.equal(authorizeTimeAprovado('dono', 'dono_1', 'carla', time()).status, 409);
  assert.equal(authorizeTimeAprovado('ana', 'dono_1', 'ana', time()).status, 403);
  assert.equal(ok.dedupeKey, 'time_aprovado_dono_1_ana_3000');
});

test('aprovado: membro antigo (não é o último aprovado pelo link) não recebe "você entrou" de novo', () => {
  const t = { ...time(), membros: ['dono', 'ana', 'davi'], jogadores: { ...time().jogadores, davi: { nome: 'Davi' } } };
  assert.equal(authorizeTimeAprovado('dono', 'dono_1', 'davi', t).status, 409);
  assert.equal(authorizeTimeAprovado('dono', 'dono_1', 'ana', { ...t, ultimoAprovado: undefined }).status, 409);
});
