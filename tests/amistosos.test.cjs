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
const A = require(path.join(root, 'api/_lib/amistosos.ts'));
const R = require(path.join(root, 'api/_lib/amistososResultado.ts'));
const { Timestamp } = require('firebase-admin/firestore');
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const AGORA = Date.UTC(2026, 10, 2, 15, 0); // 02/11/2026 12:00 em Brasília
const time = (extra = {}) => ({ nome: 'Os Brabos', donoId: 'dono', modalidade: 'society', membros: ['dono', 'ana'], ...extra });
const cenario = (extra = {}) => ({
  uid: 'dono', agora: AGORA, quando: AGORA + 3 * 24 * 3600_000,
  meuId: 'dono_1', meu: time(), adversarioId: 'rival_1', adversario: time({ nome: 'Rivais', donoId: 'rival' }),
  bloqueio: false, pendentes: [], comEle: [], ...extra,
});

test('só ações de amistoso/chave são desviadas da rota de desafios', () => {
  assert.equal(A.ehAcaoDeAmistoso({ action: 'amistoso_propor' }), true);
  assert.equal(A.ehAcaoDeAmistoso({ action: 'time_buscar' }), true);
  assert.equal(A.ehAcaoDeAmistoso({ action: 'criar' }), false);
  assert.equal(A.ehAcaoDeAmistoso(null), false);
});

test('chave: 6 caracteres sem letras ambíguas; normaliza o que a pessoa digita', () => {
  assert.match(A.gerarChave(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(A.normalizarChave(' ab3-k9z '), 'AB3K9Z');
  assert.equal(A.normalizarChave('AB0K9Z'), null); // 0 não existe no alfabeto
  assert.equal(A.normalizarChave('ABC'), null);
});

test('dia e hora são de Brasília; datas impossíveis não passam', () => {
  assert.equal(A.instanteDe('2026-11-14', '20:00'), Date.UTC(2026, 10, 14, 23, 0));
  assert.equal(A.instanteDe('2026-02-31', '20:00'), null);
  assert.equal(A.instanteDe('2026-11-14', '24:00'), null);
  assert.equal(A.quandoTexto(Date.UTC(2026, 10, 14, 23, 0)), 'sáb, 14/11 às 20:00');
});

test('parse: local limpo e obrigatório, ids e data validados', () => {
  const base = { action: 'amistoso_propor', timeId: 'dono_1', adversarioId: 'rival_2', data: '2026-11-14', hora: '20:00', local: '  Arena\n  Central ' };
  const ok = A.parseAmistosoBody(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.local, 'Arena Central');
  assert.equal(A.parseAmistosoBody({ ...base, local: 'ab' }).ok, false);
  assert.equal(A.parseAmistosoBody({ ...base, adversarioId: 'rival_3' }).ok, false);
  assert.equal(A.parseAmistosoBody({ ...base, hora: '8h' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_responder', timeId: 'dono_1', amistosoId: 'a'.repeat(20), aceitar: 'sim' }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'time_buscar', chave: 'ab3k9z' }).value.chave, 'AB3K9Z');
});

test('propor: dono, outro time, outro dono, mesma modalidade, sem bloqueio, prazo e sem convite repetido', () => {
  assert.equal(A.motivoParaNaoPropor(cenario()), null);
  assert.equal(A.motivoParaNaoPropor(cenario({ uid: 'ana' })).code, 'nao-dono');
  assert.equal(A.motivoParaNaoPropor(cenario({ adversario: null })).code, 'time-inexistente');
  assert.equal(A.motivoParaNaoPropor(cenario({ adversarioId: 'dono_1' })).code, 'mesmo-time');
  assert.equal(A.motivoParaNaoPropor(cenario({ adversario: time({ donoId: 'dono' }) })).code, 'mesmo-dono');
  assert.equal(A.motivoParaNaoPropor(cenario({ adversario: time({ donoId: 'rival', modalidade: 'futsal' }) })).code, 'modalidade');
  assert.equal(A.motivoParaNaoPropor(cenario({ bloqueio: true })).code, 'bloqueado');
  assert.equal(A.motivoParaNaoPropor(cenario({ quando: AGORA + 10 * 60_000 })).code, 'cedo');
  assert.equal(A.motivoParaNaoPropor(cenario({ quando: AGORA + 121 * 24 * 3600_000 })).code, 'longe');
  const comRival = { de: { timeId: 'rival_1' }, para: { timeId: 'dono_1' }, status: 'pendente', quando: Timestamp.fromMillis(AGORA + 3600_000) };
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [comRival] })).code, 'em-andamento');
  const enviados = Array.from({ length: A.MAX_PENDENTES }, (_, i) => ({ de: { timeId: 'dono_1' }, para: { timeId: `x${i}_1` } }));
  assert.equal(A.motivoParaNaoPropor(cenario({ pendentes: enviados })).code, 'muitos');
});

test('par de times: em andamento bloqueia; terminado libera; sem acordo bloqueia para sempre', () => {
  const jogo = (status, quandoMs, extra = {}) => ({ de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status, quando: Timestamp.fromMillis(quandoMs), ...extra });
  const passado = AGORA - 2 * 3600_000;
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('aceito', passado)] })).code, 'em-andamento');
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('placar', passado, { proposta: { porTimeId: 'dono_1', golsDe: 1, golsPara: 0, rodada: 1, venceEm: Timestamp.fromMillis(AGORA + 60_000) } })] })).code, 'em-andamento');
  // Convite que ninguém respondeu até o jogo, placar vencido pelo prazo e jogo sem placar há 3 dias: liberado.
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('pendente', passado)] })), null);
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('placar', passado, { proposta: { porTimeId: 'dono_1', golsDe: 1, golsPara: 0, rodada: 1, venceEm: Timestamp.fromMillis(AGORA - 1) } })] })), null);
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('aceito', AGORA - R.PRAZO_FINALIZAR_MS)] })), null);
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('finalizado', passado), jogo('cancelado', passado)] })), null);
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('sem_acordo', passado)] })).code, 'sem-acordo');
});

test('placar: só depois do jogo; o outro confirma ou manda outro uma vez; na 2ª rodada não concordar = sem acordo', () => {
  const base = { de: { timeId: 'rival_1', nome: 'Rivais' }, para: { timeId: 'dono_1', nome: 'Os Brabos' }, status: 'aceito', quando: Timestamp.fromMillis(AGORA - 3600_000) };
  const rival = time({ donoId: 'rival' });
  assert.equal(R.motivoParaNaoInformarPlacar('dono', AGORA, 'dono_1', time(), base, 2, 1), null);
  assert.equal(R.motivoParaNaoInformarPlacar('ana', AGORA, 'dono_1', time(), base, 2, 1).code, 'nao-dono');
  assert.equal(R.motivoParaNaoInformarPlacar('dono', AGORA, 'dono_1', time(), { ...base, quando: Timestamp.fromMillis(AGORA + 60_000) }, 2, 1).code, 'cedo');
  assert.equal(R.motivoParaNaoInformarPlacar('dono', AGORA, 'dono_1', time(), base, 100, 1).code, 'placar-invalido');
  assert.equal(R.motivoParaNaoInformarPlacar('dono', AGORA, 'dono_1', time(), base, 1.5, 1).code, 'placar-invalido');
  // Visto do time "para": golsMeu vai em golsPara.
  assert.deepEqual({ ...R.placarDoDocumento(base, 'dono_1', 2, 1) }, { golsDe: 1, golsPara: 2 });

  const enviado = { ...base, status: 'placar', proposta: { porTimeId: 'dono_1', golsDe: 1, golsPara: 2, rodada: 1, venceEm: Timestamp.fromMillis(AGORA + 30 * 60_000) } };
  assert.equal(R.motivoParaNaoInformarPlacar('dono', AGORA, 'dono_1', time(), enviado, 2, 1).code, 'aguardando');
  assert.equal(R.motivoParaNaoConfirmarPlacar('dono', AGORA, 'dono_1', time(), enviado).code, 'proprio');
  assert.equal(R.motivoParaNaoConfirmarPlacar('rival', AGORA, 'rival_1', rival, enviado), null);
  assert.equal(R.motivoParaNaoInformarPlacar('rival', AGORA, 'rival_1', rival, enviado, 3, 2), null); // não concorda: manda o dele
  assert.equal(R.motivoParaNaoRecusarPlacar('rival', AGORA, 'rival_1', rival, enviado).code, 'primeira-rodada');

  const contestado = { ...enviado, proposta: { porTimeId: 'rival_1', golsDe: 3, golsPara: 2, rodada: 2, venceEm: Timestamp.fromMillis(AGORA + 30 * 60_000) } };
  assert.equal(R.motivoParaNaoInformarPlacar('dono', AGORA, 'dono_1', time(), contestado, 2, 1).code, 'segunda-rodada');
  assert.equal(R.motivoParaNaoRecusarPlacar('dono', AGORA, 'dono_1', time(), contestado), null);
  assert.equal(R.motivoParaNaoConfirmarPlacar('dono', AGORA, 'dono_1', time(), contestado), null);
  assert.equal(R.motivoParaNaoRecusarPlacar('rival', AGORA, 'rival_1', rival, contestado).code, 'proprio');
});

test('prazos: placar sem resposta em 1 hora vale; jogo confirmado sem placar em 3 dias fica sem placar', () => {
  const placar = { status: 'placar', quando: Timestamp.fromMillis(AGORA - 2 * 3600_000), proposta: { porTimeId: 'dono_1', golsDe: 4, golsPara: 0, rodada: 2, venceEm: Timestamp.fromMillis(AGORA) } };
  assert.deepEqual({ ...R.efetivo(placar, AGORA) }, { status: 'finalizado', resultado: { golsDe: 4, golsPara: 0 } });
  assert.equal(R.efetivo(placar, AGORA - 1).status, 'placar');
  assert.equal(R.motivoParaNaoConfirmarPlacar('rival', AGORA, 'rival_1', time({ donoId: 'rival' }), { ...placar, de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' } }).code, 'finalizado');
  const aceito = { status: 'aceito', quando: Timestamp.fromMillis(AGORA - R.PRAZO_FINALIZAR_MS) };
  assert.equal(R.efetivo(aceito, AGORA).status, 'sem_placar');
  assert.equal(R.efetivo(aceito, AGORA - 1).status, 'aceito');
});

test('artilheiros: dono, só do elenco, soma até o placar do time e por 7 dias', () => {
  const a = { de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status: 'finalizado', resultado: { golsDe: 3, golsPara: 1 }, finalizadoEm: Timestamp.fromMillis(AGORA - 3600_000) };
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, { ana: 2, dono: 1 }), null);
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, {}), null); // pode limpar
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, { ana: 4 }).code, 'soma');
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, { estranho: 1 }).code, 'jogador');
  assert.equal(R.motivoParaNaoMarcarArtilheiros('ana', AGORA, 'dono_1', time(), a, { ana: 1 }).code, 'nao-dono');
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA + R.PRAZO_ARTILHEIROS_MS, 'dono_1', time(), a, { ana: 1 }).code, 'prazo');
  assert.equal(R.motivoParaNaoMarcarArtilheiros('rival', AGORA, 'rival_1', time({ donoId: 'rival', membros: ['rival', 'zé'] }), a, { 'zé': 2 }).code, 'soma');
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), { ...a, status: 'placar' }, { ana: 1 }).code, 'nao-finalizado');
});

test('resumo: vitória/empate/derrota e correção dos gols por jogador', () => {
  assert.deepEqual({ ...R.resumoDoResultado(3, 1) }, { jogos: 1, vitorias: 1, empates: 0, derrotas: 0, golsPro: 3, golsContra: 1 });
  assert.equal(R.resumoDoResultado(2, 2).empates, 1);
  assert.equal(R.resumoDoResultado(0, 1).derrotas, 1);
  assert.deepEqual({ ...R.diferencaDeGols({ ana: 2, bia: 1 }, { ana: 1, caio: 1 }) }, { ana: -1, bia: -1, caio: 1 });
  assert.deepEqual({ ...R.diferencaDeGols({ ana: 2 }, { ana: 2 }) }, {});
});

test('parse do resultado: placar inteiro, artilheiros com uid e gols válidos', () => {
  const id = 'a'.repeat(20);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_placar', timeId: 'dono_1', amistosoId: id, golsMeu: 3, golsOutro: 0 }).ok, true);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_placar', timeId: 'dono_1', amistosoId: id, golsMeu: '3', golsOutro: 0 }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_confirmar', timeId: 'dono_1', amistosoId: id }).value.action, 'amistoso_confirmar');
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_recusar_placar', timeId: 'dono_1', amistosoId: id }).ok, true);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_artilheiros', timeId: 'dono_1', amistosoId: id, gols: { ana: 2 } }).ok, true);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_artilheiros', timeId: 'dono_1', amistosoId: id, gols: { ana: 0 } }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_artilheiros', timeId: 'dono_1', amistosoId: id, gols: { 'a.b': 1 } }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_artilheiros', timeId: 'dono_1', amistosoId: id, gols: [1] }).ok, false);
  assert.equal(A.parseAmistosoBody({ action: 'amistoso_apurar', timeId: 'dono_1' }).ok, true);
  assert.equal(A.ehAcaoDeAmistoso({ action: 'amistoso_apurar' }), true);
});

test('responder: só o dono do time convidado, só pendente e antes do jogo', () => {
  const amistoso = { de: { timeId: 'rival_1' }, para: { timeId: 'dono_1' }, status: 'pendente', quando: Timestamp.fromMillis(AGORA + 3600_000) };
  assert.equal(A.motivoParaNaoResponder('dono', AGORA, 'dono_1', time(), amistoso), null);
  assert.equal(A.motivoParaNaoResponder('ana', AGORA, 'dono_1', time(), amistoso).code, 'nao-dono');
  assert.equal(A.motivoParaNaoResponder('dono', AGORA, 'dono_1', time(), { ...amistoso, para: { timeId: 'outro_1' } }).code, 'nao-convidado');
  assert.equal(A.motivoParaNaoResponder('dono', AGORA, 'dono_1', time(), { ...amistoso, status: 'aceito' }).code, 'respondido');
  assert.equal(A.motivoParaNaoResponder('dono', AGORA + 2 * 3600_000, 'dono_1', time(), amistoso).code, 'passou');
});

test('cancelar: qualquer um dos donos, pendente ou aceito, antes do jogo', () => {
  const amistoso = { de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status: 'aceito', quando: Timestamp.fromMillis(AGORA + 3600_000) };
  assert.equal(A.motivoParaNaoCancelar('dono', AGORA, 'dono_1', time(), amistoso), null);
  assert.equal(A.motivoParaNaoCancelar('dono', AGORA, 'dono_1', time(), { ...amistoso, status: 'recusado' }).code, 'fechado');
  assert.equal(A.motivoParaNaoCancelar('ana', AGORA, 'dono_1', time(), amistoso).code, 'nao-dono');
});

test('dados públicos: elenco igual ao da página do time (sem uid nem @usuário)', () => {
  const pub = A.timePublico('dono_1', time({
    jogadores: { ana: { nome: 'Ana', userName: 'ana.user', foto: '' }, dono: { nome: 'Zeca', userName: 'zeca' } },
    camisas: { ana: { numero: 9, posicao: 'atacante' } },
    convites: { bruno: { nome: 'Bruno' } }, chave: 'AB3K9Z', cidade: { city: 'Recife', state: 'PE', lat: 1 },
  }), 'ana');
  const ana = pub.elenco.find((j) => j.nome === 'Ana');
  assert.deepEqual({ ...ana }, { nome: 'Ana', foto: '', dono: false, numero: 9, posicao: 'Atacante', capitao: false });
  assert.equal(pub.elenco.length, 2);
  assert.equal(pub.elenco.some((j) => j.nome === 'Bruno'), false);
  assert.equal(JSON.stringify(pub).includes('ana.user'), false);
  assert.equal(pub.jogadores, 2);
  assert.equal(pub.souMembro, true);
  assert.equal(pub.souDono, false);
  assert.deepEqual({ ...pub.cidade }, { city: 'Recife', state: 'PE' });
  assert.equal('membros' in pub || 'donoId' in pub || 'jogadoresDetalhe' in pub, false);
});

test('encerrar time: ação reconhecida e validada', () => {
  assert.equal(A.ehAcaoDeAmistoso({ action: 'time_encerrar' }), true);
  assert.equal(A.parseAmistosoBody({ action: 'time_encerrar', timeId: 'dono_2' }).ok, true);
  assert.equal(A.parseAmistosoBody({ action: 'time_encerrar', timeId: 'dono' }).ok, false);
});

test('cópia do amistoso guarda só dados do time adversário (sem uid do dono)', () => {
  const r = A.resumoDoTime('dono_1', time({ sigla: 'BRA', cor: '#112233', chave: 'AB3K9Z', membros: ['dono'] }));
  assert.deepEqual(Object.keys(r).sort(), ['chave', 'cor', 'corSecundaria', 'escudoUrl', 'nome', 'sigla', 'timeId']);
});

test('avisos: texto e destino (abre o time na aba Jogos)', () => {
  const amistoso = { quando: Timestamp.fromMillis(Date.UTC(2026, 10, 14, 23, 0)), local: 'Arena Central' };
  const novo = A.avisoDeAmistoso('novo', amistoso, { nome: 'Os Brabos' }, 'rival_1');
  assert.equal(novo.body, 'Os Brabos chamou o seu time para um amistoso: sáb, 14/11 às 20:00 · Arena Central');
  assert.deepEqual({ ...novo.data }, { tipo: 'time_amistoso', turmaId: '', timeId: 'rival_1' });
  assert.equal(A.avisoDeAmistoso('aceito', amistoso, { nome: 'Rivais' }, 'dono_1').title, 'Amistoso confirmado!');
  const comPlacar = { ...amistoso, de: { nome: 'Os Brabos' }, para: { nome: 'Rivais' }, proposta: { porTimeId: 'dono_1', golsDe: 3, golsPara: 2, rodada: 1 } };
  assert.equal(A.avisoDeAmistoso('placar', comPlacar, { nome: 'Os Brabos' }, 'rival_1').body, 'Os Brabos informou o placar: Os Brabos 3 x 2 Rivais. Confirme em até 1 hora.');
  assert.match(A.avisoDeAmistoso('sem_acordo', comPlacar, { nome: 'Rivais' }, 'dono_1').body, /não podem mais se enfrentar/);
});

test('artilheiros: quem saiu do time mantém e pode ter os gols corrigidos; estranho continua barrado', () => {
  const a = { de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status: 'finalizado', resultado: { golsDe: 3, golsPara: 1 }, finalizadoEm: Timestamp.fromMillis(AGORA - 3600_000), artilheiros: { ze: 2 } };
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, { ze: 2, ana: 1 }), null);
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, { ze: 1 }), null);
  assert.equal(R.motivoParaNaoMarcarArtilheiros('dono', AGORA, 'dono_1', time(), a, { outro: 1 }).code, 'jogador');
});

test('par de times: amistosos com um time que foi apagado não bloqueiam o time novo na mesma vaga', () => {
  const passado = AGORA - 2 * 3600_000;
  const jogo = (status) => ({ de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status, quando: Timestamp.fromMillis(passado), adversarioEncerrado: true });
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: [jogo('sem_acordo'), jogo('aceito')] })), null);
});

test('resumo público: só os números do time, sem artilheiros', () => {
  const d = { jogos: 3, vitorias: 2, empates: 0, derrotas: 1, golsPro: 7, golsContra: 4, jogadores: { a: { nome: 'Ana', gols: 3 }, b: { nome: 'Bia', gols: 2 }, c: { nome: 'Saiu', gols: 5 }, e: { nome: 'Edu', gols: 1 }, z: { nome: 'Zero', gols: 0 } } };
  const r = A.resumoPublico(d);
  assert.equal(r.jogos, 3);
  assert.equal(r.golsPro, 7);
  assert.equal(JSON.stringify(r.artilheiros), '[]');
  assert.equal(A.resumoPublico({ jogos: 0 }), null);
  assert.equal(A.resumoPublico(undefined), null);
});

// ── Link da página pública do time (time_link) ──
const dbDoLink = (dadosDoTime) => {
  const gravados = [];
  const docs = { 'times/dono_1': dadosDoTime };
  const snap = (caminho) => ({ id: caminho.split('/')[1], exists: docs[caminho] !== undefined, get: (c) => docs[caminho]?.[c] });
  const db = {
    doc: (caminho) => ({ caminho }),
    collection: () => ({ where: (_c, _op, v) => ({ limit: () => ({ get: async () => ({ docs: dadosDoTime && dadosDoTime.linkId === v ? [snap('times/dono_1')] : [] }) }) }) }),
    runTransaction: async (fn) => fn({
      getAll: async (...refs) => refs.map((r) => snap(r.caminho)),
      create: (ref, dados) => gravados.push(['create', ref.caminho, dados]),
      update: (ref, dados) => gravados.push(['update', ref.caminho, dados]),
    }),
  };
  return { db, gravados };
};
const LINK = 'AbCdEfGh12345678';

test('time_link: aceito só com linkId válido', () => {
  assert.equal(A.ehAcaoDeAmistoso({ action: 'time_link' }), true);
  assert.deepEqual(A.parseAmistosoBody({ action: 'time_link', linkId: LINK }).value, { action: 'time_link', linkId: LINK });
  for (const linkId of ['curto', '../AbCdEfGh12345', null]) assert.equal(A.parseAmistosoBody({ action: 'time_link', linkId }).ok, false);
});

test('time_link: quem é do time (jogador, convocado ou pediu) recebe o id', async () => {
  for (const uid of ['ana', 'convocado', 'pediu']) {
    const { db, gravados } = dbDoLink(time({ linkId: LINK, convidados: ['convocado'], solicitantes: ['pediu'] }));
    assert.deepEqual(await A.executarAmistoso(db, uid, { action: 'time_link', linkId: LINK }), { ok: true, body: { timeId: 'dono_1' } });
    assert.equal(gravados.length, 0);
  }
});

test('time_link: quem é de fora recebe a chave (gerada se faltar, com o donoId do time)', async () => {
  const comChave = dbDoLink(time({ linkId: LINK, chave: 'AB3K9Z' }));
  assert.deepEqual(await A.executarAmistoso(comChave.db, 'estranho', { action: 'time_link', linkId: LINK }), { ok: true, body: { chave: 'AB3K9Z' } });
  assert.equal(comChave.gravados.length, 0);
  const semChave = dbDoLink(time({ linkId: LINK }));
  const r = await A.executarAmistoso(semChave.db, 'estranho', { action: 'time_link', linkId: LINK });
  assert.equal(r.ok, true);
  assert.equal(typeof r.body.chave, 'string');
  assert.equal(r.body.timeId, undefined);
  const criado = semChave.gravados.find((g) => g[0] === 'create');
  assert.equal(criado[2].donoId, 'dono');
  assert.equal(criado[2].timeId, 'dono_1');
});

test('time_link: link que não existe mais → 404', async () => {
  const { db } = dbDoLink(time({ linkId: 'OutroLink1234567' }));
  const r = await A.executarAmistoso(db, 'ana', { action: 'time_link', linkId: LINK });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('LIB-03: a busca do par só filtra status que nunca bloqueiam; histórico longo não esconde jogo ativo', () => {
  const TODOS = ['pendente', 'aceito', 'recusado', 'cancelado', 'placar', 'finalizado', 'sem_acordo', 'sem_placar'];
  const instantes = [AGORA - 30 * 24 * 3600_000, AGORA - 2 * 3600_000, AGORA + 3600_000, AGORA + 10 * 24 * 3600_000];
  const propostas = [undefined, { porTimeId: 'dono_1', golsDe: 1, golsPara: 0, rodada: 1, venceEm: Timestamp.fromMillis(AGORA + 60_000) }];
  // Todo status que, em algum momento, impede a proposta precisa estar entre os buscados.
  for (const status of TODOS) {
    const bloqueia = instantes.some((q) => propostas.some((proposta) => A.motivoParaNaoPropor(cenario({
      comEle: [{ de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status, quando: Timestamp.fromMillis(q), ...(proposta ? { proposta } : {}) }],
    })) !== null));
    if (bloqueia) assert.ok(A.STATUS_QUE_BLOQUEIAM.includes(status), `${status} bloqueia mas não é buscado`);
  }
  assert.ok(!A.STATUS_QUE_BLOQUEIAM.includes('finalizado'));
  // 150 jogos encerrados + 1 aceito: o ativo continua bloqueando.
  const antigos = Array.from({ length: 150 }, () => ({ de: { timeId: 'dono_1' }, para: { timeId: 'rival_1' }, status: 'finalizado', quando: Timestamp.fromMillis(AGORA - 40 * 24 * 3600_000) }));
  const ativo = { de: { timeId: 'rival_1' }, para: { timeId: 'dono_1' }, status: 'aceito', quando: Timestamp.fromMillis(AGORA + 3600_000) };
  const filtrados = [...antigos, ativo].filter((a) => A.STATUS_QUE_BLOQUEIAM.includes(a.status));
  assert.equal(A.motivoParaNaoPropor(cenario({ comEle: filtrados })).code, 'em-andamento');
});
