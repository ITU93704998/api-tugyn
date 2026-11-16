import { normalizarDesenhoTrofeu } from "./desenhoTrofeu";

/**
 * A taça do campeonato em SVG (texto), para a página pública do link. Mesmo desenho do app
 * (src/shared/trofeu/TacaPersonalizada.tsx) no modo ícone: só a taça, sem os textos da placa. Tudo vem de listas fechadas
 * (o desenho já passou por normalizarDesenhoTrofeu), então não há texto livre no SVG além da sigla (A-Z/0-9, até 3).
 * Sem desenho escolhido: a taça clássica dourada (a mesma do editor).
 */
const PADRAO = "classica|curvas|nada|degraus|pedra|ouro||estrela||FFF4D6";

interface Forma { corpo: string; boca: [number, number, number] | null; topoY: number; haste: number; alca: [number, number, number, number]; emb: [number, number]; bola?: boolean }

const estrela = (cx: number, cy: number, r: number, ri: number): string =>
  Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? ri : r;
    return `${i ? "L" : "M"}${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}`;
  }).join(" ") + " Z";

const FORMAS: Record<string, Forma> = {
  classica: { corpo: "M70 70 H170 C170 122 150 150 120 156 C90 150 70 122 70 70 Z", boca: [70, 170, 70], topoY: 70, haste: 154, alca: [72, 168, 80, 130], emb: [120, 104] },
  calice: { corpo: "M88 56 H152 C152 108 141 138 120 148 C99 138 88 108 88 56 Z", boca: [88, 152, 56], topoY: 56, haste: 146, alca: [89, 151, 66, 120], emb: [120, 92] },
  copa: { corpo: "M52 82 H188 C188 116 162 140 120 142 C78 140 52 116 52 82 Z", boca: [52, 188, 82], topoY: 82, haste: 140, alca: [56, 184, 88, 122], emb: [120, 106] },
  anfora: { corpo: "M96 52 H144 C144 70 166 84 166 114 C166 144 142 158 120 160 C98 158 74 144 74 114 C74 84 96 70 96 52 Z", boca: [96, 144, 52], topoY: 52, haste: 158, alca: [78, 162, 72, 132], emb: [120, 116] },
  bola: { corpo: "M74 104 A46 46 0 1 0 166 104 A46 46 0 1 0 74 104 Z", boca: null, topoY: 58, haste: 146, alca: [76, 164, 86, 124], emb: [120, 104], bola: true },
  estrela: { corpo: estrela(120, 102, 54, 24), boca: null, topoY: 48, haste: 132, alca: [84, 156, 112, 140], emb: [120, 106] },
};
const METAIS: Record<string, [string, string, string, string]> = {
  ouro: ["#7A4E0E", "#FBE08A", "#E2AC2F", "#8E6012"],
  prata: ["#5D6672", "#F4F7FA", "#B9C2CD", "#666F7B"],
  bronze: ["#5E3218", "#F0AC78", "#B9693A", "#6A3A1C"],
};
const BASES: Record<string, [string, string, string, string]> = {
  pedra: ["#1C232D", "#3E4A5B", "#232C38", "#151B23"],
  madeira: ["#3B200F", "#93603A", "#6A3F22", "#33190B"],
};

const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const hex = (r: number[]) => "#" + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const misturar = (a: string, b: string, t: number): string => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const luz = (h: string) => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

/** SVG da taça (viewBox 0 -12 240 300, proporção 4:5). `id` evita colisão se houver mais de uma na página. */
export function tacaSvg(desenho: unknown, largura: number, altura: number, id = "taca"): string {
  const [forma, alcas, topo, base, materialBase, metal, corMetal, emblema, sigla, detalhe] = (normalizarDesenhoTrofeu(desenho) ?? PADRAO).split("|");
  const f = FORMAS[forma] ?? FORMAS.classica;
  const corLivre = `#${corMetal || "FE7552"}`;
  const c = metal === "cor" ? [misturar(corLivre, "#000000", 0.55), misturar(corLivre, "#FFFFFF", 0.6), corLivre, misturar(corLivre, "#000000", 0.4)] : METAIS[metal] ?? METAIS.ouro;
  const escuro = c[0];
  const M = `url(#${id}m)`, B = `url(#${id}b)`;
  const pedra = materialBase === "metal" ? c : BASES[materialBase] ?? BASES.pedra;
  const contorno = misturar(pedra[0], "#000000", 0.3);
  const det = `#${detalhe}`, detTexto = luz(det) > 0.6 ? "#1B1206" : "#FFFFFF";
  const linhaEmb = misturar(escuro, "#000000", 0.2);
  const s = (extra = "") => `fill="${M}" stroke="${escuro}" stroke-width="1"${extra}`;

  let baseSvg: string, placa: [number, number, number, number], chao: number;
  const bs = `fill="${B}" stroke="${contorno}" stroke-width="1"`;
  if (base === "baixa") { baseSvg = `<rect x="78" y="201" width="84" height="42" rx="4" ${bs}/><rect x="74" y="198" width="92" height="7" rx="3" ${bs}/>`; placa = [88, 214, 64, 20]; chao = 244; }
  else if (base === "pedestal") { baseSvg = `<path d="M90 203 H150 L162 260 H78 Z" ${bs}/><rect x="86" y="198" width="68" height="7" rx="2" ${bs}/><rect x="72" y="257" width="96" height="9" rx="3" ${bs}/>`; placa = [91, 222, 58, 22]; chao = 267; }
  else { baseSvg = `<rect x="70" y="216" width="100" height="38" rx="4" ${bs}/><rect x="92" y="200" width="56" height="18" rx="3" ${bs}/>`; placa = [82, 225, 76, 20]; chao = 255; }
  const [px, py, pw, ph] = placa;
  const placaFundo = materialBase === "metal" ? "#1C232D" : M;

  const [xl, xr, a1, a2] = f.alca, meio = (a1 + a2) / 2;
  let alca = "";
  if (alcas === "curvas") alca = `<path d="M${xl + 2} ${a1} C${xl - 36} ${a1 - 6} ${xl - 36} ${a2 + 4} ${xl + 6} ${a2}" fill="none" stroke="${M}" stroke-width="7" stroke-linecap="round"/>`;
  else if (alcas === "retas") alca = `<path d="M${xl + 2} ${a1} H${xl - 22} V${a2 - 12} L${xl + 6} ${a2}" fill="none" stroke="${M}" stroke-width="6.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  else if (alcas === "argolas") alca = `<circle cx="${xl - 13}" cy="${meio}" r="13" fill="none" stroke="${M}" stroke-width="6"/><rect x="${xl - 2}" y="${meio - 3}" width="8" height="6" fill="${M}"/>`;
  else if (alcas === "asas") alca = `<path d="M${xl + 4} ${a1} Q${xl - 50} ${a1 - 26} ${xl - 46} ${a1 + 16} Q${xl - 32} ${a1 + 10} ${xl - 28} ${a1 + 30} Q${xl - 16} ${a1 + 24} ${xl - 12} ${a2 - 4} Q${xl - 4} ${a2 - 10} ${xl + 6} ${a2} Z" fill="${M}" stroke="${escuro}" stroke-width="1"/>`;

  const ls = `stroke="${linhaEmb}" stroke-width="1.2"`;
  let emb = "";
  if (emblema === "raio") emb = `<path d="M4 -16 L-10 3 H0 L-4 16 L10 -3 H0 Z" fill="${det}" ${ls} stroke-linejoin="round"/>`;
  else if (emblema === "estrela") emb = `<path d="${estrela(0, 1, 15, 6.5)}" fill="${det}" ${ls} stroke-linejoin="round"/>`;
  else if (emblema === "bola") emb = `<circle r="14" fill="${det}" ${ls}/><path d="M0 -6 L5.7 -1.9 L3.5 4.9 H-3.5 L-5.7 -1.9 Z" fill="${detTexto}"/><path d="M0 -6 V-14 M5.7 -1.9 L13 -4.5 M3.5 4.9 L8 11 M-3.5 4.9 L-8 11 M-5.7 -1.9 L-13 -4.5" stroke="${detTexto}" stroke-width="1.3"/>`;
  else if (emblema === "escudo") emb = `<path d="M0 -16 L13 -11 V0 C13 9 7 14 0 17 C-7 14 -13 9 -13 0 V-11 Z" fill="${det}" ${ls}/><path d="M0 -10 L7 -7 V0 C7 5 4 8 0 10 Z" fill="${detTexto}" opacity="0.35"/>`;
  else if (emblema === "um") emb = `<circle r="15" fill="${det}" ${ls}/><text y="7.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold" font-size="21" fill="${detTexto}">1</text>`;
  else if (emblema === "sigla") emb = `<rect x="-19" y="-11" width="38" height="22" rx="5" fill="${det}" ${ls}/><text y="5.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold" font-size="15" fill="${detTexto}">${/^[A-Z0-9]{1,3}$/.test(sigla) ? sigla : "TOP"}</text>`;

  let topoSvg = "";
  if (topo !== "nada") {
    let tampa = "", b: number;
    if (f.boca) { const [bx1, bx2, by] = f.boca; tampa = `<path d="M${bx1 + 8} ${by} Q120 ${by - 26} ${bx2 - 8} ${by} Z" ${s()}/>`; b = by - 11; } else b = f.topoY + 2;
    let peca = "";
    if (topo === "bola") peca = `<circle cy="-11" r="11" ${s()}/><path d="M0 -15 L3.8 -12.2 L2.3 -7.8 H-2.3 L-3.8 -12.2 Z" fill="${escuro}" opacity="0.7"/>`;
    else if (topo === "estrela") peca = `<path d="${estrela(0, -14, 15, 6.5)}" ${s(' stroke-linejoin="round"')}/>`;
    else if (topo === "coroa") peca = `<path d="M-17 0 L-20 -20 L-9 -10 L0 -25 L9 -10 L20 -20 L17 0 Z" ${s(' stroke-linejoin="round"')}/><circle cx="-20" cy="-21" r="2.4" fill="${det}"/><circle cy="-26" r="2.6" fill="${det}"/><circle cx="20" cy="-21" r="2.4" fill="${det}"/>`;
    else if (topo === "chuteira") peca = `<path d="M-17 0 H17 C21 0 21 -6 16 -8 L4 -12 L2 -24 H-12 L-14 -10 C-17 -8 -19 -3 -17 0 Z" ${s()}/><path d="M-12 -18 H1 M-12 -14 H2" stroke="${escuro}" stroke-width="1.2"/><rect x="-14" y="0" width="3" height="3" fill="${escuro}"/><rect x="-4" y="0" width="3" height="3" fill="${escuro}"/><rect x="8" y="0" width="3" height="3" fill="${escuro}"/>`;
    else if (topo === "chama") peca = `<path d="M0 -30 C9 -19 15 -12 11 -4 C9 0 4 1 0 1 C-4 1 -10 0 -11 -5 C-13 -13 -4 -15 -2 -21 C2 -17 1 -11 4 -10 C4 -15 2 -21 0 -30 Z" ${s()}/><path d="M0 -12 C3 -8 4 -5 2 -2 C1 -1 -1 -1 -2 -2 C-4 -5 -1 -8 0 -12 Z" fill="${det}"/>`;
    topoSvg = `${tampa}<g transform="translate(120 ${b})">${peca}</g>`;
  }

  const bolaLinhas = f.bola && emblema === "nenhum"
    ? `<g clip-path="url(#${id}c)" opacity="0.55"><path d="M120 89 L120 62 M134 99 L160 90 M129 116 L146 138 M111 116 L94 138 M106 99 L80 90" fill="none" stroke="${escuro}" stroke-width="1.6"/></g><path d="M106 99 L120 89 L134 99 L129 116 L111 116 Z" fill="${escuro}" opacity="0.55"/>`
    : "";
  const [ex, ey] = f.emb;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -12 240 300" width="${largura}" height="${altura}" aria-hidden="true">
<defs>
<linearGradient id="${id}m" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${c[0]}"/><stop offset="0.34" stop-color="${c[1]}"/><stop offset="0.62" stop-color="${c[2]}"/><stop offset="1" stop-color="${c[3]}"/></linearGradient>
<linearGradient id="${id}b" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${pedra[0]}"/><stop offset="0.4" stop-color="${pedra[1]}"/><stop offset="0.7" stop-color="${pedra[2]}"/><stop offset="1" stop-color="${pedra[3]}"/></linearGradient>
<linearGradient id="${id}i" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${misturar(c[0], "#000000", 0.35)}"/><stop offset="1" stop-color="${c[3]}"/></linearGradient>
<radialGradient id="${id}s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000000" stop-opacity="0.4"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></radialGradient>
<clipPath id="${id}c"><path d="${f.corpo}"/></clipPath>
</defs>
<ellipse cx="120" cy="${chao + 1}" rx="62" ry="7" fill="url(#${id}s)"/>
${baseSvg}
<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="2" fill="${placaFundo}" stroke="${escuro}" stroke-width="1"/>
<path d="M113 ${f.haste} H127 L125 187 H115 Z" ${s()}/>
<ellipse cx="120" cy="${(f.haste + 187) / 2 + 3}" rx="11" ry="5" ${s()}/>
<path d="M97 201 C108 197 112 192 114 186 H126 C128 192 132 197 143 201 Z" ${s()}/>
${alca ? `${alca}<g transform="translate(${xl + xr} 0) scale(-1 1)">${alca}</g>` : ""}
<path d="${f.corpo}" ${s()}/>
${f.boca ? `<ellipse cx="${(f.boca[0] + f.boca[1]) / 2}" cy="${f.boca[2]}" rx="${(f.boca[1] - f.boca[0]) / 2}" ry="5.5" fill="url(#${id}i)" stroke="${c[1]}" stroke-width="1.6"/>` : ""}
${bolaLinhas}
<g clip-path="url(#${id}c)"><ellipse cx="${ex - 26}" cy="${ey - 6}" rx="9" ry="40" fill="#FFFFFF" opacity="0.28"/><ellipse cx="${ex - 12}" cy="${ey - 10}" rx="3" ry="26" fill="#FFFFFF" opacity="0.22"/></g>
${emb ? `<g transform="translate(${ex} ${ey})">${emb}</g>` : ""}
${topoSvg}
</svg>`;
}
