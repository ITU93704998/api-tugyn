import { v2 as cloudinary } from "cloudinary";
import { USER_BUCKETS, getAccount } from "./config";

const MAX_PAGINAS = 20; // cada chamada apaga até 1000 imagens

interface ResultadoApagar {
  next_cursor?: string;
  partial?: boolean;
}

/** Repete a chamada enquanto o Cloudinary disser que ainda há mais para apagar. */
const esgotar = async (chamar: (cursor?: string) => Promise<ResultadoApagar>): Promise<void> => {
  let cursor: string | undefined;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const resultado = await chamar(cursor);
    if (!resultado.partial || !resultado.next_cursor) return;
    cursor = resultado.next_cursor;
  }
  throw new Error("Cloudinary: ainda há imagens depois do limite de páginas");
};

/** Contas com imagens de usuários que estão sem credenciais no ambiente (a rotina diária alerta; a exclusão fica pendente). */
export const bucketsSemCredenciais = (): string[] => USER_BUCKETS.filter((bucket) => !getAccount(bucket));

/**
 * Apaga todas as imagens do usuário nas contas do Cloudinary: as marcadas com a tag `uid_<uid>` (todas
 * as novas) e as que estiverem na pasta `<bucket>/<uid>/` (as antigas, anteriores à tag).
 * Buckets sem credenciais no ambiente NÃO são apagados: voltam em `avisos` e quem chama mantém a etapa pendente.
 */
export const apagarImagensDoUsuario = async (uid: string): Promise<string[]> => {
  const avisos: string[] = [];

  for (const bucket of USER_BUCKETS) {
    const conta = getAccount(bucket);
    if (!conta) {
      avisos.push(`bucket_${bucket}_sem_credenciais`);
      continue;
    }
    const opcoes = { ...conta, resource_type: "image", invalidate: true };

    await esgotar((cursor) =>
      cloudinary.api.delete_resources_by_tag(`uid_${uid}`, { ...opcoes, next_cursor: cursor }) as Promise<ResultadoApagar>,
    );
    await esgotar((cursor) =>
      cloudinary.api.delete_resources_by_prefix(`${bucket}/${uid}/`, { ...opcoes, next_cursor: cursor }) as Promise<ResultadoApagar>,
    );

    // A pasta fica vazia: apagá-la é só arrumação (pode falhar sem problema).
    try {
      await cloudinary.api.delete_folder(`${bucket}/${uid}`, conta);
    } catch {
      // ignora
    }
  }
  return avisos;
};
