const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./support.cjs');
const A='ExpoPushToken[aaaaaaaaaaa1]',B='ExpoPushToken[bbbbbbbbbbb2]',C='ExpoPushToken[ccccccccccc3]';
const turma={creatorId:'owner',nome:'Turma',participantes:['owner','ana','beto'],status:'ativa'};
function change(f,before,after,id='source-event'){return{id,source:'firestore/test',timeMs:f.options.now(),turmaId:'turma',before,after};}
function request(f,id='source-event') {return f.events.participantEvents(change(f,null,{status:'pendente'},id),'ana',turma,{status:'pendente',nome:'Ana'})[0];}
function ledger(f,event){return f.db.doc(f.outbox.EVENTS+'/'+event.id);}

test('NOT-02: one accepted device does not block another device pending retry',async()=>{
  const f=fixture(async(messages,call)=>messages.map(message=>({token:message.to,ok:call>1||message.to===A,invalid:false,retryable:true})));
  f.token(A,'owner');f.token(B,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());
  await assert.rejects(f.outbox.dispatchEvent(f.db,ledger(f,event),f.options),f.outbox.PendingEvent);
  assert.equal(f.get('pushDedupe/'+event.aviso.dedupeKey).state,'pending');
  const states=f.get('pushDedupe/'+event.aviso.dedupeKey).outcomes;
  assert.equal(states[f.push.tokenDocId(A)],'accepted');assert.equal(states[f.push.tokenDocId(B)],undefined);
  f.advance(30_000);await f.outbox.sweepEvents(f.db,f.options);
  assert.deepEqual(f.calls.map(batch=>Array.from(batch,message=>message.to)),[[A,B],[B]]);
  assert.equal(f.get(ledger(f,event).path).state,'done');
});
test('NOT-02: broadcast retries only transient rejections across multiple members',async()=>{
  const f=fixture(async(messages,call)=>messages.map(message=>({token:message.to,ok:call>1||message.to===A,invalid:message.to===C,retryable:message.to===B,error:message.to===C?'DeviceNotRegistered':'MessageRateExceeded'})));
  f.token(A,'ana');f.token(B,'beto');f.token(C,'beto');
  const game={status:'aberta',criadoPor:'owner',horario:'18:00',confirmados:{}};
  const event=f.events.gameEvents(change(f,null,game),'20261030',turma,game,f.options.now())[0];
  await f.outbox.enqueueEvent(f.db,event,f.options.now());await assert.rejects(f.outbox.dispatchEvent(f.db,ledger(f,event),f.options));
  assert.equal(f.get('pushTokens/'+f.push.tokenDocId(C)),undefined);
  f.advance(30_000);await f.outbox.sweepEvents(f.db,f.options);
  assert.deepEqual(f.calls.map(batch=>Array.from(batch,message=>message.to)),[[A,B,C],[B]]);
});
test('NOT-02: permanent and ambiguous failures are not blindly retried',async()=>{
  const f=fixture(messages=>messages.map(message=>({token:message.to,ok:message.to===A,invalid:false,uncertain:message.to===B,error:'InvalidCredentials'})));
  f.token(A,'owner');f.token(B,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);
  f.advance(600_001);await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);await f.outbox.sweepEvents(f.db,f.options);
  assert.equal(f.calls.length,1);assert.equal(f.get(ledger(f,event).path).state,'uncertain');
});
test('NOT-02: a permanent rejection remains terminal while another token is retried',async()=>{
  const f=fixture(async(messages,call)=>messages.map(message=>({token:message.to,ok:message.to===A||(message.to===B&&call>1),invalid:false,retryable:message.to===B,error:message.to===C?'InvalidCredentials':'MessageRateExceeded'})));
  f.token(A,'owner');f.token(B,'owner');f.token(C,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());await assert.rejects(f.outbox.dispatchEvent(f.db,ledger(f,event),f.options));
  f.advance(30_000);await f.outbox.sweepEvents(f.db,f.options);
  assert.deepEqual(f.calls.map(batch=>Array.from(batch,message=>message.to)),[[A,B,C],[B]]);
  assert.equal(f.get(ledger(f,event).path).state,'failed');
});
test('NOT-05: saved change creates a durable reservation without a client push call',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());
  assert.equal(f.calls.length,0);assert.equal(f.get(ledger(f,event).path).state,'queued');
  assert.equal(f.get('pushDedupe/'+event.aviso.dedupeKey).state,'pending');
  await f.outbox.sweepEvents(f.db,f.options);assert.equal(f.calls.length,1);
});
test('NOT-05: ledger and outbox roll back together on commit failure',async()=>{
  const f=fixture(),event=request(f);f.fail(()=>true);
  await assert.rejects(f.outbox.enqueueEvent(f.db,event,f.options.now()));
  assert.equal(f.get(ledger(f,event).path),undefined);assert.equal(f.get('pushDedupe/'+event.aviso.dedupeKey),undefined);
});
test('NOT-05: concurrent trigger delivery and worker execution send once',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await Promise.all(Array.from({length:12},()=>f.outbox.enqueueEvent(f.db,event,f.options.now())));
  await Promise.all(Array.from({length:12},()=>f.outbox.dispatchEvent(f.db,ledger(f,event),f.options).catch(error=>{if(!(error instanceof f.outbox.PendingEvent))throw error;})));
  assert.equal(f.calls.length,1);assert.equal(f.get(ledger(f,event).path).state,'done');
});
test('NOT-05: trigger after the legacy client call binds the same notification',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await f.consumer.enviarAviso(f.db,event.aviso,f.options);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);
  assert.equal(f.calls.length,1);
});
test('NOT-05: legacy call racing the new trigger cannot duplicate the event',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await Promise.all([f.consumer.enviarAviso(f.db,event.aviso,f.options),f.outbox.enqueueEvent(f.db,event,f.options.now())]);
  await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);assert.equal(f.calls.length,1);
});
test('NOT-05: redelivery beyond the old dedupe window never recreates a completed occurrence',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);
  f.advance(700_000);await f.outbox.enqueueEvent(f.db,event,f.options.now());await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);
  assert.equal(f.calls.length,1);
});
test('NOT-05: crash before event acknowledgement does not resend after the dedupe window',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());
  f.fail(writes=>writes.some(([key,data])=>key.startsWith('turmaPushEvents/')&&data.state==='done'));
  await assert.rejects(f.outbox.dispatchEvent(f.db,ledger(f,event),f.options));
  f.fail(()=>false);f.advance(700_000);await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);assert.equal(f.calls.length,1);
});
test('NOT-05: a later legitimate request can start a new occurrence after the dedupe window',async()=>{
  const f=fixture();f.token(A,'owner');const first=request(f,'first');
  await f.outbox.enqueueEvent(f.db,first,f.options.now());await f.outbox.dispatchEvent(f.db,ledger(f,first),f.options);
  f.advance(700_000);const second=request(f,'second');
  await f.outbox.enqueueEvent(f.db,second,f.options.now());await f.outbox.dispatchEvent(f.db,ledger(f,second),f.options);
  assert.equal(f.calls.length,2);
});
test('NOT-05: an expired unsent preparation cannot block a later legitimate request',async()=>{
  const f=fixture();f.token(A,'owner');const first=request(f,'expired-preparation');
  await f.outbox.enqueueEvent(f.db,first,f.options.now());f.advance(700_000);
  const second=request(f,'new-request');await f.outbox.enqueueEvent(f.db,second,f.options.now());
  await f.outbox.sweepEvents(f.db,f.options);
  assert.equal(f.calls.length,1);assert.equal(f.get(ledger(f,first).path).state,'superseded');assert.equal(f.get(ledger(f,second).path).state,'done');
});
test('NOT-05: old queued ledger cannot send a replacement occurrence',async()=>{
  const f=fixture();f.token(A,'owner');const event=request(f);
  await f.outbox.enqueueEvent(f.db,event,f.options.now());const key='pushDedupe/'+event.aviso.dedupeKey;
  f.put(key,{...f.get(key),notificationId:'replacement'});
  await f.outbox.dispatchEvent(f.db,ledger(f,event),f.options);assert.equal(f.calls.length,0);assert.equal(f.get(ledger(f,event).path).state,'superseded');
});
test('event detection ignores participant metadata updates and rejects stale transitions',()=>{
  const f=fixture();
  assert.equal(f.events.participantEvents(change(f,{status:'pendente'},{status:'pendente',nome:'new'}),'ana',turma,{status:'pendente'}).length,0);
  assert.equal(f.events.participantEvents(change(f,null,{status:'pendente'}),'ana',turma,{status:'aprovado'}).length,0);
  assert.equal(f.events.participantEvents(change(f,{status:'pendente'},{status:'aprovado'}),'ana',turma,{status:'aprovado'}).length,1);
  assert.equal(f.events.participantEvents(change(f,{status:'pendente'},{status:'aprovado'}),'outsider',turma,{status:'aprovado'}).length,0);
});
test('opening targets only members and confirmations only the owner',()=>{
  const f=fixture(),game={status:'aberta',criadoPor:'owner',confirmados:{ana:{nome:'Ana'},owner:{nome:'Owner'}}};
  const events=f.events.gameEvents(change(f,null,game),'20261030',turma,game,f.options.now());
  assert.deepEqual(Array.from(events[0].aviso.recipientUids),['ana','beto']);
  assert.equal(events.length,2);assert.deepEqual(Array.from(events[1].aviso.recipientUids),['owner']);
  const updated={...game,confirmados:{ana:{nome:'New'},owner:{nome:'Owner'}}};
  assert.equal(f.events.gameEvents(change(f,game,updated),'20261030',turma,updated,f.options.now()).length,0);
});
test('old day, game reopening, withdrawal and inactive turma do not create notifications',()=>{
  const f=fixture(),game={status:'aberta',criadoPor:'owner',confirmados:{}};
  assert.equal(f.events.gameEvents(change(f,null,game),'20261029',turma,game,f.options.now()).length,0);
  assert.equal(f.events.gameEvents(change(f,{...game,status:'encerrada'},game),'20261030',turma,game,f.options.now()).length,0);
  assert.equal(f.events.gameEvents(change(f,{...game,confirmados:{ana:{nome:'Ana'}}},game),'20261030',turma,game,f.options.now()).length,0);
  assert.equal(f.events.gameEvents(change(f,null,game),'20261030',{...turma,ativo:false},game,f.options.now()).length,0);
});
