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
  /**
   * SHA-256 do PNG da logo (em `adsContratoLogos/{sha256}`, imutável) ou "" sem logo. Fica na configuração: cada versão
   * publicada guarda o hash da logo que usou, e o PDF do cliente sai com essa mesma logo.
   */
  logo: string;
}

/** Logos do contrato por hash (só o servidor lê e grava; nunca são sobrescritas nem apagadas). */
export const COLECAO_LOGOS = "adsContratoLogos";
export const LOGO_MAX_BYTES = 200 * 1024;
const LOGO_MAX_LADO = 2000;

export type LogoValida = { ok: true; buffer: Buffer; sha256: string; largura: number; altura: number; transparente: boolean } | { ok: false; error: string };

/**
 * Logo enviada pelo painel (data URL base64): só PNG (a transparência — "sem fundo" — só existe em PNG), até 200 KB e
 * 2000 px. Confere a assinatura e o cabeçalho do arquivo, não o tipo informado pelo navegador.
 */
export const validarLogoPng = (valor: unknown): LogoValida => {
  if (typeof valor !== "string") return { ok: false, error: "Envie a logo em PNG." };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(valor);
  if (!m) return { ok: false, error: "A logo precisa ser um arquivo PNG (de preferência sem fundo)." };
  const buffer = Buffer.from(m[1], "base64");
  if (buffer.length === 0) return { ok: false, error: "O arquivo está vazio." };
  if (buffer.length > LOGO_MAX_BYTES) return { ok: false, error: "A logo passa de 200 KB. Reduza o tamanho e envie de novo." };
  const assinatura = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 33 || !assinatura.every((b, i) => buffer[i] === b) || buffer.toString("ascii", 12, 16) !== "IHDR") return { ok: false, error: "O arquivo não é um PNG válido." };
  const largura = buffer.readUInt32BE(16), altura = buffer.readUInt32BE(20), tipoDeCor = buffer[25];
  if (!largura || !altura || largura > LOGO_MAX_LADO || altura > LOGO_MAX_LADO) return { ok: false, error: "A logo deve ter até 2000 x 2000 pixels." };
  // Canal alfa (tipos 4 e 6) ou transparência por paleta (bloco tRNS).
  const transparente = tipoDeCor === 4 || tipoDeCor === 6 || buffer.includes(Buffer.from("tRNS", "ascii"));
  return { ok: true, buffer, sha256: createHash("sha256").update(new Uint8Array(buffer)).digest("hex"), largura, altura, transparente };
};

// Ponto de partida editável. Os dados e políticas comerciais ficam vazios até o administrador os definir.
export const TEXTO_INICIAL = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE PUBLICIDADE DIGITAL
Tugyn ADS — versão {{versao}} — {{data_versao}}

IDENTIFICAÇÃO DAS PARTES
CONTRATADA: {{razao_social}}, nome fantasia {{nome_fantasia}}, inscrita no CPF/CNPJ sob o nº {{cnpj}}, com endereço em {{endereco}}. Contato: {{email}} / {{telefone}}.
CONTRATANTE: {{cliente_nome}}, e-mail {{cliente_email}}, contato {{cliente_telefone}}, identificado no pedido {{pedido_codigo}}, que declara ter capacidade e poderes para contratar.

1. OBJETO E PEDIDO
Veiculação de anúncio no aplicativo Tugyn. Modelo: {{pedido_modelo}}. Telas: {{pedido_telas}}. Abrangência: {{pedido_cidade}}. Início previsto: {{pedido_inicio}}. Fim previsto: {{pedido_fim}}. Duração: {{pedido_dias}} dias de 24 horas. Valor total: {{pedido_total}}. Os horários são de Brasília. Este pedido integra o contrato. O anúncio é identificado como publicidade.
A contratação corresponde à disponibilização do anúncio nas telas, na abrangência e pelo período indicados no pedido. Não constitui compra de quantidade determinada de impressões, cliques, acessos ou conversões. A frequência de exibição pode variar conforme o número de usuários ativos, a navegação no aplicativo, a disponibilidade dos espaços e a alternância com outros anúncios, sem exclusividade.

2. PAGAMENTO E MATERIAL
O pagamento é antecipado e deve corresponder ao valor do pedido. A confirmação depende da conferência da equipe, em até {{pagamento_horas}} horas úteis. O anunciante envia o material e comprova os direitos necessários ao uso de imagens e marcas. A equipe analisa o material em até {{analise_horas}} horas úteis. Quando forem solicitados ajustes, o anunciante tem {{correcao_dias}} dias corridos para responder. Atendimento de segunda a sexta-feira, exceto feriados nacionais, das {{horario_inicio}} às {{horario_fim}}, horário de Brasília.
Nota fiscal: {{nota_fiscal}}

3. VEICULAÇÃO E INDISPONIBILIDADE
A veiculação só começa após pagamento confirmado e material aprovado. Se o início previsto já tiver passado, começa na aprovação, preservando a duração contratada. As datas efetivas ficam registradas no pedido. A Tugyn pode otimizar tecnicamente o arquivo sem alterar a mensagem.
Considera-se interrupção relevante o período em que o anúncio deixa de estar disponível em todas as telas contratadas por causa atribuível à Tugyn, por mais de 24 horas, seguidas ou somadas, durante o período contratado. A interrupção é verificada pelos registros técnicos da Tugyn ou pelas evidências enviadas pelo anunciante pelos contatos do pedido. Períodos sem impressões causados pela variação normal de uso do aplicativo não são interrupção.
Indisponibilidades decorrentes de manutenção, atualizações, falhas de infraestrutura ou de serviços de terceiros serão analisadas pela Tugyn. Quando houver interrupção relevante, a Tugyn oferecerá compensação proporcional, por extensão do período ou restituição do período não entregue, à escolha do anunciante, sem prejuízo dos direitos legalmente assegurados.

4. ALTERAÇÕES DO ANÚNCIO
Alterações de imagem, texto, destino ou demais elementos do anúncio após a aprovação dependem de nova análise, no mesmo prazo da análise inicial. Durante a nova análise, o anúncio aprovado continua sendo exibido, e o pedido de alteração não interrompe nem prorroga o período contratado, salvo acordo expresso entre as partes ou obrigação legal.

5. CONTEÚDO E RESPONSABILIDADES
O anunciante responde pela veracidade do conteúdo, legalidade da oferta, direitos de terceiros e funcionamento do destino do anúncio. Não são aceitos conteúdo ilegal, fraudulento, discriminatório, violento, sexual, político-partidário, jogos de azar sem autorização legal, produtos proibidos ou violações de propriedade intelectual. A Tugyn pode solicitar correções ou recusar material, indicando o motivo. Cada parte responde pelos danos decorrentes de sua atuação, preservadas as responsabilidades previstas em lei. Não há garantia de vendas, cliques ou conversões.

6. MÉTRICAS
As impressões e os cliques são registrados pelos sistemas da Tugyn e podem passar por filtragem de tráfego inválido, duplicidades e inconsistências técnicas. Os números têm caráter informativo: não são auditoria independente nem garantia de resultado comercial. Mediante solicitação pelos contatos do pedido, durante ou após a campanha, a Tugyn informa ao anunciante o resumo das impressões e dos cliques registrados.

7. CANCELAMENTO, SUSPENSÃO E REEMBOLSO
Antes do início da veiculação: {{cancelamento_antes}}
Depois do início da veiculação: {{cancelamento_depois}}
Suspensão ou recusa do material: {{suspensao}}
Prazo operacional de reembolso: até {{reembolso_dias}} dias úteis, ressalvados prazos e direitos legais aplicáveis. A restituição será feita ao pagador, preferencialmente pelo mesmo meio. As condições comerciais não afastam direitos obrigatórios, inclusive o direito de arrependimento quando aplicável.

8. DADOS E ACEITE ELETRÔNICO
Nome, contato, comprovantes e registros de aceite são tratados para executar o contrato, prestar suporte e cumprir obrigações legais, com acesso restrito, e são mantidos pelo tempo necessário para comprovar a contratação e cumprir essas obrigações. Política de privacidade: {{privacidade_url}}.
O anunciante acessa o documento no link exclusivo do pedido antes de aceitá-lo e manifesta concordância marcando a caixa de aceite, que começa desmarcada. O aceite registra o código do pedido, a data e a hora (horário de Brasília), o horário em que o documento foi aberto, a versão e o hash SHA-256 do PDF aceito, a ação de concordância no link do pedido e um identificador derivado do endereço IP (o endereço não é guardado). A cópia aceita é preservada; mudanças posteriores não alteram suas condições.

9. DISPOSIÇÕES GERAIS
Comunicações serão feitas pelo link do pedido ou contatos informados. Fica indicado o foro de {{foro}}, respeitado o foro legalmente competente, inclusive o do consumidor quando aplicável. O pedido e este instrumento compõem o acordo entre as partes.`;

/**
 * Textos SUGERIDOS para as políticas comerciais (o painel oferece "Usar sugestão"; nada é preenchido sozinho, porque são
 * decisões do administrador). A nota fiscal fica sem sugestão: depende da situação fiscal real de quem contrata.
 * Sem campos {{...}}: o texto das políticas entra no contrato como está.
 */
export const SUGESTOES_POLITICAS: Partial<Record<(typeof CAMPOS_POLITICA)[number], string>> = {
  cancelamento_antes: "O anunciante pode cancelar o pedido a qualquer momento antes do início da veiculação, pelos contatos do pedido, com restituição integral do valor pago.",
  cancelamento_depois: "Depois do início da veiculação, o anunciante pode cancelar a qualquer momento, pelos contatos do pedido. A veiculação é encerrada e a restituição é proporcional aos dias não veiculados, contados a partir do dia seguinte ao pedido de cancelamento. Exemplo: pedido de 30 dias e R$ 300,00, cancelado depois de 18 dias veiculados: restituição de R$ 120,00 (12 de 30 dias).",
  suspensao: "Se o material ou o destino do anúncio violar este contrato ou a lei, a Tugyn pode recusar o material ou suspender a veiculação, informando o motivo, e permitirá a correção no prazo de resposta aos ajustes previsto na cláusula 2, quando cabível. Em caso de fraude, ilegalidade grave ou risco aos usuários, a suspensão pode ser imediata. Se a correção não for feita no prazo, o pedido pode ser cancelado com restituição proporcional aos dias não veiculados. Se o material não for enviado em até 30 dias após a confirmação do pagamento, o pedido pode ser cancelado com restituição integral.",
};

export function configuracaoInicial(): ConfiguracaoContrato {
  return { empresa: Object.fromEntries(CAMPOS_EMPRESA.map(k => [k, k === "nome_fantasia" ? "Tugyn" : ""])) as ConfiguracaoContrato["empresa"], prazos: { pagamento_horas: 16, analise_horas: 16, correcao_dias: 7, reembolso_dias: 7 }, politicas: { cancelamento_antes: "", cancelamento_depois: "", suspensao: "", nota_fiscal: "" }, texto: TEXTO_INICIAL, logo: "" };
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
  // Configurações salvas antes da logo não têm o campo: valem como "sem logo".
  const logo = b.logo === undefined || b.logo === null ? "" : b.logo;
  if (typeof logo !== "string" || (logo !== "" && !/^[0-9a-f]{64}$/.test(logo))) return { ok: false, error: "Logo inválida. Envie a imagem de novo." };
  c.logo = logo;
  for (const m of c.texto.matchAll(/\{\{([^{}]+)\}\}/g)) if (!(VARIAVEIS as readonly string[]).includes(m[1])) return { ok: false, error: `Campo desconhecido no modelo: {{${m[1]}}}.` };
  if (c.texto.replace(/\{\{[^{}]+\}\}/g, "").includes("{{") || c.texto.replace(/\{\{[^{}]+\}\}/g, "").includes("}}")) return { ok: false, error: "Há um campo incompleto no modelo." };
  if (publicar) {
    // Empresa (CNPJ, 14 posições, alfanumérico a partir de 2026) ou pessoa física (CPF, 11 dígitos): o contrato identifica
    // quem realmente contrata, sem inventar razão social ou CNPJ.
    const documento = c.empresa.cnpj.replace(/[.\/\s-]/g, "").toUpperCase();
    if (!/^[A-Z0-9]{12}\d{2}$/.test(documento) && !/^\d{11}$/.test(documento)) return { ok: false, error: "Confira o CPF (11 dígitos) ou o CNPJ (14 posições)." };
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

/** Tamanho máximo da logo na 1ª página (pontos do PDF): discreta, centralizada no topo. */
const LOGO_PDF = { largura: 150, altura: 56 };

/**
 * Renderer sem HTML, scripts, URLs remotas ou fontes externas. A4, quebras de palavras e paginação limitada.
 * Com `logoPng`: a logo vai centralizada no topo da 1ª página e o bloco do título (título, versão e data) logo abaixo,
 * também centralizado; as páginas seguintes têm só o cabeçalho pequeno, para sobrar espaço para o texto.
 */
export async function gerarPdfContrato(texto: string, logoPng?: Uint8Array | ArrayBuffer | Buffer | null): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Contrato Tugyn ADS"); pdf.setAuthor("Tugyn ADS");
  const fonte = await pdf.embedFont(StandardFonts.Helvetica), negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Helvetica/WinAnsi: falha explicitamente em vez de gerar documento com caracteres ausentes.
  const limpo = texto.replace(/\t/g, "    ").replace(/\r\n?/g, "\n");
  try { fonte.encodeText(limpo.replace(/\n/g, "")); } catch { throw new Error("O modelo contém um caractere não suportado no PDF. Remova emojis e caracteres especiais fora do alfabeto latino."); }
  const LARGURA_A4 = 595.28;
  let pagina = pdf.addPage([LARGURA_A4, 841.89]), y = 775;
  if (logoPng) {
    let imagem;
    try { imagem = await pdf.embedPng(new Uint8Array(logoPng)); } catch { throw new Error("Não foi possível usar a logo no PDF. Envie outro arquivo PNG."); }
    const escala = Math.min(LOGO_PDF.largura / imagem.width, LOGO_PDF.altura / imagem.height, 1);
    const w = imagem.width * escala, h = imagem.height * escala;
    pagina.drawImage(imagem, { x: (LARGURA_A4 - w) / 2, y: 841.89 - 40 - h, width: w, height: h });
    y = 841.89 - 40 - h - 28;
  }
  const novaPagina = () => { if (pdf.getPageCount() >= 35) throw new Error("O contrato ultrapassa 35 páginas. Reduza o modelo."); pagina = pdf.addPage([LARGURA_A4, 841.89]); y = 775; };
  // Bloco do título centralizado: o 1º grupo de linhas (e o seguinte, quando o 1º é o aviso de prévia).
  let blocosCentralizados = limpo.trimStart().startsWith("PRÉVIA") ? 2 : 1, dentroDeBloco = false;
  for (const paragrafo of limpo.split("\n")) {
    if (!paragrafo.trim()) { if (dentroDeBloco) { blocosCentralizados -= 1; dentroDeBloco = false; } y -= 9; continue; }
    if (blocosCentralizados > 0) dentroDeBloco = true;
    const centralizado = blocosCentralizados > 0;
    const titulo = /^(?:\d+\. |[A-ZÀ-Ú][A-ZÀ-Ú \d—–()-]{5,})$/.test(paragrafo) || /^\d+\. [A-ZÀ-Ú]/.test(paragrafo);
    const f = titulo ? negrito : fonte, tamanho = titulo ? 11 : 10;
    let linha = "";
    const desenhar = () => {
      if (y < 65) novaPagina();
      const x = centralizado ? Math.max(48, (LARGURA_A4 - f.widthOfTextAtSize(linha.trimEnd(), tamanho)) / 2) : 48;
      pagina.drawText(linha, { x, y, size: tamanho, font: f, color: titulo ? rgb(.68, .25, .12) : rgb(.14, .17, .21) }); y -= 15; linha = "";
    };
    for (const palavra of paragrafo.trim().split(/\s+/)) {
      if (linha && f.widthOfTextAtSize(`${linha} ${palavra}`, tamanho) > 499) desenhar();
      for (const letra of palavra) { if (f.widthOfTextAtSize(linha + letra, tamanho) > 499) desenhar(); linha += letra; }
      linha += " ";
    }
    if (linha) desenhar();
    y -= 5;
  }
  pdf.getPages().forEach((p, i) => { if (!(logoPng && i === 0)) { p.drawText("TUGYN ADS", { x: 48, y: 810, size: 9, font: negrito, color: rgb(.68, .25, .12) }); p.drawLine({ start: { x: 48, y: 797 }, end: { x: 547, y: 797 }, thickness: .6, color: rgb(.87, .87, .87) }); } p.drawText(`${i + 1} / ${pdf.getPageCount()}  |  Horário de Brasília`, { x: 48, y: 35, size: 8, font: fonte }); });
  return Buffer.from(await pdf.save());
}
