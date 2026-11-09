import { createHash, randomBytes } from "node:crypto";
import { FieldPath, FieldValue, type Firestore, type Query, type QuerySnapshot } from "firebase-admin/firestore";
import { isSafeUid } from "./validation";

/** Uma tarefa/recibo por conta, privado; só trabalha quando a identidade muda. */
export const PERFIL_SYNC = "perfilSyncJobs";
const PAGE = 15, DONE = Number.MAX_SAFE_INTEGER;
type Data = Record<string, any>;
const map = (x: unknown): Data => x && typeof x === "object" && !Array.isArray(x) ? x as Data : {};
const text = (x: unknown, n: number) => typeof x === "string" ? x.slice(0,n) : "";
export function identidade(d: Data) {
  return { nome:text(d.name,80).trim(), foto:text(d.profileImage,500), userName:text(d.userName,30) };
}
const keyOf = (d: Data) => createHash("sha256").update(JSON.stringify(identidade(d))).digest("hex");
const disponivel = (d: Data | undefined) => !!d && d.status!=="suspended" && d.excluindoEm==null;
export const mudouIdentidade = (a: Data | undefined,b: Data | undefined) => !!b && (!a || keyOf(a)!==keyOf(b));
const novoJob = (uid:string,key:string,now:number) => ({uid,key,etapa:0,cursor:null,concluido:false,nextAttemptAt:now,attempts:0,lease:null,leaseUntil:0,atualizadoEm:FieldValue.serverTimestamp()});

export async function enfileirarPerfil(db:Firestore,uid:string,now=Date.now()):Promise<boolean> {
  if(!isSafeUid(uid))return false;
  return db.runTransaction(async tx=>{
    const ref=db.doc(`${PERFIL_SYNC}/${uid}`);
    const [p,j]=await Promise.all([tx.get(db.doc(`users/${uid}`)),tx.get(ref)]);
    const profile=p.data();
    if(!disponivel(profile)){if(j.exists)tx.delete(ref);return false;}
    const key=keyOf(profile!);
    if(j.data()?.key===key)return !j.data()?.concluido;
    tx.set(ref,novoJob(uid,key,now));return true;
  });
}

// Consultas com um filtro e ordem de documento, sem varrer todos os usuários.
const fases=[
  ["turmas","participantes"],["turmas","pendingParticipants"],["turmas","creatorId"],
  ["times","membros"],["times","convidados"],["times","solicitantes"],
  ["desafios","participantes"],
] as const;
function consulta(db:Firestore,uid:string,etapa:number,cursor:string|null):Query {
  const [collection,field]=fases[etapa];
  let q=db.collection(collection).where(field,field==="creatorId"?"==":"array-contains",uid).orderBy(FieldPath.documentId()).limit(PAGE);
  if(cursor)q=q.startAfter(cursor);
  return q;
}
class MudouPerfil extends Error {}
/** Só identidade: nunca sobrescrever estatísticas, datas de entrada ou resultados. */
export function patchIdentidade(old:Data,prefix:string,value:Data):Data {
  const patch:Data={};for(const [k,v]of Object.entries(value))if(old[k]!==v)patch[`${prefix}.${k}`]=v;
  return patch;
}
async function atualizarAlvo(db:Firestore,uid:string,job:Data,lease:string,path:string):Promise<void> {
  await db.runTransaction(async tx=>{
    const ref=db.doc(path),jobRef=db.doc(`${PERFIL_SYNC}/${uid}`);
    const [p,j,s]=await Promise.all([tx.get(db.doc(`users/${uid}`)),tx.get(jobRef),tx.get(ref)]);
    if(j.data()?.key!==job.key || j.data()?.lease!==lease)throw new MudouPerfil();
    const profile=p.data();
    if(!disponivel(profile)||keyOf(profile!)!==job.key)throw new MudouPerfil();
    if(!s.exists)return;
    const d=s.data()!,id=identidade(profile!),isTurma=path.startsWith("turmas/");
    if(isTurma){
      const member=Array.isArray(d.participantes)&&d.participantes.includes(uid);
      const pending=Array.isArray(d.pendingParticipants)&&d.pendingParticipants.includes(uid);
      const owner=d.creatorId===uid;
      if(!member&&!pending&&!owner)return;
      const partRef=db.doc(`${path}/participantes/${uid}`),resumoRef=db.doc(`${path}/resumo/atual`);
      // Só o jogo atual: partidas históricas mantêm o registro do que aconteceu.
      const dia=new Date(Date.now()-3*3600_000).toISOString().slice(0,10).replace(/-/g,"");
      const gameRef=db.doc(`${path}/jogos/${dia}`);
      const [part,resumo,game]=await Promise.all([tx.get(partRef),tx.get(resumoRef),tx.get(gameRef)]);
      if(part.exists&&(member||pending||owner)){
        const before=part.data()!,patch:Data={};
        if(before.nome!==id.nome&&id.nome)patch.nome=id.nome;
        if(before.urlPhoto!==id.foto)patch.urlPhoto=id.foto;
        if(Object.keys(patch).length)tx.update(partRef,{...patch,atualizadoEm:FieldValue.serverTimestamp()});
      }
      const entry=map(resumo.data()?.membros)[uid];
      if(member&&entry&&part.data()?.status==="aprovado"){
        const patch=patchIdentidade(map(entry),`membros.${uid}`,{...(id.nome?{nome:id.nome}:{}),urlPhoto:id.foto});
        if(Object.keys(patch).length)tx.update(resumoRef,{...patch,atualizadoEm:FieldValue.serverTimestamp()});
      }
      const confirmed=map(game.data()?.confirmados)[uid];
      if((member||owner)&&confirmed&&game.data()?.status==="aberta"){
        const patch=patchIdentidade(map(confirmed),`confirmados.${uid}`,{...(id.nome?{nome:id.nome.slice(0,60)}:{}),urlPhoto:id.foto});
        if(Object.keys(patch).length)tx.update(gameRef,patch);
      }
      if(owner){
        const patch:Data={};if(id.nome&&d.creatorName!==id.nome)patch.creatorName=id.nome;
        if(d.creatorPhoto!==id.foto)patch.creatorPhoto=id.foto;
        if(Object.keys(patch).length)tx.update(ref,patch);
      }
    }else if(path.startsWith("times/")){
      const patch:Data={};
      for(const [field,list]of [["jogadores","membros"],["convites","convidados"],["pedidos","solicitantes"]]){
        if(!Array.isArray(d[list])||!d[list].includes(uid))continue;
        const entry=map(d[field])[uid];if(!entry)continue;
        Object.assign(patch,patchIdentidade(map(entry),`${field}.${uid}`,{...(id.nome?{nome:id.nome}:{}),foto:id.foto,userName:id.userName}));
      }
      if(Object.keys(patch).length)tx.update(ref,{...patch,atualizadoEm:FieldValue.serverTimestamp()});
    }else{
      const patch:Data={};
      for(const [side,field]of [["desafiante","desafianteId"],["desafiado","desafiadoId"]])if(d[field]===uid){
        Object.assign(patch,patchIdentidade(map(d[side]),side,{...(id.nome?{nome:id.nome}:{}),foto:id.foto}));
      }
      if(Object.keys(patch).length)tx.update(ref,patch);
    }
  });
}

/** Fila recuperável com paginação, lease e fonte canônica dentro de cada transação. */
export async function processarPerfil(db:Firestore,uid:string,deadline=Date.now()+20_000):Promise<void> {
  if(!isSafeUid(uid)||Date.now()>deadline-2000)return;
  const ref=db.doc(`${PERFIL_SYNC}/${uid}`),lease=randomBytes(12).toString("hex");
  let job:Data|undefined=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),d=snap.data();
    if(!d||d.concluido||d.nextAttemptAt>Date.now()||d.leaseUntil>Date.now())return undefined;
    tx.update(ref,{lease,leaseUntil:Date.now()+45_000});return d;
  });
  if(!job)return;
  try{
    while(job.etapa<fases.length&&Date.now()<deadline-4000){
      const page:QuerySnapshot=await consulta(db,uid,job.etapa,job.cursor).get();
      // Página incompleta é repetida em caso de interrupção; comparações evitam regravações.
      for(const doc of page.docs){if(Date.now()>deadline-3000)return;await atualizarAlvo(db,uid,job,lease,doc.ref.path);}
      const etapa:number=page.size<PAGE?job.etapa+1:job.etapa;
      const cursor:string|null=page.size<PAGE?null:page.docs[page.docs.length-1].id;
      const advanced=await db.runTransaction(async tx=>{
        const current=(await tx.get(ref)).data();
        if(current?.key!==job!.key||current?.lease!==lease)return false;
        tx.update(ref,{etapa,cursor,concluido:etapa>=fases.length,nextAttemptAt:etapa>=fases.length?DONE:Date.now(),atualizadoEm:FieldValue.serverTimestamp()});return true;
      });
      if(!advanced)return;job={...job,etapa,cursor};
    }
  }catch(e){
    if(e instanceof MudouPerfil){await enfileirarPerfil(db,uid);return;}
    await db.runTransaction(async tx=>{
      const current=(await tx.get(ref)).data();if(current?.key!==job!.key||current?.lease!==lease)return;
      const attempts=Number(current.attempts||0)+1;
      tx.update(ref,{attempts,nextAttemptAt:Date.now()+Math.min(900_000,60_000*2**Math.min(attempts-1,4))});
    });throw e;
  }finally{
    await db.runTransaction(async tx=>{
      const current=(await tx.get(ref)).data();if(current?.lease!==lease)return;
      tx.update(ref,{lease:null,leaseUntil:0});
    });
  }
}

export async function recuperarPerfis(db:Firestore,deadline=Date.now()+15_000):Promise<void> {
  if(Date.now()>deadline-2500)return;
  const jobs=await db.collection(PERFIL_SYNC).where("nextAttemptAt","<=",Date.now()).limit(3).get();
  for(const job of jobs.docs){if(Date.now()>deadline-2500)break;try{await processarPerfil(db,job.id,deadline);}catch{console.error(JSON.stringify({evt:"perfil_sync_retry"}));}}
}
