// AUD-09: as turmas que a pessoa já tinha deixado são anonimizadas numa etapa durável do job de exclusão. Sem o índice de
// grupo de coleções a etapa fica pendente (lança isMissingIndex); com ele, anonimiza só o que falta (idempotente).
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
const del = require(path.join(root, 'api/_lib/accountDeletion.ts'));
const exc = require(path.join(root, 'api/_lib/exclusaoConta.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

/** Firestore em memória, só o que a etapa usa. Sentinelas do FieldValue são gravadas como vieram. */
const criarDb = (dados, { semIndice = false, falharCommit = 0 } = {}) => {
  let commits = 0;
  const docs = new Map(Object.entries(dados).map(([k, v]) => [k, { ...v }]));
  const snap = (p) => {
    const d = docs.get(p);
    return { exists: Boolean(d), id: p.split('/').pop(), ref: ref(p), data: () => (d ? { ...d } : undefined), get: (k) => d?.[k] };
  };
  const ref = (p) => {
    const partes = p.split('/');
    const pai = partes.length > 2 ? { id: partes.at(-3), parent: null } : null;
    return {
      id: partes.at(-1),
      path: p,
      parent: { id: partes.at(-2), parent: pai ? ref(partes.slice(0, -2).join('/')) : null },
      get: async () => snap(p),
      update: async (campos) => aplicar(p, campos),
    };
  };
  const aplicar = (p, campos) => {
    const atual = { ...(docs.get(p) || {}) };
    for (const [k, v] of Object.entries(campos)) {
      if (k.includes('.')) continue; // `membros.x` (resumo) não é usado nestes cenários
      atual[k] = v;
    }
    docs.set(p, atual);
  };
  return {
    docs,
    doc: ref,
    collection: (c) => ({
      get: async () => ({ docs: [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1).map(snap) }),
    }),
    collectionGroup: (nome) => {
      const consulta = (filtro, lim = Infinity, depois = null) => ({
        select: () => consulta(filtro, lim, depois),
        limit: (n) => consulta(filtro, n, depois),
        startAfter: (s) => consulta(filtro, lim, s.ref.path),
        get: async () => {
          if (semIndice) throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 });
          let chaves = [...docs.keys()].filter((k) => k.split('/').at(-2) === nome && filtro(docs.get(k))).sort();
          if (depois) chaves = chaves.filter((k) => k > depois);
          const lista = chaves.map(snap);
          return { docs: lista.slice(0, lim), size: Math.min(lista.length, lim) };
        },
      });
      return { where: (campo, _op, valor) => consulta((d) => d[campo] === valor) };
    },
    batch: () => {
      const ops = [];
      return {
        update: (r, campos) => ops.push(() => aplicar(r.path, campos)),
        delete: (r) => ops.push(() => docs.delete(r.path)),
        commit: async () => {
          commits += 1;
          if (commits === falharCommit) throw new Error('falha injetada no lote ' + commits);
          ops.forEach((f) => f());
        },
      };
    },
  };
};

const cenario = () => ({
  // Turma que ela deixou (não está mais em participantes): nome e partidas ainda com ela.
  'turmas/t1': { nome: 'Pelada', creatorId: 'org', participantes: ['org'], pendingParticipants: [] },
  'turmas/t1/participantes/ana': { id: 'ana', nome: 'Ana', urlPhoto: 'x.jpg', status: 'saiu' },
  'turmas/t1/partidas/p1': { jogadores: [{ participanteId: 'ana', nomeJogador: 'Ana' }, { participanteId: 'org', nomeJogador: 'Org' }] },
  // Turma já anonimizada pelo fluxo principal: não mexe de novo.
  'turmas/t2': { nome: 'Outra', creatorId: 'org', participantes: ['org'], pendingParticipants: [] },
  'turmas/t2/participantes/ana': { id: 'ana', nome: 'Usuário removido', urlPhoto: '', status: 'saiu', anonimizado: true },
});

test('sem o índice: a etapa lança (fica pendente) e a verificação final não dá por limpo', async () => {
  const db = criarDb(cenario(), { semIndice: true });
  await assert.rejects(del.anonimizarTurmasDeixadas(db, 'ana'), (e) => del.isMissingIndex(e));
  assert.equal(await del.contarTurmasDeixadasPendentes(db, 'ana'), null);
  assert.equal(db.docs.get('turmas/t1/participantes/ana').nome, 'Ana');
});

test('com o índice: anonimiza o participante e as partidas da turma deixada, uma vez só', async () => {
  const db = criarDb(cenario());
  assert.equal(await del.contarTurmasDeixadasPendentes(db, 'ana'), 1);
  assert.equal(await del.anonimizarTurmasDeixadas(db, 'ana'), 1);
  const p = db.docs.get('turmas/t1/participantes/ana');
  assert.equal(p.nome, del.REMOVED_NAME);
  assert.equal(p.urlPhoto, '');
  assert.equal(p.anonimizado, true);
  assert.equal(p.status, 'saiu');
  assert.deepEqual(db.docs.get('turmas/t1/partidas/p1').jogadores.map((j) => j.nomeJogador), [del.REMOVED_NAME, 'Org']);
  assert.equal(await del.contarTurmasDeixadasPendentes(db, 'ana'), 0);
  assert.equal(await del.anonimizarTurmasDeixadas(db, 'ana'), 0);
});

test('avaliarRestos: turma deixada sem anonimizar (ou sem como conferir) reabre a etapa exMembros', () => {
  const limpo = { perfil: false, contaAuth: false, usernames: 0, avaliacoesDadas: 0, avaliacoesRecebidas: 0, desafios: 0, vagas: false, vagasDeAdversarios: 0, pushTokens: 0, reservas: 0 };
  assert.deepEqual(exc.avaliarRestos({ ...limpo, exMembros: 0 }).refazerEtapas, []);
  assert.deepEqual(exc.avaliarRestos({ ...limpo, exMembros: 2 }).refazerEtapas, ['exMembros']);
  const semIndice = exc.avaliarRestos({ ...limpo, exMembros: null });
  assert.deepEqual(semIndice.refazerEtapas, ['exMembros']);
  assert.deepEqual(semIndice.pendencias, ['exMembros']);
  assert.equal(semIndice.refazerExclusao, false);
});

test('revalidação AUD-09: falha no 2º lote não marca a turma como limpa; a nova tentativa termina as partidas', async () => {
  const dados = {
    'turmas/t1': { nome: 'Pelada', creatorId: 'org', participantes: ['org'], pendingParticipants: [] },
    'turmas/t1/participantes/ana': { id: 'ana', nome: 'Ana', urlPhoto: 'x.jpg', status: 'saiu' },
  };
  for (let i = 0; i < 405; i++) dados['turmas/t1/partidas/p' + String(i).padStart(3, '0')] = { jogadores: [{ participanteId: 'ana', nomeJogador: 'Ana' }] };
  const db = criarDb(dados, { falharCommit: 2 });
  await assert.rejects(del.anonimizarTurmasDeixadas(db, 'ana'), /falha injetada/);
  assert.notEqual(db.docs.get('turmas/t1/participantes/ana').anonimizado, true, 'marcador só no fim');
  assert.equal(await del.contarTurmasDeixadasPendentes(db, 'ana'), 1, 'verificação não dá por limpo');
  assert.equal(await del.anonimizarTurmasDeixadas(db, 'ana'), 1, 'a nova tentativa não pula a turma');
  const restantes = [...db.docs.entries()].filter(([k, v]) => k.includes('/partidas/') && v.jogadores.some((j) => j.nomeJogador === 'Ana'));
  assert.equal(restantes.length, 0);
  assert.equal(db.docs.get('turmas/t1/participantes/ana').anonimizado, true);
  assert.equal(await del.contarTurmasDeixadasPendentes(db, 'ana'), 0);
});

test('revalidação AUD-09: a verificação final lê todas as páginas (pendente depois do 300º participante)', async () => {
  const dados = {};
  for (let i = 0; i < 701; i++) {
    const t = 'turmas/t' + String(i).padStart(4, '0');
    dados[t + '/participantes/ana'] = { id: 'ana', nome: i === 700 ? 'Ana' : 'Usuário removido', status: 'saiu', anonimizado: i !== 700 };
  }
  assert.equal(await del.contarTurmasDeixadasPendentes(criarDb(dados), 'ana'), 1);
});
