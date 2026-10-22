/**
 * A SOLICITAÇÃO feita por quem quer anunciar, pela página pública (sem login): empresa, e-mail e WhatsApp. O administrador aprova
 * (vira um contrato comum) ou exclui. Lógica PURA, idêntica no painel (formulário) e no servidor (validação de verdade).
 */
export const SOLICITACAO_LIMITES = { nome: 80, email: 120, whatsapp: 30, mensagem: 300 } as const;

export interface DadosSolicitacao {
  nome: string;
  email: string;
  whatsapp: string;
  mensagem: string;
}

export type ErrosSolicitacao = Partial<Record<keyof DadosSolicitacao, string>>;
export type ResultadoSolicitacao = { ok: true; dados: DadosSolicitacao; whatsappDigitos: string } | { ok: false; erros: ErrosSolicitacao };

const limpar = (valor: unknown, max: number): string => (typeof valor === "string" ? valor.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WHATSAPP = /^[0-9+()\-\s]{8,30}$/;

export const soDigitos = (valor: string): string => valor.replace(/\D/g, "");

/**
 * Valida o que a pessoa digitou. Nome, e-mail e WhatsApp são obrigatórios (o link do contrato vai pelo WhatsApp). O WhatsApp precisa ter
 * DDD: de 10 a 13 dígitos (com ou sem o 55 do Brasil). Mensagens prontas para mostrar abaixo de cada campo.
 */
export const validarSolicitacao = (raw: unknown): ResultadoSolicitacao => {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const erros: ErrosSolicitacao = {};
  const nome = limpar(r.nome, SOLICITACAO_LIMITES.nome);
  if (!nome) erros.nome = "Informe o nome da empresa ou do anunciante.";
  const email = limpar(r.email, SOLICITACAO_LIMITES.email);
  if (!email) erros.email = "Informe o seu e-mail.";
  else if (!EMAIL.test(email)) erros.email = "E-mail inválido. Confira o @ e o final (por exemplo, .com).";
  const whatsapp = limpar(r.whatsapp, SOLICITACAO_LIMITES.whatsapp);
  const digitos = soDigitos(whatsapp);
  if (!whatsapp) erros.whatsapp = "Informe o seu WhatsApp, com DDD.";
  else if (!WHATSAPP.test(whatsapp) || digitos.length < 10 || digitos.length > 13) erros.whatsapp = "WhatsApp inválido. Use o DDD e o número, por exemplo (63) 90000-0000.";
  const mensagem = limpar(r.mensagem, SOLICITACAO_LIMITES.mensagem);
  if (typeof r.mensagem === "string" && r.mensagem.trim().length > SOLICITACAO_LIMITES.mensagem) erros.mensagem = `No máximo ${SOLICITACAO_LIMITES.mensagem} caracteres.`;
  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return { ok: true, dados: { nome, email, whatsapp, mensagem }, whatsappDigitos: digitos };
};
