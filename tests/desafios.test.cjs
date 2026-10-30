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
  assert.deepEqual(d.parseDesafioBody({ action: 'criar', desafiadoId: 'u2', turmaId: 't1', temporada: 'proxima' }).value, { action: 'criar', tipo: 'temporada', desafiadoId: 'u2', turmaId: 't1', temporada: 'proxima' });
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

// AGORA = terça 10/11/2026, 12:00 em Brasília.
const turmaHoje = { horario: '21:00', diasSemana: ['tuesday', 'thursday'] };
const PARTIDA = Date.parse('2026-11-11T00:00:00Z'); // 21:00 de Brasília

test('desafio do dia: corpo, partida de hoje e prazo de 30 minutos', () => {
  assert.deepEqual(d.parseDesafioBody({ action: 'criar', tipo: 'dia', desafiadoId: 'u2', turmaId: 't1' }).value, { action: 'criar', tipo: 'dia', desafiadoId: 'u2', turmaId: 't1' });
  assert.equal(d.parseDesafioBody({ action: 'criar', tipo: 'mes', desafiadoId: 'u2', turmaId: 't1', temporada: 'atual' }).ok, false);
  assert.equal(d.isDesafioId('d20261110__a__b'), true);

  const hoje = d.partidaDeHoje(turmaHoje, AGORA);
  assert.equal(hoje.chave, 'd20261110');
  assert.equal(hoje.dia, '2026-11-10');
  assert.equal(hoje.partidaMs, PARTIDA);
  assert.equal(hoje.fimMs, Date.parse('2026-11-11T03:00:00Z'));
  assert.equal(d.partidaDeHoje({ ...turmaHoje, diasSemana: ['segunda'] }, AGORA), null);
  assert.equal(d.partidaDeHoje({ ...turmaHoje, horario: '' }, AGORA), null);
  assert.equal(d.partidaDeHoje({ horario: '21:00', diasSemana: ['Terça-feira'] }, AGORA).dia, '2026-11-10');

  const dia = { ...base, tipo: 'dia', temporada: undefined, turmaDados: turmaHoje };
  const ok = d.autorizarCriacao(dia);
  assert.equal(ok.ok, true);
  assert.equal(ok.id, 'd20261110__a__b');
  assert.equal(ok.dados.tipo, 'dia');
  assert.equal(ok.dados.dia, '2026-11-10');
  assert.equal(ok.dados.inicioEm.getTime(), PARTIDA);
  assert.match(ok.draft.body, /partida de hoje \(21:00\)/);
  assert.equal(d.autorizarCriacao({ ...dia, agoraMs: PARTIDA - 30 * 60_000 }).ok, true);
  assert.equal(d.autorizarCriacao({ ...dia, agoraMs: PARTIDA - 29 * 60_000 }).code, 'partida_muito_proxima');
  assert.equal(d.autorizarCriacao({ ...dia, turmaDados: { ...turmaHoje, diasSemana: ['monday'] } }).code, 'sem_partida_hoje');
  assert.equal(d.autorizarCriacao({ ...dia, existente: { status: 'aceito' } }).error, 'Vocês já têm um desafio hoje.');
});

test('desafio do dia: aceitar até a partida e resultado 12 h depois do fim do dia', () => {
  const doDia = desafio({ tipo: 'dia', dia: '2026-11-10', inicioEm: ts_(PARTIDA), fimEm: ts_(Date.parse('2026-11-11T03:00:00Z')) });
  assert.match(d.autorizarResposta('b', doDia, true, AGORA).draft.body, /partida de 10\/11/);
  assert.equal(d.autorizarResposta('b', doDia, true, PARTIDA).code, 'partida_comecou');
  assert.equal(d.decidirApuracao('a', doDia, PARTIDA).acao, 'expirar');
  const aceito = { ...doDia, status: 'aceito' };
  const liberado = Date.parse('2026-11-11T15:00:00Z');
  assert.equal(d.decidirApuracao('a', aceito, liberado - 1).acao, 'nada');
  assert.equal(d.decidirApuracao('a', aceito, liberado).acao, 'finalizar');
  assert.match(d.avisoDeResultado(null, aceito).body, /partida de 10\/11 terminou empatado/);
});

test('desafio do dia: soma só as partidas daquele dia', () => {
  const partidas = [
    { data: '2026-11-11T00:30:00.000Z', salvadoEmMs: 0, jogadores: [{ participanteId: 'a', gols_partida: 2, assistencias: 1 }, { participanteId: 'b', gols_partida: 1 }] },
    // criada às 23:30 de Brasília do mesmo dia (02:30Z do dia 11): ainda conta
    { data: '2026-11-11T02:30:00.000Z', salvadoEmMs: 0, jogadores: [{ participanteId: 'a', gols_partida: 1 }] },
    // outra partida, do dia seguinte: não conta
    { data: '2026-11-11T22:00:00.000Z', salvadoEmMs: 0, jogadores: [{ participanteId: 'a', gols_partida: 9 }] },
    // sem data: vale o dia do primeiro envio
    { salvadoEmMs: Date.parse('2026-11-11T01:00:00Z'), jogadores: [{ participanteId: 'b', gols_partida: 1, assistencias: 2 }] },
  ];
  assert.deepEqual(d.somarDoDia(partidas, '2026-11-10', 'a'), { gols: 3, assistencias: 1, jogos: 2, pontos: 10 });
  assert.deepEqual(d.somarDoDia(partidas, '2026-11-10', 'b'), { gols: 2, assistencias: 2, jogos: 2, pontos: 8 });
  assert.deepEqual(d.somarDoDia(partidas, '2026-11-10', 'c'), { gols: 0, assistencias: 0, jogos: 0, pontos: 0 });
});

test('criação: conta suspensa, perfil privado e uid com "__"', () => {
  assert.equal(d.autorizarCriacao({ ...base, perfilDesafiante: { status: 'suspended' } }).code, 'conta_suspensa');
  assert.equal(d.autorizarCriacao({ ...base, perfilDesafiado: { name: 'Beto', isPublic: false } }).code, 'perfil_privado');
  assert.equal(d.autorizarCriacao({ ...base, perfilDesafiado: { name: 'Beto', isPublic: true } }).ok, true);
  assert.equal(d.autorizarCriacao({ ...base, desafiadoId: 'x__y' }).code, 'atleta_invalido');
  // a rotina diária acha o convite pelo prazo para aceitar
  assert.equal(d.autorizarCriacao(base).dados.apurarEm.getTime(), Date.parse('2027-01-01T03:00:00Z'));
});

test('vagas: só as válidas contam e a validade depende do status', () => {
  const ativos = { 't2026_6__a__b': AGORA + 1, 't2026_6__a__c': AGORA, '../x': AGORA + 9, 't2026_6__a__d': 'x' };
  assert.deepEqual(d.vagasValidas(ativos, AGORA), { 't2026_6__a__b': AGORA + 1 });
  assert.deepEqual(d.vagasValidas(null, AGORA), {});
  // calculada com os dados da criação (Date) e com os lidos do Firestore (Timestamp)
  const criado = d.autorizarCriacao(base).dados;
  const fim = Date.parse('2027-01-01T03:00:00Z');
  assert.equal(d.vagaVenceEm(criado, 'pendente'), fim);
  assert.equal(d.vagaVenceEm(desafio(), 'pendente'), fim);
  assert.equal(d.vagaVenceEm(desafio(), 'aceito'), fim + 3 * DIA + 7 * DIA);
});

test('aceitar: revalida bloqueio, conta de quem desafiou e turma', () => {
  const turma = { status: 'ativa', participantes: ['a', 'b'] };
  const c = { bloqueio: false, turma, perfilDesafiante: { name: 'Ana' }, desafio: desafio() };
  assert.equal(d.motivoParaNaoAceitar(c), null);
  assert.ok(d.motivoParaNaoAceitar({ ...c, bloqueio: true }));
  assert.ok(d.motivoParaNaoAceitar({ ...c, perfilDesafiante: { status: 'suspended' } }));
  assert.ok(d.motivoParaNaoAceitar({ ...c, perfilDesafiante: null }));
  assert.ok(d.motivoParaNaoAceitar({ ...c, turma: { ...turma, status: 'encerrada' } }));
  assert.ok(d.motivoParaNaoAceitar({ ...c, turma: { status: 'ativa', participantes: ['a'] } }));
  assert.ok(d.motivoParaNaoAceitar({ ...c, turma: null }));
});

test('rotina do servidor apura sem ser participante', () => {
  const fim = Date.parse('2027-01-01T03:00:00Z');
  assert.equal(d.decidirApuracao(null, desafio({ status: 'aceito' }), fim + 3 * DIA).acao, 'finalizar');
  assert.equal(d.decidirApuracao(null, desafio(), fim).acao, 'expirar');
});

test('desafio do dia: partidas enviadas depois do corte não entram', () => {
  const corte = Date.parse('2026-11-11T15:00:00Z');
  const partidas = [
    { data: '2026-11-11T00:30:00.000Z', salvadoEmMs: corte - 1, jogadores: [{ participanteId: 'a', gols_partida: 1 }] },
    { data: '2026-11-11T01:30:00.000Z', salvadoEmMs: corte, jogadores: [{ participanteId: 'a', gols_partida: 5 }] },
  ];
  assert.equal(d.somarDoDia(partidas, '2026-11-10', 'a', corte).gols, 1);
  assert.equal(d.somarDoDia(partidas, '2026-11-10', 'a').gols, 6);
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
