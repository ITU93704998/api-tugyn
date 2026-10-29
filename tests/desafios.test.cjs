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
const d = require(path.join(root, 'api/_lib/desafios.ts'));
const { campoDaTemporada } = require(path.join(root, 'api/_lib/estatisticas.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const DIA = 24 * 3600_000;
// 10/11/2026 12:00 em Brasília: temporada Nov–Dez 2026 (t2026_6).
const AGORA = Date.parse('2026-11-10T15:00:00Z');
const ts_ = (ms) => ({ toMillis: () => ms });

test('temporada no fuso de Brasília, igual à chave das estatísticas', () => {
  const atual = d.temporadaInfo(AGORA);
  assert.equal(atual.chave, 't2026_6');
  assert.equal(atual.rotulo, 'Nov–Dez 2026');
  assert.equal(atual.inicioMs, Date.parse('2026-11-01T03:00:00Z'));
  assert.equal(atual.fimMs, Date.parse('2027-01-01T03:00:00Z'));
  const proxima = d.temporadaInfo(AGORA, 1);
  assert.equal(proxima.chave, 't2027_1');
  assert.equal(proxima.rotulo, 'Jan–Fev 2027');
  for (const iso of ['2026-01-01T03:00:00Z', '2026-10-31T23:00:00Z', '2026-11-01T02:59:00Z', '2026-12-31T12:00:00Z']) {
    assert.equal(d.temporadaInfo(Date.parse(iso)).chave, campoDaTemporada(new Date(iso)), iso);
  }
});

test('id fixo por dupla e temporada', () => {
  assert.equal(d.idDoDesafio('t2026_6', 'b', 'a'), d.idDoDesafio('t2026_6', 'a', 'b'));
  assert.equal(d.isDesafioId(d.idDoDesafio('t2026_6', 'abc', 'xyz')), true);
  assert.equal(d.isDesafioId('../x'), false);
});

test('valida o corpo', () => {
  assert.deepEqual(d.parseDesafioBody({ action: 'criar', desafiadoId: 'u2', turmaId: 't1', temporada: 'proxima' }).value, { action: 'criar', desafiadoId: 'u2', turmaId: 't1', temporada: 'proxima' });
  assert.equal(d.parseDesafioBody({ action: 'criar', desafiadoId: 'u2', turmaId: 't1', temporada: 'outra' }).ok, false);
  assert.equal(d.parseDesafioBody({ action: 'criar', desafiadoId: 'u2', temporada: 'atual' }).ok, false);
  assert.equal(d.parseDesafioBody({ action: 'criar', desafiadoId: 'u2', turmaId: '../x', temporada: 'atual' }).ok, false);
  assert.equal(d.parseDesafioBody({ action: 'responder', desafioId: 't2026_6__a__b', aceitar: 'sim' }).ok, false);
  assert.equal(d.parseDesafioBody({ action: 'apurar', desafioIds: [] }).ok, false);
  assert.equal(d.parseDesafioBody({ action: 'apurar', desafioIds: Array(11).fill('t2026_6__a__b') }).ok, false);
  assert.deepEqual(d.parseDesafioBody({ action: 'apurar', desafioIds: ['t2026_6__a__b', 't2026_6__a__b'] }).value.desafioIds, ['t2026_6__a__b']);
});

test('turma do desafio: só ativa e com os dois', () => {
  assert.deepEqual(d.turmaDoDesafio({ id: 't1', data: { nome: 'Pelada', participantes: ['a', 'b'], status: 'ativa' } }, 'a', 'b'), { id: 't1', nome: 'Pelada' });
  assert.equal(d.turmaDoDesafio({ id: 't2', data: { nome: 'Velha', participantes: ['a', 'b'], status: 'encerrada' } }, 'a', 'b'), null);
  assert.equal(d.turmaDoDesafio({ id: 't3', data: { nome: 'Outra', participantes: ['a', 'c'] } }, 'a', 'b'), null);
  assert.equal(d.turmaDoDesafio({ id: 't4', data: { nome: 'Deles', participantes: ['b', 'c'] } }, 'a', 'b'), null);
  assert.equal(d.turmaDoDesafio({ id: 't5', data: null }, 'a', 'b'), null);
});

const base = {
  uid: 'a', desafiadoId: 'b', temporada: 'atual', agoraMs: AGORA,
  perfilDesafiante: { name: 'Ana' }, perfilDesafiado: { name: 'Beto' }, bloqueio: false,
  turma: { id: 't1', nome: 'Pelada' }, ativosDesafiante: 0, ativosDesafiado: 0, existente: null,
};

test('criação: casos permitidos e negados', () => {
  const ok = d.autorizarCriacao(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.id, 't2026_6__a__b');
  assert.deepEqual(ok.dados.participantes, ['a', 'b']);
  assert.equal(ok.dados.status, 'pendente');
  assert.deepEqual(ok.dados.turmas, [{ id: 't1', nome: 'Pelada' }]);
  assert.equal(ok.draft.data.tipo, 'desafio');

  assert.equal(d.autorizarCriacao({ ...base, desafiadoId: 'a' }).code, 'mesmo_atleta');
  assert.equal(d.autorizarCriacao({ ...base, perfilDesafiado: null }).code, 'atleta_nao_encontrado');
  assert.equal(d.autorizarCriacao({ ...base, perfilDesafiado: { status: 'suspended' } }).code, 'atleta_nao_encontrado');
  assert.equal(d.autorizarCriacao({ ...base, bloqueio: true }).code, 'bloqueado');
  assert.equal(d.autorizarCriacao({ ...base, turma: null }).code, 'sem_turma_em_comum');
  assert.equal(d.autorizarCriacao({ ...base, agoraMs: Date.parse('2026-12-28T12:00:00Z') }).code, 'temporada_acabando');
  assert.equal(d.autorizarCriacao({ ...base, agoraMs: Date.parse('2026-12-28T12:00:00Z'), temporada: 'proxima' }).ok, true);
  assert.equal(d.autorizarCriacao({ ...base, existente: { status: 'recusado' } }).code, 'ja_recusado');
  assert.equal(d.autorizarCriacao({ ...base, existente: { status: 'aceito' } }).code, 'ja_existe');
  assert.equal(d.autorizarCriacao({ ...base, existente: { status: 'cancelado' } }).ok, true);
  assert.equal(d.autorizarCriacao({ ...base, ativosDesafiante: 10 }).code, 'limite_desafiante');
  assert.equal(d.autorizarCriacao({ ...base, ativosDesafiado: 10 }).code, 'limite_desafiado');
});

const desafio = (extra = {}) => ({
  participantes: ['a', 'b'], desafianteId: 'a', desafiadoId: 'b', status: 'pendente',
  desafiado: { nome: 'Beto' }, temporadaRotulo: 'Nov–Dez 2026', fimEm: ts_(Date.parse('2027-01-01T03:00:00Z')), ...extra,
});

test('resposta e cancelamento', () => {
  assert.equal(d.autorizarResposta('b', desafio(), true, AGORA).draft.title, 'Desafio aceito!');
  assert.equal(d.autorizarResposta('b', desafio(), false, AGORA).draft, null);
  assert.equal(d.autorizarResposta('a', desafio(), true, AGORA).code, 'nao_desafiado');
  assert.equal(d.autorizarResposta('b', desafio({ status: 'aceito' }), true, AGORA).code, 'nao_pendente');
  assert.equal(d.autorizarResposta('b', desafio(), true, Date.parse('2027-01-02T00:00:00Z')).code, 'temporada_encerrada');
  assert.equal(d.autorizarResposta('b', null, true, AGORA).status, 404);

  assert.equal(d.autorizarCancelamento('a', desafio()).ok, true);
  assert.equal(d.autorizarCancelamento('b', desafio()).code, 'nao_desafiante');
  assert.equal(d.autorizarCancelamento('a', desafio({ status: 'aceito' })).code, 'nao_pendente');
});

test('apuração: só depois do prazo e só para quem participa', () => {
  const fim = Date.parse('2027-01-01T03:00:00Z');
  assert.equal(d.decidirApuracao('c', desafio({ status: 'aceito' }), fim + 4 * DIA).code, 'nao_participante');
  assert.equal(d.decidirApuracao('a', desafio({ status: 'aceito' }), fim + 2 * DIA).acao, 'nada');
  assert.equal(d.decidirApuracao('b', desafio({ status: 'aceito' }), fim + 3 * DIA).acao, 'finalizar');
  assert.equal(d.decidirApuracao('a', desafio(), fim).acao, 'expirar');
  assert.equal(d.decidirApuracao('a', desafio(), fim - 1).acao, 'nada');
  assert.equal(d.decidirApuracao('a', desafio({ status: 'finalizado' }), fim + 9 * DIA).acao, 'nada');
});

test('soma só a temporada do desafio e decide o vencedor', () => {
  const docs = [
    { temporadas: { t2026_6: { gols: 2, assistencias: 1, jogos: 3 }, t2026_5: { gols: 9 } } },
    null,
    { temporadas: { t2026_6: { gols: 1, assistencias: -2, jogos: 1 } } },
  ];
  assert.deepEqual(d.somarDoDesafio(docs, 't2026_6'), { gols: 3, assistencias: 1, jogos: 4, pontos: 10 });

  const n = (uid, gols, assistencias) => ({ uid, gols, assistencias, jogos: 1, pontos: gols * 3 + assistencias });
  assert.equal(d.vencedorEntre(n('a', 2, 0), n('b', 1, 2)), 'a'); // 6 x 5
  assert.equal(d.vencedorEntre(n('a', 1, 3), n('b', 2, 0)), 'b'); // 6 x 6 nos pontos: b tem mais gols
  assert.equal(d.vencedorEntre(n('a', 1, 0), n('b', 1, 0)), null); // empate
  assert.equal(d.vencedorEntre(n('a', 0, 0), n('b', 0, 0)), null);
});
