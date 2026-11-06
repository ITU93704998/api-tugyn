// Ferramentas de suporte, caixa de relatos e custos/cotas (painel › Plataforma).
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
const R = require(path.join(root, 'api/_lib/relatos.ts'));
const S = require(path.join(root, 'api/_lib/adminSuporte.ts'));
const C = require(path.join(root, 'api/_lib/custos.ts'));
if (anterior) require.extensions['.ts'] = anterior;
else delete require.extensions['.ts'];

const HORA = 3_600_000, DIA = 24 * HORA;
const AGORA = Date.UTC(2026, 10, 6, 20, 0); // 12h no Pacífico

test('relato: valida tipo e tamanho, limpa controles e mantém as quebras de linha', () => {
  assert.equal(R.parseRelato(null).ok, false);
  assert.match(R.parseRelato({ categoria: 'x', texto: 'a'.repeat(20) }).error, /tipo/);
  assert.match(R.parseRelato({ categoria: 'erro', texto: 'curto' }).error, /pelo menos 10/);
  assert.match(R.parseRelato({ categoria: 'erro', texto: 'a'.repeat(2001) }).error, /até 2000/);
  const ok = R.parseRelato({ categoria: 'erro', texto: '  O app\r\nfecha\n\n\n\nao abrir\u0007 a turma ', sistema: 'Android 14\n', modelo: 42 });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.texto, 'O app\nfecha\n\nao abrir  a turma');
  assert.equal(ok.value.sistema, 'Android 14');
  assert.equal(ok.value.modelo, '');
});

test('relato: a ação "relato" existe e conta suspensa não envia', () => {
  const s = (() => {
    const ant = require.extensions['.ts'];
    require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
    const m = require(path.join(root, 'api/_lib/suspensao.ts'));
    if (ant) require.extensions['.ts'] = ant; else delete require.extensions['.ts'];
    return m;
  })();
  assert.ok(s.ACOES_DA_API.includes('relato'));
  assert.equal(s.acaoPermitida({ status: 'suspended' }, 'relato'), false);
});

test('relatos e versões do app são apagados junto com a conta', () => {
  const job = fs.readFileSync(path.join(root, 'api/_lib/exclusaoContaJob.ts'), 'utf8');
  assert.match(job, /collection: "relatos", field: "uid"/);
  assert.match(job, /collection: "versoesApp", field: "uid"/);
  assert.match(fs.readFileSync(path.join(root, 'api/_lib/sistema.ts'), 'utf8'), /set\(\{ uid, versao/);
});

test('busca de turma: código de convite, identificador ou nome', () => {
  assert.equal(S.tipoBuscaTurma('ABC234'), 'codigo');
  assert.equal(S.tipoBuscaTurma('abc234'), 'codigo');
  assert.equal(S.tipoBuscaTurma('ABC10I'), 'nome', 'I, O, 0 e 1 não existem no código');
  assert.equal(S.tipoBuscaTurma('k3J9aZ0qLm2Xc8Vb7Nn1'), 'id');
  assert.equal(S.tipoBuscaTurma('Pelada de quinta'), 'nome');
  assert.deepEqual(S.variantesDoNome('pelada'), ['pelada', 'Pelada']);
  assert.deepEqual(S.variantesDoNome('Ébano'), ['Ébano', 'ébano']);
});

test('resumo da turma: aponta quem falta e quem sobra', () => {
  assert.deepEqual(S.compararResumo(['a', 'b', 'c'], ['a', 'b', 'c']), { faltando: 0, sobrando: 0, diverge: false });
  assert.deepEqual(S.compararResumo(['a', 'b', 'c'], ['a', 'x']), { faltando: 2, sobrando: 1, diverge: true });
});

test('exclusão: travada depois de 3 rodadas ou parada há 1 h; só retoma quando a rotina também retomaria', () => {
  const ts_ = (n) => ({ toMillis: () => n });
  const recente = S.lerExclusao('u1', { estado: 'excluindo', atualizadaEm: ts_(AGORA - 10 * 60_000), rodadas: 0 }, AGORA);
  assert.equal(recente.travada, false);
  assert.equal(recente.podeRetomar, false);
  const parada = S.lerExclusao('u1', { estado: 'excluindo', atualizadaEm: ts_(AGORA - 2 * HORA), bloqueio: 'x' }, AGORA);
  assert.equal(parada.travada, true);
  assert.equal(parada.podeRetomar, true);
  const pos = S.lerExclusao('u1', { estado: 'pos_exclusao', atualizadaEm: ts_(AGORA), rodadas: 3, pendencias: ['imagens', 7] }, AGORA);
  assert.equal(pos.travada, true);
  assert.equal(pos.podeRetomar, true);
  assert.deepEqual(pos.pendencias, ['imagens']);
});

test('relato lido: campos desconhecidos viram padrão; nota com limite', () => {
  const r = S.lerRelato('r1', { uid: 'u', categoria: 'hack', status: 'apagado', texto: 'oi', criadoEm: { toMillis: () => 5 } });
  assert.equal(r.categoria, 'outro');
  assert.equal(r.status, 'aberto');
  assert.equal(r.criadoEm, 5);
  assert.equal(S.parseNota(undefined), '');
  assert.equal(S.parseNota('  respondido por e-mail '), 'respondido por e-mail');
  assert.equal(S.parseNota('a'.repeat(1001)), null);
  assert.equal(S.parseNota(3), null);
});

test('cotas: inválido volta ao padrão no que é lido e é recusado no que é salvo', () => {
  assert.deepEqual(C.normalizarCotas({ firestore: { leituras: -1, escritas: 30_000 }, alertaPct: 150 }), {
    firestore: { leituras: 50_000, escritas: 30_000, exclusoes: 20_000 },
    alertaPct: 80,
  });
  assert.equal(C.parseCotasEnviadas({ firestore: { leituras: 1, escritas: 1, exclusoes: 0 }, alertaPct: 80 }).ok, false);
  assert.match(C.parseCotasEnviadas({ firestore: { leituras: 1, escritas: 1, exclusoes: 1 }, alertaPct: 100 }).error, /10% e 99%/);
  assert.equal(C.parseCotasEnviadas({ firestore: { leituras: 1e6, escritas: 2e5, exclusoes: 2e5 }, alertaPct: 70 }).ok, true);
});

test('níveis: atenção a partir do alerta, crítico a partir de 100%', () => {
  assert.equal(C.nivelPorPct(null, 80), 'sem_dados');
  assert.equal(C.nivelPorPct(79.9, 80), 'ok');
  assert.equal(C.nivelPorPct(80, 80), 'atencao');
  assert.equal(C.nivelPorPct(100, 80), 'critico');
  assert.equal(C.piorNivel(['ok', 'sem_dados', 'atencao']), 'atencao');
  assert.equal(C.piorNivel(['sem_dados']), 'sem_dados');
  assert.equal(C.piorNivel([]), 'sem_dados');
});

test('Firestore: soma os pontos horários por dia do Pacífico', () => {
  const dias = C.ultimosDias(AGORA);
  assert.equal(dias.length, 7);
  assert.equal(dias[6], '2026-11-06');
  const ponto = (fimUtc, n) => ({ interval: { endTime: new Date(fimUtc).toISOString() }, value: { int64Value: String(n) } });
  // 08:00 UTC = meia-noite no Pacífico (PST, UTC-8): a hora que termina às 08:00 ainda é do dia 5.
  const series = [{ points: [ponto(Date.UTC(2026, 10, 6, 8), 100), ponto(Date.UTC(2026, 10, 6, 9), 40), ponto(Date.UTC(2026, 10, 6, 19), 2), ponto(Date.UTC(2026, 9, 1), 999)] }];
  const porDia = C.somarPorDia(series, dias);
  assert.equal(porDia[6], 42);
  assert.equal(porDia[5], 100);
  assert.equal(porDia.reduce((a, b) => a + b, 0), 142, 'ponto fora da janela é ignorado');
});

test('Firestore: mensagem clara quando falta o papel Monitoring Viewer', () => {
  assert.match(C.motivoDaFalha(403), /Monitoring Viewer/);
  assert.match(C.motivoDaFalha(500), /não respondeu/);
});

test('Cloudinary: lê créditos do plano e junta contas repetidas', () => {
  const u = C.lerUsoCloudinary('conta1', ['usuarios'], { plan: 'Free', credits: { usage: 21.5, limit: 25, used_percent: 86 }, storage: { usage: 1024 }, bandwidth: { usage: 2048 }, transformations: { usage: 300 }, last_updated: '2026-11-05' }, 80);
  assert.deepEqual(u.creditos, { usados: 21.5, limite: 25, pct: 86 });
  assert.equal(u.nivel, 'atencao');
  assert.equal(u.armazenamentoBytes, 1024);
  assert.equal(C.lerUsoCloudinary('c', [], {}, 80).nivel, 'sem_dados');
  const contas = C.contasDoCloudinary((b) => (b === 'arenas' ? null : { cloud_name: b === 'usuarios' ? 'a' : 'b', api_key: 'k', api_secret: 's' }));
  assert.deepEqual([...contas.keys()], ['a', 'b']);
  assert.deepEqual(contas.get('b').usos, ['times', 'anuncios', 'turmas']);
});

// ─── Correções da auditoria do painel (06/11/2026) ───

test('PAD-03: turma com mais de 200 membros e tudo certo não acusa divergência', () => {
  const ids = Array.from({ length: 201 }, (_, i) => `u${String(i).padStart(3, '0')}`);
  const docs = ids.map((id) => ({ id, status: 'aprovado' }));
  const d = S.diagnosticarTurma(ids, docs, true, { existe: true, membros: ids });
  assert.deepEqual(d.comparacao, { faltando: 0, sobrando: 0, diverge: false });
  assert.equal(d.inconsistencias, 0);
  assert.equal(d.contagem.aprovado, 201);
});

test('PAD-03: leitura parcial deixa o diagnóstico indeterminado (nada vira "sobrando")', () => {
  const d = S.diagnosticarTurma(['a', 'b', 'c'], [{ id: 'a', status: 'aprovado' }], false, { existe: true, membros: ['a', 'b', 'c'] });
  assert.deepEqual(d.comparacao, { faltando: null, sobrando: null, diverge: null });
  assert.equal(d.inconsistencias, null);
});

test('PAD-03: aprovado fora da lista, lista sem documento e resumo inexistente', () => {
  const d = S.diagnosticarTurma(['a', 'x'], [{ id: 'a', status: 'aprovado' }, { id: 'b', status: 'aprovado' }], true, { existe: false, membros: [] });
  assert.equal(d.inconsistencias, 2, 'b aprovado fora da lista + x na lista sem documento');
  assert.deepEqual(d.comparacao, { faltando: 1, sobrando: 0, diverge: true });
});

/** Firestore falso só com o que executarComRegistro usa. */
const dbDoLog = ({ falharInicio = false, falharFim = false } = {}) => {
  const gravacoes = [];
  return {
    gravacoes,
    collection: () => ({
      doc: () => ({
        id: 'op1',
        set: async (d) => { if (falharInicio) throw new Error('log fora'); gravacoes.push(['set', d.estado]); },
        update: async (d) => { if (falharFim && d.estado === 'concluida') throw new Error('log fora'); gravacoes.push(['update', d.estado]); },
      }),
    }),
  };
};

test('PAD-04: ação concluída com falha no fechamento do registro responde sucesso marcado', async () => {
  const db = dbDoLog({ falharFim: true });
  let chamadas = 0;
  const r = await S.executarComRegistro(db, 'sessoes-encerrar', 'u1', 'adm', 'motivo', async () => { chamadas++; return { ok: true }; });
  assert.equal(chamadas, 1);
  assert.equal(r.ok, true);
  assert.equal(r.registroIncompleto, true);
  assert.equal(r.operacaoId, 'op1');
  assert.deepEqual(db.gravacoes, [['set', 'iniciada']]);
});

test('PAD-04: sem conseguir registrar a intenção, a ação não roda', async () => {
  let chamadas = 0;
  await assert.rejects(S.executarComRegistro(dbDoLog({ falharInicio: true }), 'turma-resumo', 't', 'adm', 'm', async () => { chamadas++; return {}; }), /log fora/);
  assert.equal(chamadas, 0);
});

test('PAD-04: falha da ação fica registrada como "falhou" e o erro segue', async () => {
  const db = dbDoLog();
  await assert.rejects(S.executarComRegistro(db, 'turma-resumo', 't', 'adm', 'm', async () => { throw new S.Recusa(404, 'Turma não encontrada.'); }), /Turma não encontrada/);
  assert.deepEqual(db.gravacoes, [['set', 'iniciada'], ['update', 'falhou']]);
  const ok = dbDoLog();
  const r = await S.executarComRegistro(ok, 'turma-resumo', 't', 'adm', 'm', async () => ({ membros: 3 }));
  assert.equal(r.registroIncompleto, undefined);
  assert.deepEqual(ok.gravacoes, [['set', 'iniciada'], ['update', 'concluida']]);
});

test('retomada de exclusão: reserva ativa impede outra retomada; a rotina diária respeita a reserva', () => {
  const t = (n) => ({ toMillis: () => n });
  const x = S.lerExclusao('u1', { estado: 'pos_exclusao', atualizadaEm: t(AGORA), retomadaAte: t(AGORA + 60_000) }, AGORA);
  assert.equal(x.podeRetomar, false);
  assert.equal(x.retomadaAte, AGORA + 60_000);
  assert.equal(S.lerExclusao('u1', { estado: 'pos_exclusao', atualizadaEm: t(AGORA), retomadaAte: t(AGORA - 1) }, AGORA).podeRetomar, true, 'reserva vencida');
  assert.match(fs.readFileSync(path.join(root, 'api/_lib/exclusaoContaJob.ts'), 'utf8'), /retomadaAte"\)\) \?\? 0\) > agora\) return/);
});

test('PAD-01: relatos ordenados no servidor com desempate e cursor validado', () => {
  const src = fs.readFileSync(path.join(root, 'api/_lib/adminSuporte.ts'), 'utf8');
  assert.match(src, /orderBy\("criadoEm", "desc"\)\.orderBy\(FieldPath\.documentId\(\), "desc"\)/);
  assert.match(src, /startAfter\(new Timestamp\(depoisDe\.s, depoisDe\.n\), depoisDe\.id\)/);
  assert.doesNotMatch(src, /fromMillis\(depoisDe/);
  assert.deepEqual(S.parseCursor({ s: 5, n: 123456000, id: 'abc' }), { s: 5, n: 123456000, id: 'abc' });
  assert.equal(S.parseCursor({ s: 5, n: 0, id: '../x' }), null);
  assert.equal(S.parseCursor({ s: -1, n: 0, id: 'a' }), null);
  assert.equal(S.parseCursor({ s: 5, n: 1e9, id: 'a' }), null, 'nanossegundos fora da faixa');
  assert.equal(S.parseCursor({ s: 5, n: 1.5, id: 'a' }), null);
  assert.equal(S.parseCursor({ em: 5, id: 'a' }), null, 'cursor antigo em milissegundos');
  assert.equal(S.parseCursor('x'), null);
});

test('PAD-01b: o cursor guarda segundos e nanossegundos exatos (sem arredondar para milissegundos)', () => {
  // O 50º relato tem microssegundos que o milissegundo perderia.
  assert.deepEqual(S.cursorDoRelato('r50', { seconds: 1762430400, nanoseconds: 123456789 }), { s: 1762430400, n: 123456789, id: 'r50' });
  assert.equal(S.cursorDoRelato('r50', 1762430400123), null, 'criadoEm que não é Timestamp não vira cursor');
  assert.equal(S.cursorDoRelato('r50', null), null);
});

test('PAD-06: pedidos simultâneos de custos fazem uma coleta só', async () => {
  C.esquecerCustos();
  let coletas = 0;
  let liberar;
  const coletar = () => { coletas++; return new Promise((r) => { liberar = () => r({ geradoEm: Date.now(), nivel: 'ok', cotas: C.COTAS_PADRAO, firestore: { disponivel: false, motivo: '', dias: [], metricas: [] }, cloudinary: [] }); }); };
  const a = C.custos({}, false, false, coletar);
  const b = C.custos({}, true, false, coletar);
  liberar();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(coletas, 1);
  assert.equal(ra, rb);
  await C.custos({}, false, false, coletar);
  assert.equal(coletas, 1, 'cache vale');
  const forcado = C.custos({}, false, true, coletar);
  liberar();
  await forcado;
  assert.equal(coletas, 2, 'forçar (depois de salvar cotas) refaz');
  C.esquecerCustos();
});
