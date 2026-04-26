import { VercelRequest, VercelResponse } from '@vercel/node';
import { v2 as cloudinary } from 'cloudinary';

// O mesmo mapeamento de contas que usamos no upload
const ACCOUNTS_CONFIG = {
  usuarios: {
    cloud_name: process.env.CLOUDINARY_NAME_USUARIOS,
    api_key: process.env.CLOUDINARY_KEY_USUARIOS,
    api_secret: process.env.CLOUDINARY_SECRET_USUARIOS,
  },
  times: {
    cloud_name: process.env.CLOUDINARY_NAME_TIMES,
    api_key: process.env.CLOUDINARY_KEY_TIMES,
    api_secret: process.env.CLOUDINARY_SECRET_TIMES,
  },
  arenas: {
    cloud_name: process.env.CLOUDINARY_NAME_ARENAS,
    api_key: process.env.CLOUDINARY_KEY_ARENAS,
    api_secret: process.env.CLOUDINARY_SECRET_ARENAS,
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Garantir que a requisição seja POST
  if (req.method !== 'POST') return res.status(405).send('Método Não Permitido');

  const { public_id, bucket } = req.body;

  // 1. Validar se o bucket foi enviado e existe na config
  const config = ACCOUNTS_CONFIG[bucket as keyof typeof ACCOUNTS_CONFIG];
  
  if (!config || !config.cloud_name) {
    return res.status(400).json({ error: 'Bucket inválido ou não configurado para exclusão.' });
  }

  // 2. Configurar o Cloudinary com a conta correta
  cloudinary.config(config);

  try {
    // 3. Deletar a imagem
    // O public_id completo geralmente é algo como "usuarios/ID_USER/profile"
    const result = await cloudinary.uploader.destroy(public_id, {
      invalidate: true, // Limpa o cache da CDN para que a imagem suma na hora
    });

    if (result.result === 'not found') {
      return res.status(404).json({ message: 'Imagem não encontrada no Cloudinary.' });
    }

    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: (error as any).message });
  }
}