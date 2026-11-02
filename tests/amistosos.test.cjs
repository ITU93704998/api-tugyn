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
const { Timestamp } = require('firebase-admin/firestore');
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const AGORA = Date.UTC(2026, 10, 2, 15, 0); // 02/11/2026 12:00 em Brasília
const time = (extra = {}) => ({ nome: 'Os Brabos', donoId: 'dono', modalidade: 'society', membros: ['dono', 'ana'], ...extra });
const cenario = (extra = {}) => ({
  uid: 'dono', agora: AGORA, quando: AGORA + 3 * 24 * 3600_000,
  meuId: 'dono_1', meu: time(), adversarioId: 'rival_1', adversario: time({ nome: 'Rivais', donoId: 'rival' }),
  bloqueio: false, pendentes: [], ...extra,
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
  const comRival = { de: { timeId: 'rival_1' }, para: { timeId: 'dono_1' } };
  assert.equal(A.motivoParaNaoPropor(cenario({ pendentes: [comRival] })).code, 'ja-pendente');
  const enviados = Array.from({ length: A.MAX_PENDENTES }, (_, i) => ({ de: { timeId: 'dono_1' }, para: { timeId: `x${i}_1` } }));
  assert.equal(A.motivoParaNaoPropor(cenario({ pendentes: enviados })).code, 'muitos');
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

test('dados públicos: nada do elenco além da contagem', () => {
  const pub = A.timePublico('dono_1', time({ jogadores: { ana: { nome: 'Ana' } }, convites: {}, chave: 'AB3K9Z', cidade: { city: 'Recife', state: 'PE', lat: 1 } }), 'ana');
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
});
