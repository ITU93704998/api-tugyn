// Saúde do sistema e configuração remota do app (painel › Plataforma › Saúde do sistema).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const anterior = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};
const S = require(path.join(root, 'api/_lib/sistema.ts'));
const A = require(path.join(root, 'api/_lib/adminSistema.ts'));
if (anterior) require.extensions['.ts'] = anterior;
else delete require.extensions['.ts'];

const MIN = 60_000, HORA = 60 * MIN, DIA = 24 * HORA;
const AGORA = Date.UTC(2026, 10, 6, 15, 0);

test('config remota: campo inválido volta ao padrão e nunca desliga nada por engano', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(S.normalizarConfig(null))), JSON.parse(JSON.stringify(S.CONFIG_PADRAO)));
  const c = S.normalizarConfig({
    versoes: { ios: { min: '5.4', latest: 'x' }, android: { min: 5, latest: '5.4.1' } },
    aviso: '  Manutenção   às 22h  ', mensagemAtualizacao: '', funcoes: { desafios: false, amistosos: 'nao', anuncios: null },
  });
  assert.deepEqual({ ...c.versoes.ios }, { min: '5.4', latest: null });
  assert.deepEqual({ ...c.versoes.android }, { min: null, latest: '5.4.1' });
  assert.equal(c.aviso, 'Manutenção às 22h');
  assert.equal(c.mensagemAtualizacao, null);
  assert.deepEqual({ ...c.funcoes }, { desafios: false, amistosos: true, anuncios: true, acompanharConfirmacoes: true }, 'só false explícito desliga');
});

test('política pública: painel vale por cima da Vercel; mínima maior que a recente é rebaixada', () => {
  const base = { minVersion: '5.2', latestVersion: '5.3', storeUrl: 'https://play.google.com/x', message: 'env' };
  const cfg = S.normalizarConfig({ versoes: { android: { min: '5.4' }, ios: { min: '5.4', latest: '5.5' } }, aviso: 'Instabilidade', funcoes: { anuncios: false } });
  const android = S.aplicarConfigRemota(base, cfg, 'android');
  assert.equal(android.minVersion, '5.3', 'mínima do painel (5.4) > mais recente da Vercel (5.3): usa 5.3');
  assert.equal(android.message, 'env');
  assert.equal(android.aviso, 'Instabilidade');
  assert.equal(android.funcoes.anuncios, false);
  const ios = S.aplicarConfigRemota(base, cfg, 'ios');
  assert.deepEqual([ios.minVersion, ios.latestVersion], ['5.4', '5.5']);
  const sem = S.aplicarConfigRemota(base, cfg, null);
  assert.deepEqual([sem.minVersion, sem.latestVersion], ['5.2', '5.3']);
});

test('lerConfig: usa cache de 30 s e, se o Firestore falhar, a última lida (ou o padrão)', async () => {
  S.esquecerConfig();
  let leituras = 0, falhar = false;
  const db = { doc: () => ({ get: async () => { leituras++; if (falhar) throw Error('fora'); return { exists: true, data: () => ({ funcoes: { desafios: false } }) }; } }) };
  assert.equal((await S.lerConfig(db, 1000)).funcoes.desafios, false);
  await S.lerConfig(db, 20_000);
  assert.equal(leituras, 1);
  falhar = true;
  assert.equal((await S.lerConfig(db, 40_000)).funcoes.desafios, false, 'falha: mantém a última');
  S.esquecerConfig();
  assert.equal((await S.lerConfig(db, 50_000)).funcoes.desafios, true, 'sem nada lido: padrão (ligado)');
  S.esquecerConfig();
});

test('versão do app: só cabeçalhos válidos, no máximo 1 gravação por dia por usuário', async () => {
  assert.equal(S.versaoDoPedido({ headers: {} }), null);
  assert.equal(S.versaoDoPedido({ headers: { 'x-app-version': '5.4', 'x-app-platform': 'web' } }), null);
  assert.equal(S.versaoDoPedido({ headers: { 'x-app-version': '5.4; drop', 'x-app-platform': 'ios' } }), null);
  assert.deepEqual({ ...S.versaoDoPedido({ headers: { 'x-app-version': '5.4.1', 'x-app-platform': 'android' } }) }, { versao: '5.4.1', plataforma: 'android' });
  const gravados = [];
  const db = { doc: (p) => ({ set: async (d) => { gravados.push([p, d.versao, d.plataforma]); } }) };
  const req = { headers: { 'x-app-version': '5.4', 'x-app-platform': 'ios' } };
  assert.equal(await S.registrarVersaoDoApp(db, 'uidA', req, AGORA), true);
  assert.equal(await S.registrarVersaoDoApp(db, 'uidA', req, AGORA + HORA), false, 'mesmo dia: não grava de novo');
  assert.equal(await S.registrarVersaoDoApp(db, 'uidA', { headers: { 'x-app-version': '5.5', 'x-app-platform': 'ios' } }, AGORA + HORA), true, 'atualizou: grava');
  assert.equal(await S.registrarVersaoDoApp(db, 'uidA', req, AGORA + DIA), true, 'dia seguinte: grava');
  assert.equal(await S.registrarVersaoDoApp(db, 'uidB', { headers: {} }, AGORA), false, 'painel (sem cabeçalho): ignora');
  assert.deepEqual(gravados.map((g) => g.join('|')), ['versoesApp/uidA|5.4|ios', 'versoesApp/uidA|5.5|ios', 'versoesApp/uidA|5.4|ios']);
});

test('registrarRotina: grava só o campo da rotina (e a hora da falha), e nunca lança', async () => {
  const chamadas = [];
  const db = { doc: () => ({ set: async (dados, opcoes) => { chamadas.push([Object.keys(dados), opcoes.mergeFields]); } }) };
  await S.registrarRotina(db, 'push_recibos', { ok: true, duracaoMs: 120.4, resumo: { verificados: 3, texto: 'x', 'a.b': 1 } });
  await S.registrarRotina(db, 'push_recibos', { ok: false, duracaoMs: 5, problemas: ['falha_geral'] });
  assert.deepEqual(JSON.parse(JSON.stringify(chamadas)), [[['push_recibos'], ['push_recibos']], [['push_recibos', 'falhas'], ['push_recibos', 'falhas.push_recibos']]]);
  await S.registrarRotina({ doc: () => ({ set: async () => { throw Error('fora'); } }) }, 'push_reenvio', { ok: true, duracaoMs: 1 });
});

test('rotinas: parada, atrasada, com problema, sem registro e opcional', () => {
  const ts_ = (m) => ({ toMillis: () => m });
  assert.equal(A.avaliarRotina('push_reenvio', { em: ts_(AGORA - MIN), ok: true }, null, AGORA).nivel, 'ok');
  assert.equal(A.avaliarRotina('push_reenvio', { em: ts_(AGORA - 6 * MIN), ok: true }, null, AGORA).nivel, 'atencao');
  assert.equal(A.avaliarRotina('push_reenvio', { em: ts_(AGORA - 20 * MIN), ok: true }, null, AGORA).nivel, 'critico');
  assert.equal(A.avaliarRotina('push_recibos', { em: ts_(AGORA - MIN), ok: false, problemas: ['falhas:2'] }, ts_(AGORA - MIN), AGORA).nivel, 'atencao');
  assert.equal(A.avaliarRotina('rotina_diaria', { em: ts_(AGORA - 25 * HORA), ok: true }, null, AGORA).nivel, 'ok');
  assert.equal(A.avaliarRotina('rotina_diaria', { em: ts_(AGORA - 51 * HORA), ok: true }, null, AGORA).nivel, 'critico');
  assert.equal(A.avaliarRotina('rotina_diaria', undefined, null, AGORA).nivel, 'atencao');
  assert.equal(A.avaliarRotina('pendencias_estatisticas', undefined, null, AGORA).nivel, 'sem_dados');
});

test('filas: vazia é ok; espera longa vira atenção/crítico; leitura falha é sem dados', () => {
  assert.equal(A.avaliarFila('recalculos', 0, 0, AGORA).nivel, 'ok');
  assert.equal(A.avaliarFila('recalculos', 3, AGORA - 30 * MIN, AGORA).nivel, 'ok');
  assert.equal(A.avaliarFila('recalculos', 3, AGORA - 2 * HORA, AGORA).nivel, 'atencao');
  assert.equal(A.avaliarFila('recalculos', 3, AGORA - 2 * DIA, AGORA).nivel, 'critico');
  assert.equal(A.avaliarFila('push_pendentes', 1, AGORA - 15 * MIN, AGORA).nivel, 'atencao');
  assert.equal(A.avaliarFila('push_pendentes', null, 0, AGORA).nivel, 'sem_dados');
  assert.equal(A.nivelGeral(['ok', 'sem_dados', 'atencao']), 'atencao');
  assert.equal(A.nivelGeral(['ok', 'sem_dados']), 'ok');
  assert.equal(A.nivelGeral(['atencao', 'critico']), 'critico');
});

test('distribuição de versões: 30 e 7 dias por plataforma, mais nova primeiro, ignora lixo', () => {
  const d = (versao, plataforma, diasAtras) => ({ versao, plataforma, vistoEm: { toMillis: () => AGORA - diasAtras * DIA } });
  const r = A.resumirVersoes([d('5.4', 'android', 1), d('5.4', 'android', 10), d('5.10', 'android', 2), d('5.3', 'ios', 3), d('5.3', 'ios', 40), d('x', 'ios', 1), d('5.4', 'web', 1)], AGORA);
  assert.equal(r.total30d, 4);
  assert.equal(r.total7d, 3);
  assert.deepEqual(r.versoes.map((v) => `${v.plataforma} ${v.versao} ${v.usuarios30d}/${v.usuarios7d}`), ['android 5.10 1/1', 'android 5.4 2/1', 'ios 5.3 1/1']);
});

test('salvar config: valida versões, mínima ≤ recente, tamanhos e interruptores', () => {
  const ok = { versoes: { ios: { min: '5.4', latest: '5.4' }, android: { min: '', latest: null } }, mensagemAtualizacao: ' Atualize ', aviso: null, funcoes: { desafios: true, amistosos: false, anuncios: true, acompanharConfirmacoes: true } };
  const r = A.parseConfigEnviada(ok);
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.value.versoes.android }, { min: null, latest: null });
  assert.equal(r.value.mensagemAtualizacao, 'Atualize');
  assert.match(A.parseConfigEnviada({ ...ok, versoes: { ...ok.versoes, ios: { min: '5.5', latest: '5.4' } } }).error, /não pode ser maior/);
  assert.match(A.parseConfigEnviada({ ...ok, versoes: { ...ok.versoes, ios: { min: 'v5', latest: null } } }).error, /Versão inválida no iOS/);
  assert.match(A.parseConfigEnviada({ ...ok, aviso: 'a'.repeat(161) }).error, /160/);
  assert.match(A.parseConfigEnviada({ ...ok, funcoes: { desafios: true } }).error, /Interruptores/);
});
