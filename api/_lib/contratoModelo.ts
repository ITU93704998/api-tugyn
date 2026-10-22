import { createHash } from "node:crypto";

/**
 * O contrato em PDF (modelo único para os anunciantes): o administrador envia pelo painel, o arquivo vai para o Cloudinary (privado) e
 * o cliente o abre por um endereço temporário. Cada envio novo é uma VERSÃO nova; o aceite do cliente guarda a versão e o hash do
 * arquivo que ele leu (prova de qual texto foi aceito).
 */
export const MODELO_DOC = "adsConfig/contratoModelo";
/** O PDF vai em base64 dentro do JSON (a função da Vercel aceita ~4,5 MB por requisição): 3 MB já decodificados. */
export const PDF_MAX_BYTES = 3 * 1024 * 1024;
export const PDF_URL_SEGUNDOS = 300;
export const VERSOES_GUARDADAS = 20;

export interface VersaoModelo {
  versao: number;
  nome: string;
  bytes: number;
  /** SHA-256 do arquivo (em hexadecimal). */
  sha256: string;
  publicId: string;
  enviadoEm: number;
}

export interface ContratoModelo extends VersaoModelo {
  enviadoPor: string;
  /** As versões anteriores (a mais recente primeiro), para o aceite de contratos antigos continuar rastreável. */
  anteriores: VersaoModelo[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

const parseVersao = (raw: unknown): VersaoModelo | null => {
  if (!isRecord(raw) || typeof raw.publicId !== "string" || !raw.publicId || !/^[0-9a-f]{64}$/.test(String(raw.sha256)) || num(raw.versao) < 1) return null;
  return { versao: num(raw.versao), nome: str(raw.nome, 80), bytes: num(raw.bytes), sha256: String(raw.sha256), publicId: raw.publicId, enviadoEm: num(raw.enviadoEm) };
};

/** Lê o documento com cuidado. Null se não houver um contrato cadastrado (ou se estiver quebrado). */
export const parseModelo = (raw: unknown): ContratoModelo | null => {
  const atual = parseVersao(raw);
  if (!atual || !isRecord(raw)) return null;
  const anteriores = Array.isArray(raw.anteriores) ? raw.anteriores.map(parseVersao).filter((v): v is VersaoModelo => v !== null).slice(0, VERSOES_GUARDADAS) : [];
  return { ...atual, enviadoPor: str(raw.enviadoPor, 128), anteriores };
};

export type PdfValido = { ok: true; buffer: Buffer; bytes: number; sha256: string; dataUri: string } | { ok: false; error: string };

/** PDF recebido (data URL base64): confere o tipo pelos primeiros bytes (não pelo que o navegador diz), o tamanho e calcula o hash. */
export const validarPdf = (valor: unknown): PdfValido => {
  if (typeof valor !== "string") return { ok: false, error: "Envie o arquivo PDF do contrato." };
  const m = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(valor);
  if (!m) return { ok: false, error: "Envie o contrato como arquivo PDF." };
  const buffer = Buffer.from(m[1], "base64");
  if (buffer.length === 0) return { ok: false, error: "O arquivo está vazio." };
  if (buffer.length > PDF_MAX_BYTES) return { ok: false, error: "O PDF passa de 3 MB. Comprima o arquivo e envie de novo." };
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") return { ok: false, error: "O arquivo não é um PDF válido." };
  return { ok: true, buffer, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"), dataUri: valor };
};

/** Nome para mostrar: só o nome do arquivo (sem pasta), sem caracteres de controle, até 80, sempre terminando em .pdf. */
export const limparNomePdf = (nome: unknown): string => {
  const base = typeof nome === "string" ? (nome.split(/[\\/]/).pop() ?? "") : "";
  const limpo = base.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/\.pdf$/i, "").trim();
  return `${(limpo || "contrato").slice(0, 76)}.pdf`;
};

/** A versão nova, guardando a anterior no histórico. */
export const proximaVersao = (atual: ContratoModelo | null, novo: { nome: string; bytes: number; sha256: string; publicId: string }, agora: number, uid: string): ContratoModelo => {
  const resumo = (v: VersaoModelo): VersaoModelo => ({ versao: v.versao, nome: v.nome, bytes: v.bytes, sha256: v.sha256, publicId: v.publicId, enviadoEm: v.enviadoEm });
  return {
    versao: (atual ? atual.versao : 0) + 1,
    nome: novo.nome,
    bytes: novo.bytes,
    sha256: novo.sha256,
    publicId: novo.publicId,
    enviadoEm: agora,
    enviadoPor: uid,
    anteriores: atual ? [resumo(atual), ...atual.anteriores.map(resumo)].slice(0, VERSOES_GUARDADAS) : [],
  };
};

/** Procura uma versão (a atual ou uma anterior). */
export const acharVersao = (modelo: ContratoModelo, versao: number | undefined): VersaoModelo | null => (versao === undefined || versao === modelo.versao ? modelo : (modelo.anteriores.find((v) => v.versao === versao) ?? null));
