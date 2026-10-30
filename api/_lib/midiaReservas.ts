import type { TipoDeImagem } from "./mediaCooldown";
import { bannerParaApagar } from "./turmaGestao";

/**
 * Troca de foto de perfil / banner de turma em etapas recuperáveis (parte PURA; quem lê e grava é `midiaReservasJob.ts`).
 *
 *  1. RESERVA (`midiaReservas/{id}`, numa transação com o prazo de 7 dias): uma troca por vez por alvo; outra chamada ao
 *     mesmo tempo recebe 409. A reserva já guarda o `public_id` que será usado (dá para limpar mesmo se a função morrer).
 *  2. ENVIO para um id NOVO (nunca sobrescreve nem invalida a imagem publicada).
 *  3. CONFIRMAÇÃO: a referência (perfil/turma) passa a apontar para a imagem nova e a troca da semana é consumida.
 *     Foto: a API confirma (`action: "confirmar"`). Banner e apps antigos: o app grava a referência (as regras conferem o prazo).
 *  4. Foto confirmada: é PROMOVIDA para o id fixo `profile` (as cópias da URL em turmas, partidas e desafios continuam valendo);
 *     o id temporário é apagado um dia depois. Banner: o id novo já é o definitivo; o antigo é apagado.
 *  5. A rotina diária resolve toda reserva vencida: referenciada → conclui; não referenciada → apaga o envio órfão.
 */

/** Por quanto tempo uma reserva segura o alvo (o envio + a confirmação cabem com folga). */
export const RESERVA_MS = 10 * 60_000;
/** Depois de promovida, a foto temporária ainda fica este tempo (alguém pode ter copiado a URL nesse meio-tempo). */
export const GUARDAR_TEMPORARIA_MS = 24 * 3600_000;
export const ID_FIXO_DO_AVATAR = "profile";

export type EstadoDaReserva = "reservada" | "enviada" | "confirmada" | "promovida" | "falhou";

export interface Reserva {
  uid: string;
  tipo: TipoDeImagem;
  estado: EstadoDaReserva;
  /** `public_id` completo do envio (com a pasta). */
  publicId: string;
  bucket: string;
  turmaId?: string | null;
  url?: string | null;
  anterior?: { url?: string | null; publicId?: string | null } | null;
}

/** Um alvo por chave: a foto de cada pessoa e o banner de cada turma. */
export const chaveDaReserva = (uid: string, tipo: TipoDeImagem, turmaId?: string): string =>
  tipo === "fotoPerfil" ? `foto_${uid}` : `banner_${turmaId}`;

/** Nome do arquivo no Cloudinary: foto → temporário (`tmp_`), promovido depois; banner → definitivo. */
export const nomeDoEnvio = (tipo: TipoDeImagem, aleatorio: string, agoraMs: number): string =>
  `${tipo === "fotoPerfil" ? "tmp" : "b"}_${agoraMs.toString(36)}_${aleatorio}`;

/** Segura o alvo: ainda dentro do prazo e sem desfecho. */
export const reservaAtiva = (r: { estado?: unknown; expiraEmMs?: number | null }, agoraMs: number): boolean =>
  (r.estado === "reservada" || r.estado === "enviada") && typeof r.expiraEmMs === "number" && r.expiraEmMs > agoraMs;

/** `public_id` de uma URL de entrega do Cloudinary (`.../image/upload/[v123/]<id>.<ext>`), ou null. */
export const publicIdDaUrl = (url: unknown): string | null => {
  if (typeof url !== "string") return null;
  const match = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(.+)$/.exec(url.split("?")[0]);
  if (!match) return null;
  const segmentos = match[1].split("/");
  const versao = segmentos.findIndex((s) => /^v\d+$/.test(s));
  const caminho = (versao >= 0 ? segmentos.slice(versao + 1) : segmentos).join("/").replace(/\.[A-Za-z0-9]+$/, "");
  return caminho && !caminho.includes("..") ? caminho : null;
};

/** A referência atual (URL gravada no perfil/turma) aponta para este envio? */
export const referenciaAponta = (url: unknown, publicId: string): boolean => publicIdDaUrl(url) === publicId;

export type PassoDaReserva = "promover" | "concluir" | "apagar_envio";

/**
 * O que a rotina faz com uma reserva vencida. Referenciada = confirmada (pela API, pelo app antigo ou pelo cadastro):
 * foto → promover para o id fixo; banner → concluir (apagar o anterior). Não referenciada → o envio não está em uso
 * (nunca confirmado, já promovido ou trocado de novo) e é apagado.
 */
export const proximoPasso = (r: Pick<Reserva, "tipo">, referenciada: boolean): PassoDaReserva => {
  if (!referenciada) return "apagar_envio";
  return r.tipo === "fotoPerfil" ? "promover" : "concluir";
};

/**
 * Imagem anterior que pode ser apagada depois da troca concluída: só a do próprio dono/turma, nunca o envio novo nem o id fixo
 * do avatar (ele recebe a foto nova). Devolve { bucket, publicId } ou null.
 */
export const anteriorParaApagar = (r: Reserva): { bucket: string; publicId: string } | null => {
  const anterior = r.anterior ?? null;
  if (!anterior) return null;
  if (r.tipo === "bannerTurma") {
    const banner = typeof anterior.url === "string" ? bannerParaApagar(anterior.url) : null;
    return banner && banner.publicId !== r.publicId ? banner : null;
  }
  const id = (typeof anterior.publicId === "string" && anterior.publicId) || publicIdDaUrl(anterior.url);
  const pasta = `usuarios/${r.uid}/`;
  if (!id || !id.startsWith(pasta) || id === r.publicId || id.endsWith(`/${ID_FIXO_DO_AVATAR}`)) return null;
  return /^[A-Za-z0-9_\-./]+$/.test(id) ? { bucket: "usuarios", publicId: id } : null;
};
