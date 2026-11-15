// Executar da pasta notifications-functions, DEPOIS de npm run build.
// Apenas lista por padrão. --aplicar grava as galerias pelo mesmo reconciliador do gatilho.
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getFirestore,FieldPath}=require('firebase-admin/firestore');
const {sincronizarTrofeusTimes}=require('../lib/api/_lib/campeonatosTimesTrofeusSync.js');
const args=process.argv.slice(2),projeto=args.find(a=>a.startsWith('--projeto='))?.slice(10);
if(!projeto||!/^[-a-z0-9]+$/.test(projeto)||args.some(a=>a!=='--aplicar'&&!a.startsWith('--projeto=')))throw Error('Use --projeto=ID [--aplicar]. Requer credencial Admin/ADC; não use credenciais do app.');
initializeApp({credential:applicationDefault(),projectId:projeto});
const db=getFirestore(),aplicar=args.includes('--aplicar');
(async()=>{
 let cursor=null,total=0;
 console.log(`Projeto: ${projeto}. Modo: ${aplicar?'APLICAR':'SÓ LISTAR (sem gravações)'}`);
 for(;;){
  let q=db.collection('campeonatosTimes').where('status','==','encerrado').orderBy(FieldPath.documentId()).limit(50);
  if(cursor)q=q.startAfter(cursor);
  const pagina=await q.get();if(pagina.empty)break;
  for(const s of pagina.docs){console.log(s.id,aplicar?await sincronizarTrofeusTimes(db,s.id):'pendente de aplicação');total++;}
  cursor=pagina.docs.at(-1);
 }
 console.log(`${total} campeonato(s) encerrado(s) conferido(s).`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
