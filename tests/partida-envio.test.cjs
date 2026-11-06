const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));
function load(file, dependencies) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'api/_lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: module.exports, module, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, Date, Intl, JSON, console: { log() {}, error() {}, warn() {} }, process });
  return module.exports;
}

const HORA = 3_600_000;
const AGORA = Date.parse('2026-11-05T22:00:00Z'); // 19h em Brasília
const ts_ = ms => ({ toMillis: () => ms });
const SERVER = { servidor: true };
const inc = n => ({ incremento: n });
const clonar = v => (Array.isArray(v) ? v.map(clonar) : v && typeof v === "object" && typeof v.toMillis !== "function" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonar(x)])) : v);

const validation = { isSafeUid: v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) };
const estatisticas = load('estatisticas.ts', { './validation': validation });
const firestore = { FieldValue: { serverTimestamp: () => SERVER, increment: inc }, Timestamp: { fromMillis: ms => ts_(ms) } };
const mod = load('partidaEnvio.ts', { 'firebase-admin/firestore': firestore, './estatisticas': estatisticas, './validation': validation });

/** Firestore em memória com transação (tx.get/set/update), incrementos e campos com ponto. */
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, clonar(v)]));
  const valor = v => (v === SERVER ? ts_(AGORA) : v);
  const setCampo = (obj, caminho, v) => {
    const partes = caminho.split('.');
    let o = obj;
    for (const p of partes.slice(0, -1)) o = o[p] = typeof o[p] === 'object' && o[p] !== null ? o[p] : {};
    const ultimo = partes[partes.length - 1];
    o[ultimo] = v && typeof v === 'object' && 'incremento' in v ? (typeof o[ultimo] === 'number' ? o[ultimo] : 0) + v.incremento : valor(v);
  };
  const ref = key => ({ key });
  const snap = key => { const d = docs.get(key); return { exists: !!d, data: () => (d ? clonar(d) : undefined), get: c => c.split('.').reduce((o, k) => o?.[k], d) }; };
  const escritas = [];
  const db = {
    doc: ref,
    runTransaction: async fn => {
      const ops = [];
      const tx = {
        get: async r => snap(r.key),
        set: (r, data, opts) => ops.push(['set', r.key, data, opts]),
        update: (r, data) => ops.push(['update', r.key, data]),
      };
      const out = await fn(tx);
      for (const [op, key, data, opts] of ops) {
        escritas.push([op, key]);
        if (op === 'update' && !docs.has(key)) throw Error('not found ' + key);
        const base = op === 'set' && !opts?.merge ? {} : docs.get(key) ?? {};
        for (const [k, v] of Object.entries(data)) {
          if (op === 'set' && typeof v === 'object' && v !== null && !('incremento' in v) && v !== SERVER && !v.toMillis && !Array.isArray(v)) {
            base[k] = { ...(base[k] ?? {}), ...Object.fromEntries(Object.entries(v).map(([a, b]) => [a, valor(b)])) };
          } else setCampo(base, k, v);
        }
        docs.set(key, base);
      }
      return out;
    },
  };
  return { db, docs, escritas };
}

const T = 'turmas/t1';
const base = (extra = {}) => ({
  [T]: { creatorId: 'org', participantes: ['org', 'ana', 'bia', 'temp'], status: 'ativa', ...extra.turma },
  [`${T}/participantes/ana`]: { status: 'aprovado', gols: 1, jogos: 1, assistencias: 0 },
  [`${T}/participantes/bia`]: { status: 'aprovado', gols: 0, jogos: 0, assistencias: 0 },
  [`${T}/participantes/temp`]: { status: 'aprovado', gols: 0, jogos: 0, assistencias: 0, aprovadoEm: ts_(AGORA - 48 * HORA) },
  [`${T}/participantes/pend`]: { status: 'pendente' },
  [`${T}/resumo/atual`]: { membros: { ana: { nome: 'Ana', gols: 1, jogos: 1, assistencias: 0 }, bia: { nome: 'Bia', gols: 0, jogos: 0, assistencias: 0 } } },
  ...extra.docs,
});
const corpo = (jogadores, extra = {}) => ({ turmaId: 't1', partidaId: 'p1', partida: { nome: 'Quinta', data: new Date(AGORA - HORA).toISOString(), modalidade: 'futsal', ...extra }, jogadores });
const parse = b => { const r = mod.parsePartidaEnviada(b); assert.equal(r.ok, true, r.error); return r.value; };
const enviar = (db, uid, b, agora = AGORA) => mod.enviarPartida(db, uid, parse(b), agora);
const ANA1 = [{ participanteId: 'ana', nomeJogador: 'Ana', gols_partida: 1, assistencias: 0 }];

test('1º envio: partida com totais da lista, números, resumo, pendência e atividade', async () => {
  const { db, docs } = fakeDb(base());
  const r = await enviar(db, 'org', corpo([...ANA1, { participanteId: 'bia', nomeJogador: 'Bia', assistencias: 1 }, { nomeJogador: 'Convidado', gols_partida: 3 }]));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.participantesAlterados].sort(), ['ana', 'bia']);
  const p = docs.get(`${T}/partidas/p1`);
  assert.equal(p.totalGols, 1);
  assert.equal(p.totalAssistencias, 1);
  assert.equal(p.totalJogadores, 2);
  assert.equal(p.modalidade, 'futsal');
  assert.equal(p.diaDoJogo, '2026-11-05');
  assert.equal(p.temporada, 't2026_6');
  assert.equal(p.enviadaPor, 'org');
  const ana = docs.get(`${T}/participantes/ana`);
  assert.equal(ana.gols, 2);
  assert.equal(ana.jogos, 2);
  assert.equal(ana.temporadas.t2026_6.gols, 1);
  assert.equal(docs.get(`${T}/resumo/atual`).membros.ana.gols, 2);
  assert.ok(docs.get('recalculosPendentes/t1').pendentes.bia);
  assert.ok(docs.get(T).ultimaAtividade);
});

test('LIB-01: reenviar o mesmo conteúdo não soma de novo (nem escreve)', async () => {
  const { db, docs, escritas } = fakeDb(base());
  await enviar(db, 'org', corpo(ANA1));
  const n = escritas.length;
  for (let i = 0; i < 3; i++) {
    const r = await enviar(db, 'org', corpo(ANA1));
    assert.equal(r.alterado, false);
  }
  assert.equal(escritas.length, n);
  assert.equal(docs.get(`${T}/participantes/ana`).gols, 2);
  assert.equal(docs.get(`${T}/participantes/ana`).jogos, 2);
});

test('correção aplica só a diferença; tirar alguém da lista desconta', async () => {
  const { db, docs } = fakeDb(base());
  await enviar(db, 'org', corpo([...ANA1, { participanteId: 'bia', gols_partida: 2 }]));
  await enviar(db, 'org', corpo([{ participanteId: 'ana', gols_partida: 3 }]));
  assert.equal(docs.get(`${T}/participantes/ana`).gols, 4);
  assert.equal(docs.get(`${T}/participantes/ana`).jogos, 2);
  assert.equal(docs.get(`${T}/participantes/bia`).gols, 0);
  assert.equal(docs.get(`${T}/participantes/bia`).jogos, 0);
  assert.equal(docs.get(`${T}/partidas/p1`).totalGols, 3);
});

test('LIB-02: jogador que não é membro aprovado é recusado; números fora do limite também', async () => {
  const { db, docs } = fakeDb(base());
  const r = await enviar(db, 'org', corpo([...ANA1, { participanteId: 'pend', nomeJogador: 'Pedro', gols_partida: 1 }]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'jogador_fora');
  const r2 = await enviar(db, 'org', corpo([{ participanteId: 'fantasma', gols_partida: 1 }]));
  assert.equal(r2.code, 'jogador_fora');
  assert.equal(docs.has(`${T}/partidas/p1`), false);
  for (const gols of [99999, -1, 1.5, '3']) {
    assert.equal(mod.parsePartidaEnviada(corpo([{ participanteId: 'ana', gols_partida: gols }])).ok, false);
  }
  // Repetido na lista: soma, mas não passa de 99 por jogador.
  assert.equal(mod.parsePartidaEnviada(corpo([{ participanteId: 'ana', gols_partida: 60 }, { participanteId: 'ana', gols_partida: 60 }])).ok, false);
  assert.equal(mod.parsePartidaEnviada({ ...corpo(ANA1), partidaId: '../x' }).ok, false);
});

test('versão gravada adulterada (lista com 99999) não vira desconto/soma absurdo', async () => {
  const { db, docs } = fakeDb(base({ docs: { [`${T}/partidas/p1`]: { jogadores: [{ participanteId: 'ana', gols_partida: 99999 }], corrigivelAte: ts_(AGORA + HORA), salvadoEm: ts_(AGORA - HORA), temporada: 't2026_6', diaDoJogo: '2026-11-05' } } }));
  await enviar(db, 'org', corpo(ANA1));
  // Antes tratado como 0 gols (fora do formato) com 1 jogo: agora 1 gol → +1 gol, jogos igual.
  assert.equal(docs.get(`${T}/participantes/ana`).gols, 2);
  assert.equal(docs.get(`${T}/participantes/ana`).jogos, 1);
});

test('organizador temporário no prazo envia; vencido, reaprovado depois ou membro comum, não', async () => {
  const temp = desde => ({ turma: { organizadorTemporario: { uid: 'temp', nome: 'Temp', desde: ts_(desde) } } });
  const ok = fakeDb(base(temp(AGORA - 2 * HORA)));
  assert.equal((await enviar(ok.db, 'temp', corpo(ANA1))).ok, true);
  const vencido = fakeDb(base(temp(AGORA - 25 * HORA)));
  assert.equal((await enviar(vencido.db, 'temp', corpo(ANA1))).code, 'sem_permissao');
  const reaprovado = fakeDb(base({ ...temp(AGORA - 2 * HORA), docs: { [`${T}/participantes/temp`]: { status: 'aprovado', aprovadoEm: ts_(AGORA - HORA) } } }));
  assert.equal((await enviar(reaprovado.db, 'temp', corpo(ANA1))).code, 'sem_permissao');
  const comum = fakeDb(base());
  assert.equal((await enviar(comum.db, 'bia', corpo(ANA1))).code, 'sem_permissao');
  assert.equal(comum.docs.has(`${T}/partidas/p1`), false);
  const moderada = fakeDb(base({ turma: { ...temp(AGORA - HORA).turma, encerradaPor: 'moderacao' } }));
  assert.equal((await enviar(moderada.db, 'temp', corpo(ANA1))).code, 'sem_permissao');
});

test('prazo de correção encerrado e turma inexistente', async () => {
  const { db } = fakeDb(base({ docs: { [`${T}/partidas/p1`]: { jogadores: ANA1, corrigivelAte: ts_(AGORA - 1), salvadoEm: ts_(AGORA - 30 * HORA) } } }));
  const r = await enviar(db, 'org', corpo([{ participanteId: 'ana', gols_partida: 2 }]));
  assert.equal(r.code, 'prazo_encerrado');
  const vazio = fakeDb({});
  assert.equal((await enviar(vazio.db, 'org', corpo(ANA1))).code, 'turma_nao_encontrada');
});

test('modalidade e temporada gravadas não mudam na correção', async () => {
  const { db, docs } = fakeDb(base());
  await enviar(db, 'org', corpo(ANA1));
  await enviar(db, 'org', corpo([{ participanteId: 'ana', gols_partida: 2 }], { modalidade: 'futebol' }));
  assert.equal(docs.get(`${T}/partidas/p1`).modalidade, 'futsal');
  assert.equal(docs.get(`${T}/partidas/p1`).temporada, 't2026_6');
});

test('prazo igual ao do app: meio-dia do dia seguinte, no máximo 35 h do 1º envio', () => {
  const jogo = Date.parse('2026-11-05T22:00:00Z');
  assert.equal(mod.calcularCorrigivelAte(jogo, jogo), Date.parse('2026-11-06T15:00:00Z'));
  const tarde = Date.parse('2026-11-06T18:00:00Z');
  assert.equal(mod.calcularCorrigivelAte(jogo, tarde), tarde + 2 * HORA);
});
