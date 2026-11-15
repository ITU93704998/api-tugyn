export type RecursoRegional = "times" | "campeonatosTimes";
export type ModoRegional = "todos" | "selecionados" | "desligado";
export interface RegiaoRecurso { modo: ModoRegional; estados: string[]; cidades: string[] }
export interface RegioesTimes { times: RegiaoRecurso; campeonatosTimes: RegiaoRecurso }
export const UFS_REGIONAIS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const cidadeValida = (v: unknown): v is string => typeof v === "string" && v.length <= 120 && /^[a-z0-9]+(?:_[a-z0-9]+)*_[a-z]{2}$/.test(v) && UFS_REGIONAIS.includes(v.slice(-2).toUpperCase());
const unica = (v: unknown): unknown[] => Array.isArray(v) ? [...new Set(v)] : [];
export function normalizarRegioesTimes(v: unknown): RegioesTimes {
  const d = obj(v);
  const regiao = (r: unknown): RegiaoRecurso => {
    if (r === undefined) return { modo: "todos", estados: [], cidades: [] };
    const x = obj(r);
    return { modo: x.modo === "todos" || x.modo === "selecionados" ? x.modo : "desligado", estados: unica(x.estados).filter((s): s is string => typeof s === "string" && UFS_REGIONAIS.includes(s)).sort(), cidades: unica(x.cidades).filter(cidadeValida).slice(0, 200).sort() };
  };
  return { times: regiao(d.times), campeonatosTimes: regiao(d.campeonatosTimes) };
}
export function erroConfigRegioes(v: unknown): string | null {
  const d = obj(v);
  for (const nome of ["times", "campeonatosTimes"] as const) {
    const x = obj(d[nome]);
    if (!["todos", "selecionados", "desligado"].includes(String(x.modo)) || !Array.isArray(x.estados) || x.estados.length > 27 || x.estados.some(s => typeof s !== "string" || !UFS_REGIONAIS.includes(s)) || !Array.isArray(x.cidades) || x.cidades.length > 200 || x.cidades.some(s => !cidadeValida(s))) return "Informe um modo válido, UFs válidas e até 200 cidades por recurso.";
  }
  return null;
}
/** Mesma origem usada pelas regras: cityId canônico do cadastro; UF do seu sufixo ou state. Não usa GPS. */
export function localRegional(perfil: unknown): { cidade: string; uf: string } {
  const p = obj(perfil), l = obj(p.location);
  const bruto = l.cityId ?? p.cityId;
  let cidade = typeof bruto === "string" && cidadeValida(bruto.toLowerCase()) ? bruto.toLowerCase() : "";
  const estado = l.state ?? p.state;
  const uf = cidade ? cidade.slice(-2).toUpperCase() : typeof estado === "string" ? estado.toUpperCase() : "";
  const nome = l.city ?? p.city;
  if (!cidade && UFS_REGIONAIS.includes(uf) && typeof nome === "string") {
    const slug = nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const candidata = `${slug}_${uf.toLowerCase()}`;
    if (cidadeValida(candidata)) cidade = candidata;
  }
  return { cidade, uf: UFS_REGIONAIS.includes(uf) ? uf : "" };
}
export function recursoRegionalLiberado(config: RegioesTimes, recurso: RecursoRegional, perfil: unknown): boolean {
  const local = localRegional(perfil);
  const permite = (r: RegiaoRecurso) => r.modo === "todos" || r.modo === "selecionados" && (Boolean(local.uf) && r.estados.includes(local.uf) || Boolean(local.cidade) && r.cidades.includes(local.cidade));
  return permite(config.times) && (recurso === "times" || permite(config.campeonatosTimes));
}
