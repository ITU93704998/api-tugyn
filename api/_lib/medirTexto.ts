/**
 * Medida aproximada de texto em Inter negrito, para o cartão da prévia dos links (o gerador não corta texto pela largura).
 * A estimativa erra para MAIS (letras largas como W e M contam quase uma fonte inteira): o que ela diz que cabe, cabe.
 * Mesma lógica das imagens de compartilhar do app (`src/shared/compartilhar/medirTexto.ts`).
 */

const ESTREITAS = new Set([..."iljtfrI.,:;'!|()[] "]);
const LARGAS_MAIUSCULAS = new Set([..."WMÆŒ"]);
const LARGAS_MINUSCULAS = new Set([..."mwæœ"]);

/** Largura de uma letra em "fontes" (1 = o tamanho da fonte). */
const larguraDaLetra = (l: string): number => {
  if (ESTREITAS.has(l)) return 0.34;
  if (LARGAS_MAIUSCULAS.has(l)) return 0.98;
  if (LARGAS_MINUSCULAS.has(l)) return 0.9;
  if (/[0-9]/.test(l)) return 0.64;
  if (l !== l.toLowerCase()) return 0.76; // maiúscula (com ou sem acento)
  if (/\p{L}/u.test(l)) return 0.62;
  return 0.7; // emoji, símbolos: com folga
};

export const larguraDoTexto = (texto: string, fonte: number, espacamento = 0): number => {
  const letras = [...texto];
  return letras.reduce((t, l) => t + larguraDaLetra(l) * fonte, 0) + Math.max(0, letras.length - 1) * espacamento;
};

/** O texto inteiro, ou cortado com "…" até caber em `max`. */
export const caberEm = (texto: string, fonte: number, max: number, espacamento = 0): string => {
  const t = texto.replace(/\s+/g, " ").trim();
  if (larguraDoTexto(t, fonte, espacamento) <= max) return t;
  const letras = [...t];
  while (letras.length > 1 && larguraDoTexto(`${letras.join("").trimEnd()}…`, fonte, espacamento) > max) letras.pop();
  return `${letras.join("").trimEnd()}…`;
};

/**
 * Quebra o texto em até `maxLinhas` linhas que cabem em `max` (pelas palavras; palavra maior que a linha é cortada com "…").
 * O que sobra depois da última linha entra nela, cortado com "…".
 */
export const quebrarEmLinhas = (texto: string, fonte: number, max: number, maxLinhas: number): string[] => {
  const palavras = texto.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const linhas: string[] = [];
  let atual = "";
  for (let i = 0; i < palavras.length; i++) {
    const tentativa = atual ? `${atual} ${palavras[i]}` : palavras[i];
    if (larguraDoTexto(tentativa, fonte) <= max) { atual = tentativa; continue; }
    if (!atual) { linhas.push(caberEm(palavras[i], fonte, max)); continue; }
    linhas.push(atual);
    atual = palavras[i];
    if (linhas.length === maxLinhas - 1) { atual = palavras.slice(i).join(" "); break; }
  }
  if (atual) linhas.push(caberEm(atual, fonte, max));
  if (linhas.length > maxLinhas) {
    const ultimas = linhas.splice(maxLinhas - 1);
    linhas.push(caberEm(ultimas.join(" "), fonte, max));
  }
  return linhas;
};

/** Maior fonte (da lista, em ordem decrescente) em que o texto cabe inteiro em até `maxLinhas`; senão, a menor, cortada. */
export const ajustarTitulo = (texto: string, fontes: readonly number[], max: number, maxLinhas: number): { fonte: number; linhas: string[] } => {
  const limpo = texto.replace(/\s+/g, " ").trim();
  for (const fonte of fontes) {
    const linhas = quebrarEmLinhas(limpo, fonte, max, maxLinhas);
    if (!linhas.length) return { fonte, linhas: [""] };
    if (!linhas.some((l) => l.endsWith("…")) || fonte === fontes[fontes.length - 1]) return { fonte, linhas };
  }
  return { fonte: fontes[fontes.length - 1], linhas: [caberEm(limpo, fontes[fontes.length - 1], max)] };
};
