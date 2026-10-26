const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PUSH_API_ROOT || path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const sourcePath = path.join(root, 'api/_lib/push.ts');
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const input = filename === sourcePath && process.env.PUSH_SOURCE_FILE ? process.env.PUSH_SOURCE_FILE : filename;
  const source = fs.readFileSync(input, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const { authorizeAttendanceConfirmed, authorizeGameOpened, parsePushBody, buildMessages } = require(sourcePath);
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];
const turma = { creatorId: 'organizador', nome: 'Futebol', participantes: ['jogador', 'outro'], status: 'ativa' };
const jogo = { status: 'aberta', criadoPor: 'organizador', confirmados: { jogador: { nome: 'Ana' } } };
const attendance = (t = turma, j = jogo, uid = 'jogador', dia = '20261026') => authorizeAttendanceConfirmed(uid, 'turma1', dia, t, j);

test('aceita o novo evento sem confiar em destinatario ou nome enviados pelo cliente', () => {
  const parsed = parsePushBody({ action: 'notificar', evento: 'presenca_confirmada', turmaId: 'turma1', userId: 'vitima', nome: 'Falso' });
  assert.deepEqual(parsed, { ok: true, value: { action: 'notificar', evento: 'presenca_confirmada', turmaId: 'turma1' } });
  assert.equal(parsePushBody({ action: 'notificar', evento: 'presenca_confirmada', turmaId: '../turma' }).ok, false);
});
test('avisa o organizador e usa o nome da presenca salva', () => {
  const result = attendance();
  assert.equal(result.ok, true);
  assert.equal(result.recipientUid, 'organizador');
  assert.match(result.draft.body, /Ana/);
  assert.deepEqual(result.draft.data, { tipo: 'presenca_confirmada', turmaId: 'turma1' });
});
test('bloqueia turma ausente, encerrada ou sem organizador valido', () => {
  for (const t of [null, { ...turma, status: 'encerrada' }, { ...turma, ativo: false }, { ...turma, creatorId: '../invalido' }]) assert.equal(attendance(t).ok, false);
});
test('bloqueia quem nao e membro e a propria confirmacao do organizador', () => {
  assert.equal(attendance(turma, jogo, 'intruso').ok, false);
  assert.equal(attendance(turma, jogo, 'organizador').ok, false);
});
test('exige partida aberta e presenca propria salva', () => {
  for (const j of [null, { ...jogo, status: 'encerrada' }, { ...jogo, confirmados: {} }, { ...jogo, confirmados: [] }, { ...jogo, confirmados: { jogador: null } }, { ...jogo, confirmados: { jogador: [] } }]) assert.equal(attendance(turma, j).ok, false);
});
test('repeticoes da mesma pessoa no mesmo dia compartilham a chave; outro dia ou pessoa nao', () => {
  assert.equal(attendance().dedupeKey, attendance().dedupeKey);
  assert.notEqual(attendance().dedupeKey, attendance(turma, jogo, 'jogador', '20261027').dedupeKey);
  const other = attendance(turma, { ...jogo, confirmados: { outro: { nome: 'Bia' } } }, 'outro');
  assert.notEqual(attendance().dedupeKey, other.dedupeKey);
});
test('abertura avisa membros uma unica vez e exclui o organizador', () => {
  const result = authorizeGameOpened('organizador', 'turma1', '20261026', { ...turma, participantes: ['jogador', 'jogador', 'organizador', '../invalido'] }, jogo);
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipientUids, ['jogador']);
  assert.equal(authorizeGameOpened('intruso', 'turma1', '20261026', turma, jogo).ok, false);
});
test('abertura sem outros membros nao tem destinatarios', () => {
  const result = authorizeGameOpened('organizador', 'turma1', '20261026', { ...turma, participantes: [] }, jogo);
  assert.deepEqual(result.recipientUids, []);
});
test('mensagem Expo conserva o novo evento e o canal existente', () => {
  const messages = buildMessages(['ExpoPushToken[teste123456]'], attendance().draft);
  assert.equal(messages[0].data.tipo, 'presenca_confirmada');
  assert.equal(messages[0].channelId, 'avisos-turma');
});
