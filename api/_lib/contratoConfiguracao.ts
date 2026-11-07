import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const CONFIG_CONTRATO_DOC = "adsConfig/contratoConfiguracao";
export const CAMPOS_EMPRESA = ["razao_social", "nome_fantasia", "cnpj", "endereco", "email", "telefone", "foro", "privacidade_url", "data_versao", "horario_inicio", "horario_fim"] as const;
export const CAMPOS_PRAZO = ["pagamento_horas", "analise_horas", "correcao_dias", "reembolso_dias"] as const;
export const CAMPOS_POLITICA = ["cancelamento_antes", "cancelamento_depois", "suspensao", "nota_fiscal"] as const;
export const CAMPOS_PEDIDO = ["cliente_nome", "cliente_email", "cliente_telefone", "pedido_codigo", "pedido_modelo", "pedido_telas", "pedido_cidade", "pedido_inicio", "pedido_fim", "pedido_dias", "pedido_total", "versao"] as const;
export const VARIAVEIS = [...CAMPOS_EMPRESA, ...CAMPOS_PRAZO, ...CAMPOS_POLITICA, ...CAMPOS_PEDIDO];
export interface ConfiguracaoContrato {
  empresa: Record<(typeof CAMPOS_EMPRESA)[number], string>;
  prazos: Record<(typeof CAMPOS_PRAZO)[number], number>;
  politicas: Record<(typeof CAMPOS_POLITICA)[number], string>;
  texto: string;
}

// Ponto de partida editável. Os dados e políticas comerciais ficam vazios até o administrador os definir.
export const TEXTO_INICIAL = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE PUBLICIDADE DIGITAL
Tugyn ADS — versão {{versao}} — {{data_versao}}

IDENTIFICAÇÃO DAS PARTES
CONTRATADA: {{razao_social}}, nome fantasia {{nome_fantasia}}, CNPJ {{cnpj}}, com endereço em {{endereco}}. Contato: {{email}} / {{telefone}}.
CONTRATANTE: {{cliente_nome}}, e-mail {{cliente_email}}, contato {{cliente_telefone}}, identificado no pedido {{pedido_codigo}}, que declara ter capacidade e poderes para contratar.

1. OBJETO E PEDIDO
Veiculação de anúncio no aplicativo Tugyn. Modelo: {{pedido_modelo}}. Telas: {{pedido_telas}}. Abrangência: {{pedido_cidade}}. Início previsto: {{pedido_inicio}}. Fim previsto: {{pedido_fim}}. Duração: {{pedido_dias}} dias de 24 horas. Valor total: {{pedido_total}}. Os horários são de Brasília. Este pedido integra o contrato. O anúncio é identificado como publicidade e pode alternar com outros anúncios, sem exclusividade ou garantia de frequência específica.

2. PAGAMENTO E MATERIAL
O pagamento é antecipado e deve corresponder ao valor do pedido. A confirmação depende da conferência da equipe, em até {{pagamento_horas}} horas úteis. O anunciante envia o material e comprova os direitos necessários ao uso de imagens e marcas. A equipe analisa o material em até {{analise_horas}} horas úteis. Quando forem solicitados ajustes, o anunciante tem {{correcao_dias}} dias corridos para responder. Atendimento de segunda a sexta-feira, exceto feriados nacionais, das {{horario_inicio}} às {{horario_fim}}, horário de Brasília.
Nota fiscal: {{nota_fiscal}}

3. VEICULAÇÃO
A veiculação só começa após pagamento confirmado e material aprovado. Se o início previsto já tiver passado, começa na aprovação, preservando a duração contratada. As datas efetivas ficam registradas no pedido. A Tugyn pode otimizar tecnicamente o arquivo sem alterar a mensagem. Interrupção relevante que impeça a entrega contratada será tratada por extensão proporcional ou restituição do período não entregue, conforme o caso.

4. CONTEÚDO E RESPONSABILIDADES
O anunciante responde pela veracidade do conteúdo, legalidade da oferta, direitos de terceiros e funcionamento do destino do anúncio. Não são aceitos conteúdo ilegal, fraudulento, discriminatório, violento, sexual, político-partidário, jogos de azar sem autorização legal, produtos proibidos ou violações de propriedade intelectual. A Tugyn pode solicitar correções ou recusar material, indicando o motivo. Cada parte responde pelos danos decorrentes de sua atuação, preservadas as responsabilidades previstas em lei. Não há garantia de vendas, cliques ou conversões. Métricas são estimativas técnicas.

5. CANCELAMENTO, SUSPENSÃO E REEMBOLSO
Antes da aprovação: {{cancelamento_antes}}
Após a aprovação ou início: {{cancelamento_depois}}
Suspensão ou recusa do material: {{suspensao}}
Prazo operacional de reembolso: até {{reembolso_dias}} dias úteis, ressalvados prazos e direitos legais aplicáveis. A restituição será feita ao pagador, preferencialmente pelo mesmo meio. As condições comerciais não afastam direitos obrigatórios, inclusive o direito de arrependimento quando aplicável.

6. DADOS E ACEITE ELETRÔNICO
Nome, contato, comprovantes e registros de aceite são tratados para executar o contrato, prestar suporte e cumprir obrigações legais. Política de privacidade: {{privacidade_url}}. Comprovantes têm acesso restrito. O aceite registra data, hora, versão, hash do PDF e identificador derivado do endereço IP. O cliente manifesta concordância no link exclusivo do pedido, após acessar o documento. A cópia aceita é preservada; mudanças posteriores não alteram suas condições.

7. DISPOSIÇÕES GERAIS
Comunicações serão feitas pelo link do pedido ou contatos informados. Fica indicado o foro de {{foro}}, respeitado o foro legalmente competente, inclusive o do consumidor quando aplicável. O pedido e este instrumento compõem o acordo entre as partes.`;

export function configuracaoInicial(): ConfiguracaoContrato {
  return { empresa: Object.fromEntries(CAMPOS_EMPRESA.map(k => [k, k === "nome_fantasia" ? "Tugyn" : ""])) as ConfiguracaoContrato["empresa"], prazos: { pagamento_horas: 16, analise_horas: 16, correcao_dias: 7, reembolso_dias: 7 }, politicas: { cancelamento_antes: "", cancelamento_depois: "", suspensao: "", nota_fiscal: "" }, texto: TEXTO_INICIAL };
}
const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function validarConfiguracao(raw: unknown, publicar = false): { ok: true; valor: ConfiguracaoContrato } | { ok: false; error: string } {
  const b = record(raw), empresa = record(b.empresa), prazos = record(b.prazos), politicas = record(b.politicas);
  const c = configuracaoInicial();
  for (const k of CAMPOS_EMPRESA) {
    if (typeof empresa[k] !== "string" || (empresa[k] as string).length > 400 || /[\u0000-\u001f\u007f]/.test(empresa[k] as string)) return { ok: false, error: `Confira o campo ${k}.` };
    c.empresa[k] = (empresa[k] as string).trim();
    if (publicar && !c.empresa[k]) return { ok: false, error: `Preencha ${k} antes de publicar.` };
  }
  for (const k of CAMPOS_PRAZO) {
    const n = prazos[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > (k.endsWith("horas") ? 720 : 365)) return { ok: false, error: `Prazo inválido: ${k}.` };
    c.prazos[k] = n;
  }
  for (const k of CAMPOS_POLITICA) {
    if (typeof politicas[k] !== "string" || (politicas[k] as string).length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(politicas[k] as string)) return { ok: false, error: `Confira a política ${k}.` };
    c.politicas[k] = (politicas[k] as string).trim();
    if (publicar && !c.politicas[k]) return { ok: false, error: `Defina ${k} antes de publicar.` };
  }
  if (typeof b.texto !== "string" || b.texto.length < 100 || b.texto.length > 40000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(b.texto)) return { ok: false, error: "O modelo deve ter entre 100 e 40.000 caracteres de texto." };
  c.texto = b.texto.trim();
  for (const m of c.texto.matchAll(/\{\{([^{}]+)\}\}/g)) if (!(VARIAVEIS as readonly string[]).includes(m[1])) return { ok: false, error: `Campo desconhecido no modelo: {{${m[1]}}}.` };
  if (c.texto.replace(/\{\{[^{}]+\}\}/g, "").includes("{{") || c.texto.replace(/\{\{[^{}]+\}\}/g, "").includes("}}")) return { ok: false, error: "Há um campo incompleto no modelo." };
  if (publicar) {
    if (!/^[A-Z0-9]{12}\d{2}$/.test(c.empresa.cnpj.replace(/[.\/-]/g, "").toUpperCase())) return { ok: false, error: "Confira o formato do CNPJ (14 posições)." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.empresa.email)) return { ok: false, error: "Confira o e-mail da empresa." };
    try { const u = new URL(c.empresa.privacidade_url); if (u.protocol !== "https:" || u.username || u.password) throw Error(); } catch { return { ok: false, error: "A política de privacidade deve ter um endereço HTTPS válido." }; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.empresa.data_versao) || !Number.isFinite(Date.parse(c.empresa.data_versao)) || new Date(c.empresa.data_versao).toISOString().slice(0, 10) !== c.empresa.data_versao) return { ok: false, error: "Confira a data da versão." };
    if (![c.empresa.horario_inicio, c.empresa.horario_fim].every(v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) || c.empresa.horario_inicio >= c.empresa.horario_fim) return { ok: false, error: "O horário final deve ser posterior ao inicial." };
    if (/\[(?:REVISAR|DEFINIR|PRAZO|PERCENTUAL|NOME|ENDEREÇO|CIDADE)/i.test(c.texto)) return { ok: false, error: "Resolva os campos de rascunho antes de publicar." };
  }
  return { ok: true, valor: c };
}
export function preencherTexto(c: ConfiguracaoContrato, pedido: Record<string, string> = {}): string {
  const valores: Record<string, string | number> = { ...c.empresa, ...c.prazos, ...c.politicas, ...pedido };
  return c.texto.replace(/\{\{([^{}]+)\}\}/g, (_, k: string) => String(valores[k] ?? `[${k}]`));
}
export const hashPdf = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Renderer sem HTML, scripts, URLs remotas ou fontes externas. A4, quebras de palavras e paginação limitada. */
export async function gerarPdfContrato(texto: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Contrato Tugyn ADS"); pdf.setAuthor("Tugyn ADS");
  const fonte = await pdf.embedFont(StandardFonts.Helvetica), negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Helvetica/WinAnsi: falha explicitamente em vez de gerar documento com caracteres ausentes.
  const limpo = texto.replace(/\t/g, "    ").replace(/\r\n?/g, "\n");
  try { fonte.encodeText(limpo.replace(/\n/g, "")); } catch { throw new Error("O modelo contém um caractere não suportado no PDF. Remova emojis e caracteres especiais fora do alfabeto latino."); }
  let pagina = pdf.addPage([595.28, 841.89]), y = 775;
  const novaPagina = () => { if (pdf.getPageCount() >= 35) throw new Error("O contrato ultrapassa 35 páginas. Reduza o modelo."); pagina = pdf.addPage([595.28, 841.89]); y = 775; };
  for (const paragrafo of limpo.split("\n")) {
    if (!paragrafo.trim()) { y -= 9; continue; }
    const titulo = /^(?:\d+\. |[A-ZÀ-Ú][A-ZÀ-Ú \d—–()-]{5,})$/.test(paragrafo) || /^\d+\. [A-ZÀ-Ú]/.test(paragrafo);
    const f = titulo ? negrito : fonte, tamanho = titulo ? 11 : 10;
    let linha = "";
    const desenhar = () => { if (y < 65) novaPagina(); pagina.drawText(linha, { x: 48, y, size: tamanho, font: f, color: titulo ? rgb(.68, .25, .12) : rgb(.14, .17, .21) }); y -= 15; linha = ""; };
    for (const palavra of paragrafo.trim().split(/\s+/)) {
      if (linha && f.widthOfTextAtSize(`${linha} ${palavra}`, tamanho) > 499) desenhar();
      for (const letra of palavra) { if (f.widthOfTextAtSize(linha + letra, tamanho) > 499) desenhar(); linha += letra; }
      linha += " ";
    }
    if (linha) desenhar();
    y -= 5;
  }
  pdf.getPages().forEach((p, i) => { p.drawText("TUGYN ADS", { x: 48, y: 810, size: 9, font: negrito, color: rgb(.68, .25, .12) }); p.drawLine({ start: { x: 48, y: 797 }, end: { x: 547, y: 797 }, thickness: .6, color: rgb(.87, .87, .87) }); p.drawText(`${i + 1} / ${pdf.getPageCount()}  |  Horário de Brasília`, { x: 48, y: 35, size: 8, font: fonte }); });
  return Buffer.from(await pdf.save());
}
