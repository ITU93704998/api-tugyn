import { campeaoDe } from "./campeonato/classificacao";
import { REGRAS_PADRAO } from "./campeonato/tabela";
import { ID_CT, ID_PESSOA_CT, type Dados, type InscricaoCT, type JogoCT } from "./campeonatosTimesDominio";
import type { Trofeu } from "./trofeus";
import { normalizarDesenhoTrofeu } from "./desenhoTrofeu";

export type TrofeuTimes = Trofeu & { origem: "times" };
export const chaveTrofeuTimes = (id: string): string => `times:${id}`;

/** Só recebe o elenco APROVADO e congelado na inscrição, nunca o elenco atual do time.
 * Fontes são exclusivas da API/Admin. Reconfere campeão e estatísticas antes de premiar.
 * Empates positivos compartilham artilharia/assistências; pênaltis não entram na soma. */
export function calcularTrofeusTimes(id: string, camp: Dados | null, inscricoes: InscricaoCT[], jogos: Record<string, JogoCT>): Map<string, TrofeuTimes> {
  const vazio = () => new Map<string, TrofeuTimes>();
  if (!ID_CT.test(id) || camp?.status !== "encerrado") return vazio();
  const aprovadas = inscricoes.filter(i => i.status === "aprovada");
  if (aprovadas.length < 3 || aprovadas.length > 16 || !Object.keys(jogos).length) return vazio();
  const times = Object.fromEntries(aprovadas.map(i => [i.timeId, { nome: i.timeNome, cor: i.cor ?? "#FE7552", elenco: i.jogadores.map(j => ({ id: j.id, nome: j.nome })) }]));
  const atletas = new Map<string, { time: InscricaoCT; gols: number; assistencias: number }>();
  for (const i of aprovadas) {
    if (i.jogadores.length > 30) return vazio();
    for (const j of i.jogadores) {
      if (!ID_PESSOA_CT.test(j.id) || atletas.has(j.id)) return vazio();
      atletas.set(j.id, { time: i, gols: 0, assistencias: 0 });
    }
  }
  const placar = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99;
  for (const j of Object.values(jogos)) {
    if (j.status !== "finalizado" || !j.casa || !j.fora || j.casa === j.fora || !times[j.casa] || !times[j.fora] || !placar(j.golsCasa) || !placar(j.golsFora)) return vazio();
    for (const campo of ["gols", "assistencias"] as const) {
      const totais: Record<string, number> = { [j.casa]: 0, [j.fora]: 0 };
      for (const [uid, n] of Object.entries(j[campo] ?? {})) {
        const a = atletas.get(uid);
        if (!a || !(a.time.timeId in totais) || !placar(n)) return vazio();
        totais[a.time.timeId] += n;
        a[campo] += n;
      }
      if (totais[j.casa] > j.golsCasa || totais[j.fora] > j.golsFora) return vazio();
    }
  }
  if ((camp.formato === "mata" || camp.formato === "grupos_mata") && !jogos.final) return vazio();
  const campeao = campeaoDe({ times, jogos, sorteio: Array.isArray(camp.ordem) ? camp.ordem as string[] : [], regras: REGRAS_PADRAO });
  if (!campeao || campeao !== camp.campeaoTimeId || !times[campeao]) return vazio();
  const maxGols = Math.max(0, ...[...atletas.values()].map(a => a.gols));
  const maxAssist = Math.max(0, ...[...atletas.values()].map(a => a.assistencias));
  const resultado = vazio();
  const desenho = normalizarDesenhoTrofeu(camp.trofeuDesenho);
  for (const [uid, a] of atletas) {
    const titulos: Trofeu["titulos"] = [];
    if (a.time.timeId === campeao) titulos.push("campeao");
    if (maxGols > 0 && a.gols === maxGols) titulos.push("artilheiro");
    if (maxAssist > 0 && a.assistencias === maxAssist) titulos.push("garcom");
    if (!titulos.length) continue;
    resultado.set(uid, { origem: "times", turmaId: "", campeonatoId: id, modelo: "classica", campeonato: String(camp.nome || "Campeonato").slice(0, 60),
      turma: "Campeonato de times", time: a.time.timeNome.slice(0, 80), cor: /^#[0-9a-f]{6}$/i.test(a.time.cor ?? "") ? a.time.cor! : "#FE7552", titulos, gols: a.gols, assistencias: a.assistencias, ...(desenho ? { desenho } : {}) });
  }
  return resultado;
}
