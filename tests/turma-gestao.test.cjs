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
const { parseGestaoBody, autorizarTransferencia, autorizarExclusao, autorizarTemporario, bannerParaApagar } = require(path.join(root, 'api/_lib/turmaGestao.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const turma = { creatorId: 'dono', nome: 'Futebol', participantes: ['dono', 'ana'], codigoConvite: 'ABC234', bannerUrl: '' };
const ana = { status: 'aprovado', nome: 'Ana', urlPhoto: 'https://x/ana.jpg' };

test('valida o corpo e ignora campos extras', () => {
  assert.deepEqual(parseGestaoBody({ action: 'excluir', turmaId: 't1', creatorId: 'falso' }), { ok: true, value: { action: 'excluir', turmaId: 't1' } });
  assert.deepEqual(parseGestaoBody({ action: 'transferir', turmaId: 't1', novoOrganizadorId: 'ana' }).value.novoOrganizadorId, 'ana');
  for (const body of [null, {}, { action: 'excluir', turmaId: '../t' }, { action: 'transferir', turmaId: 't1' }, { action: 'outra', turmaId: 't1' }]) {
    assert.equal(parseGestaoBody(body).ok, false);
  }
});

test('transferir: só o organizador, para um membro aprovado', () => {
  const ok = autorizarTransferencia('dono', 't1', 'ana', turma, ana);
  assert.equal(ok.ok, true);
  assert.equal(ok.creatorName, 'Ana');
  assert.deepEqual(ok.draft.data, { tipo: 'organizacao_transferida', turmaId: 't1' });

  assert.equal(autorizarTransferencia('ana', 't1', 'ana', turma, ana).code, 'nao_organizador');
  assert.equal(autorizarTransferencia('dono', 't1', 'dono', turma, ana).code, 'mesmo_organizador');
  assert.equal(autorizarTransferencia('dono', 't1', 'ana', turma, { ...ana, status: 'pendente' }).code, 'nao_membro');
  assert.equal(autorizarTransferencia('dono', 't1', 'beto', turma, { ...ana }).code, 'nao_membro');
  assert.equal(autorizarTransferencia('dono', 't1', 'ana', null, ana).status, 404);
});

test('excluir: só o organizador e só sem outros membros', () => {
  assert.equal(autorizarExclusao('dono', turma).code, 'turma_com_membros');
  assert.equal(autorizarExclusao('ana', turma).code, 'nao_organizador');
  const sozinho = autorizarExclusao('dono', { ...turma, participantes: ['dono'] });
  assert.equal(sozinho.ok, true);
  assert.equal(sozinho.codigoConvite, 'ABC234');
  assert.equal(autorizarExclusao('dono', { ...turma, participantes: ['dono'], codigoConvite: '../x' }).codigoConvite, null);
});

test('banner: apaga só uploads de banner, nunca o id fixo antigo nem outras URLs', () => {
  assert.deepEqual(bannerParaApagar('https://res.cloudinary.com/c/image/upload/v123/turmas/dono/banner/abc.jpg'), { bucket: 'turmas', publicId: 'turmas/dono/banner/abc' });
  assert.deepEqual(bannerParaApagar('https://res.cloudinary.com/c/image/upload/v1/times/dono/banner/x.png').bucket, 'times');
  assert.equal(bannerParaApagar('https://res.cloudinary.com/c/image/upload/v1/times/dono/profile/profile.jpg'), null);
  assert.equal(bannerParaApagar('https://res.cloudinary.com/c/image/upload/v1/usuarios/dono/profile/profile.jpg'), null);
  assert.equal(bannerParaApagar('https://exemplo.com/turmas/dono/banner/abc.jpg'), null);
  assert.equal(bannerParaApagar('https://res.cloudinary.com/c/image/upload/v1/turmas/dono/banner/../../x.jpg'), null);
});

test('organizador temporário: só o organizador escolhe um membro aprovado; null encerra', () => {
  assert.deepEqual(parseGestaoBody({ action: 'temporario', turmaId: 't1', membroId: 'ana' }).value, { action: 'temporario', turmaId: 't1', membroId: 'ana' });
  assert.deepEqual(parseGestaoBody({ action: 'temporario', turmaId: 't1', membroId: null }).value.membroId, null);
  for (const membroId of [undefined, '', '../x', 5]) assert.equal(parseGestaoBody({ action: 'temporario', turmaId: 't1', membroId }).ok, false);

  const ok = autorizarTemporario('dono', 't1', 'ana', turma, ana);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.membro, { uid: 'ana', nome: 'Ana' }, 'o nome vem do participante salvo, não do app');
  assert.deepEqual(ok.draft.data, { tipo: 'organizador_temporario', turmaId: 't1' });
  assert.match(ok.draft.title, /Futebol/);

  assert.deepEqual(autorizarTemporario('dono', 't1', null, turma, null), { ok: true, membro: null });
  assert.equal(autorizarTemporario('ana', 't1', 'ana', turma, ana).code, 'nao_organizador');
  assert.equal(autorizarTemporario('ana', 't1', null, turma, null).code, 'nao_organizador', 'membro não encerra o temporário');
  assert.equal(autorizarTemporario('dono', 't1', 'dono', turma, ana).code, 'mesmo_organizador');
  assert.equal(autorizarTemporario('dono', 't1', 'ana', turma, { ...ana, status: 'saiu' }).code, 'nao_membro');
  assert.equal(autorizarTemporario('dono', 't1', 'zeca', turma, ana).code, 'nao_membro');
  assert.equal(autorizarTemporario('dono', 't1', 'ana', { ...turma, encerradaPor: 'moderacao' }, ana).code, 'turma_moderada');
  assert.equal(autorizarTemporario('dono', 't1', 'ana', null, ana).status, 404);
});
