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
const N = require(path.join(root, 'api/_lib/notificacoesGerais.ts'));
const P = require(path.join(root, 'api/_lib/push.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];

const AGORA = Date.UTC(2026, 10, 3, 15, 0);
const TOKEN = (n) => `ExponentPushToken[aparelho-000${n}]`;
const MSG = { titulo: 'Novidade', texto: 'Já dá para marcar amistoso!' };

/** Firestore em memória: documentos, subcoleções, transações (escritas aplicadas no fim), where ==/in/<, orderBy (campo ou id), startAfter, limit. */
function banco(inicial) {
  const dados = new Map(Object.entries(inicial));
  const leituras = { users: 0 };
  // Versão por documento: a transação que leu um documento alterado por outra é refeita (como no Firestore).
  const versoes = new Map();
  const mudou = (c) => versoes.set(c, (versoes.get(c) ?? 0) + 1);
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const pegar = (obj, campo) => campo.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const escrever = (c, v, o) => { mudou(c); dados.set(c, o?.merge ? { ...(dados.get(c) ?? {}), ...clone(v) } : clone(v)); };
  const atualizar = (c, v) => { if (!dados.has(c)) throw new Error('não existe: ' + c); mudou(c); dados.set(c, { ...dados.get(c), ...clone(v) }); };
  const snap = (c) => { const v = dados.get(c); return { id: c.split('/').pop(), ref: ref(c), exists: v !== undefined, data: () => clone(v), get: (k) => clone(pegar(v, k)) }; };
  const ref = (c) => ({
    caminho: c, id: c.split('/').pop(),
    get: async () => snap(c), set: async (v, o) => escrever(c, v, o), update: async (v) => atualizar(c, v), delete: async () => { mudou(c); dados.delete(c); },
    collection: (sub) => consulta(`${c}/${sub}`),
  });
  const consulta = (col, s = { filtros: [], ordem: null, depois: undefined, max: Infinity }) => {
    const com = (m) => consulta(col, { ...s, ...m });
    return {
      doc: (id) => ref(`${col}/${id}`),
      where: (c, op, v) => com({ filtros: [...s.filtros, [c, op, v]] }),
      select: () => com({}),
      orderBy: (c, dir = 'asc') => com({ ordem: [c, dir] }),
      startAfter: (v) => com({ depois: v }),
      limit: (n) => com({ max: n }),
      get: async () => {
        const prof = col.split('/').length + 1;
        let ks = [...dados.keys()].filter((k) => k.startsWith(col + '/') && k.split('/').length === prof);
        ks = ks.filter((k) => s.filtros.every(([c, op, v]) => { const x = pegar(dados.get(k), c); return op === 'in' ? v.includes(x) : op === '<' ? x < v : x === v; }));
        const chave = (k) => (s.ordem && typeof s.ordem[0] === 'string' ? pegar(dados.get(k), s.ordem[0]) : k.split('/').pop());
        if (s.ordem) ks.sort((a, b) => (chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0) * (s.ordem[1] === 'desc' ? -1 : 1));
        if (s.depois !== undefined) ks = ks.filter((k) => (s.ordem?.[1] === 'desc' ? chave(k) < s.depois : chave(k) > s.depois));
        ks = ks.slice(0, s.max);
        if (col === 'users') leituras.users += ks.length;
        return { size: ks.length, docs: ks.map(snap) };
      },
    };
  };
  return {
    dados, leituras,
    doc: ref,
    collection: (c) => consulta(c),
    batch: () => { const ops = []; return { delete: (r) => ops.push(() => { mudou(r.caminho); dados.delete(r.caminho); }), commit: async () => ops.forEach((o) => o()) }; },
    runTransaction: async (fn) => {
      for (let tentativa = 0; tentativa < 20; tentativa++) {
      const escritas = [];
      const lidas = new Map();
      const tx = {
        get: async (r) => { lidas.set(r.caminho, versoes.get(r.caminho) ?? 0); return snap(r.caminho); },
        set: (r, v, o) => escritas.push(() => escrever(r.caminho, v, o)),
        update: (r, v) => escritas.push(() => atualizar(r.caminho, v)),
        create: (r, v) => { if (dados.has(r.caminho)) throw new Error('já existe'); escritas.push(() => escrever(r.caminho, v)); },
        delete: (r) => escritas.push(() => { mudou(r.caminho); dados.delete(r.caminho); }),
      };
      const r = await fn(tx);
      if ([...lidas].some(([c, v]) => (versoes.get(c) ?? 0) !== v)) continue; // conflito: refaz
      escritas.forEach((e) => e());
      return r;
      }
      throw new Error('transação: conflitos demais');
    },
  };
}

const tokenDoc = (n, uid, extra = {}) => ({ [`pushTokens/${P.tokenDocId(TOKEN(n))}`]: { uid, token: TOKEN(n), updatedAt: AGORA - 1000, ...extra } });
const cenario = () => banco({
  'users/ana': { location: { city: 'Palmas', state: 'TO', cityId: 'palmas_to' } },
  'users/bia': { location: { city: 'Palmas', state: 'Tocantins', cityId: 'palmas_to' } },
  'users/caio': { location: { city: 'Gurupi', state: 'TO', cityId: 'gurupi_to' } },
  'users/duda': { location: { city: 'Goiânia', state: 'GO', cityId: 'goiania_go' } },
  'users/eva': { status: 'suspended', location: { city: 'Palmas', state: 'TO', cityId: 'palmas_to' } },
  'users/fabi': {},
  ...tokenDoc(1, 'ana'), ...tokenDoc(2, 'ana'), ...tokenDoc(3, 'caio'), ...tokenDoc(4, 'duda'), ...tokenDoc(5, 'eva'), ...tokenDoc(6, 'fabi'),
});
/** Transporte falso: `regra(token)` decide o resultado de cada aparelho. Guarda tudo o que foi enviado. */
const transporte = (regra = () => ({ ok: true })) => {
  const enviados = [];
  const send = async (msgs) => msgs.map((m, i) => {
    enviados.push(m.to);
    const r = regra(m.to) ?? {};
    return { token: m.to, invalid: false, ok: false, ...r, ...(r.ok ? { ticketId: `tk-${i}-${enviados.length}` } : {}) };
  });
  return { enviados, send };
};
const relogio = (inicio = AGORA) => { let t = inicio; const f = () => t; f.passar = (ms) => { t += ms; }; return f; };
const criarEAvancar = async (db, id, alvo, msg, op) => { await N.criarCampanha(db, 'admin', id, alvo, msg, op.agora()); return N.avancar(db, id, op); };
const ID = (n) => `envio-0000000000${String(n).padStart(2, '0')}`;

test('locais: agrupa por cidade, conta só contas ativas e separa quem não tem cidade', async () => {
  const r = await N.lerLocais(cenario(), false, AGORA);
  assert.deepEqual(r.locais, [
    { cityId: 'goiania_go', cidade: 'Goiânia', uf: 'GO', usuarios: 1 },
    { cityId: 'gurupi_to', cidade: 'Gurupi', uf: 'TO', usuarios: 1 },
    { cityId: 'palmas_to', cidade: 'Palmas', uf: 'TO', usuarios: 2 },
  ]);
  assert.equal(r.semCidade, 1);
  assert.equal(r.total, 5);
});

test('locais: cópia por 24 h; "Atualizar" no máximo a cada 10 min; uma reconstrução por vez (NG-06)', async () => {
  const db = cenario();
  await N.lerLocais(db, false, AGORA);
  db.dados.set('users/gil', { location: { city: 'Palmas', cityId: 'palmas_to' } });
  const palmas = (r) => r.locais.find((l) => l.cityId === 'palmas_to').usuarios;
  assert.equal(palmas(await N.lerLocais(db, false, AGORA + 3600_000)), 2);
  assert.equal(palmas(await N.lerLocais(db, true, AGORA + 5 * 60_000)), 2);
  // Outra chamada já está reconstruindo: devolve a cópia anterior marcada, sem ler os perfis de novo.
  db.dados.set('adminCache/locaisUsuarios', { ...db.dados.get('adminCache/locaisUsuarios'), reconstruindoAte: AGORA + 12 * 60_000 });
  const antes = db.leituras.users;
  const ocupado = await N.lerLocais(db, true, AGORA + 11 * 60_000);
  assert.equal(ocupado.atualizando, true);
  assert.equal(db.leituras.users, antes);
  assert.equal(palmas(await N.lerLocais(db, true, AGORA + 13 * 60_000)), 3);
  // Sem cópia e com reconstrução em andamento: pede para tentar de novo.
  const vazio = banco({ 'adminCache/locaisUsuarios': { reconstruindoAte: AGORA + 60_000 } });
  await assert.rejects(N.lerLocais(vazio, false, AGORA), /sendo montada/);
});

test('validação: título, texto e alvo', () => {
  assert.deepEqual(N.parseMensagem({ titulo: '  Oi  ', texto: 'a   b' }), { titulo: 'Oi', texto: 'a b' });
  assert.equal(N.parseMensagem({ titulo: '', texto: 'x' }), null);
  assert.equal(N.parseMensagem({ titulo: 'x'.repeat(61), texto: 'x' }), null);
  assert.equal(N.parseMensagem({ titulo: 'x', texto: 'x'.repeat(181) }), null);
  assert.deepEqual(N.parseAlvo({ tipo: 'estado', uf: 'TO' }), { tipo: 'estado', uf: 'TO' });
  assert.deepEqual(N.parseAlvo({ tipo: 'cidade', cityId: 'sao_paulo_sp' }), { tipo: 'cidade', cityId: 'sao_paulo_sp' });
  for (const a of [null, { tipo: 'estado', uf: 'XX' }, { tipo: 'cidade', cityId: 'palmas' }, { tipo: 'cidade', cityId: 'palmas_xx' }, { tipo: 'cidade', cityId: '../x_to' }]) {
    assert.equal(N.parseAlvo(a), null, JSON.stringify(a));
  }
});

test('cidade: só os aparelhos daquela cidade (sem suspensos); recibos gravados junto com o lote (NG-08)', async () => {
  const db = cenario();
  const t = transporte();
  const r = await criarEAvancar(db, ID(1), { tipo: 'cidade', cityId: 'palmas_to' }, MSG, { agora: relogio(), send: t.send });
  assert.deepEqual(t.enviados.sort(), [TOKEN(1), TOKEN(2)]);
  assert.equal(r.fase, 'concluido');
  assert.equal(r.resultado, 'enviado');
  assert.deepEqual([r.usuarios, r.dispositivos, r.aceitos, r.falhas, r.incertos, r.pendentes], [2, 2, 2, 0, 0, 0]);
  const recibos = [...db.dados.keys()].filter((k) => k.startsWith('pushRecibos/'));
  assert.deepEqual(recibos, [`pushRecibos/geral_${ID(1)}_000000_00_0`]);
  assert.equal(Object.keys(db.dados.get(recibos[0]).tickets).length, 2);
  // Concluída: os lotes (com as cópias dos tokens) foram apagados; ficam os totais.
  assert.equal([...db.dados.keys()].some((k) => k.includes(`${ID(1)}/lotes/`)), false);
  assert.equal(db.dados.get(`notificacoesGerais/${ID(1)}`).lotesApagados, true);
});

test('estado: usa os perfis atuais, não a lista guardada — cidade nova entra (NG-04)', async () => {
  const db = cenario();
  await N.lerLocais(db, false, AGORA); // a lista guardada conhece Palmas e Gurupi
  db.dados.set('users/novo', { location: { city: 'Araguaína', cityId: 'araguaina_to' } });
  for (const [k, v] of Object.entries(tokenDoc(7, 'novo'))) db.dados.set(k, v);
  const t = transporte();
  await criarEAvancar(db, ID(2), { tipo: 'estado', uf: 'TO' }, MSG, { agora: relogio(), send: t.send });
  assert.deepEqual(t.enviados.sort(), [TOKEN(1), TOKEN(2), TOKEN(3), TOKEN(7)]);
});

test('todos: ativos com aparelho; quem não tem cidade também recebe', async () => {
  const t = transporte();
  const r = await criarEAvancar(cenario(), ID(3), { tipo: 'todos' }, MSG, { agora: relogio(), send: t.send });
  assert.deepEqual(t.enviados.sort(), [TOKEN(1), TOKEN(2), TOKEN(3), TOKEN(4), TOKEN(6)]);
  assert.equal(r.usuarios, 5);
});

test('falha transitória: repete só o aparelho que falhou, depois da espera; o aceito não é reenviado (NG-01)', async () => {
  const db = cenario();
  const agora = relogio();
  let falhar = true;
  const t = transporte((tok) => (tok === TOKEN(2) && falhar ? { ok: false, retryable: true, error: 'http-503' } : { ok: true }));
  let r = await criarEAvancar(db, ID(4), { tipo: 'cidade', cityId: 'palmas_to' }, MSG, { agora, send: t.send });
  assert.equal(r.fase, 'enviando');
  assert.deepEqual([r.aceitos, r.pendentes], [1, 1]);
  await N.avancar(db, ID(4), { agora, send: t.send }); // ainda na espera: não envia
  assert.equal(t.enviados.length, 2);
  agora.passar(31_000);
  falhar = false;
  r = await N.avancar(db, ID(4), { agora, send: t.send });
  assert.deepEqual(t.enviados.slice(2), [TOKEN(2)]);
  assert.equal(r.resultado, 'enviado');
  assert.deepEqual([r.aceitos, r.falhas, r.pendentes], [2, 0, 0]);
});

test('falha transitória persistente: após 3 tentativas vira falha; resultado parcial', async () => {
  const db = cenario();
  const agora = relogio();
  const t = transporte((tok) => (tok === TOKEN(2) ? { ok: false, retryable: true, error: 'http-503' } : { ok: true }));
  await criarEAvancar(db, ID(5), { tipo: 'cidade', cityId: 'palmas_to' }, MSG, { agora, send: t.send });
  let r;
  for (let i = 0; i < 3; i++) { agora.passar(5 * 60_000); r = await N.avancar(db, ID(5), { agora, send: t.send }); }
  assert.equal(t.enviados.filter((x) => x === TOKEN(2)).length, 3);
  assert.equal(r.resultado, 'parcial');
  assert.deepEqual([r.aceitos, r.falhas], [1, 1]);
});

test('resultado incerto fica incerto e não é reenviado (NG-02)', async () => {
  const db = cenario();
  const agora = relogio();
  const t = transporte(() => ({ ok: false, uncertain: true, error: 'rede' }));
  const r = await criarEAvancar(db, ID(6), { tipo: 'cidade', cityId: 'palmas_to' }, MSG, { agora, send: t.send });
  assert.equal(r.resultado, 'incerto');
  assert.deepEqual([r.aceitos, r.incertos], [0, 2]);
  agora.passar(3600_000);
  await N.avancar(db, ID(6), { agora, send: t.send });
  assert.equal(t.enviados.length, 2);
});

test('chamada que morreu no meio do envio: o lote vira incerto, sem reenvio (NG-03)', async () => {
  const db = cenario();
  const agora = relogio();
  const t = transporte();
  await N.criarCampanha(db, 'admin', ID(7), { tipo: 'cidade', cityId: 'palmas_to' }, MSG, agora());
  // Prazo curto: prepara, mas não sobra tempo para enviar.
  await N.avancar(db, ID(7), { agora, send: t.send, prazoAte: Date.now() + 5_000 });
  assert.equal(t.enviados.length, 0);
  const lote = [...db.dados.keys()].find((k) => k.includes(`${ID(7)}/lotes/`));
  db.dados.set(lote, { ...db.dados.get(lote), estado: 'enviando', owner: 'outra', leaseUntil: agora() + 60_000 });
  agora.passar(61_000);
  const r = await N.avancar(db, ID(7), { agora, send: t.send });
  assert.equal(t.enviados.length, 0);
  assert.equal(r.resultado, 'incerto');
  assert.equal(r.incertos, 2);
});

test('preparação reservada por uma chamada que morreu: continua depois do lease, em páginas, sem duplicar (NG-03/NG-06)', async () => {
  const docs = {};
  for (let i = 0; i < 650; i++) { const uid = `u${String(i).padStart(4, '0')}`; docs[`users/${uid}`] = { location: { cityId: 'palmas_to' } }; Object.assign(docs, tokenDoc(1000 + i, uid)); }
  const db = banco(docs);
  const agora = relogio();
  await N.criarCampanha(db, 'admin', ID(8), { tipo: 'todos' }, MSG, agora());
  db.dados.set(`notificacoesGerais/${ID(8)}`, { ...db.dados.get(`notificacoesGerais/${ID(8)}`), owner: 'morta', leaseUntil: agora() + 60_000 });
  let r = await N.avancar(db, ID(8), { agora, send: transporte().send });
  assert.equal(r.fase, 'preparando'); // reservada por outra: nada feito
  agora.passar(61_000);
  const t = transporte();
  r = await N.avancar(db, ID(8), { agora, send: t.send });
  assert.equal(r.dispositivos, 650);
  assert.equal(t.enviados.length, 650);
  assert.equal(new Set(t.enviados).size, 650);
  assert.equal(r.resultado, 'enviado');
});

test('acima do teto de aparelhos: termina antes de enviar qualquer coisa', async () => {
  const docs = {};
  for (let i = 0; i < 2501; i++) { const uid = `v${String(i).padStart(5, '0')}`; docs[`users/${uid}`] = {}; Object.assign(docs, tokenDoc(10000 + 2 * i, uid), tokenDoc(10001 + 2 * i, uid)); }
  const t = transporte();
  const r = await criarEAvancar(banco(docs), ID(9), { tipo: 'todos' }, MSG, { agora: relogio(), send: t.send });
  assert.equal(r.resultado, 'excedeu-limite');
  assert.equal(t.enviados.length, 0);
});

test('mesmo id: mesmo conteúdo retoma; conteúdo diferente é recusado com 409 (NG-07)', async () => {
  const db = cenario();
  const t = transporte();
  await criarEAvancar(db, ID(10), { tipo: 'todos' }, MSG, { agora: relogio(), send: t.send });
  assert.deepEqual(await N.criarCampanha(db, 'admin', ID(10), { tipo: 'todos' }, { ...MSG }, AGORA), { repetido: true });
  await assert.rejects(N.criarCampanha(db, 'admin', ID(10), { tipo: 'todos' }, { ...MSG, texto: 'outro' }, AGORA), (e) => e.status === 409);
  await assert.rejects(N.criarCampanha(db, 'admin', ID(10), { tipo: 'estado', uf: 'TO' }, MSG, AGORA), (e) => e.status === 409);
  await N.avancar(db, ID(10), { agora: relogio(), send: t.send });
  assert.equal(t.enviados.length, 5);
});

test('aparelho que não existe mais: token apagado; cadastro renovado depois do envio é mantido (NG-11)', async () => {
  const db = cenario();
  const ids = (n) => `pushTokens/${P.tokenDocId(TOKEN(n))}`;
  const send = async (msgs) => {
    // TOKEN(3) é registrado de novo enquanto o envio está em andamento.
    db.dados.set(ids(3), { ...db.dados.get(ids(3)), updatedAt: AGORA + 60_000 });
    return msgs.map((m) => ({ token: m.to, ok: false, invalid: true, error: 'DeviceNotRegistered' }));
  };
  await criarEAvancar(db, ID(11), { tipo: 'estado', uf: 'TO' }, MSG, { agora: () => AGORA, send });
  assert.equal(db.dados.has(ids(1)), false);
  assert.equal(db.dados.has(ids(2)), false);
  assert.equal(db.dados.has(ids(3)), true);
});

test('histórico: mais recentes primeiro, paginado, com a situação normalizada (NG-10)', async () => {
  const db = cenario();
  const t = transporte();
  await criarEAvancar(db, ID(12), { tipo: 'todos' }, MSG, { agora: () => AGORA, send: t.send });
  await criarEAvancar(db, ID(13), { tipo: 'cidade', cityId: 'palmas_to' }, { titulo: 'Segundo', texto: 'x' }, { agora: () => AGORA + 1000, send: t.send });
  db.dados.set('notificacoesGerais/antigo-0000000000001', { titulo: 'Antigo', estado: 'enviando', criadoEm: AGORA - 1000, alvo: { rotulo: 'Todos os usuários' }, dispositivos: 3 });
  const h = await N.historico(db);
  assert.deepEqual(h.envios.map((e) => [e.titulo, e.alvo, e.resultado]), [['Segundo', 'Cidade: palmas_to', 'enviado'], ['Novidade', 'Todos os usuários', 'enviado'], ['Antigo', 'Todos os usuários', 'incerto']]);
  assert.equal(h.mais, false);
  assert.deepEqual((await N.historico(db, AGORA)).envios.map((e) => e.titulo), ['Antigo']);
});

test('transporte: no máximo 6 conexões simultâneas, resultados na ordem (NG-05)', async () => {
  let ativas = 0, pico = 0;
  const fetchImpl = async (_u, init) => {
    ativas++; pico = Math.max(pico, ativas);
    await new Promise((r) => setTimeout(r, 5));
    ativas--;
    const lote = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: lote.map(() => ({ status: 'ok', id: 'abc' })) }) };
  };
  const msgs = Array.from({ length: 5000 }, (_, i) => ({ to: `ExponentPushToken[t${String(i).padStart(10, '0')}]` }));
  const r = await P.sendExpoPush(msgs, { fetchImpl });
  assert.equal(pico, P.EXPO_CONEXOES_MAX);
  assert.equal(r.length, 5000);
  assert.equal(r[4999].token, msgs[4999].to);
});
