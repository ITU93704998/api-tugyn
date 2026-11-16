/**
 * Links curtos compartilhados (domínio https://link.tugyntec.com.br, o mesmo projeto da API; vercel.json reescreve):
 *
 *   /campeonato/<codigo>   campeonato entre times: os 10 primeiros caracteres do id (`ct_<24 hex>` → `e2b8902acd`)
 *   /turma/<codigo>        turma: o código de convite de 6 letras (turmas antigas sem código: o id da turma)
 *   /time/<linkId>         página pública do time (linkId de 16 letras/números)
 *   /convocacao/<codigo>   link de convocação de 1 hora
 *   /imagem/<tipo>/<id>    a imagem da prévia (1200x630) que o WhatsApp mostra
 *
 * Os links antigos (/api/turma/..., /api/time/..., /api/campeonato/...) continuam funcionando em qualquer domínio.
 * O código do campeonato não é guardado em lugar nenhum: sai do id (que já é aleatório) e volta por uma consulta de
 * intervalo pelo id do documento. 10 caracteres hexadecimais = 40 bits: colisão só com centenas de milhares de
 * campeonatos, e mesmo assim o servidor recusa o código ambíguo em vez de abrir o campeonato errado.
 */
import { FieldPath, type Firestore } from "firebase-admin/firestore";

export const DOMINIO_LINK_CURTO = "link.tugyntec.com.br";
export const CODIGO_TURMA = /^[A-HJKMNP-Z2-9]{6}$/;
export const CODIGO_CAMPEONATO = /^[a-f0-9]{10}$/;
const ID_CAMPEONATO = /^ct_[a-f0-9]{24}$/;

export const codigoDoCampeonato = (id: string): string => (ID_CAMPEONATO.test(id) ? id.slice(3, 13) : id);

export type TipoLink = "turma" | "time" | "convite" | "campeonato";
/** Caminho bonito de cada tipo (o que vai no link e no og:url). */
export const caminhoPublico = (tipo: TipoLink, id: string): string => {
  const pasta = tipo === "campeonato" ? "campeonato" : tipo === "convite" ? "convocacao" : tipo === "time" ? "time" : "turma";
  return `/${pasta}/${encodeURIComponent(tipo === "campeonato" ? codigoDoCampeonato(id) : id)}`;
};

/** Id completo do campeonato pelo código curto; null se não existir ou se o código for ambíguo. */
export const campeonatoPorCodigo = async (db: Firestore, codigo: string): Promise<string | null> => {
  if (!CODIGO_CAMPEONATO.test(codigo)) return null;
  const inicio = `ct_${codigo}`;
  const snap = await db
    .collection("campeonatosTimes")
    .orderBy(FieldPath.documentId())
    .startAt(inicio)
    .endAt(`${inicio}`)
    .limit(2)
    .select()
    .get();
  return snap.docs.length === 1 ? snap.docs[0].id : null;
};

/** Id da turma pelo código de convite (codigosConvite/<codigo> → turmaId); null se não existir. */
export const turmaPorCodigo = async (db: Firestore, codigo: string): Promise<string | null> => {
  if (!CODIGO_TURMA.test(codigo)) return null;
  const snap = await db.collection("codigosConvite").doc(codigo).get();
  const turmaId = snap.exists ? snap.get("turmaId") : null;
  return typeof turmaId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(turmaId) ? turmaId : null;
};
