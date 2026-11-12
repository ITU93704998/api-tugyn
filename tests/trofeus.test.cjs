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
const { calcularTrofeus, planoDosTrofeus, chaveDoTrofeu, motivoInvalido, mesmoTrofeu } = require(path.join(root, 'api/_lib/trofeus.ts'));
const { sincronizarTrofeusCampeonato, mexeNosTrofeus } = require(path.join(root, 'api/_lib/trofeusSync.ts'));
const { gerarPontosCorridos, gerarMataMata } = require(path.join(root, 'api/_lib/campeonato/tabela.ts'));
const { campeaoDe, precisaPenaltis, resolverJogos } = require(path.join(root, 'api/_lib/campeonato/classificacao.ts'));
const { parseGestaoBody } = require(path.join(root, 'api/_lib/turmaGestao.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const turma = { nome: 'Pelada de Quinta', creatorId: 'dono', participantes: ['dono', 'ana', 'bia', 'caio', 'davi'] };
const regras = { returno: false, idaVolta: false, pontosVitoria: 3, pontosEmpate: 1, finalEntreDois: false, tempos: 2, minutosPorTempo: 10 };
const times = () => ({
  t1: { nome: 'Azul', cor: '#3B82F6', elenco: [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }] },
  t2: { nome: 'Verde', cor: '#22C55E', elenco: [{ id: 'caio', nome: 'Caio' }] },
  t3: { nome: 'Branco', cor: 'branco', elenco: [] },
});
const par = (j, a, b) => (j.casa === a && j.fora === b) || (j.casa === b && j.fora === a);
/** Placar do ponto de vista de `a` × `b`, com gols/assistências por jogador. */
const lancar = (jogos, a, b, ga, gb, gols = {}, assistencias = {}) => {
  const [id, j] = Object.entries(jogos).find(([, x]) => par(x, a, b));
  const inv = j.casa !== a;
  jogos[id] = { ...j, golsCasa: inv ? gb : ga, golsFora: inv ? ga : gb, gols, assistencias };
};
/** Triangular encerrado: Azul campeão (6 pts), Caio artilheiro (4 gols), Bia garçom. */
const campeonato = () => {
  const c = { nome: 'Copa', formato: 'pontos', regras: clone(regras), status: 'encerrado', times: times(), sorteio: ['t1', 't2', 't3'] };
  const jogos = clone(gerarPontosCorridos(['t1', 't2', 't3'], false, false));
  lancar(jogos, 't1', 't2', 2, 1, { ana: 1, caio: 1 }, { bia: 1 });
  lancar(jogos, 't1', 't3', 1, 0, { ana: 1 }, {});
  lancar(jogos, 't2', 't3', 3, 0, { caio: 3 }, {});
  c.jogos = jogos;
  c.campeao = campeaoDe(c);
  return c;
};

test('campeonato válido: campeão para o elenco; artilheiro e garçom pelos jogos encerrados', () => {
  const c = campeonato();
  assert.equal(c.campeao, 't1');
  assert.equal(motivoInvalido('C1', c), null);
  const r = calcularTrofeus('T1', 'C1', turma, c);
  assert.deepEqual([...r.keys()].sort(), ['ana', 'bia', 'caio']);
  assert.deepEqual(r.get('ana').titulos, ['campeao']);
  assert.deepEqual(r.get('bia').titulos, ['campeao', 'garcom']);
  assert.deepEqual(r.get('caio').titulos, ['artilheiro']);
  assert.equal(r.get('caio').gols, 4);
  assert.equal(r.get('ana').turma, 'Pelada de Quinta');
  assert.equal(r.get('caio').time, 'Verde');
});

test('mata-mata com ida e volta e pênaltis: campeão recalculado pela chave', () => {
  const ids = ['t1', 't2', 't3', 't4'];
  const c = { nome: 'Copa', formato: 'mata', regras: { ...clone(regras), idaVolta: true }, status: 'encerrado', times: { ...times(), t4: { nome: 'Preto', cor: '#000000', elenco: [{ id: 'davi', nome: 'Davi' }] } }, sorteio: ids };
  let jogos = clone(gerarMataMata(ids, true));
  const preencher = () => {
    jogos = clone(resolverJogos({ ...c, jogos }));
    for (const [id, j] of Object.entries(jogos).sort((a, b) => a[1].ordem - b[1].ordem)) {
      if (j.casa && j.fora && j.golsCasa === null) {
        jogos[id] = { ...j, golsCasa: 1, golsFora: 1, penaltis: id === 'final' || j.perna === 2 ? [4, 3] : null, gols: {}, assistencias: {} };
        return true;
      }
    }
    return false;
  };
  while (preencher());
  c.jogos = jogos;
  c.campeao = campeaoDe(c);
  assert.ok(c.campeao);
  assert.equal(motivoInvalido('C1', c), null);
  assert.ok(calcularTrofeus('T1', 'C1', turma, c).size > 0);
});

test('CAMP-01: o servidor recusa campeonato manipulado (ninguém recebe nada)', () => {
  const casos = {
    'campeão sem jogos': (c) => { for (const j of Object.values(c.jogos)) Object.assign(j, { golsCasa: null, golsFora: null, gols: {}, assistencias: {} }); },
    'campeão diferente do calculado': (c) => { c.campeao = 't2'; },
    'placar negativo': (c) => { Object.values(c.jogos)[0].golsCasa = -8; },
    'placar quebrado': (c) => { Object.values(c.jogos)[0].golsFora = 1.5; },
    'só um lado do placar': (c) => { Object.values(c.jogos)[0].golsFora = null; },
    'gols além do placar': (c) => { const j = Object.values(c.jogos).find((x) => par(x, 't2', 't3')); j.gols = { caio: 50 }; },
    'gol de quem não joga a partida': (c) => { const j = Object.values(c.jogos).find((x) => par(x, 't2', 't3')); j.gols = { ana: 1 }; },
    'assistência de estranho': (c) => { const j = Object.values(c.jogos)[0]; j.assistencias = { estranho: 1 }; },
    'jogador em dois times': (c) => { c.times.t2.elenco.push({ id: 'ana', nome: 'Ana' }); },
    'id inválido no elenco': (c) => { c.times.t2.elenco.push({ id: '../x', nome: 'X' }); },
    'jogo a menos': (c) => { delete c.jogos[Object.keys(c.jogos)[0]]; },
    'par repetido no lugar de outro': (c) => { const [a, b] = Object.values(c.jogos); Object.assign(b, { casa: a.casa, fora: a.fora }); },
    'pontuação fora das opções': (c) => { c.regras.pontosVitoria = 10; },
    'em andamento': (c) => { c.status = 'andamento'; },
    'dois times só': (c) => { delete c.times.t3; },
    // Revalidação A: 3 assistências de quem é do time que fez 1 gol (o total dos dois times caberia).
    'assistências além dos gols do time': (c) => { const j = Object.values(c.jogos).find((x) => par(x, 't1', 't2')); j.assistencias = { caio: 3 }; },
    'gols além dos gols do time': (c) => { const j = Object.values(c.jogos).find((x) => par(x, 't1', 't2')); j.gols = { caio: 2 }; },
    // Revalidação B: final configurada, mas no lugar dela um jogo "extra" sem vínculo com o 1º e o 2º.
    'final configurada sem a final': (c) => {
      c.regras.finalEntreDois = true;
      const copia = Object.values(c.jogos)[0];
      c.jogos.extra = { ...copia, fase: 'final', ordem: 99000, confronto: 'extra', origem: null };
    },
    'final sem vínculo com as posições': (c) => {
      c.regras.finalEntreDois = true;
      c.jogos.final = { fase: 'final', ordem: 99000, confronto: 'final', perna: 1, casa: 't1', fora: 't3', origem: null, golsCasa: 1, golsFora: 0, penaltis: null, gols: {}, assistencias: {} };
    },
    'jogo com fase trocada': (c) => { Object.values(c.jogos)[0].fase = 'r9'; },
    'time trocado de lugar só num jogo': (c) => { const j = Object.values(c.jogos)[0]; const x = j.casa; j.casa = j.fora; j.fora = x; },
  };
  for (const [nome, mexer] of Object.entries(casos)) {
    const c = campeonato();
    mexer(c);
    assert.notEqual(motivoInvalido('C1', c), null, nome);
    assert.equal(calcularTrofeus('T1', 'C1', turma, c).size, 0, nome);
  }
  assert.equal(calcularTrofeus('T1', 'C1', turma, null).size, 0);
  assert.equal(calcularTrofeus('T1', 'C1', { ...turma, encerradaPor: 'moderacao' }, campeonato()).size, 0);
});

test('CAMP-01: uid de fora da turma no elenco não recebe troféu', () => {
  const c = campeonato();
  c.times.t1.elenco.push({ id: 'estranho', nome: 'De fora' });
  const aceitos = new Set(turma.participantes);
  const r = calcularTrofeus('T1', 'C1', turma, c, (u) => aceitos.has(u));
  assert.equal(r.has('estranho'), false);
  assert.ok(r.has('ana'));
});

test('empate no topo: todos levam; sem assistências, ninguém é garçom', () => {
  const c = campeonato();
  const j = Object.values(c.jogos).find((x) => par(x, 't1', 't3'));
  j.golsCasa = j.casa === 't1' ? 3 : 0; j.golsFora = j.casa === 't1' ? 0 : 3; j.gols = { ana: 3 };
  for (const x of Object.values(c.jogos)) x.assistencias = {};
  c.campeao = campeaoDe(c);
  const r = calcularTrofeus('T1', 'C1', turma, c);
  assert.ok(r.get('ana').titulos.includes('artilheiro'));
  assert.ok(r.get('caio').titulos.includes('artilheiro'));
  assert.ok(![...r.values()].some((t) => t.titulos.includes('garcom')));
});

test('plano, comparação e gatilho', () => {
  const atuais = calcularTrofeus('T1', 'C1', turma, campeonato());
  const p = planoDosTrofeus(['ana', 'davi', 'bad/uid'], atuais);
  assert.deepEqual(p.remover, ['davi']);
  assert.equal(p.gravar.length, 3);
  assert.equal(chaveDoTrofeu('T1', 'C1'), 'T1_C1');
  const ana = atuais.get('ana');
  assert.equal(mesmoTrofeu({ ...ana, em: 'qualquer' }, ana), true);
  assert.equal(mesmoTrofeu({ ...ana, gols: 9 }, ana), false);
  assert.equal(mexeNosTrofeus({ status: 'andamento' }, { status: 'andamento' }), false, 'lance ao vivo não dispara');
  assert.equal(mexeNosTrofeus({ status: 'andamento' }, { status: 'encerrado' }), true);
  assert.equal(mexeNosTrofeus({ status: 'encerrado' }, { status: 'andamento' }), true, 'reaberto');
  assert.equal(mexeNosTrofeus({ status: 'andamento' }, null), true, 'apagado');
});

// ─── Sincronização (Firestore falso, transação simples) ──────────────────────
const { FieldValue } = require(require.resolve('firebase-admin/firestore', { paths: [root] }));
const APAGAR = FieldValue.delete();
const AGORA = FieldValue.serverTimestamp();
const fakeDb = (inicial) => {
  const docs = new Map(Object.entries(clone(inicial)));
  let relogio = 0;
  const sentinela = (v) => v && typeof v.isEqual === 'function';
  const mesclar = (alvo, dados) => {
    for (const [k, v] of Object.entries(dados)) {
      if (sentinela(v) && v.isEqual(APAGAR)) delete alvo[k];
      else if (sentinela(v) && v.isEqual(AGORA)) alvo[k] = `ts${++relogio}`;
      else if (v && typeof v === 'object' && !Array.isArray(v)) mesclar((alvo[k] = alvo[k] && typeof alvo[k] === 'object' ? alvo[k] : {}), v);
      else alvo[k] = v;
    }
    return alvo;
  };
  const snap = (p) => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => (docs.has(p) ? clone(docs.get(p)) : undefined) });
  const db = {
    escritas: 0,
    docs,
    doc: (p) => ({ path: p }),
    runTransaction: async (fn) => fn({
      getAll: async (...refs) => refs.map((r) => snap(r.path)),
      set: (r, dados, op) => { db.escritas++; docs.set(r.path, op?.merge ? mesclar(docs.get(r.path) ?? {}, dados) : mesclar({}, dados)); },
      delete: (r) => { db.escritas++; docs.delete(r.path); },
    }),
  };
  return db;
};
const base = () => ({
  'turmas/T1': turma,
  'turmas/T1/campeonatos/C1': campeonato(),
  'users/ana': {}, 'users/bia': {}, 'users/caio': {}, 'users/davi': {},
});

test('sync: grava, não regrava igual (mantém a data) e retira ao reabrir/excluir', async () => {
  const db = fakeDb(base());
  assert.deepEqual(await sincronizarTrofeusCampeonato(db, 'T1', 'C1'), { recebem: 3, gravados: 3, removidos: 0 });
  assert.ok(db.docs.get('users/ana/restrito/trofeus').itens.T1_C1.em);
  assert.deepEqual(db.docs.get('trofeusCampeonatos/T1_C1').uids.sort(), ['ana', 'bia', 'caio']);

  db.escritas = 0;
  assert.deepEqual(await sincronizarTrofeusCampeonato(db, 'T1', 'C1'), { recebem: 3, gravados: 0, removidos: 0 });
  assert.equal(db.escritas, 0, 'repetir não escreve nada');

  // Correção: Bia deixa de ser garçom; a data da conquista dela fica a original.
  const emAntes = db.docs.get('users/bia/restrito/trofeus').itens.T1_C1.em;
  const c = db.docs.get('turmas/T1/campeonatos/C1');
  for (const j of Object.values(c.jogos)) j.assistencias = {};
  db.docs.set('turmas/T1/campeonatos/C1', c);
  await sincronizarTrofeusCampeonato(db, 'T1', 'C1');
  const bia = db.docs.get('users/bia/restrito/trofeus').itens.T1_C1;
  assert.deepEqual(bia.titulos, ['campeao']);
  assert.equal(bia.em, emAntes);

  // Reaberto: todos perdem.
  c.status = 'andamento';
  db.docs.set('turmas/T1/campeonatos/C1', c);
  assert.equal((await sincronizarTrofeusCampeonato(db, 'T1', 'C1')).removidos, 3);
  assert.equal(db.docs.get('users/ana/restrito/trofeus').itens.T1_C1, undefined);

  // Encerrado de novo e depois apagado (ou a turma excluída): sai tudo e o registro some.
  db.docs.set('turmas/T1/campeonatos/C1', campeonato());
  await sincronizarTrofeusCampeonato(db, 'T1', 'C1');
  db.docs.delete('turmas/T1/campeonatos/C1');
  db.docs.delete('turmas/T1');
  assert.equal((await sincronizarTrofeusCampeonato(db, 'T1', 'C1')).removidos, 3);
  assert.equal(db.docs.has('trofeusCampeonatos/T1_C1'), false);
});

test('sync: conta excluída e uid de fora não recebem; quem saiu da turma depois mantém', async () => {
  const inicial = base();
  inicial['turmas/T1/campeonatos/C1'].times.t1.elenco.push({ id: 'estranho', nome: 'X' });
  inicial['users/estranho'] = {};
  delete inicial['users/caio'];
  const db = fakeDb(inicial);
  const r = await sincronizarTrofeusCampeonato(db, 'T1', 'C1');
  assert.equal(r.recebem, 2);
  assert.equal(db.docs.has('users/estranho/restrito/trofeus'), false);
  assert.equal(db.docs.has('users/caio/restrito/trofeus'), false);
  // Bia sai da turma; uma correção depois não tira o troféu dela.
  db.docs.set('turmas/T1', { ...turma, participantes: ['dono', 'ana'] });
  await sincronizarTrofeusCampeonato(db, 'T1', 'C1');
  assert.ok(db.docs.get('users/bia/restrito/trofeus').itens.T1_C1);
});

test('corpo da ação trofeus', () => {
  assert.deepEqual(parseGestaoBody({ action: 'trofeus', turmaId: 'T1', campeonatoId: 'C1', uids: ['x'] }), { ok: true, value: { action: 'trofeus', turmaId: 'T1', campeonatoId: 'C1' } });
  assert.equal(parseGestaoBody({ action: 'trofeus', turmaId: 'T1' }).ok, false);
  assert.equal(parseGestaoBody({ action: 'trofeus', turmaId: 'T1', campeonatoId: '../c' }).ok, false);
});

test('campeonatos legítimos gerados pela lógica do app passam (folgas, returno, final)', () => {
  const nomes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'];
  const cenarios = [];
  for (const n of [3, 5, 6, 7, 16]) {
    cenarios.push({ formato: 'mata', n, r: { idaVolta: false } }, { formato: 'mata', n, r: { idaVolta: true } });
    cenarios.push({ formato: 'pontos', n, r: { returno: true, finalEntreDois: true } }, { formato: 'pontos', n, r: {} });
  }
  for (const { formato, n, r } of cenarios) {
    const ids = nomes.slice(0, n);
    const c = { nome: 'X', formato, regras: { ...clone(regras), ...r }, status: 'encerrado', sorteio: ids, times: Object.fromEntries(ids.map((id) => [id, { nome: id, cor: '#123456', elenco: [] }])) };
    let jogos = clone(formato === 'mata' ? gerarMataMata(ids, c.regras.idaVolta) : gerarPontosCorridos(ids, c.regras.returno, c.regras.finalEntreDois));
    let k = 0;
    for (;;) {
      jogos = clone(resolverJogos({ ...c, jogos }));
      const prox = Object.entries(jogos).sort((a, b) => a[1].ordem - b[1].ordem).find(([, j]) => j.casa && j.fora && j.golsCasa === null);
      if (!prox) break;
      const [id, j] = prox;
      k += 1;
      jogos[id] = { ...j, golsCasa: k % 3, golsFora: (k + 1) % 2, penaltis: null, gols: {}, assistencias: {} };
      if (precisaPenaltis(jogos, id, jogos[id].golsCasa, jogos[id].golsFora)) jogos[id].penaltis = [5, 4];
    }
    c.jogos = jogos;
    c.campeao = campeaoDe(c);
    assert.ok(c.campeao, `${formato} ${n} ${JSON.stringify(r)} sem campeão`);
    assert.equal(motivoInvalido('C1', c), null, `${formato} ${n} ${JSON.stringify(r)}`);
  }
});
