/**
 * Contratos de anúncio (Tugyn ADS): preço, validação do pedido, fuso de Brasília, dinheiro e etapas do contrato.
 * Lógica PURA (sem Firebase, React nem rede). É usada pelo painel (a página do cliente mostra o valor ao vivo) E pelo servidor, que
 * RECALCULA tudo: o valor que o cliente vê é só um apoio. Este arquivo é IDÊNTICO nos dois lugares (há teste que confere).
 */

export const MODELOS = ["text", "banner"] as const;
export type Modelo = (typeof MODELOS)[number];
export const ESCOPOS = ["cidade", "todas"] as const;
export type Escopo = (typeof ESCOPOS)[number];
/** Os mesmos ids dos espaços do app (`AD_PLACEMENTS` em adCore.ts; um teste confere). */
export const TELAS = ["home", "partidas", "listaJogadores", "turmas", "turmaDetalhe", "desafios"] as const;
export type Tela = (typeof TELAS)[number];

/** Todo dinheiro é INTEIRO em centavos (sem erro de arredondamento). */
export type Centavos = number;
export type PrecosPorTela = Record<Tela, Centavos | null>;
export type PrecosDoModelo = Record<Escopo, PrecosPorTela>;
export type TabelaDePrecos = Record<Modelo, PrecosDoModelo>;
export type MinimoPorDia = Record<Modelo, Record<Escopo, Centavos | null>>;

export interface Cidade {
  id: string;
  nome: string;
  uf: string;
}

export interface ConfigContratos {
  /** Valor POR DIA de cada tela, por modelo e abrangência. `null` = não oferecido. */
  precos: TabelaDePrecos;
  /** Valor mínimo POR DIA, por modelo e abrangência. `null` = sem mínimo. */
  minimoPorDia: MinimoPorDia;
  dias: { min: number; max: number };
  /** O início do anúncio precisa ficar a pelo menos tantas horas de agora (tempo para pagar e analisar). */
  antecedenciaHoras: number;
  /** Quantos dias o link vale enquanto não houver pagamento. */
  validadeLinkDias: number;
  /** Pix: `pixChave`, `pixNome` e `pixCidade` geram, em cada contrato, o Pix copia e cola com o valor e o código do pedido. */
  pagamento: { linkCartao: string; linkPix: string; instrucoes: string; pixChave: string; pixNome: string; pixCidade: string };
  contato: { email: string; whatsapp: string; texto: string };
  /** Cidades que o cliente pode escolher. */
  cidades: Cidade[];
}

export const LIMITES = {
  precoMaxCentavos: 100_000_000,
  diasMax: 365,
  antecedenciaMaxHoras: 720,
  validadeMaxDias: 180,
  cidadesMax: 100,
  instrucoesMax: 600,
  contatoTextoMax: 400,
  emailMax: 120,
  whatsappMax: 30,
  urlMax: 500,
  /** Limites do padrão do Pix (BR Code): chave até 77, nome do recebedor até 25 e cidade até 15 caracteres. */
  pixChaveMax: 77,
  pixNomeMax: 25,
  pixCidadeMax: 15,
  cidadeNomeMax: 60,
  /** O início não pode ficar mais longe que isto. */
  inicioMaxDias: 365,
} as const;

const HORA_MS = 3_600_000;
export const DIA_MS = 24 * HORA_MS;

const semPrecosPorTela = (): PrecosPorTela => ({ home: null, partidas: null, listaJogadores: null, turmas: null, turmaDetalhe: null, desafios: null });
const semPrecosDoModelo = (): PrecosDoModelo => ({ cidade: semPrecosPorTela(), todas: semPrecosPorTela() });

export const configPadrao = (): ConfigContratos => ({
  precos: { text: semPrecosDoModelo(), banner: semPrecosDoModelo() },
  minimoPorDia: { text: { cidade: null, todas: null }, banner: { cidade: null, todas: null } },
  dias: { min: 1, max: 90 },
  antecedenciaHoras: 24,
  validadeLinkDias: 30,
  pagamento: { linkCartao: "", linkPix: "", instrucoes: "", pixChave: "", pixNome: "", pixCidade: "" },
  contato: { email: "", whatsapp: "", texto: "" },
  cidades: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** Centavos válidos (inteiro de 0 até o teto) ou null. Qualquer outra coisa (texto, negativo, decimal, absurdo) vira null: "não oferecido". */
const centavosOuNull = (value: unknown): Centavos | null => (isInt(value) && value >= 0 && value <= LIMITES.precoMaxCentavos ? value : null);
const inteiroEntre = (value: unknown, min: number, max: number, padrao: number): number => (isInt(value) && value >= min && value <= max ? value : padrao);
const texto = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
// ── Pix copia e cola (BR Code estático do Banco Central) ──────────────────────────────────────────────────────────────

/**
 * Chave como o Pix espera: CPF/CNPJ só com números (aceita digitado com pontos e traço), telefone "+55" com DDD e número,
 * e-mail e chave aleatória em minúsculas. Telefone sem "+55" fica ambíguo com CPF; por isso o formulário pede o "+55".
 */
export const normalizarChavePix = (valor: string): string => {
  const v = valor.trim();
  if (!v) return "";
  if (/^[\d.\-/\s]+$/.test(v)) return v.replace(/\D/g, "");
  if (v.startsWith("+")) return "+" + v.replace(/\D/g, "");
  return v.replace(/\s/g, "").toLowerCase();
};

const digitoVerificador = (base: string, pesos: number[]): number => {
  const resto = pesos.reduce((s, p, i) => s + Number(base[i]) * p, 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
};
/** CPF com os dois dígitos verificadores certos (e sem todos os números iguais). */
export const cpfValido = (cpf: string): boolean => {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const d1 = digitoVerificador(cpf, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(cpf[9]) && digitoVerificador(cpf, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(cpf[10]);
};
/** CNPJ com os dois dígitos verificadores certos (e sem todos os números iguais). */
export const cnpjValido = (cnpj: string): boolean => {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const d1 = digitoVerificador(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(cnpj[12]) && digitoVerificador(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(cnpj[13]);
};

/**
 * CPF ou CNPJ (com os dígitos verificadores), telefone +55, e-mail ou chave aleatória. Só ASCII: o CRC do BR Code é calculado
 * sobre os caracteres, e um e-mail com acento poderia gerar um código que o banco lê diferente.
 */
export const chavePixValida = (chave: string): boolean =>
  chave.length > 0 && chave.length <= LIMITES.pixChaveMax && /^[\x21-\x7e]+$/.test(chave) &&
  (cpfValido(chave) || cnpjValido(chave) || /^\+55\d{10,11}$/.test(chave) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(chave) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(chave));

/** Nome e cidade no Pix: sem acento e só letras, números, espaço e pontuação simples (alguns bancos recusam o resto). */
export const textoPix = (valor: string, max: number): string =>
  valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 .,&'\-]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();

const campoPix = (id: string, valor: string): string => id + String(valor.length).padStart(2, "0") + valor;

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF): o dígito de conferência do BR Code. */
export const crc16Pix = (s: string): string => {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
};

/**
 * O Pix copia e cola (o mesmo texto vira o QR Code) com o VALOR do contrato e o código do pedido como identificador (txid).
 * Vazio quando falta chave, nome, cidade ou valor: aí o cliente não vê a opção.
 */
export const pixCopiaECola = (p: { chave: string; nome: string; cidade: string; valorCentavos: number | null; txid: string }): string => {
  const nome = textoPix(p.nome, LIMITES.pixNomeMax), cidade = textoPix(p.cidade, LIMITES.pixCidadeMax);
  if (!chavePixValida(p.chave) || !nome || !cidade || !isInt(p.valorCentavos) || p.valorCentavos <= 0) return "";
  const txid = /^[A-Za-z0-9]{1,25}$/.test(p.txid) ? p.txid : "***";
  const valor = `${Math.floor(p.valorCentavos / 100)}.${String(p.valorCentavos % 100).padStart(2, "0")}`;
  const corpo =
    campoPix("00", "01") +
    campoPix("26", campoPix("00", "br.gov.bcb.pix") + campoPix("01", p.chave)) +
    campoPix("52", "0000") +
    campoPix("53", "986") +
    campoPix("54", valor) +
    campoPix("58", "BR") +
    campoPix("59", nome) +
    campoPix("60", cidade) +
    campoPix("62", campoPix("05", txid)) +
    "6304";
  return corpo + crc16Pix(corpo);
};

const urlHttps = (value: unknown): string => {
  const v = texto(value, LIMITES.urlMax);
  return /^https:\/\/[^\s]+$/.test(v) ? v : "";
};

/**
 * Lê a configuração gravada no Firestore com cuidado (pode vir incompleta, de versão antiga ou adulterada): nunca lança, sempre devolve
 * uma configuração utilizável. Preço ou mínimo inválido vira "não oferecido"/"sem mínimo". Links só valem se forem https.
 */
export const parseConfig = (raw: unknown): ConfigContratos => {
  const base = configPadrao();
  if (!isRecord(raw)) return base;
  const precosRaw = isRecord(raw.precos) ? raw.precos : {};
  const minimosRaw = isRecord(raw.minimoPorDia) ? raw.minimoPorDia : {};
  for (const modelo of MODELOS) {
    const doModelo = isRecord(precosRaw[modelo]) ? (precosRaw[modelo] as Record<string, unknown>) : {};
    const minimosDoModelo = isRecord(minimosRaw[modelo]) ? (minimosRaw[modelo] as Record<string, unknown>) : {};
    for (const escopo of ESCOPOS) {
      const dasTelas = isRecord(doModelo[escopo]) ? (doModelo[escopo] as Record<string, unknown>) : {};
      for (const tela of TELAS) base.precos[modelo][escopo][tela] = centavosOuNull(dasTelas[tela]);
      base.minimoPorDia[modelo][escopo] = centavosOuNull(minimosDoModelo[escopo]);
    }
  }
  const dias = isRecord(raw.dias) ? raw.dias : {};
  const min = inteiroEntre(dias.min, 1, LIMITES.diasMax, base.dias.min);
  const max = inteiroEntre(dias.max, 1, LIMITES.diasMax, base.dias.max);
  base.dias = { min: Math.min(min, max), max: Math.max(min, max) };
  base.antecedenciaHoras = inteiroEntre(raw.antecedenciaHoras, 0, LIMITES.antecedenciaMaxHoras, base.antecedenciaHoras);
  base.validadeLinkDias = inteiroEntre(raw.validadeLinkDias, 1, LIMITES.validadeMaxDias, base.validadeLinkDias);
  const pagamento = isRecord(raw.pagamento) ? raw.pagamento : {};
  const chave = normalizarChavePix(texto(pagamento.pixChave, LIMITES.pixChaveMax + 20));
  base.pagamento = {
    linkCartao: urlHttps(pagamento.linkCartao),
    linkPix: urlHttps(pagamento.linkPix),
    instrucoes: texto(pagamento.instrucoes, LIMITES.instrucoesMax),
    pixChave: chavePixValida(chave) ? chave : "",
    pixNome: textoPix(texto(pagamento.pixNome, 60), LIMITES.pixNomeMax),
    pixCidade: textoPix(texto(pagamento.pixCidade, 60), LIMITES.pixCidadeMax),
  };
  const contato = isRecord(raw.contato) ? raw.contato : {};
  base.contato = { email: texto(contato.email, LIMITES.emailMax), whatsapp: texto(contato.whatsapp, LIMITES.whatsappMax), texto: texto(contato.texto, LIMITES.contatoTextoMax) };
  const ids = new Set<string>();
  if (Array.isArray(raw.cidades)) {
    for (const item of raw.cidades) {
      if (!isRecord(item) || ids.size >= LIMITES.cidadesMax) continue;
      const id = typeof item.id === "string" && /^[a-z0-9_]{1,80}$/.test(item.id) ? item.id : "";
      const nome = texto(item.nome, LIMITES.cidadeNomeMax);
      const uf = typeof item.uf === "string" && /^[A-Za-z]{2}$/.test(item.uf) ? item.uf.toUpperCase() : "";
      if (!id || !nome || !uf || ids.has(id)) continue;
      ids.add(id);
      base.cidades.push({ id, nome, uf });
    }
  }
  return base;
};

/** O cliente pode escolher esta tela neste modelo e abrangência? (tem preço) */
export const telaOferecida = (config: ConfigContratos, modelo: Modelo, escopo: Escopo, tela: Tela): boolean => config.precos[modelo][escopo][tela] !== null;

export interface Selecao {
  modelo: Modelo;
  telas: Tela[];
  escopo: Escopo;
  /** Obrigatório quando `escopo` é "cidade"; null em "todas". */
  cidadeId: string | null;
  /** Início, em milissegundos (instante absoluto). */
  inicioMs: number;
  dias: number;
}

export interface Cotacao {
  /** Quanto vale cada tela escolhida, por dia. */
  porTela: Partial<Record<Tela, Centavos>>;
  somaTelasPorDia: Centavos;
  minimoPorDia: Centavos | null;
  /** O mínimo por dia foi maior que a soma das telas e prevaleceu. */
  minimoAplicado: boolean;
  valorPorDia: Centavos;
  dias: number;
  total: Centavos;
  inicioMs: number;
  fimMs: number;
}

/**
 * O preço: valor por dia = o MAIOR entre o mínimo por dia e a soma dos valores das telas escolhidas; total = valor por dia × dias.
 * Assume uma seleção já válida (use `validarSelecao`). Tela sem preço não entra na conta (a validação a recusa antes).
 */
export const cotar = (config: ConfigContratos, selecao: Selecao): Cotacao => {
  const tabela = config.precos[selecao.modelo][selecao.escopo];
  const porTela: Partial<Record<Tela, Centavos>> = {};
  let soma = 0;
  for (const tela of TELAS) {
    if (!selecao.telas.includes(tela)) continue;
    const valor = tabela[tela];
    if (valor === null) continue;
    porTela[tela] = valor;
    soma += valor;
  }
  const minimo = config.minimoPorDia[selecao.modelo][selecao.escopo];
  const valorPorDia = Math.max(minimo ?? 0, soma);
  return {
    porTela,
    somaTelasPorDia: soma,
    minimoPorDia: minimo,
    minimoAplicado: minimo !== null && minimo > soma,
    valorPorDia,
    dias: selecao.dias,
    total: valorPorDia * selecao.dias,
    inicioMs: selecao.inicioMs,
    fimMs: selecao.inicioMs + selecao.dias * DIA_MS,
  };
};

export type ResultadoSelecao = { ok: true; selecao: Selecao; cidade: Cidade | null; cotacao: Cotacao } | { ok: false; erros: string[] };

/**
 * Valida o que o cliente escolheu (texto vindo da rede: nada é confiado) contra a configuração e o relógio, e já devolve a cotação.
 * Os erros são mensagens prontas para mostrar.
 */
export const validarSelecao = (config: ConfigContratos, raw: unknown, nowMs: number): ResultadoSelecao => {
  if (!isRecord(raw)) return { ok: false, erros: ["Escolha inválida."] };
  const erros: string[] = [];
  const modelo = (MODELOS as readonly unknown[]).includes(raw.modelo) ? (raw.modelo as Modelo) : null;
  if (!modelo) erros.push("Escolha o modelo do anúncio.");
  const escopo = (ESCOPOS as readonly unknown[]).includes(raw.escopo) ? (raw.escopo as Escopo) : null;
  if (!escopo) erros.push("Escolha uma cidade ou todas as cidades.");

  const telas: Tela[] = [];
  if (Array.isArray(raw.telas)) {
    for (const item of raw.telas) if ((TELAS as readonly unknown[]).includes(item) && !telas.includes(item as Tela)) telas.push(item as Tela);
  }
  if (telas.length === 0) erros.push("Escolha pelo menos uma tela.");
  if (modelo && escopo && telas.some((tela) => !telaOferecida(config, modelo, escopo, tela))) erros.push("Uma das telas escolhidas não está disponível para esta combinação.");

  let cidade: Cidade | null = null;
  if (escopo === "cidade") {
    cidade = typeof raw.cidadeId === "string" ? (config.cidades.find((c) => c.id === raw.cidadeId) ?? null) : null;
    if (!cidade) erros.push("Escolha a cidade.");
  }

  const inicio = isInt(raw.inicioMs) ? raw.inicioMs : null;
  if (inicio === null) erros.push("Escolha a data e a hora de início.");
  else if (inicio < nowMs + config.antecedenciaHoras * HORA_MS - 60_000) erros.push(`O início precisa ser daqui a pelo menos ${config.antecedenciaHoras} hora(s).`);
  else if (inicio > nowMs + LIMITES.inicioMaxDias * DIA_MS) erros.push("O início está longe demais.");

  const dias = isInt(raw.dias) ? raw.dias : null;
  if (dias === null || dias < config.dias.min || dias > config.dias.max) erros.push(`Escolha entre ${config.dias.min} e ${config.dias.max} dias.`);

  if (erros.length > 0 || !modelo || !escopo || inicio === null || dias === null) return { ok: false, erros };
  const selecao: Selecao = { modelo, telas: TELAS.filter((tela) => telas.includes(tela)), escopo, cidadeId: cidade ? cidade.id : null, inicioMs: inicio, dias };
  return { ok: true, selecao, cidade, cotacao: cotar(config, selecao) };
};

// ── Fuso de Brasília (UTC−3, fixo: o Brasil não tem mais horário de verão) ──
const BRASILIA_OFFSET_MS = -3 * HORA_MS;
const pad = (n: number, tamanho = 2): string => String(n).padStart(tamanho, "0");

/** "2026-10-25T14:30" (hora de Brasília) → instante em milissegundos. Null se o texto não for uma data e hora reais. */
export const deInputBrasilia = (value: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi) - BRASILIA_OFFSET_MS;
  const volta = new Date(ms + BRASILIA_OFFSET_MS);
  // recusa datas que não existem (31/02 vira 03/03 no Date.UTC)
  return volta.getUTCFullYear() === y && volta.getUTCMonth() === mo - 1 && volta.getUTCDate() === d ? ms : null;
};

/** Instante → "2026-10-25T14:30" na hora de Brasília (valor de `<input type="datetime-local">`). */
export const paraInputBrasilia = (ms: number): string => {
  const d = new Date(ms + BRASILIA_OFFSET_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** "25/10/2026 14:30" (hora de Brasília). */
export const formatarDataHora = (ms: number): string => {
  const d = new Date(ms + BRASILIA_OFFSET_MS);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCFullYear(), 4)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// ── Dinheiro ──
/** 123450 → "R$ 1.234,50". */
export const formatarReais = (centavos: Centavos): string => {
  const negativo = centavos < 0;
  const abs = Math.abs(Math.round(centavos));
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "-" : ""}R$ ${reais},${pad(abs % 100)}`;
};

/**
 * Texto digitado → centavos. Aceita "1.234,50", "1234,5", "1234.50", "12", "R$ 12,00". Com vírgula, a vírgula é o decimal; só com ponto,
 * "1.234" é milhar e "12.5" é decimal. Recusa negativo, mais de 2 casas e valor acima do teto. Vazio ou inválido → null.
 */
export const reaisParaCentavos = (entrada: string): Centavos | null => {
  let t = entrada.replace(/R\$/gi, "").replace(/\s/g, "");
  if (!t || !/^[0-9.,]+$/.test(t)) return null;
  if (t.includes(",")) {
    if (t.indexOf(",") !== t.lastIndexOf(",")) return null;
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, "");
  } else if ((t.match(/\./g) ?? []).length > 1) {
    return null;
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const centavos = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(centavos) && centavos <= LIMITES.precoMaxCentavos ? centavos : null;
};

// ── Etapas do contrato ──
/**
 * Etapas do contrato. `pago` = pagamento confirmado, AGUARDANDO os dados do anúncio. Depois: `em_analise` (o cliente enviou o anúncio
 * e o aceite do contrato), `ajustes_solicitados` (você pediu correções; o cliente reenvia) e `aprovado` (a campanha foi criada).
 */
export const STATUS = ["aguardando_configuracao", "aguardando_pagamento", "comprovante_enviado", "pago", "em_analise", "ajustes_solicitados", "aprovado", "cancelado"] as const;
export type Status = (typeof STATUS)[number];
export type Ator = "cliente" | "admin";
export type Acao = "configurar" | "enviar_comprovante" | "confirmar_pagamento" | "pedir_novo_comprovante" | "enviar_anuncio" | "aprovar" | "pedir_ajustes" | "cancelar" | "novo_link";

export const ROTULO_STATUS: Record<Status, string> = {
  aguardando_configuracao: "Aguardando o cliente escolher",
  aguardando_pagamento: "Aguardando pagamento",
  comprovante_enviado: "Comprovante enviado",
  pago: "Pago · aguardando o anúncio",
  em_analise: "Anúncio em análise",
  ajustes_solicitados: "Ajustes solicitados",
  aprovado: "Aprovado",
  cancelado: "Cancelado",
};

const TRANSICOES: Record<Ator, Partial<Record<Acao, { de: readonly Status[]; para: Status | "mesmo" }>>> = {
  cliente: {
    // o cliente confirma o pedido (e pode refazer enquanto não enviou o comprovante)
    configurar: { de: ["aguardando_configuracao", "aguardando_pagamento"], para: "aguardando_pagamento" },
    enviar_comprovante: { de: ["aguardando_pagamento"], para: "comprovante_enviado" },
    // depois de pago, o cliente envia o anúncio (e reenvia quando você pede ajustes)
    enviar_anuncio: { de: ["pago", "ajustes_solicitados"], para: "em_analise" },
  },
  admin: {
    // o administrador pode confirmar mesmo sem comprovante (ex.: o PIX caiu na conta e o cliente não mandou a imagem)
    confirmar_pagamento: { de: ["aguardando_pagamento", "comprovante_enviado"], para: "pago" },
    pedir_novo_comprovante: { de: ["comprovante_enviado"], para: "aguardando_pagamento" },
    aprovar: { de: ["em_analise"], para: "aprovado" },
    pedir_ajustes: { de: ["em_analise"], para: "ajustes_solicitados" },
    // um contrato APROVADO já virou campanha: para tirar do ar, pause ou arquive a campanha (não se cancela o contrato)
    cancelar: { de: ["aguardando_configuracao", "aguardando_pagamento", "comprovante_enviado", "pago", "em_analise", "ajustes_solicitados"], para: "cancelado" },
    novo_link: { de: ["aguardando_configuracao", "aguardando_pagamento", "comprovante_enviado", "pago", "em_analise", "ajustes_solicitados", "aprovado"], para: "mesmo" },
  },
};

/** O status depois da ação, ou null se esta pessoa não pode fazer isso neste status. */
export const proximoStatus = (status: Status, acao: Acao, ator: Ator): Status | null => {
  const regra = TRANSICOES[ator][acao];
  if (!regra || !regra.de.includes(status)) return null;
  return regra.para === "mesmo" ? status : regra.para;
};

/** O link expirou? Cancelado nunca vale; pago vale até o `tokenExpiresAt` (que a confirmação do pagamento estende até o fim do anúncio). */
export const linkExpirado = (contrato: { status: Status; tokenExpiresAt: number }, nowMs: number): boolean => contrato.status === "cancelado" || contrato.tokenExpiresAt <= nowMs;

/** Depois do pagamento, o link vale SÓ até o fim do anúncio contratado (nem antes, nem depois). */
export const validadeAposPagamento = (fimMs: number): number => fimMs;

/** Etapas depois do pagamento e ANTES da aprovação: o cliente ainda pode precisar do link (enviar o anúncio, corrigir). */
export const ETAPAS_DO_ANUNCIO: readonly Status[] = ["pago", "em_analise", "ajustes_solicitados"];

/**
 * Validade de um link NOVO. Antes do pagamento: a validade padrão. Depois do pagamento e antes da aprovação: o fim do período
 * contratado, mas nunca menos que 7 dias (o cliente pode demorar a mandar o anúncio e o contrato mantém os dias: o início passa a ser
 * a aprovação). Aprovado: só até o fim do anúncio. Devolve null quando não há o que abrir (anúncio aprovado que já terminou).
 */
export const validadeDoLinkNovo = (c: { status: Status; fimMs: number | null }, nowMs: number, validadeLinkDias: number): number | null => {
  if (c.status === "aprovado") return c.fimMs !== null && c.fimMs > nowMs ? c.fimMs : null;
  if (ETAPAS_DO_ANUNCIO.includes(c.status)) return Math.max(c.fimMs ?? 0, nowMs + 7 * DIA_MS);
  return nowMs + validadeLinkDias * DIA_MS;
};

/**
 * Datas do anúncio ao APROVAR. Se o início combinado já passou (o pagamento ou o envio atrasaram), o anúncio começa AGORA e mantém os
 * dias contratados (o cliente não perde dias). Senão, vale o combinado.
 */
export const datasAoAprovar = (pedido: { inicioMs: number; dias: number }, nowMs: number): { inicioMs: number; fimMs: number; deslocado: boolean } => {
  const deslocado = pedido.inicioMs < nowMs;
  const inicioMs = deslocado ? nowMs : pedido.inicioMs;
  return { inicioMs, fimMs: inicioMs + pedido.dias * DIA_MS, deslocado };
};
