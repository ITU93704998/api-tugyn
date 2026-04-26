import { VercelRequest, VercelResponse } from '@vercel/node';
import { v2 as cloudinary } from 'cloudinary';

// Mapeamento das contas no servidor
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
  if (req.method !== 'POST') return res.status(405).send('Apenas POST permitido');

  const { image, userId, bucket, folderName } = req.body;

  // 1. Validar se o bucket existe nas nossas configurações
  const config = ACCOUNTS_CONFIG[bucket as keyof typeof ACCOUNTS_CONFIG];
  
  if (!config || !config.cloud_name) {
    return res.status(400).json({ error: 'Bucket inválido ou não configurado.' });
  }

  // 2. Configurar o Cloudinary com a conta correta para esta requisição
  cloudinary.config(config);

  try {
    // 3. Fazer o Upload
    const result = await cloudinary.uploader.upload(image, {
      // Se for perfil, usamos um ID fixo para sobrescrever. 
      // Se for outra coisa, podemos deixar o Cloudinary gerar o ID.
      public_id: folderName === 'profile' ? 'profile' : undefined,
      folder: `${bucket}/${userId}/${folderName || ''}`,
      overwrite: true,
      invalidate: true,
      resource_type: 'image'
    });

    return res.status(200).json({ 
      url: result.secure_url, 
      public_id: result.public_id 
    });
  } catch (error) {
    return res.status(500).json({ error: (error as any).message });
  }
}