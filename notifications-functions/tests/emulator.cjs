const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
if(!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??''))throw Error('Local Firestore emulator required. Production is prohibited.');
process.env.GCLOUD_PROJECT='demo-turma-notifications';
const {getFirestore}=require('firebase-admin/firestore');
const entry=require('../lib/notifications-functions/src/index.js');
const {participantEvents,gameEvents}=require('../lib/notifications-functions/src/events.js');
const {tokenDocId,diaDeBrasilia}=require('../lib/api/_lib/push.js');
const {enviarAviso}=require('../lib/api/_lib/pushEnvio.js');
const {deleteApp,getApp}=require('firebase-admin/app');
const db=getFirestore(),namespace='not02-not05-'+randomUUID(),refs=new Map(),batches=[],tickets=new Set();
const owner=namespace+'-owner',ana=namespace+'-ana',beto=namespace+'-beto';
const A='ExpoPushToken['+randomUUID().replaceAll('-','')+']',B='ExpoPushToken['+randomUUID().replaceAll('-','')+']',C='ExpoPushToken['+randomUUID().replaceAll('-','')+']',D='ExpoPushToken['+randomUUID().replaceAll('-','')+']';
const E='ExpoPushToken['+randomUUID().replaceAll('-','')+']',F='ExpoPushToken['+randomUUID().replaceAll('-','')+']';
const transientFailures=new Map([[B,1],[F,1]]);
const originalFetch=global.fetch;
global.fetch=async(url,init)=>{
  if(url!=='https://exp.host/--/api/v2/push/send')throw Error('External HTTP prohibited in emulator test');
  const messages=JSON.parse(init.body);batches.push(messages.map(message=>message.to));
  const data=messages.map(message=>{
    if((transientFailures.get(message.to)??0)>0){transientFailures.set(message.to,transientFailures.get(message.to)-1);return{status:'error',details:{error:'MessageRateExceeded'}};}
    if(message.to===C)return{status:'error',details:{error:'DeviceNotRegistered'}};
    const id=randomUUID();tickets.add(id);return{status:'ok',id};
  });
  return{ok:true,json:async()=>({data})};
};
function ref(key){const value=db.doc(key);refs.set(key,value);return value;}
function cloud(change,params){return{id:change.id,source:change.source,time:new Date(change.timeMs).toISOString(),specversion:'1.0',type:'google.cloud.firestore.document.v1.written',params,data:{before:change.beforeSnap,after:change.afterSnap}};}
async function captureParticipant(doc,updates){
  const beforeSnap=await doc.get();await doc.set(updates,{merge:true});const afterSnap=await doc.get();
  const change={id:randomUUID(),source:'//firestore.googleapis.com/projects/demo-turma-notifications/databases/(default)',timeMs:Date.now(),turmaId:namespace,before:beforeSnap.data()??null,after:afterSnap.data()??null,beforeSnap,afterSnap};
  const planned=participantEvents(change,ana,(await db.doc('turmas/'+namespace).get()).data(),afterSnap.data());
  await entry.captureTurmaParticipantNotification.run(cloud(change,{turmaId:namespace,participantId:ana}));
  return planned;
}
async function captureGame(doc,updates){
  const beforeSnap=await doc.get();await doc.set(updates,{merge:true});const afterSnap=await doc.get();
  const change={id:randomUUID(),source:'//firestore.googleapis.com/projects/demo-turma-notifications/databases/(default)',timeMs:Date.now(),turmaId:namespace,before:beforeSnap.data()??null,after:afterSnap.data()??null,beforeSnap,afterSnap};
  const planned=gameEvents(change,doc.id,(await db.doc('turmas/'+namespace).get()).data(),afterSnap.data(),Date.now());
  await entry.captureTurmaGameNotification.run(cloud(change,{turmaId:namespace,dayId:doc.id}));
  return planned;
}
async function deliver(event){
  const ledger=ref('turmaPushEvents/'+event.id);ref('pushDedupe/'+event.aviso.dedupeKey);
  const data=await ledger.get();assert.equal(data.exists,true);
  await entry.deliverTurmaNotification.run({id:randomUUID(),data,params:{eventId:event.id}});
}
async function run(){
  try{
    for(const exported of ['captureTurmaParticipantNotification','captureTurmaGameNotification','deliverTurmaNotification','retryTurmaNotifications'])assert.equal(typeof entry[exported].run,'function');
    const turmaRef=ref('turmas/'+namespace);await turmaRef.set({creatorId:owner,nome:'Emulator turma',participantes:[owner,ana,beto],status:'ativa'});
    for(const [token,uid] of [[A,owner],[B,owner],[C,ana],[D,beto]])await ref('pushTokens/'+tokenDocId(token)).set({uid,token,updatedAt:Date.now()});
    const participant=ref('turmas/'+namespace+'/participantes/'+ana);
    const [requested]=await captureParticipant(participant,{status:'pendente',nome:'Ana'});
    assert.equal(batches.length,0);assert.equal((await db.doc('pushDedupe/'+requested.aviso.dedupeKey).get()).get('state'),'pending');
    console.log('PASS: saved join request creates a durable event without any client push request.');
    await assert.rejects(deliver(requested),/pending/i);
    assert.equal((await db.doc('pushDedupe/'+requested.aviso.dedupeKey).get()).get('state'),'pending');
    await db.doc('pushDedupe/'+requested.aviso.dedupeKey).update({nextAttemptAt:Date.now()-1});
    await entry.retryTurmaNotifications.run({scheduleTime:new Date().toISOString(),jobName:'local-only'});
    assert.equal(batches.length,2);assert.deepEqual(new Set(batches[0]),new Set([A,B]));assert.deepEqual(batches[1],[B]);assert.equal((await db.doc('turmaPushEvents/'+requested.id).get()).get('state'),'done');
    console.log('PASS: the server worker retries only the failed device after partial success.');
    const [approved]=await captureParticipant(participant,{status:'aprovado'});await deliver(approved);
    assert.equal((await db.doc('pushTokens/'+tokenDocId(C)).get()).exists,false);
    assert.deepEqual(batches.at(-1),[C]);
    console.log('PASS: approval targets the approved member; DeviceNotRegistered removes the dead token.');
    const game=ref('turmas/'+namespace+'/jogos/'+diaDeBrasilia(Date.now()).id);
    const [opened]=await captureGame(game,{status:'aberta',criadoPor:owner,horario:'18:00',confirmados:{}});await deliver(opened);
    assert.deepEqual(batches.at(-1),[D]);
    console.log('PASS: opening notifies members and excludes the organizer.');
    const [attendance]=await captureGame(game,{confirmados:{[ana]:{nome:'Ana'}}});await deliver(attendance);
    assert.deepEqual(new Set(batches.at(-1)),new Set([A,B]));
    console.log('PASS: attendance notifies only the organizer.');
    assert.equal((await captureParticipant(participant,{nome:'Changed name'})).length,0);
    console.log('PASS: unrelated participant edits do not generate a notification.');
    const genericUid=namespace+'-generic';
    for(const token of [E,F])await ref('pushTokens/'+tokenDocId(token)).set({uid:genericUid,token,updatedAt:Date.now()});
    const genericKey='desafio_local_'+namespace;
    const genericRef=ref('pushDedupe/'+genericKey);
    const result=await enviarAviso(db,{evento:'desafio',turmaId:'',dedupeKey:genericKey,dedupeMs:600_000,recipientUids:[genericUid],dedupeUid:genericUid,draft:{title:'Emulator challenge',body:'No real push',data:{tipo:'desafio',turmaId:'',desafioId:namespace}}});
    assert.equal(result.pendente,true);await genericRef.update({nextAttemptAt:Date.now()-1});
    await entry.retryTurmaNotifications.run({scheduleTime:new Date().toISOString(),jobName:'local-only'});
    assert.deepEqual(new Set(batches.at(-2)),new Set([E,F]));assert.deepEqual(batches.at(-1),[F]);
    assert.equal((await genericRef.get()).get('state'),'done');
    console.log('PASS: generic API push without a turma ledger also retries only its failed device.');
  }finally{
    global.fetch=originalFetch;
    for(const reference of [...refs.values()].reverse())await reference.delete();
    // Delete only receipts generated by this test, never other emulator data.
    const receipts=await db.collection('pushRecibos').get();
    for(const receipt of receipts.docs)if(Object.keys(receipt.get('tickets')??{}).some(id=>tickets.has(id)))await receipt.ref.delete();
    await db.terminate();await deleteApp(getApp());
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
