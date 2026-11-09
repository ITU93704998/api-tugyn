// Departamento médico por grupo (api/_lib/departamentoMedico.ts): só membros consultam, e só aparece quem AINDA é membro e
// AINDA está no DM. Firestore falso em memória.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (m, p) =>
  m._compile(ts.transpileModule(fs.readFileSync(p, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p);
const dm = require("../api/_lib/departamentoMedico.ts");

const AGORA = Date.UTC(2026, 10, 9, 15);
const tsDe = (ms) => ({ toMillis: () => ms });

function fakeDb(docs) {
  const consultas = [];
  const apagados = [];
  const snap = (path) => ({
    id: path.split("/").pop(),
    exists: path in docs,
    data: () => docs[path],
    updateTime: { v: 1 },
    ref: { delete: async (pre) => { apagados.push([path, pre]); delete docs[path]; } },
  });
  return {
    consultas,
    apagados,
    db: {
      doc: (path) => ({ get: async () => snap(path) }),
      collection: (c) => ({
        where: (campo, op, v) => {
          if (op === "in") {
            assert.ok(v.length <= 30, "no máximo 30 ids por consulta");
            return {
              get: async () => {
                consultas.push(v.length);
                return { docs: v.filter((id) => `${c}/${id}` in docs).map((id) => snap(`${c}/${id}`)) };
              },
            };
          }
          const doGrupo = Object.keys(docs).filter((k) => k.startsWith(c + "/") && k.split("/").length === 2);
          const bate = (k) => (op === "==" ? docs[k][campo] === v : Array.isArray(docs[k][campo]) && docs[k][campo].includes(v));
          return { limit: () => ({ get: async () => { consultas.push(op); return { docs: doGrupo.filter(bate).map(snap) }; } }) };
        },
      }),
    },
  };
}

const base = () => ({
  "turmas/T1": { creatorId: "org", participantes: ["org", "ana", "bia"] },
  "times/X1": { membros: ["bia", "ana"] },
  "departamentoMedico/ana": { retorno: null },
  "departamentoMedico/bia": { retorno: tsDe(AGORA + 86_400_000) },
  "departamentoMedico/ze": { retorno: null }, // não é do grupo
});

test("membro da turma vê quem está no DM, só entre os membros", async () => {
  const { db } = fakeDb(base());
  assert.deepEqual(await dm.lerDMDoGrupo(db, "bia", "turmas", "T1", AGORA), { ana: null, bia: AGORA + 86_400_000 });
  assert.deepEqual(await dm.lerDMDoGrupo(db, "org", "turmas", "T1", AGORA), { ana: null, bia: AGORA + 86_400_000 });
});

test("quem é de fora ou grupo inexistente: null (a rota responde 403)", async () => {
  const { db } = fakeDb(base());
  assert.equal(await dm.lerDMDoGrupo(db, "ze", "turmas", "T1", AGORA), null);
  assert.equal(await dm.lerDMDoGrupo(db, "ze", "times", "X1", AGORA), null);
  assert.equal(await dm.lerDMDoGrupo(db, "ana", "turmas", "NAO", AGORA), null);
  assert.equal(await dm.lerDMDoGrupo(db, "org", "times", "X1", AGORA), null, "organizador de turma não lê time");
});

test("ex-membro some na hora (sem cópia para limpar)", async () => {
  const docs = base();
  docs["turmas/T1"] = { creatorId: "org", participantes: ["org", "bia"] };
  docs["times/X1"] = { membros: ["bia"] };
  const { db } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoGrupo(db, "bia", "turmas", "T1", AGORA), { bia: AGORA + 86_400_000 });
  assert.deepEqual(await dm.lerDMDoGrupo(db, "bia", "times", "X1", AGORA), { bia: AGORA + 86_400_000 });
  assert.equal(await dm.lerDMDoGrupo(db, "ana", "times", "X1", AGORA), null, "quem saiu não lê mais");
});

test("saiu do DM (registro apagado em qualquer aparelho): some de todos os grupos", async () => {
  const docs = base();
  delete docs["departamentoMedico/ana"];
  const { db } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoGrupo(db, "bia", "turmas", "T1", AGORA), { bia: AGORA + 86_400_000 });
  assert.deepEqual(await dm.lerDMDoGrupo(db, "bia", "times", "X1", AGORA), { bia: AGORA + 86_400_000 });
});

test("volta prevista vencida não aparece e é apagada com condição de não ter mudado", async () => {
  const docs = base();
  docs["departamentoMedico/bia"] = { retorno: tsDe(AGORA - 1) };
  const { db, apagados } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoGrupo(db, "ana", "times", "X1", AGORA), { ana: null });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(apagados, [["departamentoMedico/bia", { lastUpdateTime: { v: 1 } }]]);
});

test("registro com formato inesperado não aparece", async () => {
  const docs = base();
  docs["departamentoMedico/ana"] = { retorno: "amanhã" };
  const { db } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoGrupo(db, "bia", "times", "X1", AGORA), { bia: AGORA + 86_400_000 });
});

test("turma grande: consultas em lotes de até 30 ids", async () => {
  const participantes = Array.from({ length: 65 }, (_, i) => `u${i}`);
  const docs = { "turmas/G": { creatorId: "u0", participantes }, "departamentoMedico/u64": { retorno: null } };
  const { db, consultas } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoGrupo(db, "u3", "turmas", "G", AGORA), { u64: null });
  assert.deepEqual(consultas, [30, 30, 5]);
});

test("ids inválidos na lista de membros são ignorados", () => {
  assert.deepEqual(dm.membrosVisiveis("times", { membros: ["a", "../x", 3, "b"] }, "a"), ["a", "b"]);
});

test("perfil: colega de turma ou de time vê o DM; quem é de fora recebe o mesmo que \"não está\"", async () => {
  const { db } = fakeDb(base());
  assert.deepEqual(await dm.lerDMDoPerfil(db, "bia", "ana", AGORA), { ana: null });
  assert.deepEqual(await dm.lerDMDoPerfil(db, "org", "ana", AGORA), { ana: null }, "organizador da turma");
  assert.deepEqual(await dm.lerDMDoPerfil(db, "ze", "ana", AGORA), {});
  assert.deepEqual(await dm.lerDMDoPerfil(db, "ze", "org", AGORA), {}, "não está no DM: mesma resposta");
});

test("perfil: sem DM não consulta grupos (1 leitura); vencido não aparece", async () => {
  const docs = base();
  const { db, consultas } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoPerfil(db, "bia", "org", AGORA), {});
  assert.equal(consultas.length, 0);
  docs["departamentoMedico/ana"] = { retorno: tsDe(AGORA - 1) };
  assert.deepEqual(await dm.lerDMDoPerfil(db, "bia", "ana", AGORA), {});
  assert.equal(consultas.length, 0);
});

test("perfil: ex-colega deixa de ver", async () => {
  const docs = base();
  docs["turmas/T1"] = { creatorId: "org", participantes: ["org", "ana"] };
  docs["times/X1"] = { membros: ["ana"] };
  const { db } = fakeDb(docs);
  assert.deepEqual(await dm.lerDMDoPerfil(db, "bia", "ana", AGORA), {});
  assert.deepEqual(await dm.lerDMDoPerfil(db, "org", "ana", AGORA), { ana: null });
});
