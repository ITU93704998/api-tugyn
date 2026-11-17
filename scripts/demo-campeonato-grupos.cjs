/**
 * Campeonato de TESTE (grupos + mata-mata, 8 times, já em andamento) organizado pela conta de um e-mail, para ver as
 * telas desse formato. Também apaga o campeonato de teste depois (`--apagar`).
 *
 * Como funciona: roda o fluxo REAL do servidor (criar, inscrever, aprovar, iniciar, marcar jogos e lançar resultados,
 * com as mesmas funções da API) num banco em memória e só depois grava o resultado no Firestore. Assim os dados ficam
 * exatamente como os de um campeonato de verdade e nenhum aviso (push) é enviado a ninguém.
 *
 * O que é gravado no Firestore: SÓ `campeonatosTimes/{id}` (com as subcoleções) e o contador de campeonatos ativos do
 * organizador (`controleCampeonatosTimes/{uid}`, +1; volta ao apagar). Os 8 times e os atletas são fictícios e existem
 * só dentro do campeonato: nenhum perfil nem time falso é criado (tocar num atleta ou abrir o time fora do campeonato
 * mostra que não existe). O campeonato fica marcado com `dadosDeTeste: true`.
 * Lido do Firestore: só o perfil do organizador (a cidade dele vira a cidade do campeonato) e o contador acima.
 *
 * Uso (a credencial fica FORA do OneDrive e do git; o script não a lê nem a copia):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\caminho\fora-do-onedrive\chave.json"
 *   node scripts/demo-campeonato-grupos.cjs --projeto=<id-do-projeto> --email=<email-do-organizador>              (só simula e mostra)
 *   node scripts/demo-campeonato-grupos.cjs --projeto=<id-do-projeto> --email=<email-do-organizador> --confirmar  (grava)
 *   node scripts/demo-campeonato-grupos.cjs --projeto=<id-do-projeto> --email=<email-do-organizador> --apagar --confirmar
 *
 * Observações: o organizador precisa ter a cidade no perfil e ter menos de 3 campeonatos em andamento; o campeonato só
 * aparece no app se a região dele tiver os campeonatos entre times liberados. Ele fica em "Meus campeonatos" e no link
 * público, mas não no catálogo de inscrições abertas (já começou).
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");

const args = process.argv.slice(2);
const opcao = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || "").split("=").slice(1).join("=").trim();
const PROJETO = opcao("projeto"), EMAIL = opcao("email").toLowerCase();
const CONFIRMAR = args.includes("--confirmar"), APAGAR = args.includes("--apagar");
if (!/^[a-z0-9-]{4,40}$/.test(PROJETO) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL)) {
  console.error("Uso: node scripts/demo-campeonato-grupos.cjs --projeto=<id-do-projeto> --email=<email> [--apagar] [--confirmar]");
  process.exit(1);
}
const CHAVE_PEDIDO = "demo-grupos-mata-0001";
const idDoCampeonato = (uid) => `ct_${createHash("sha256").update(`${uid}:${CHAVE_PEDIDO}`).digest("hex").slice(0, 24)}`;

// ---------- Carrega os módulos TypeScript da API (o mesmo carregador dos testes) ----------
const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
const cacheMod = new Map();
function carregar(nome) {
  const f = path.join(root, "api/_lib", nome + ".ts");
  if (cacheMod.has(f)) return cacheMod.get(f).exports;
  const m = { exports: {} }; cacheMod.set(f, m);
  const req = createRequire(f);
  const local = (n) => n.startsWith(".") && fs.existsSync(path.resolve(path.dirname(f), n) + ".ts")
    ? carregar(path.relative(path.join(root, "api/_lib"), path.resolve(path.dirname(f), n)).replaceAll("\\", "/")) : req(n);
  const src = ts.transpileModule(fs.readFileSync(f, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext("(function(require,module,exports){" + src + "\n})", { filename: f })(local, m, m.exports);
  return m.exports;
}

// ---------- Banco em memória (mesmo comportamento do usado nos testes) ----------
const clone = (x) => structuredClone(x);
class Ref {
  constructor(db, p) { this.db = db; this.path = p; this.id = p.split("/").at(-1); }
  get parent() { return new Query(this.db, this.path.split("/").slice(0, -1).join("/")); }
  collection(n) { return new Query(this.db, this.path + "/" + n); }
  async get() { return this.db.snap(this.path); }
  async delete() { this.db.data.delete(this.path); }
  async set(v) { this.db.data.set(this.path, clone(v)); }
  async update(v) { const a = this.db.data.get(this.path); if (!a) throw Error("not-found"); this.db.data.set(this.path, { ...a, ...v }); }
}
class Query {
  constructor(db, p, filters = [], orders = [], lim = Infinity, cursor = null) { Object.assign(this, { db, path: p, filters, orders, lim, cursor }); }
  doc(n) { return new Ref(this.db, this.path + "/" + n); }
  get id() { return this.path.split("/").at(-1); }
  get parent() { const p = this.path.split("/"); return p.length > 1 ? new Ref(this.db, p.slice(0, -1).join("/")) : null; }
  where(k, op, v) { return new Query(this.db, this.path, [...this.filters, [k, op, v]], this.orders, this.lim, this.cursor); }
  orderBy(k, d = "asc") { return new Query(this.db, this.path, this.filters, [...this.orders, [typeof k === "string" ? k : "__name__", d]], this.lim, this.cursor); }
  limit(n) { return new Query(this.db, this.path, this.filters, this.orders, n, this.cursor); }
  startAfter(...v) { if (v.length === 1 && typeof v[0]?.get === "function") { const s = v[0]; v = [s.get(this.orders[0][0]), s.id]; } return new Query(this.db, this.path, this.filters, this.orders, this.lim, v); }
  async get() {
    const grupo = this.path.startsWith("**/") ? this.path.slice(3) : null;
    let all = [...this.db.data.keys()].filter((p) => grupo ? p.split("/").at(-2) === grupo && p.split("/").length % 2 === 0 : p.startsWith(this.path + "/") && p.split("/").length === this.path.split("/").length + 1).map((p) => this.db.snap(p));
    const campo = (s, k) => k.split(".").reduce((o, p) => o?.[p], s.data());
    all = all.filter((s) => this.filters.every(([k, op, v]) => op === "in" ? v.includes(campo(s, k)) : op === "==" ? s.get(k) === v : op === "array-contains" ? s.get(k)?.includes(v) : op === "<=" ? s.get(k) <= v : op === ">" ? s.get(k) > v : false));
    const cmp = (s, t) => { for (const [k, d] of this.orders) { const a = k === "__name__" ? s.id : s.get(k), b = k === "__name__" ? t.id : t.get(k); if (a !== b) return (a < b ? -1 : 1) * (d === "desc" ? -1 : 1); } return 0; };
    all.sort(cmp);
    if (this.cursor) { const fake = { id: this.cursor[1], get: () => this.cursor[0] }; all = all.filter((s) => cmp(s, fake) > 0); }
    const docs = all.slice(0, this.lim); return { docs, size: docs.length, empty: !docs.length };
  }
}
class MemDB {
  constructor(seed = {}) { this.data = new Map(Object.entries(clone(seed))); this.tail = Promise.resolve(); }
  doc(p) { return new Ref(this, p); }
  collection(p) { return new Query(this, p); }
  collectionGroup(n) { return new Query(this, "**/" + n); }
  batch() { const ops = []; return { set: (r, d) => ops.push(() => this.data.set(r.path, clone(d))), delete: (r) => ops.push(() => this.data.delete(r.path)), commit: async () => ops.forEach((f) => f()) }; }
  snap(p) { const v = this.data.get(p); return { id: p.split("/").at(-1), ref: this.doc(p), exists: v !== undefined, data: () => v === undefined ? undefined : clone(v), get: (k) => v?.[k] }; }
  async runTransaction(fn) {
    const prior = this.tail; let release; this.tail = new Promise((r) => (release = r)); await prior;
    const writes = []; let escreveu = false;
    const read = async (r) => { if (escreveu) throw Error("leitura depois de escrita"); return r.get(); };
    const tx = { get: read, getAll: async (...refs) => Promise.all(refs.filter((r) => typeof r.get === "function").map(read)),
      create: (r, d) => { escreveu = true; writes.push(["create", r, d]); }, set: (r, d) => { escreveu = true; writes.push(["set", r, d]); },
      update: (r, d) => { escreveu = true; writes.push(["update", r, d]); }, delete: (r) => { escreveu = true; writes.push(["delete", r]); } };
    try {
      const result = await fn(tx);
      for (const [op, r, d] of writes) { if (op === "delete") this.data.delete(r.path); else this.data.set(r.path, clone(op === "update" ? { ...this.data.get(r.path), ...d } : d)); }
      return result;
    } finally { release(); }
  }
}

// ---------- Elencos fictícios ----------
const TIMES = [
  ["Furacão da Vila", "#E53935"], ["Leões do Norte", "#FB8C00"], ["Unidos do Bairro", "#1E88E5"], ["Real Várzea", "#43A047"],
  ["Tsunami FC", "#00ACC1"], ["Atlético Esperança", "#8E24AA"], ["Amigos da Bola", "#FDD835"], ["Estrela do Sul", "#3949AB"],
];
const NOMES = ["Lucas", "Gabriel", "Matheus", "Rafael", "Pedro", "Bruno", "Felipe", "Thiago", "Diego", "André", "Caio", "Vinícius", "Igor", "Renan", "Danilo", "Leandro", "Márcio", "Fábio", "Júlio", "Rodrigo", "Eduardo", "Samuel", "Henrique", "Murilo", "Otávio", "Wesley", "Alan", "Jefferson", "Kauã", "Davi", "Nathan", "Ruan", "Everton", "Paulo", "Sérgio", "Tiago", "Luan", "Erick", "Marcos", "Ícaro", "Hugo", "Willian", "Artur", "Enzo", "Joaquim", "Breno", "Cauã", "Yuri", "Douglas", "Robson", "Cristiano", "Anderson", "Fernando", "Gustavo", "Maurício", "Ronaldo"];
const SOBRENOMES = ["Silva", "Souza", "Oliveira", "Santos", "Pereira", "Costa", "Rodrigues", "Almeida", "Nascimento", "Lima", "Araújo", "Fernandes", "Carvalho", "Gomes", "Martins", "Rocha", "Ribeiro", "Barros", "Freitas", "Moura"];
const POSICOES = ["goleiro", "fixo", "ala", "ala", "pivo", "ala", "fixo"];
let semente = 20261117;
const aleatorio = () => ((semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648);
const sortear = (lista) => lista[Math.floor(aleatorio() * lista.length)];

(async () => {
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore } = require("firebase-admin/firestore");
  initializeApp({ credential: applicationDefault(), projectId: PROJETO });
  const fdb = getFirestore();
  const usuario = await getAuth().getUserByEmail(EMAIL);
  const uid = usuario.uid, id = idDoCampeonato(uid);
  const refCamp = fdb.doc(`campeonatosTimes/${id}`), refCota = fdb.doc(`controleCampeonatosTimes/${uid}`);
  console.log(`Projeto: ${PROJETO}\nOrganizador: ${EMAIL} (${uid})\nCampeonato de teste: ${id}`);

  if (APAGAR) {
    const s = await refCamp.get();
    if (!s.exists) { console.log("Não há campeonato de teste para apagar."); return; }
    if (s.get("dadosDeTeste") !== true || s.get("organizadorId") !== uid) throw new Error("Esse campeonato não foi criado por este script. Nada foi apagado.");
    const ativo = s.get("status") === "inscricoes" || s.get("status") === "em_andamento";
    if (!CONFIRMAR) { console.log("Simulação: o campeonato seria apagado" + (ativo ? " e o contador de ativos diminuiria 1." : ".") + " Rode de novo com --confirmar."); return; }
    await fdb.recursiveDelete(refCamp);
    if (ativo) await fdb.runTransaction(async (tx) => { const c = await tx.get(refCota); tx.set(refCota, { ativos: Math.max(0, Number(c.get("ativos") ?? 1) - 1) }, { merge: true }); });
    console.log("Campeonato de teste apagado.");
    return;
  }

  const [perfilOrg, cotaOrg, jaExiste] = await Promise.all([fdb.doc(`users/${uid}`).get(), refCota.get(), refCamp.get()]);
  if (jaExiste.exists) throw new Error("O campeonato de teste já existe. Para recriar, apague antes com --apagar --confirmar.");
  if (!perfilOrg.exists) throw new Error(`O perfil users/${uid} não existe.`);
  const perfil = perfilOrg.data();

  // Banco em memória com o organizador real e os times/atletas fictícios (na cidade do organizador).
  const seed = { [`users/${uid}`]: perfil };
  if (cotaOrg.exists) seed[`controleCampeonatosTimes/${uid}`] = cotaOrg.data();
  const local = { location: perfil.location ?? null, cityId: perfil.cityId ?? null, city: perfil.city ?? null, state: perfil.state ?? null };
  const usados = new Set();
  const nomeNovo = () => { for (;;) { const n = `${sortear(NOMES)} ${sortear(SOBRENOMES)}`; if (!usados.has(n)) { usados.add(n); return n; } } };
  const elencos = TIMES.map(([nome, cor], t) => {
    const ids = POSICOES.map((_, k) => `demo${t}x${k}`);
    const nomes = ids.map(() => nomeNovo());
    ids.forEach((pid, k) => { seed[`users/${pid}`] = { name: nomes[k], status: "active", ...local }; });
    seed[`times/demo${t}x0_1`] = { donoId: ids[0], nome, cor, modalidade: "futsal", genero: "masculino", faixaEtaria: "livre", membros: ids,
      jogadores: Object.fromEntries(ids.map((pid, k) => [pid, { nome: nomes[k] }])),
      camisas: Object.fromEntries(ids.map((pid, k) => [pid, { numero: k === 0 ? 1 : k * 2 + 3, posicao: POSICOES[k] }])) };
    return { timeId: `demo${t}x0_1`, dono: ids[0], ids, nomes };
  });
  const db = new MemDB(seed);
  const S = carregar("campeonatosTimesServico");
  carregar("campeonatosTimesPremium").PREMIUM_CT.gruposParaTodos = true; // não gasta crédito na simulação

  const DIA = 86_400_000, agora = Date.now(), inicio = agora - 12 * DIA;
  const corpo = { chavePedido: CHAVE_PEDIDO, nome: "Copa Teste Tugyn", descricao: "Campeonato de teste para conferir as telas do formato grupos + mata-mata.",
    modalidade: "futsal", formato: "grupos_mata", maxTimes: 8, inscricoesAte: inicio + 5 * DIA, dataInicio: inicio + 7 * DIA,
    locais: [{ nome: "Arena Central", endereco: "Rua das Quadras, 100" }, { nome: "Ginásio do Bairro", endereco: "Av. Principal, 2000" }],
    inscricaoCentavos: 15000, premiacao: { valorCentavos: 100000, trofeus: true, medalhas: true, texto: "Troféu e medalhas para o campeão e o vice." },
    regrasTexto: "Dois tempos de 20 minutos. Dois melhores de cada grupo vão para a semifinal. Empate no mata-mata vai para os pênaltis.",
    genero: "masculino", faixaEtaria: "livre", minJogadores: 5, maxJogadores: 12, requisitos: { linha: 4, goleiros: 1 }, sorteio: "automatico" };
  const r = await S.criarCT(db, uid, corpo, true, inicio);
  if (r.campeonatoId !== id) throw new Error("Identificador inesperado.");

  // Inscrições e aprovações (dias 1 a 4), pagamento marcado na maioria.
  for (const [k, e] of elencos.entries()) {
    const quando = inicio + DIA + k * 10 * 3_600_000;
    await S.inscreverCT(db, e.dono, { campeonatoId: id, timeId: e.timeId, jogadorIds: e.ids }, quando);
    await S.responderCT(db, uid, { campeonatoId: id, timeId: e.timeId, jogadorIds: e.ids, aceitar: true }, quando + 3_600_000);
    if (k < 6) await S.administrarCT(db, uid, { acao: "marcarPagamento", campeonatoId: id, timeId: e.timeId, pago: true }, quando + 7_200_000);
  }
  await S.iniciarCT(db, uid, { campeonatoId: id }, inicio + 7 * DIA);

  // Resultados: grupo A completo; grupo B com 4 dos 6 jogos. Os 2 restantes ficam marcados para os próximos dias.
  const det = await S.lerDetalheCT(db, uid, { campeonatoId: id });
  const porGrupo = (g) => det.jogos.filter((j) => j.grupo === g);
  const grupos = [...new Set(det.jogos.map((j) => j.grupo).filter(Boolean))].sort();
  const elencoDe = (tid) => elencos.find((e) => e.timeId === tid);
  const distribuir = (tid, n) => { const linha = elencoDe(tid).ids.slice(1), m = {}; for (let i = 0; i < n; i++) { const p = sortear(linha); m[p] = (m[p] ?? 0) + 1; } return m; };
  let quandoJogo = inicio + 7 * DIA + 19 * 3_600_000, lancados = 0;
  const lancar = async (j) => {
    const atual = (await S.lerDetalheCT(db, uid, { campeonatoId: id })).jogos.find((x) => x.id === j.id);
    const golsCasa = Math.floor(aleatorio() * 5), golsFora = Math.floor(aleatorio() * 4);
    const gols = { ...distribuir(atual.casa, golsCasa), ...distribuir(atual.fora, golsFora) };
    const assist = { ...distribuir(atual.casa, Math.max(0, golsCasa - 1)), ...distribuir(atual.fora, Math.max(0, golsFora - 1)) };
    const amarelos = aleatorio() < 0.5 ? { [sortear(elencoDe(atual.casa).ids.slice(1))]: 1 } : {};
    await S.administrarCT(db, uid, { acao: "agendarJogo", campeonatoId: id, jogoId: j.id, quando: quandoJogo, local: lancados % 2 ? "Ginásio do Bairro" : "Arena Central" }, quandoJogo - DIA / 2);
    await S.resultadoCT(db, uid, { campeonatoId: id, jogoId: j.id, casaEsperada: atual.casa, foraEsperada: atual.fora, versaoEsperada: atual.versao ?? 0, golsCasa, golsFora, gols, assistencias: assist, amarelos }, quandoJogo + 2 * 3_600_000);
    lancados++; quandoJogo += lancados % 2 ? 3_600_000 : DIA - 3_600_000;
  };
  for (const j of porGrupo(grupos[0])) await lancar(j);
  const jogosB = porGrupo(grupos[1]);
  for (const j of jogosB.slice(0, 4)) await lancar(j);
  for (const [k, j] of jogosB.slice(4).entries())
    await S.administrarCT(db, uid, { acao: "agendarJogo", campeonatoId: id, jogoId: j.id, quando: agora + (k + 1) * DIA + 19 * 3_600_000, local: "Arena Central" }, agora);

  // O que vai para o Firestore: só o campeonato (com subcoleções) e o contador do organizador.
  const prefixo = `campeonatosTimes/${id}`, cota = `controleCampeonatosTimes/${uid}`;
  const gravar = [...db.data.entries()].filter(([p]) => p === prefixo || p.startsWith(prefixo + "/") || p === cota);
  const ignorados = [...new Set([...db.data.keys()].filter((p) => !(p in seed) && !gravar.some(([g]) => g === p)).map((p) => p.split("/")[0]))];
  const raizDoc = db.data.get(prefixo);
  raizDoc.dadosDeTeste = true;
  const fin = (await S.lerDetalheCT(db, uid, { campeonatoId: id }));
  console.log(`\nSimulação pronta: ${fin.campeonato.nome}, ${fin.campeonato.status}, ${fin.jogos.filter((j) => j.status === "finalizado").length} de ${fin.jogos.length} jogos com resultado, 2 marcados para os próximos dias.`);
  console.log(`Documentos a gravar: ${gravar.length} (campeonato e subcoleções + contador de ativos).`);
  if (ignorados.length) console.log(`Não gravados (só existiam na simulação): ${ignorados.join(", ")}`);
  if (!CONFIRMAR) { console.log("\nNada foi gravado. Rode de novo com --confirmar para gravar."); return; }

  // Grava: primeiro as subcoleções, por último a raiz e o contador (o campeonato só aparece completo).
  const ordem = [...gravar.filter(([p]) => p !== prefixo && p !== cota), ...gravar.filter(([p]) => p === prefixo || p === cota)];
  for (let i = 0; i < ordem.length; i += 400) {
    const lote = fdb.batch();
    for (const [p, v] of ordem.slice(i, i + 400)) lote.set(fdb.doc(p), v);
    await lote.commit();
  }
  console.log(`\nGravado. Abra o app com a conta ${EMAIL}: Torneios › Entre times › Meus campeonatos › "Copa Teste Tugyn".`);
  console.log("Para apagar depois: o mesmo comando com --apagar --confirmar.");
})().catch((e) => { console.error("Falhou:", e?.message ?? e); process.exit(1); });
