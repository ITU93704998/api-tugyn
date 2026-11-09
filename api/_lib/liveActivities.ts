import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DOC_CONFIG, FUNCAO_DESLIGADA, funcaoLigadaConfiavel, lerConfig } from "./sistema";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { FieldPath, type Firestore, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getFirebaseApp, requireUser } from "./auth";
import { handleCors } from "./cors";
import { dentroDoLimite } from "./rateLimit";
import { perfilDisponivel } from "./suspensao";
import { LIVE_GROUPS, LIVE_MAX_MS, LIVE_SUBSCRIPTIONS, type AttendanceProps, attendanceSnapshot, canFollowAttendance, dataLive, livePayload, safeLiveDay, safeLiveId } from "./liveActivityCore";
import { createLiveApnsClient, type LiveApnsClient } from "./liveActivityApns";

const hash = (v:string)=>createHash("sha256").update(v).digest("hex");
export const liveGameKey=(turmaId:string,dayId:string)=>hash(`${turmaId}/${dayId}`);
const enabled=()=>process.env.LIVE_ACTIVITIES_ENABLED==="true";
const ambiente=()=>process.env.LIVE_ACTIVITY_APNS_ENV || "production";
const MAX_SUBS=3000; // até 500 membros × cinco atividades/aparelhos, mais o organizador
const COOLDOWN=15_000;
interface Subscription { uid:string; activityId:string; turmaId:string; dayId:string; gameKey:string; token:string; environment:string; expiresAt:number; createdAt:number; revocationHash:string; lastVersion:number; nextAttemptAt:number; attempts:number }
interface Group { enrollmentRevision?:number; turmaId:string; dayId:string; props:AttendanceProps; version:number; dirty:boolean; dueAt:number; lease:string|null; leaseUntil:number; lastSentAt:number; expiresAt:number }
class LiveRefusal extends Error { constructor(readonly status:number,message:string){super(message);} }

export async function handleLiveActivities(req:VercelRequest,res:VercelResponse) {
  if(handleCors(req,res))return;
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST"){res.setHeader("Allow","POST, OPTIONS");return res.status(405).json({error:"Método não permitido."});}
  const b=dataLive(req.body);
  if(!["disponibilidade","preparar","registrar","parar"].includes(String(b.action)))return res.status(400).json({error:"Ação inválida."});
  try {
    if(b.action==="parar") {
      if(typeof b.subscriptionId!=="string" || !/^[a-f0-9]{64}$/.test(b.subscriptionId) || typeof b.revocationKey!=="string" || !/^[a-f0-9]{64}$/.test(b.revocationKey))return res.status(400).json({error:"Pedido inválido."});
      const ip=String(req.headers["x-forwarded-for"] ?? "unknown").split(",")[0];
      if(!await dentroDoLimite(hash(ip),"live-stop",300,3600))return res.status(429).json({error:"Tente novamente mais tarde."});
      const db=getFirestore(getFirebaseApp());
      await revokeLiveSubscription(db,b.subscriptionId,b.revocationKey);
      return res.status(200).json({ok:true}); // mesma resposta para inexistente/chave errada; sem dados de terceiros
    }
    const user=await requireUser(req,res,"live-activity");if(!user)return;
    if(!await dentroDoLimite(user.uid,"live-activity",90,3600))return res.status(429).json({error:"Muitas tentativas. Tente novamente mais tarde."});
    if(b.action==="disponibilidade") {
      const servico=enabled();
      const permitido=servico && (await lerConfig(getFirestore(getFirebaseApp()))).funcoes.acompanharConfirmacoes;
      return res.status(200).json({enabled:permitido,environment:ambiente(),reason:permitido?null:servico?"painel_desativado":"servico_desativado"});
    }
    if(!enabled())return res.status(503).json({error:"O acompanhamento na tela bloqueada ainda não foi disponibilizado."});
    if(b.action==="preparar")return res.status(200).json(prepareLiveSubscription(user.uid,b.activityId));
    const result=await registerLiveSubscription(getFirestore(getFirebaseApp()),user.uid,b,Date.now());
    return res.status(200).json(result);
  }catch(e){
    if(e instanceof LiveRefusal)return res.status(e.status).json({error:e.message});
    console.error(JSON.stringify({evt:"live_activity_api_error"}));
    return res.status(503).json({error:"Não foi possível ativar o acompanhamento. Sua presença continua confirmada."});
  }
}

export async function revokeLiveSubscription(db:Firestore,id:string,key:string):Promise<void> {
  await db.runTransaction(async tx=>{
    const ref=db.doc(`${LIVE_SUBSCRIPTIONS}/${id}`),snap=await tx.get(ref),d=snap.data();
    const expected=typeof d?.revocationHash==="string" ? d.revocationHash : "";
    if(/^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(new Uint8Array(Buffer.from(expected,"hex")),new Uint8Array(Buffer.from(hash(key),"hex"))))tx.delete(ref);
  });
}

/** No database write: losing this response cannot create an orphan subscription. */
export function prepareLiveSubscription(uid:string,activityId:unknown) {
  if(typeof activityId!=="string" || !/^[A-Za-z0-9-]{1,128}$/.test(activityId))throw new LiveRefusal(400,"Identificador de atividade inválido.");
  return {subscriptionId:hash(`${uid}/${activityId}`),revocationKey:randomBytes(32).toString("hex")};
}

export async function registerLiveSubscription(db:Firestore,uid:string,b:Record<string,unknown>,now:number) {
  if(!safeLiveId(b.turmaId) || !safeLiveDay(b.dayId))throw new LiveRefusal(400,"A turma ou a data do acompanhamento é inválida. Atualize a partida e tente novamente.");
  if(typeof b.activityId!=="string" || !/^[A-Za-z0-9-]{1,128}$/.test(b.activityId))throw new LiveRefusal(400,"O identificador da atividade do iPhone é inválido. Reinicie o acompanhamento.");
  if(typeof b.token!=="string" || !/^[a-fA-F0-9]{32,1024}$/.test(b.token))throw new LiveRefusal(400,"O token da atividade do iPhone é inválido. Reinicie o acompanhamento.");
  if(b.environment!=="production" && b.environment!=="development")throw new LiveRefusal(400,"O iPhone não informou o ambiente de notificações. Instale a build atualizada pelo TestFlight.");
  if(b.environment!==ambiente())throw new LiveRefusal(400,"O ambiente de notificações da build difere do servidor. Confira LIVE_ACTIVITY_APNS_ENV na API e nas Functions (production para TestFlight).");
  const turmaId=b.turmaId,dayId=b.dayId,activityId=b.activityId,token=b.token.toLowerCase(),environment=String(b.environment);
  if(b.revocationKey===undefined)throw new LiveRefusal(409,"Atualize o app para ativar o acompanhamento com cancelamento seguro.");
  if(typeof b.revocationKey!=="string" || !/^[a-f0-9]{64}$/.test(b.revocationKey))throw new LiveRefusal(400,"Chave de cancelamento inválida.");
  // Persisted by the client before sending; never rotate on registration/retry.
  const revocationKey=b.revocationKey;
  const id=hash(`${uid}/${activityId}`), gameKey=liveGameKey(turmaId,dayId);
  const ref=db.doc(`${LIVE_SUBSCRIPTIONS}/${id}`),groupRef=db.doc(`${LIVE_GROUPS}/${gameKey}`);
  let snapshot:AttendanceProps|null=null,expiresAt=0;
  await db.runTransaction(async tx=>{
    const [turma,participant,game,profile,previous,group,own,config]=await Promise.all([
      tx.get(db.doc(`turmas/${turmaId}`)),tx.get(db.doc(`turmas/${turmaId}/participantes/${uid}`)),tx.get(db.doc(`turmas/${turmaId}/jogos/${dayId}`)),
      tx.get(db.doc(`users/${uid}`)),tx.get(ref),tx.get(groupRef),tx.get(db.collection(LIVE_SUBSCRIPTIONS).where("uid","==",uid).where("expiresAt",">",now).limit(6)),tx.get(db.doc(DOC_CONFIG)),
    ]);
    if(config.data()?.funcoes?.acompanharConfirmacoes===false)throw new LiveRefusal(503,FUNCAO_DESLIGADA.acompanharConfirmacoes);
    const t=turma.exists ? turma.data()! : null,j=game.exists ? game.data()! : null;
    if(!perfilDisponivel(profile.data()) || !canFollowAttendance(uid,t,participant.data()??null,j,now))throw new LiveRefusal(403,"Confirme sua presença em uma turma de que você participa para acompanhar.");
    snapshot=attendanceSnapshot(turmaId,dayId,t,j,now);
    if(snapshot.expiraEm>now+LIVE_MAX_MS)throw new LiveRefusal(409,"O acompanhamento fica disponível mais perto do horário da partida (até 7 horas e meia antes do encerramento).");
    const old=previous.data() as Subscription|undefined;
    if(old && (old.uid!==uid || old.turmaId!==turmaId || old.dayId!==dayId))throw new LiveRefusal(409,"Esta atividade pertence a outra partida.");
    if(own.docs.filter(d=>d.id!==id && Number(d.data().expiresAt)>now).length>=5)throw new LiveRefusal(409,"Você já acompanha partidas em cinco aparelhos/atividades. Encerre uma antes de continuar.");
    const createdAt=old?.createdAt ?? now;
    expiresAt=Math.min(snapshot.expiraEm,createdAt+LIVE_MAX_MS);
    if(expiresAt<=now)throw new LiveRefusal(409,"Este acompanhamento já terminou. Inicie outro pela partida.");
    const g=group.data() as Group|undefined;
    // O registro cria uma fila durável; o trigger do servidor fará a entrega mesmo se o app fechar.
    const props=g?.props && sameSnapshot(g.props,snapshot) ? g.props : snapshot;
    const version=props===g?.props ? g!.version : Math.max(now,(g?.version??0)+1);
    tx.set(ref,{uid,activityId,turmaId,dayId,gameKey,token,environment,expiresAt,createdAt,revocationHash:hash(revocationKey),lastVersion:0,nextAttemptAt:0,attempts:0,deleteAfter:Timestamp.fromMillis(expiresAt+86400_000)});
    tx.set(groupRef,{enrollmentRevision:(g?.enrollmentRevision??0)+1,turmaId,dayId,props,version,dirty:true,dueAt:now,lease:g?.lease??null,leaseUntil:g?.leaseUntil??0,lastSentAt:g?.lastSentAt??0,expiresAt:snapshot.expiraEm,deleteAfter:Timestamp.fromMillis(snapshot.expiraEm+86400_000)});
  });
  return {subscriptionId:id,revocationKey,expiresAt,props:snapshot};
}

function sameSnapshot(a:AttendanceProps,b:AttendanceProps):boolean { return a.nome===b.nome && a.horario===b.horario && a.local===b.local && a.total===b.total && a.status===b.status && a.expiraEm===b.expiraEm; }

/** Lê o estado ATUAL na transação: eventos Firestore duplicados ou fora de ordem não fazem o contador retroceder. */
export async function captureLiveAttendance(db:Firestore,turmaId:string,dayId:string,force=false,now=Date.now()):Promise<void> {
  if(!enabled() || !safeLiveId(turmaId) || !safeLiveDay(dayId))return;
  const ref=db.doc(`${LIVE_GROUPS}/${liveGameKey(turmaId,dayId)}`);
  await db.runTransaction(async tx=>{
    const old=await tx.get(ref);if(!old.exists)return; // ninguém acompanha: só uma leitura, sem fanout nem documento novo
    const g=old.data() as Group;
    const [t,j]=await Promise.all([tx.get(db.doc(`turmas/${turmaId}`)),tx.get(db.doc(`turmas/${turmaId}/jogos/${dayId}`))]);
    const props=attendanceSnapshot(turmaId,dayId,t.exists?t.data()!:null,j.exists?j.data()!:null,now);
    if(!force && sameSnapshot(g.props,props))return;
    tx.update(ref,{props,version:Math.max(now,g.version+1),dirty:true,dueAt:props.status!=="aberta"?now:Math.max(now,g.lastSentAt+COOLDOWN),expiresAt:props.expiraEm || now});
  });
}

export async function invalidateLiveUser(db:Firestore,uid:string,turmaId?:string):Promise<void> {
  if(!enabled() || !safeLiveId(uid))return;
  const subscriptions=await db.collection(LIVE_SUBSCRIPTIONS).where("uid","==",uid).where("expiresAt",">",Date.now()).limit(6).get();
  const groups=new Map<string,{turmaId:string;dayId:string}>();
  for(const d of subscriptions.docs){const s=d.data() as Subscription;if(!turmaId || s.turmaId===turmaId)groups.set(s.gameKey,s);}
  for(const s of groups.values())await captureLiveAttendance(db,s.turmaId,s.dayId,true);
}

export async function dispatchLiveAttendance(db:Firestore,key:string,options:{client?:LiveApnsClient;now?:()=>number;deadline?:number}={}):Promise<void> {
  if(!enabled() || !/^[a-f0-9]{64}$/.test(key))return;
  // Sem saber com certeza se a função está ligada, não envia nada (nem update, nem end): o grupo continua na fila
  // (dirty/dueAt intactos) e o sweep tenta de novo quando a configuração puder ser lida.
  const ligado=await funcaoLigadaConfiavel(db,"acompanharConfirmacoes");
  if(ligado===null){console.error(JSON.stringify({evt:"live_activity_config_indisponivel"}));return;}
  const paused=!ligado;
  const now=options.now??Date.now,ref=db.doc(`${LIVE_GROUPS}/${key}`),lease=randomBytes(12).toString("hex");
  let group:Group|null=null;
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);if(!snap.exists)return;
    const g=snap.data() as Group;
    if((!paused && (!g.dirty || g.dueAt>now())) || g.leaseUntil>now())return;
    group=g;tx.update(ref,{lease,leaseUntil:now()+45_000});
  });
  if(!group)return;
  const g=group as Group;
  let client:LiveApnsClient|undefined,remaining=false;
  try {
    client=options.client??createLiveApnsClient();
    const snapshots=await db.collection(LIVE_SUBSCRIPTIONS).where("gameKey","==",key).limit(MAX_SUBS+1).get();
    if(snapshots.size>MAX_SUBS)throw new Error("live_activity_group_limit");
    const [t,j]=await Promise.all([db.doc(`turmas/${g.turmaId}`).get(),db.doc(`turmas/${g.turmaId}/jogos/${g.dayId}`).get()]);
    const turma=t.exists?t.data()!:null,jogo=j.exists?j.data()!:null;
    const current=attendanceSnapshot(g.turmaId,g.dayId,turma,jogo,now());
    if(!paused && !sameSnapshot(g.props,current)){await captureLiveAttendance(db,g.turmaId,g.dayId,true,now());remaining=true;return;}
    const pending=snapshots.docs.filter(d=>paused || Number(d.data().lastVersion)<g.version);
    const selected=pending;
    const deadline=options.deadline??now()+35_000;
    for(let offset=0;offset<selected.length;offset+=20){
      if(now()>deadline-7500){remaining=true;break;}
      const currentGroup=await ref.get();
      if(currentGroup.data()?.lease!==lease || currentGroup.data()?.version!==g.version){remaining=true;break;}
      await Promise.all(selected.slice(offset,offset+20).map(async d=>{
        const s=d.data() as Subscription;
        if(s.nextAttemptAt>now()){remaining=true;return;}
        if(s.environment!==ambiente()){remaining=true;console.error(JSON.stringify({evt:"live_activity_environment_mismatch"}));return;}
        const [profile,participant]=await Promise.all([db.doc(`users/${s.uid}`).get(),db.doc(`turmas/${s.turmaId}/participantes/${s.uid}`).get()]);
        const owner=turma?.creatorId===s.uid;
        const member=owner || participant.data()?.status==="aprovado" && Array.isArray(turma?.participantes) && turma.participantes.includes(s.uid);
        const confirmed=owner || !jogo || Object.prototype.hasOwnProperty.call(dataLive(jogo.confirmados),s.uid);
        const allowed=perfilDisponivel(profile.data()) && member && confirmed;
        const end=paused || g.props.status!=="aberta" || s.expiresAt<=now() || !allowed;
        // Ao perder acesso não enviamos nem o nome/local nem o contador atual da turma.
        const props=paused || !allowed ? {...g.props,nome:"Acompanhamento encerrado",local:"",horario:"",total:0,status:"encerrada" as const} : g.props;
        if(now()>deadline-7500){remaining=true;return;}
        const result=await client!.send(s.token,livePayload(props,end,now()),Math.max(now()+60_000,s.expiresAt));
        await db.runTransaction(async tx=>{
          const fresh=await tx.get(d.ref),actual=fresh.data() as Subscription|undefined;
          if(!actual)return;
          if(actual.token!==s.token || actual.revocationHash!==s.revocationHash){remaining=true;return;}
          if(result.ok && end || result.permanent)tx.delete(d.ref);
          else if(result.ok)tx.update(d.ref,{lastVersion:g.version,nextAttemptAt:0,attempts:0});
          else {remaining=true;tx.update(d.ref,{attempts:Math.min(10,s.attempts+1),nextAttemptAt:now()+Math.min(15*60_000,60_000*2**Math.min(4,s.attempts))});}
        });
        if(!result.ok && !result.permanent)console.error(JSON.stringify({evt:"live_activity_retry",reason:result.reason}));
      }));
    }
    if(snapshots.empty){
      await db.runTransaction(async tx=>{
        const [currentGroup,subscriptions]=await Promise.all([tx.get(ref),tx.get(db.collection(LIVE_SUBSCRIPTIONS).where("gameKey","==",key).limit(1))]);
        if(currentGroup.data()?.lease===lease && subscriptions.empty)tx.delete(ref);
      });
      return;
    }
  }catch{remaining=true;console.error(JSON.stringify({evt:"live_activity_dispatch_error"}));}
  finally {
    client?.close();
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);if(!snap.exists || snap.data()?.lease!==lease)return;
      const actual=snap.data() as Group;
      const changed=actual.version!==g.version || actual.enrollmentRevision!==g.enrollmentRevision;
      tx.update(ref,{lease:null,leaseUntil:0,lastSentAt:now(),dirty:changed||remaining,dueAt:changed||remaining ? now()+(remaining?60_000:COOLDOWN) : Number.MAX_SAFE_INTEGER});
    });
  }
}

const CURSOR_PAUSA="sistema/liveActivitiesPausa";
const LOTE_PAUSA=10;
/**
 * Próximo cursor do rodízio com a função desligada: página vazia ou curta processada inteira → volta ao começo;
 * nada processado (prazo acabou antes) → mantém; senão continua depois do último grupo processado.
 */
export function proximoCursorPausa(cursor:string|null,pagina:string[],ultimo:string|null):string|null {
  if(pagina.length===0)return null;
  if(ultimo===null)return cursor;
  if(ultimo===pagina[pagina.length-1] && pagina.length<LOTE_PAUSA)return null;
  return ultimo;
}

/** Retry durável e encerramento por horário, inclusive sem mais gravações e sem o app aberto. */
export async function sweepLiveAttendance(db:Firestore):Promise<void> {
  if(!enabled())return;
  const deadline=Date.now()+40_000;
  const ligado=await funcaoLigadaConfiavel(db,"acompanharConfirmacoes");
  if(ligado===null){console.error(JSON.stringify({evt:"live_activity_config_indisponivel"}));return;}
  if(!ligado){
    // Inclui grupos sem alterações: interromper deve alcançar atividades já sincronizadas. Percorre TODOS os grupos em
    // rodízio, com cursor durável: grupos em retry não prendem as vagas do lote, e o passe seguinte continua de onde parou.
    const cursorRef=db.doc(CURSOR_PAUSA);
    const salvo=(await cursorRef.get()).data()?.ultimo;
    const cursor=typeof salvo==="string" ? salvo : null;
    let consulta=db.collection(LIVE_GROUPS).orderBy(FieldPath.documentId()).limit(LOTE_PAUSA);
    if(cursor)consulta=consulta.startAfter(cursor);
    const groups=await consulta.get();
    let ultimo:string|null=null;
    for(const d of groups.docs){if(Date.now()>deadline-8000)break;await dispatchLiveAttendance(db,d.id,{deadline});ultimo=d.id;}
    await cursorRef.set({ultimo:proximoCursorPausa(cursor,groups.docs.map(d=>d.id),ultimo),em:Date.now()});
    return;
  }
  const expired=await db.collection(LIVE_GROUPS).where("expiresAt","<=",Date.now()).limit(5).get();
  for(const d of expired.docs){const g=d.data() as Group;await captureLiveAttendance(db,g.turmaId,g.dayId,true);}
  const pending=await db.collection(LIVE_GROUPS).where("dueAt","<=",Date.now()).orderBy("dueAt").limit(10).get();
  for(const d of pending.docs){if(Date.now()>deadline-8000)break;await dispatchLiveAttendance(db,d.id,{deadline});}
}
