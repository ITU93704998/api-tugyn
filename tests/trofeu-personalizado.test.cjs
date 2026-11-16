// Troféu personalizado (campeonatos entre times): formato das peças, criação, premiação, galeria e modelos salvos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const antes = require.extensions['.ts'];
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, f);
const T = require('../api/_lib/desenhoTrofeu.ts');
const D = require('../api/_lib/campeonatosTimesDominio.ts');
const S = require('../api/_lib/campeonatosTimesServico.ts');
const { calcularTrofeusTimes } = require('../api/_lib/campeonatosTimesTrofeus.ts');
const { gerarJogosCT, registrarResultadoCT } = D;
if (antes) require.extensions['.ts'] = antes; else delete require.extensions['.ts'];

const OK = 'calice|asas|coroa|pedestal|pedra|ouro||escudo||17212F';

test('desenho: aceita só peças da lista; campos dependentes conferidos; saída canônica', () => {
  assert.equal(T.normalizarDesenhoTrofeu(OK), OK);
  assert.equal(T.normalizarDesenhoTrofeu('estrela|nenhuma|nada|baixa|metal|cor|fe7552|um||FFFFFF'), 'estrela|nenhuma|nada|baixa|metal|cor|FE7552|um||FFFFFF');
  assert.equal(T.normalizarDesenhoTrofeu('classica|curvas|nada|degraus|pedra|ouro||sigla|BRA|FFF4D6'), 'classica|curvas|nada|degraus|pedra|ouro||sigla|BRA|FFF4D6');
  for (const ruim of [
    'taca|asas|coroa|pedestal|pedra|ouro||escudo||17212F', // forma desconhecida
    'calice|asas|coroa|pedestal|pedra|ouro|FF0000|escudo||17212F', // cor sem metal "cor"
    'calice|asas|coroa|pedestal|pedra|cor||escudo||17212F', // metal "cor" sem cor
    'calice|asas|coroa|pedestal|pedra|ouro||sigla||17212F', // sigla vazia
    'calice|asas|coroa|pedestal|pedra|ouro||sigla|ABCD|17212F', // sigla longa
    'calice|asas|coroa|pedestal|pedra|ouro||escudo|X|17212F', // sigla sem emblema sigla
    'calice|asas|coroa|pedestal|pedra|ouro||escudo||123456', // cor de detalhe fora da lista
    'calice|asas|coroa|pedestal|pedra|ouro||escudo|', // peças faltando
    '<svg onload=alert(1)>', 42, null, 'a'.repeat(200),
  ]) assert.equal(T.normalizarDesenhoTrofeu(ruim), null, String(ruim).slice(0, 40));
});

test('modelos gravados: lista válida, ids únicos; modelo antigo sem id ganha id estável', () => {
  assert.deepEqual(T.modelosGravados([{ id: 'aaaaaaaaaaaa', nome: '  Minha   taça ', desenho: OK }]), [{ id: 'aaaaaaaaaaaa', nome: 'Minha taça', desenho: OK }]);
  const antigo = T.modelosGravados([{ nome: 'Velho', desenho: OK }]);
  assert.match(antigo[0].id, /^[a-f0-9]{12}$/);
  assert.equal(T.modelosGravados([{ nome: 'Velho', desenho: OK }])[0].id, antigo[0].id, 'mesmo id em toda leitura');
  assert.deepEqual(T.modelosGravados([{ id: 'aaaaaaaaaaaa', nome: 'a', desenho: OK }, { id: 'aaaaaaaaaaaa', nome: 'b', desenho: OK }, { nome: 'x'.repeat(31), desenho: OK }, { nome: 'ruim', desenho: 'x' }, 'lixo']).map((m) => m.nome), ['a']);
  assert.equal(T.modelosGravados(Array.from({ length: 15 }, (_, i) => ({ id: String(i).padStart(12, 'a'), nome: 'm' + i, desenho: OK }))).length, 10);
  assert.deepEqual(T.modelosGravados(undefined), []);
});

const NOW = 1_800_000_000_000;
const corpo = (extra = {}) => ({ chavePedido: 'pedido-00000001', nome: 'Copa Tugyn', descricao: '', modalidade: 'futsal', formato: 'triangular', maxTimes: 3, inscricoesAte: NOW + 86400000, dataInicio: null, locais: [{ nome: 'Arena' }], minJogadores: 1, maxJogadores: 5, ...extra });

test('criação: troféu opcional; sem troféu o pedido fica igual ao de antes; inválido recusa', () => {
  assert.equal(D.novoCT(corpo({ trofeu: OK }), NOW, true).trofeuDesenho, OK);
  assert.equal('trofeuDesenho' in D.novoCT(corpo(), NOW, true), false, 'app antigo: assinatura do pedido não muda');
  assert.throws(() => D.novoCT(corpo({ trofeu: 'calice|x' }), NOW, true), /troféu/i);
  const dto = S.detalheCT('ct_' + 'a'.repeat(24), { ...D.novoCT(corpo({ trofeu: OK }), NOW, true), status: 'inscricoes' });
  assert.equal(dto.trofeuDesenho, OK);
  assert.equal(S.detalheCT('ct_' + 'a'.repeat(24), { ...D.novoCT(corpo(), NOW, true), status: 'inscricoes' }).trofeuDesenho, null);
});

function encerrado(extra = {}) {
  const ins = Array.from({ length: 3 }, (_, i) => ({ timeId: `t${i}`, timeNome: `Time ${i}`, status: 'aprovada', cor: '#123456', jogadores: [{ id: `u${i}`, nome: `Atleta ${i}` }] }));
  const ordem = ins.map((i) => i.timeId), gerado = gerarJogosCT('triangular', ordem);
  const camp = { nome: 'Copa', formato: 'triangular', ordem, grupos: gerado.grupos, status: 'em_andamento', ...extra };
  let jogos = gerado.jogos;
  for (let k = 0; k < 20; k++) {
    const j = Object.values(jogos).find((j) => j.casa && j.fora && j.status !== 'finalizado'); if (!j) break;
    const uid = ins.find((i) => i.timeId === j.casa).jogadores[0].id;
    const r = registrarResultadoCT(camp, ins, jogos, j.id, { casaEsperada: j.casa, foraEsperada: j.fora, versaoEsperada: j.versao ?? 0, golsCasa: 1, golsFora: 0, gols: { [uid]: 1 }, assistencias: {} });
    jogos = r.jogos; camp.campeaoTimeId = r.campeaoTimeId;
  }
  camp.status = 'encerrado';
  return { camp, ins, jogos };
}

test('premiação: o desenho vai no troféu de cada atleta; campeonato sem desenho não ganha o campo', () => {
  const id = 'ct_' + 'b'.repeat(24);
  const com = encerrado({ trofeuDesenho: OK });
  const r = calcularTrofeusTimes(id, com.camp, com.ins, com.jogos);
  assert.ok(r.size > 0);
  for (const t of r.values()) assert.equal(t.desenho, OK);
  const sem = encerrado();
  for (const t of calcularTrofeusTimes(id, sem.camp, sem.ins, sem.jogos).values()) assert.equal('desenho' in t, false, 'troféus antigos não são regravados');
  const ruim = encerrado({ trofeuDesenho: 'adulterado' });
  for (const t of calcularTrofeusTimes(id, ruim.camp, ruim.ins, ruim.jogos).values()) assert.equal('desenho' in t, false);
});

/** Firestore falso com transações otimistas: grava só se o que foi lido não mudou (como o Firestore, que repete a transação). */
function bancoFalso(inicial) {
  const docs = new Map(Object.entries(inicial)), versao = new Map();
  const snap = (p) => ({ exists: docs.has(p), data: () => docs.get(p), get: (k) => docs.get(p)?.[k] });
  return {
    docs,
    doc: (p) => ({ path: p, get: async () => snap(p) }),
    async runTransaction(fn, { antesDeGravar } = {}) {
      for (let tentativa = 0; tentativa < 5; tentativa++) {
        const lidos = new Map(), escritas = [];
        const r = await fn({ get: async (ref) => { lidos.set(ref.path, versao.get(ref.path) ?? 0); return snap(ref.path); }, set: (ref, v) => escritas.push([ref.path, v]) });
        if (antesDeGravar) await antesDeGravar();
        if ([...lidos].some(([p, v]) => (versao.get(p) ?? 0) !== v)) continue; // alguém gravou no meio: repete
        for (const [p, v] of escritas) { docs.set(p, structuredClone(v)); versao.set(p, (versao.get(p) ?? 0) + 1); }
        return r;
      }
      throw new Error('conflito');
    },
  };
}
const MODELOS = 'users/u1/restrito/modelosTrofeu';
let seq = 0; const novoId = () => (++seq).toString(16).padStart(12, '0');

test('modelos: adicionar e remover um por vez, sobre a lista atual', async () => {
  const db = bancoFalso({ 'users/u1': { name: 'Ana' } });
  assert.deepEqual(await S.lerModelosTrofeuCT(db, 'u1'), { modelos: [] });
  const a = await S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: 'Copa', desenho: OK }, novoId);
  assert.equal(a.modelos.length, 1);
  const repetido = await S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: 'Copa', desenho: OK }, novoId);
  assert.equal(repetido.modelos.length, 1, 'toque duplo não duplica');
  const r = await S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'remover', id: a.modelos[0].id });
  assert.deepEqual(r.modelos, []);
  assert.deepEqual((await S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'remover', id: a.modelos[0].id })).modelos, [], 'id que já saiu: nada muda');
  await assert.rejects(S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: 'x', desenho: 'ruim' }), /troféu é inválido/);
  await assert.rejects(S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: '', desenho: OK }), /nome/);
  await assert.rejects(S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'trocarTudo', modelos: [] }), /Operação inválida/);
});

test('dois aparelhos salvando ao mesmo tempo: os dois modelos ficam (TP-01)', async () => {
  const db = bancoFalso({ 'users/u1': { name: 'Ana' }, [MODELOS]: { modelos: [{ id: 'aaaaaaaaaaaa', nome: 'Antigo', desenho: OK }] } });
  const rt = db.runTransaction.bind(db);
  // As duas transações leem a mesma lista antes de qualquer uma gravar.
  let liberar; const juntas = new Promise((r) => { liberar = r; }); let lidas = 0;
  db.runTransaction = (fn) => rt(fn, { antesDeGravar: async () => { if (++lidas === 2) liberar(); await juntas; } });
  const outro = 'calice|asas|coroa|pedestal|pedra|prata||escudo||17212F';
  await Promise.all([
    S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: 'Celular', desenho: OK }, novoId),
    S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: 'Tablet', desenho: outro }, novoId),
  ]);
  assert.deepEqual(db.docs.get(MODELOS).modelos.map((m) => m.nome).sort(), ['Antigo', 'Celular', 'Tablet']);
});

test('modelos: limite de 10 e conta indisponível não grava', async () => {
  const cheios = Array.from({ length: 10 }, (_, i) => ({ id: String(i).padStart(12, 'b'), nome: 'm' + i, desenho: OK }));
  const db = bancoFalso({ 'users/u1': { name: 'Ana' }, [MODELOS]: { modelos: cheios }, 'users/u2': { name: 'Bia', excluindoEm: 1 } });
  await assert.rejects(S.alterarModelosTrofeuCT(db, 'u1', { operacao: 'adicionar', nome: 'Novo', desenho: 'estrela|nenhuma|nada|baixa|metal|cor|FE7552|um||FFFFFF' }, novoId), /10 modelos/);
  await assert.rejects(S.alterarModelosTrofeuCT(db, 'u2', { operacao: 'adicionar', nome: 'x', desenho: OK }, novoId), /perfil não está disponível/);
});

test('o app usa exatamente as mesmas peças', () => {
  const app = path.resolve(root, '../../../../Documents/tugyn/src/shared/trofeu/desenhoTrofeu.ts');
  if (!fs.existsSync(app)) return; // fora da máquina de desenvolvimento
  const m = { exports: {} };
  new Function('module', 'exports', ts.transpileModule(fs.readFileSync(app, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(m, m.exports);
  assert.deepEqual(JSON.parse(JSON.stringify(m.exports.PECAS_TROFEU)), JSON.parse(JSON.stringify(T.PECAS_TROFEU)));
});
