/**
 * Troféu personalizado dos campeonatos entre times: a escolha de cada peça (de listas fechadas), num texto compacto.
 *
 *   forma|alcas|topo|base|materialBase|metal|corMetal|emblema|sigla|detalhe
 *   ex.: "calice|asas|coroa|pedestal|pedra|ouro||escudo||17212F"
 *
 * Sem imagem, sem SVG enviado pelo usuário: o app (e o servidor, no cartão do link) desenha a taça a partir das peças.
 * `corMetal` só existe com metal "cor"; `sigla` só com emblema "sigla". A MESMA lista fica em
 * src/shared/trofeu/desenhoTrofeu.ts no app (os testes conferem que são iguais).
 */
export const PECAS_TROFEU = {
  forma: ["classica", "calice", "copa", "anfora", "bola", "estrela"],
  alcas: ["nenhuma", "curvas", "retas", "argolas", "asas"],
  topo: ["nada", "bola", "estrela", "coroa", "chuteira", "chama"],
  base: ["baixa", "degraus", "pedestal"],
  materialBase: ["pedra", "madeira", "metal"],
  metal: ["ouro", "prata", "bronze", "cor"],
  emblema: ["nenhum", "raio", "estrela", "bola", "escudo", "um", "sigla"],
  detalhe: ["FFF4D6", "FFFFFF", "17212F", "FE7552", "2F6FEB", "D93636", "1F9D57"],
} as const;

export const MAX_MODELOS_TROFEU = 10;
const TAMANHO_MAXIMO = 90;

/** Texto canônico do desenho, ou null se qualquer peça for desconhecida. */
export function normalizarDesenhoTrofeu(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length > TAMANHO_MAXIMO) return null;
  const p = valor.split("|");
  if (p.length !== 10) return null;
  const [forma, alcas, topo, base, materialBase, metal, corMetal, emblema, sigla, detalhe] = p;
  const em = <K extends keyof typeof PECAS_TROFEU>(k: K, v: string) => (PECAS_TROFEU[k] as readonly string[]).includes(v);
  if (!em("forma", forma) || !em("alcas", alcas) || !em("topo", topo) || !em("base", base) || !em("materialBase", materialBase)
    || !em("metal", metal) || !em("emblema", emblema) || !em("detalhe", detalhe)) return null;
  const cor = corMetal.toUpperCase();
  if (metal === "cor" ? !/^[0-9A-F]{6}$/.test(cor) : corMetal !== "") return null;
  if (emblema === "sigla" ? !/^[A-Z0-9]{1,3}$/.test(sigla) : sigla !== "") return null;
  return [forma, alcas, topo, base, materialBase, metal, metal === "cor" ? cor : "", emblema, sigla, detalhe].join("|");
}

/**
 * Modelos salvos da conta (`users/{uid}/restrito/modelosTrofeu`): até 10, cada um com id (gerado pelo servidor), nome e
 * desenho. O app só ADICIONA ou REMOVE um por vez (por id), sempre sobre a lista atual, numa transação: salvar em dois
 * aparelhos ao mesmo tempo nunca apaga o modelo do outro.
 */
export interface ModeloTrofeuSalvo { id: string; nome: string; desenho: string }
export const ID_MODELO_TROFEU = /^[a-f0-9]{12}$/;

/** Nome digitado: espaços juntados, 1 a 30 letras; null se não servir. */
export const nomeDoModelo = (nome: unknown): string | null => {
  const n = typeof nome === "string" ? nome.replace(/\s+/g, " ").trim() : "";
  return n && Array.from(n).length <= 30 ? n : null;
};

/** Lido do Firestore (pode estar ausente ou ser de um formato antigo): sempre devolve uma lista válida, com ids únicos. */
export const modelosGravados = (valor: unknown, idPara: (nome: string, desenho: string) => string = idDeConteudo): ModeloTrofeuSalvo[] => {
  if (!Array.isArray(valor)) return [];
  const saida: ModeloTrofeuSalvo[] = [];
  const vistos = new Set<string>();
  for (const v of valor) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const nome = nomeDoModelo(o.nome), desenho = normalizarDesenhoTrofeu(o.desenho);
    if (!nome || !desenho) continue;
    // Modelo gravado antes dos ids: id estável a partir do conteúdo (o mesmo em toda leitura).
    const id = typeof o.id === "string" && ID_MODELO_TROFEU.test(o.id) ? o.id : idPara(nome, desenho);
    if (vistos.has(id)) continue;
    vistos.add(id);
    saida.push({ id, nome, desenho });
    if (saida.length >= MAX_MODELOS_TROFEU) break;
  }
  return saida;
};

/** Id derivado do conteúdo (só para modelos antigos, sem id): hex de 12, sem dependências do Node aqui. */
function idDeConteudo(nome: string, desenho: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (const ch of `${nome}\u0000${desenho}`) {
    const c = ch.codePointAt(0) ?? 0;
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 12);
}
