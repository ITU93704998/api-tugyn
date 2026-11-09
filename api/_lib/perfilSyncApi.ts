import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";
import { enfileirarPerfil } from "./perfilSync";

/** Reparação do próprio perfil para contas anteriores ao gatilho; identidade sempre vem do servidor. */
export async function handlePerfilSync(req:VercelRequest,res:VercelResponse){
  if(handleCors(req,res))return;
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST"){res.setHeader("Allow","POST, OPTIONS");return res.status(405).json({error:"Método não permitido."});}
  const user=await requireUser(req,res,"perfil-sync");if(!user)return;
  if(!await dentroDoLimite(user.uid,"perfil-sync",6,3600))return res.status(429).json({error:"Aguarde antes de solicitar novamente."});
  try{
    await enfileirarPerfil(getFirestore(getFirebaseApp()),user.uid);
    return res.status(200).json({ok:true});
  }catch{
    console.error(JSON.stringify({evt:"perfil_sync_enqueue_failed"}));
    return res.status(503).json({error:"Não foi possível agendar a atualização do perfil."});
  }
}
