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
const des = require(path.join(root, 'api/_lib/desafios.ts'));
const res = require(path.join(root, 'api/_lib/midiaReservas.ts'));
const exc = require(path.join(root, 'api/_lib/exclusaoConta.ts'));
const cool = require(path.join(root, 'api/_lib/mediaCooldown.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

// ── INF-02: leitura em páginas ─────────────────────────────────────────────
const fonte = (total) => {
  const itens = Array.from({ length: total }, (_, i) => i);
  const chamadas = [];
  const buscar = async (depoisDe, limite) => {
    chamadas.push(limite);
    const inicio = depoisDe === null ? 0 : depoisDe + 1;
    return itens.slice(inicio, inicio + limite);
  };
  return { buscar, chamadas };
};

test('lerEmPaginas: lê tudo quando cabe (inclusive exatamente no tamanho da página)', async () => {
  for (const total of [0, 1, 99, 100, 101, 250, 500]) {
    const { buscar } = fonte(total);
    const r = await des.lerEmPaginas(buscar, 100, 5);
    assert.equal(r.completo, true, `total ${total}`);
    assert.equal(r.itens.length, total);
    assert.deepEqual(r.itens.slice(-1), total ? [total - 1] : []);
  }
});

test('lerEmPaginas: acima do teto NÃO é completo (a apuração não fecha com soma parcial)', async () => {
  const { buscar, chamadas } = fonte(501);
  const r = await des.lerEmPaginas(buscar, 100, 5);
  assert.equal(r.completo, false);
  assert.equal(r.itens.length, 500);
  assert.deepEqual(chamadas, [101, 101, 101, 101, 101]); // sempre pede 1 a mais para saber se existe a próxima
});

// ── INF-01: fila com cursor e prazo ────────────────────────────────────────
test('percorrerComPrazo: percorre a fila inteira em lotes pelo cursor', async () => {
  const { buscar } = fonte(45);
  const vistos = [];
  const r = await des.percorrerComPrazo({ buscar, lote: 20, prazoMs: Infinity, processar: async (i) => { vistos.push(i); } });
  assert.deepEqual(r, { processados: 45, restantes: false });
  assert.deepEqual(vistos, Array.from({ length: 45 }, (_, i) => i));
});

test('percorrerComPrazo: para no prazo e avisa que restou (próxima rodada continua)', async () => {
  const { buscar } = fonte(100);
  let relogio = 0;
  const r = await des.percorrerComPrazo({ buscar, lote: 20, prazoMs: 30, agora: () => relogio, processar: async () => { relogio += 1; } });
  assert.deepEqual(r, { processados: 30, restantes: true });
});

test('percorrerComPrazo: lote exato sem sobra termina sem restantes', async () => {
  const { buscar } = fonte(40);
  const r = await des.percorrerComPrazo({ buscar, lote: 20, prazoMs: Infinity, processar: async () => {} });
  assert.deepEqual(r, { processados: 40, restantes: false });
});

test('problemasDaRotina: só vazio quando tudo foi feito', () => {
  const ok = { falhou: 0, reconciliar: 0, apuracaoIncompleta: false, avisosIncompletos: false, atrasoMaxMs: 3600_000, etapasComFalha: [] };
  assert.deepEqual(des.problemasDaRotina(ok), []);
  const ruim = des.problemasDaRotina({ ...ok, falhou: 2, reconciliar: 1, apuracaoIncompleta: true, avisosIncompletos: true, atrasoMaxMs: 3 * 86400_000, etapasComFalha: ['push_recibos'] });
  assert.deepEqual(ruim, ['apuracoes_falharam:2', 'reconciliacao_pendente:1', 'fila_de_apuracao_restante', 'fila_de_avisos_restante', 'atraso_max_h:72', 'etapa_falhou:push_recibos']);
});

// ── INF-03: reservas de imagem ─────────────────────────────────────────────
const url = (id, v = 'v17') => `https://res.cloudinary.com/demo/image/upload/${v}/${id}.jpg`;

test('publicIdDaUrl / referenciaAponta', () => {
  assert.equal(res.publicIdDaUrl(url('usuarios/u1/profile/tmp_a_b')), 'usuarios/u1/profile/tmp_a_b');
  assert.equal(res.publicIdDaUrl('https://res.cloudinary.com/demo/image/upload/usuarios/u1/profile/profile.png?x=1'), 'usuarios/u1/profile/profile');
  assert.equal(res.publicIdDaUrl('https://outro.com/image/upload/v1/x.jpg'), null);
  assert.equal(res.publicIdDaUrl(url('usuarios/../x')), null);
  assert.equal(res.referenciaAponta(url('usuarios/u1/profile/tmp_a_b'), 'usuarios/u1/profile/tmp_a_b'), true);
  assert.equal(res.referenciaAponta(url('usuarios/u1/profile/profile'), 'usuarios/u1/profile/tmp_a_b'), false);
  assert.equal(res.referenciaAponta('', 'x'), false);
});

test('reserva: chave por alvo, nome novo a cada envio, ativa só no prazo e sem desfecho', () => {
  assert.equal(res.chaveDaReserva('u1', 'fotoPerfil'), 'foto_u1');
  assert.equal(res.chaveDaReserva('u1', 'bannerTurma', 't9'), 'banner_t9');
  assert.match(res.nomeDoEnvio('fotoPerfil', 'abc', 1000), /^tmp_/);
  assert.match(res.nomeDoEnvio('bannerTurma', 'abc', 1000), /^b_/);
  assert.notEqual(res.nomeDoEnvio('fotoPerfil', 'abc', 1000), 'profile');
  assert.equal(res.reservaAtiva({ estado: 'reservada', expiraEmMs: 2000 }, 1000), true);
  assert.equal(res.reservaAtiva({ estado: 'enviada', expiraEmMs: 2000 }, 1000), true);
  assert.equal(res.reservaAtiva({ estado: 'enviada', expiraEmMs: 1000 }, 1000), false);
  for (const estado of ['confirmada', 'promovida', 'falhou']) assert.equal(res.reservaAtiva({ estado, expiraEmMs: 9e15 }, 0), false);
});

test('proximoPasso: referenciada conclui/promove; sem referência apaga o envio', () => {
  assert.equal(res.proximoPasso({ tipo: 'fotoPerfil' }, true), 'promover');
  assert.equal(res.proximoPasso({ tipo: 'bannerTurma' }, true), 'concluir');
  assert.equal(res.proximoPasso({ tipo: 'fotoPerfil' }, false), 'apagar_envio');
  assert.equal(res.proximoPasso({ tipo: 'bannerTurma' }, false), 'apagar_envio');
});

test('anteriorParaApagar: nunca o id fixo do avatar, o envio novo ou imagem de outro dono', () => {
  const base = { uid: 'u1', tipo: 'fotoPerfil', estado: 'confirmada', publicId: 'usuarios/u1/profile/tmp_x', bucket: 'usuarios' };
  assert.equal(res.anteriorParaApagar({ ...base, anterior: { publicId: 'usuarios/u1/profile/profile' } }), null);
  assert.equal(res.anteriorParaApagar({ ...base, anterior: { publicId: 'usuarios/u1/profile/tmp_x' } }), null);
  assert.equal(res.anteriorParaApagar({ ...base, anterior: { publicId: 'usuarios/u2/profile/abc' } }), null);
  assert.deepEqual(res.anteriorParaApagar({ ...base, anterior: { url: url('usuarios/u1/profile/antiga') } }), { bucket: 'usuarios', publicId: 'usuarios/u1/profile/antiga' });
  const banner = { uid: 'u1', tipo: 'bannerTurma', estado: 'enviada', publicId: 'turmas/u1/banner/b_novo', bucket: 'turmas' };
  assert.deepEqual(res.anteriorParaApagar({ ...banner, anterior: { url: url('turmas/u1/banner/velho') } }), { bucket: 'turmas', publicId: 'turmas/u1/banner/velho' });
  assert.equal(res.anteriorParaApagar({ ...banner, anterior: { url: url('turmas/u1/banner/b_novo') } }), null);
  assert.equal(res.anteriorParaApagar({ ...banner, anterior: null }), null);
});

test('checarIntervalo: prazo e organizador, sem Firestore', () => {
  const agora = Date.UTC(2026, 9, 30);
  const dias = (n) => new Date(agora - n * 86400_000);
  assert.equal(cool.checarIntervalo('u1', 'fotoPerfil', null, agora).allowed, true);
  assert.equal(cool.checarIntervalo('u1', 'fotoPerfil', { profileImageChangedAt: dias(8) }, agora).allowed, true);
  const bloqueado = cool.checarIntervalo('u1', 'fotoPerfil', { profileImageChangedAt: dias(2) }, agora);
  assert.equal(bloqueado.status, 429);
  assert.equal(bloqueado.retryAfterSeconds, 5 * 86400);
  assert.equal(cool.checarIntervalo('u1', 'bannerTurma', null, agora).status, 404);
  assert.equal(cool.checarIntervalo('u1', 'bannerTurma', { creatorId: 'u2' }, agora).status, 403);
  assert.equal(cool.checarIntervalo('u1', 'bannerTurma', { creatorId: 'u1', bannerChangedAt: dias(1) }, agora).status, 429);
});

// ── INF-04: job da exclusão ────────────────────────────────────────────────
test('paresDosDesafios: adversário de cada desafio, ignorando ids estranhos', () => {
  assert.deepEqual(
    exc.paresDosDesafios('eu', ['t2026_6__eu__ana', 'd20261030__bia__eu', 'x__ana__bia', 'lixo', 't__eu__eu', 't__eu__../x']),
    { 't2026_6__eu__ana': 'ana', 'd20261030__bia__eu': 'bia' },
  );
});

test('etapasPendentes / deveProcessar', () => {
  assert.deepEqual(exc.etapasPendentes(undefined), ['avaliacoesDadas', 'vagasAdversarios', 'imagens']);
  assert.deepEqual(exc.etapasPendentes({ avaliacoesDadas: { ok: true, tentativas: 1 }, imagens: { ok: false, tentativas: 2, pendencias: ['bucket_turmas_sem_credenciais'] } }), ['vagasAdversarios', 'imagens']);
  const agora = 10 * 3600_000;
  assert.equal(exc.deveProcessar({ estado: 'pos_exclusao', atualizadaEmMs: agora }, agora), true);
  assert.equal(exc.deveProcessar({ estado: 'excluindo', atualizadaEmMs: agora - 60_000 }, agora), false); // em andamento agora
  assert.equal(exc.deveProcessar({ estado: 'excluindo', atualizadaEmMs: agora - exc.RETOMAR_APOS_MS }, agora), true);
  assert.equal(exc.deveProcessar({ estado: 'outro', atualizadaEmMs: 0 }, agora), false);
});

test('avaliarRestos: limpo conclui; resto principal refaz o fluxo; resto de etapa reabre a etapa', () => {
  const limpo = { perfil: false, contaAuth: false, usernames: 0, avaliacoesDadas: 0, avaliacoesRecebidas: 0, desafios: 0, vagas: false, vagasDeAdversarios: 0, pushTokens: 0, reservas: 0 };
  assert.deepEqual(exc.avaliarRestos(limpo), { pendencias: [], refazerExclusao: false, refazerEtapas: [] });
  const etapa = exc.avaliarRestos({ ...limpo, avaliacoesDadas: 1, vagasDeAdversarios: 2 });
  assert.equal(etapa.refazerExclusao, false);
  assert.deepEqual(etapa.refazerEtapas, ['avaliacoesDadas', 'vagasAdversarios']);
  const principal = exc.avaliarRestos({ ...limpo, contaAuth: true, desafios: 1 });
  assert.equal(principal.refazerExclusao, true);
  assert.deepEqual(principal.pendencias, ['conta_auth', 'desafios']);
});
