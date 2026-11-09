const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');const ts=require('typescript');
require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,p);
const core=require('../api/_lib/liveActivityCore.ts'),live=require('../api/_lib/liveActivities.ts');
const {generateKeyPairSync,verify}=require('node:crypto');const {EventEmitter}=require('node:events');
process.env.LIVE_ACTIVITIES_ENABLED='true';process.env.LIVE_ACTIVITY_APNS_ENV='production';
const NOW=Date.now(),clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
function fakeDb(initial={}){
 const docs=new Map(Object.entries(initial).map(([k,v])=>[k,clone(v)]));let queue=Promise.resolve();
 const snap=k=>({exists:docs.has(k),id:k.split('/').pop(),ref:ref(k),data:()=>clone(docs.get(k))});
 const ref=k=>({path:k,id:k.split('/').pop(),get:async()=>snap(k),set:async v=>{docs.set(k,clone(v));},delete:async()=>docs.delete(k)});
 const query=(collection,filters=[],sort=null,max=Infinity,after=null)=>({where:(k,op,v)=>query(collection,[...filters,[k,op,v]],sort,max,after),orderBy:k=>query(collection,filters,k,max,after),limit:n=>query(collection,filters,sort,n,after),startAfter:v=>query(collection,filters,sort,max,v),get:async()=>{let rows=[...docs].filter(([k,v])=>k.startsWith(collection+'/')&&k.split('/').length===collection.split('/').length+1&&filters.every(([f,op,target])=>op==='=='?v[f]===target:op==='<='?v[f]<=target:op==='>'?v[f]>target:false));if(sort&&typeof sort!=='string')rows.sort((a,b)=>a[0].localeCompare(b[0]));else if(sort)rows.sort((a,b)=>a[1][sort]-b[1][sort]);if(after!==null)rows=rows.filter(([k])=>k.split('/').pop()>after);const out=rows.slice(0,max).map(([k])=>snap(k));return{docs:out,size:out.length,empty:!out.length};}});
 const db={doc:ref,collection:k=>query(k),runTransaction:async f=>{const before=queue;let release;queue=new Promise(r=>release=r);await before;const writes=[];let started=false;const write=f=>{started=true;writes.push(f);};try{const result=await f({get:async r=>{if(started)throw Error('read after write');return r.get();},set:(r,v)=>write(()=>docs.set(r.path,clone(v))),update:(r,v)=>write(()=>docs.set(r.path,{...docs.get(r.path),...clone(v)})),delete:r=>write(()=>docs.delete(r.path))});writes.forEach(f=>f());return result;}finally{release();}}};return{db,docs};
}
const ids={turmaId:'turma1',dayId:'20261107'};
const base=()=>({ 'turmas/turma1':{nome:'Pelada de sábado',creatorId:'dono',ativo:true,participantes:['u1','u2']},'turmas/turma1/jogos/20261107':{status:'aberta',horario:'19:00',local:'Quadra',expiraEm:NOW+3600000,confirmados:{u1:{nome:'não vai ao payload'},u2:{}}},'users/u1':{},'users/u2':{},'users/dono':{},'turmas/turma1/participantes/u1':{status:'aprovado'},'turmas/turma1/participantes/u2':{status:'aprovado'}});
const body=(activityId='a1',token='aa'.repeat(32))=>({...ids,activityId,token,revocationKey:require('node:crypto').createHash('sha256').update(activityId).digest('hex'),environment:'production'});
const setup=async()=>{const f=fakeDb(base());const a=await live.registerLiveSubscription(f.db,'u1',body(),NOW);const b=await live.registerLiveSubscription(f.db,'u2',body('a2','bb'.repeat(32)),NOW);return{...f,a,b,key:live.liveGameKey(ids.turmaId,ids.dayId)};};
test('snapshot contém só agregado; contagem limitada e expiração/encerramento seguros',()=>{const d=base();const p=core.attendanceSnapshot(ids.turmaId,ids.dayId,d['turmas/turma1'],d['turmas/turma1/jogos/20261107'],NOW);assert.equal(p.total,2);assert.ok(!JSON.stringify(p).includes('não vai'));assert.equal(core.attendanceSnapshot('t','d',null,null,NOW).status,'cancelada');assert.equal(core.attendanceSnapshot('t','d',{}, {status:'aberta',expiraEm:NOW-1},NOW).status,'encerrada');assert.equal(core.safeLiveDay('20260230'),false);});
test('somente dono ou membro aprovado com presença pode acompanhar',()=>{const d=base(),t=d['turmas/turma1'],j=d['turmas/turma1/jogos/20261107'];assert.equal(core.canFollowAttendance('u1',t,{status:'aprovado'},j,NOW),true);assert.equal(core.canFollowAttendance('fora',t,{status:'aprovado'},j,NOW),false);assert.equal(core.canFollowAttendance('u1',t,{status:'pendente'},j,NOW),false);assert.equal(core.canFollowAttendance('dono',t,null,j,NOW),true);assert.equal(core.canFollowAttendance('u1',t,{status:'aprovado'},{...j,confirmados:{}},NOW),false);});
test('registro valida ambiente, token, data e conta suspensa; cliente não escolhe contador',async()=>{const {db,docs}=fakeDb(base());for(const bad of [{token:'ExpoPushToken[errado]'},{environment:'development'},{dayId:'20260230'},{turmaId:'../x'}])await assert.rejects(()=>live.registerLiveSubscription(db,'u1',{...body(),...bad},NOW));const r=await live.registerLiveSubscription(db,'u1',{...body(),total:999,uid:'dono'},NOW);assert.equal(r.props.total,2);const sub=docs.get(core.LIVE_SUBSCRIPTIONS+'/'+r.subscriptionId);assert.equal(sub.uid,'u1');assert.notEqual(sub.revocationHash,r.revocationKey);docs.set('users/u2',{status:'suspended'});await assert.rejects(()=>live.registerLiveSubscription(db,'u2',body('a2'),NOW));});
test('registro recusa janela maior que 7,5 h e não prolonga atividade ao renovar token',async()=>{const {db,docs}=fakeDb(base());const game=docs.get('turmas/turma1/jogos/20261107');game.expiraEm=NOW+10*3600000;await assert.rejects(()=>live.registerLiveSubscription(db,'u1',body(),NOW));game.expiraEm=NOW+3600000;const a=await live.registerLiveSubscription(db,'u1',body(),NOW);const b=await live.registerLiveSubscription(db,'u1',body('a1','cc'.repeat(32)),NOW+1000);assert.equal(a.subscriptionId,b.subscriptionId);assert.equal(a.expiresAt,b.expiresAt);assert.equal(a.revocationKey,b.revocationKey);});
test('revogação funciona sem login com segredo correto e não expõe existência',async()=>{const {db,docs}=fakeDb(base());const a=await live.registerLiveSubscription(db,'u1',body(),NOW);await live.revokeLiveSubscription(db,a.subscriptionId,'0'.repeat(64));assert.ok(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+a.subscriptionId));await live.revokeLiveSubscription(db,a.subscriptionId,a.revocationKey);assert.equal(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+a.subscriptionId),false);await live.revokeLiveSubscription(db,a.subscriptionId,a.revocationKey);});
test('eventos duplicados e alterações de foto/nome não criam atualizações do contador',async()=>{const {db,docs,key}=await setup();const ref=core.LIVE_GROUPS+'/'+key,version=docs.get(ref).version;await live.captureLiveAttendance(db,ids.turmaId,ids.dayId,false,NOW+500);assert.equal(docs.get(ref).version,version);docs.get('turmas/turma1/jogos/20261107').confirmados.u1.nome='Outra foto/nome';await live.captureLiveAttendance(db,ids.turmaId,ids.dayId,false,NOW+600);assert.equal(docs.get(ref).version,version);delete docs.get('turmas/turma1/jogos/20261107').confirmados.u2;await live.captureLiveAttendance(db,ids.turmaId,ids.dayId,false,NOW+700);assert.equal(docs.get(ref).props.total,1);});
test('sucesso parcial repete só aparelho transitório, sem reenviar ao que recebeu',async()=>{const {db,docs,a,b,key}=await setup();let clock=NOW+1000;const sent=[];let fail=true;const client={close(){},send:async token=>{sent.push(token);return token.startsWith('bb')&&fail?{ok:false,permanent:false,reason:'503'}:{ok:true,permanent:false,reason:'200'};}};await live.dispatchLiveAttendance(db,key,{client,now:()=>clock});assert.equal(sent.length,2);assert.ok(docs.get(core.LIVE_SUBSCRIPTIONS+'/'+a.subscriptionId).lastVersion>0);assert.equal(docs.get(core.LIVE_SUBSCRIPTIONS+'/'+b.subscriptionId).lastVersion,0);clock+=61000;fail=false;await live.dispatchLiveAttendance(db,key,{client,now:()=>clock});assert.equal(sent.length,3);assert.ok(sent[2].startsWith('bb'));});
test('duas entregas simultâneas compartilham lease; invalidado remove só aquele token',async()=>{const {db,docs,a,b,key}=await setup();let sends=0;const client={close(){},send:async token=>{sends++;await new Promise(r=>setTimeout(r,5));return{ok:!token.startsWith('bb'),permanent:token.startsWith('bb'),reason:'Unregistered'};}};await Promise.all([live.dispatchLiveAttendance(db,key,{client,now:()=>NOW+1000}),live.dispatchLiveAttendance(db,key,{client,now:()=>NOW+1000})]);assert.equal(sends,2);assert.ok(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+a.subscriptionId));assert.equal(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+b.subscriptionId),false);});
test('membro removido/desistente recebe encerramento sem nome/local/contador da turma',async()=>{const {db,docs,key}=await setup();delete docs.get('turmas/turma1/jogos/20261107').confirmados.u2;await live.captureLiveAttendance(db,ids.turmaId,ids.dayId,true,NOW+1000);const payloads=[];const client={close(){},send:async(token,payload)=>{payloads.push([token,payload]);return{ok:true,permanent:false,reason:'200'};}};await live.dispatchLiveAttendance(db,key,{client,now:()=>NOW+2000});const out=payloads.find(([t])=>t.startsWith('bb'))[1];assert.equal(out.aps.event,'end');const p=JSON.parse(out.aps['content-state'].props);assert.equal(p.total,0);assert.equal(p.local,'');assert.equal(p.nome,'Acompanhamento encerrado');});
test('cancelamento e expiração encerram em vez de deixar contador ativo',async()=>{const {db,docs,key}=await setup();docs.delete('turmas/turma1/jogos/20261107');await live.captureLiveAttendance(db,ids.turmaId,ids.dayId,false,NOW+1000);const events=[];const client={close(){},send:async(_t,p)=>{events.push(p.aps.event);return{ok:true,permanent:false,reason:'200'};}};await live.dispatchLiveAttendance(db,key,{client,now:()=>NOW+2000});assert.deepEqual(events,['end','end']);assert.equal([...docs.keys()].filter(k=>k.startsWith(core.LIVE_SUBSCRIPTIONS+'/')).length,0);});
test('payload ActivityKit é compacto, sem alerta/som, e usa formato Expo Widgets',()=>{const p=core.attendanceSnapshot('t','20261107',{nome:'Turma'},{status:'aberta',expiraEm:NOW+1000,confirmados:{}},NOW);const out=core.livePayload(p,false,NOW);assert.equal(out.aps['content-state'].name,'TurmaAttendance');assert.equal(out.aps.timestamp,Math.floor(NOW/1000));assert.equal(out.aps.alert,undefined);assert.equal(out.aps.sound,undefined);assert.ok(Buffer.byteLength(JSON.stringify(out))<4096);});
test('conexão APNs usa HTTP/2, tópico Live Activity e JWT ES256 verificável',async()=>{const http2=require('node:http2'),original=http2.connect;const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});let headers,payload;http2.connect=host=>{assert.equal(host,'https://api.push.apple.com');const connection=new EventEmitter();connection.setTimeout=()=>{};connection.destroy=()=>{};connection.request=h=>{headers=h;const stream=new EventEmitter();stream.close=()=>{};stream.end=p=>{payload=JSON.parse(p);queueMicrotask(()=>{stream.emit('response',{':status':200});stream.emit('end');});};return stream;};return connection;};try{const apns=require('../api/_lib/liveActivityApns.ts').createLiveApnsClient({APPLE_TEAM_ID:'ABCDE12345',LIVE_ACTIVITY_APNS_KEY_ID:'12345ABCDE',LIVE_ACTIVITY_APNS_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}),LIVE_ACTIVITY_APNS_ENV:'production'});const out=await apns.send('aa'.repeat(32),{aps:{event:'update'}},NOW+1000);assert.equal(out.ok,true);assert.equal(headers['apns-topic'],'com.tugyn.tugynfut.push-type.liveactivity');assert.equal(headers['apns-push-type'],'liveactivity');assert.equal(headers['apns-priority'],'5');const token=headers.authorization.slice(7).split('.');assert.ok(verify('sha256',Buffer.from(token[0]+'.'+token[1]),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(token[2],'base64url')));assert.equal(payload.aps.event,'update');apns.close();}finally{http2.connect=original;}});
test('API exige login e conta permitida nas ações que cadastram/acessam disponibilidade',async()=>{const auth=require('../api/_lib/auth.ts'),original=auth.requireUser;try{auth.requireUser=async(_req,res)=>{res.status(401).json({error:'Login'});return null;};for(const action of ['registrar','disponibilidade']){const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};await live.handleLiveActivities({method:'POST',headers:{},body:{action}},res);assert.equal(res.code,401);}}finally{auth.requireUser=original;}});
test('gatilhos cobrem desistência/exclusão e não dependem do cliente chamar push',()=>{const src=fs.readFileSync(path.join(__dirname,'../notifications-functions/src/index.ts'),'utf8');assert.ok(src.includes('await captureLiveAttendance(db, event.params.turmaId, event.params.dayId)'));assert.ok(src.includes('document:"users/{uid}"'));assert.ok(src.includes('document:"turmas/{turmaId}"'));assert.ok(src.includes('sweepLiveAttendance(db)'));});

test('interruptor bloqueia registro mesmo com cache de disponibilidade antigo; reativar permite',async()=>{
 const {db,docs}=fakeDb(base());
 docs.set('sistema/config',{funcoes:{acompanharConfirmacoes:false}});
 await assert.rejects(()=>live.registerLiveSubscription(db,'u1',body(),NOW),e=>e.status===503);
 assert.equal([...docs.keys()].filter(k=>k.startsWith(core.LIVE_SUBSCRIPTIONS+'/')).length,0);
 docs.set('sistema/config',{funcoes:{acompanharConfirmacoes:true}});
 assert.ok((await live.registerLiveSubscription(db,'u1',body(),NOW)).subscriptionId);
});
test('interruptor encerra aparelhos já sincronizados, mantém retry parcial e não os recria ao ligar',async()=>{
 const system=require('../api/_lib/sistema.ts');system.esquecerConfig();
 const {db,docs,key,a,b}=await setup();let clock=NOW+1000;const events=[];let fail=false;
 const client={close(){},send:async(token,p)=>{events.push([token,p]);return{ok:!(fail&&token.startsWith('bb')),permanent:false,reason:'503'};}};
 try{
  await live.dispatchLiveAttendance(db,key,{client,now:()=>clock});
  assert.equal(docs.get(core.LIVE_GROUPS+'/'+key).dirty,false);
  docs.set('sistema/config',{funcoes:{acompanharConfirmacoes:false}});system.esquecerConfig();fail=true;clock+=1000;
  await live.dispatchLiveAttendance(db,key,{client,now:()=>clock});
  assert.deepEqual(events.slice(2).map(e=>e[1].aps.event),['end','end']);
  assert.equal(JSON.parse(events[2][1].aps['content-state'].props).total,0);
  assert.equal(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+a.subscriptionId),false);
  assert.equal(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+b.subscriptionId),true);
  fail=false;clock+=61000;await live.dispatchLiveAttendance(db,key,{client,now:()=>clock});
  assert.equal(events.length,5);assert.ok(events[4][0].startsWith('bb'));
  docs.set('sistema/config',{funcoes:{acompanharConfirmacoes:true}});system.esquecerConfig();
  await live.dispatchLiveAttendance(db,key,{client,now:()=>clock+61000});assert.equal(events.length,5);
 }finally{system.esquecerConfig();}
});

// ── Auditoria 07/11: interruptor confiável, rodízio do encerramento e validade do conteúdo ──
const semConfig=db=>({...db,doc:k=>k==='sistema/config'?{path:k,id:'config',get:async()=>{throw Error('firestore indisponível');}}:db.doc(k)});
test('LA-01: falha ao ler o interruptor não envia update nem end; a fila continua para nova tentativa',async()=>{
 const system=require('../api/_lib/sistema.ts');system.esquecerConfig();
 const {db,docs,key}=await setup();const sent=[];const client={close(){},send:async(t,p)=>{sent.push(p.aps.event);return{ok:true,permanent:false,reason:'200'};}};
 try{
  await live.dispatchLiveAttendance(semConfig(db),key,{client,now:()=>NOW+1000});
  assert.equal(sent.length,0);
  assert.equal(docs.get(core.LIVE_GROUPS+'/'+key).dirty,true,'continua pendente');
  // Último estado conhecido "desligado" é mantido mesmo com a leitura falhando depois.
  docs.set('sistema/config',{funcoes:{acompanharConfirmacoes:false}});
  assert.equal(await system.funcaoLigadaConfiavel(db,'acompanharConfirmacoes',NOW),false);
  assert.equal(await system.funcaoLigadaConfiavel(semConfig(db),'acompanharConfirmacoes',NOW+60000),false);
  // Último estado "ligado" + falha: não supõe ligado.
  docs.set('sistema/config',{funcoes:{acompanharConfirmacoes:true}});system.esquecerConfig();
  assert.equal(await system.funcaoLigadaConfiavel(db,'acompanharConfirmacoes',NOW),true);
  assert.equal(await system.funcaoLigadaConfiavel(semConfig(db),'acompanharConfirmacoes',NOW+60000),null);
 }finally{system.esquecerConfig();}
});
test('LA-02: desligado, o encerramento percorre todos os grupos em rodízio (mais de 10, primeiro lote em retry)',async()=>{
 const system=require('../api/_lib/sistema.ts');system.esquecerConfig();
 const ini={'sistema/config':{funcoes:{acompanharConfirmacoes:false}}};
 const chaves=Array.from({length:11},(_,i)=>(i+1).toString(16).padStart(64,'0'));
 for(const k of chaves)ini[core.LIVE_GROUPS+'/'+k]={turmaId:'turma1',dayId:'20261107',props:{},version:1,dirty:false,dueAt:Number.MAX_SAFE_INTEGER,lease:null,leaseUntil:0,lastSentAt:0,expiresAt:NOW+3600000};
 const {db,docs}=fakeDb(ini);
 try{
  // Sem credenciais APNs no teste: cada envio falha de forma transitória (retry), como no relatório.
  await live.sweepLiveAttendance(db);
  const tocados=()=>chaves.filter(k=>docs.get(core.LIVE_GROUPS+'/'+k).lastSentAt>0);
  assert.equal(tocados().length,10);
  assert.equal(docs.get('sistema/liveActivitiesPausa').ultimo,chaves[9]);
  await live.sweepLiveAttendance(db);
  assert.ok(docs.get(core.LIVE_GROUPS+'/'+chaves[10]).lastSentAt>0,'o 11º grupo foi alcançado');
  assert.equal(docs.get('sistema/liveActivitiesPausa').ultimo,null,'página curta: volta ao começo');
 }finally{system.esquecerConfig();}
});
test('LA-02: cursor do rodízio (página cheia, curta, vazia, interrompida)',()=>{
 const p=['a','b','c','d','e','f','g','h','i','j'];
 assert.equal(live.proximoCursorPausa(null,p,'j'),'j');
 assert.equal(live.proximoCursorPausa('j',['k'],'k'),null);
 assert.equal(live.proximoCursorPausa('k',[],null),null);
 assert.equal(live.proximoCursorPausa('x',p,null),'x');
 assert.equal(live.proximoCursorPausa(null,p,'d'),'d');
});
test('LA-04: atualização vale até o fim da partida (sem "desatualizado" após 5 min sem mudanças)',()=>{
 const p=core.attendanceSnapshot('t','20261107',{nome:'Turma'},{status:'aberta',expiraEm:NOW+3*3600000,confirmados:{}},NOW);
 assert.equal(core.livePayload(p,false,NOW).aps['stale-date'],Math.floor((NOW+3*3600000)/1000));
});

test('registro diferencia ambiente ausente, divergente e campos inválidos sem acessar o banco',async()=>{
 const db={doc(){throw Error('não deve ler o banco');}};
 for(const [extra,pattern]of [[{environment:null},/não informou o ambiente/],[{environment:'development'},/difere do servidor/],[{activityId:'../x'},/identificador/],[{token:'ExpoPushToken[x]'},/token da atividade/],[{dayId:'20260230'},/data do acompanhamento/]]){
  await assert.rejects(()=>live.registerLiveSubscription(db,'u1',{...body(),...extra},NOW),e=>e.status===400&&pattern.test(e.message));
 }
});

test('chave preparada permanece válida após resposta perdida no cadastro e na renovação',async()=>{
 const {db,docs}=fakeDb(base());
 const prepared=live.prepareLiveSubscription('u1','stable');
 assert.equal(docs.size,Object.keys(base()).length,'preparação não grava inscrição');
 const first=await live.registerLiveSubscription(db,'u1',{...body('stable'),revocationKey:prepared.revocationKey},NOW);
 assert.equal(first.subscriptionId,prepared.subscriptionId);
 assert.equal(first.revocationKey,prepared.revocationKey);
 const second=await live.registerLiveSubscription(db,'u1',{...body('stable','cc'.repeat(32)),revocationKey:prepared.revocationKey},NOW+1);
 assert.equal(second.revocationKey,prepared.revocationKey);
 await live.revokeLiveSubscription(db,prepared.subscriptionId,prepared.revocationKey);
 assert.equal(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+prepared.subscriptionId),false);
 // Primeiro registro confirmado no servidor, mas resposta descartada pelo app.
 const pending=live.prepareLiveSubscription('u1','initial-lost');
 await live.registerLiveSubscription(db,'u1',{...body('initial-lost'),revocationKey:pending.revocationKey},NOW+2);
 await live.revokeLiveSubscription(db,pending.subscriptionId,pending.revocationKey);
 assert.equal(docs.has(core.LIVE_SUBSCRIPTIONS+'/'+pending.subscriptionId),false);
});

test('registros expirados não escondem os cinco ativos; renovação e outro usuário continuam permitidos',async()=>{
 const {db,docs}=fakeDb(base());
 for(let i=0;i<8;i++)docs.set(core.LIVE_SUBSCRIPTIONS+'/expired-'+i,{uid:'u1',expiresAt:NOW-1});
 for(let i=0;i<5;i++)await live.registerLiveSubscription(db,'u1',body('active-'+i),NOW);
 await assert.rejects(()=>live.registerLiveSubscription(db,'u1',body('sixth'),NOW),e=>e.status===409);
 await live.registerLiveSubscription(db,'u1',body('active-0','cc'.repeat(32)),NOW+1);
 await live.registerLiveSubscription(db,'u2',body('other'),NOW+1);
 const first=live.prepareLiveSubscription('u1','active-0');
 const renewed=await live.registerLiveSubscription(db,'u1',{...body('active-0'),revocationKey:first.revocationKey},NOW+2);
 await live.revokeLiveSubscription(db,renewed.subscriptionId,renewed.revocationKey);
 await live.registerLiveSubscription(db,'u1',body('replacement'),NOW+3);
 assert.equal([...docs].filter(([k,v])=>k.startsWith(core.LIVE_SUBSCRIPTIONS+'/')&&v.uid==='u1'&&v.expiresAt>NOW).length,5);
});

test('preparação e chave fornecida são validadas antes de ler o banco',async()=>{
 assert.throws(()=>live.prepareLiveSubscription('u1','../bad'));
 const db={doc(){throw Error('não deve ler o banco');}};
 await assert.rejects(()=>live.registerLiveSubscription(db,'u1',{...body(),revocationKey:'bad'},NOW),e=>e.status===400);
});

test('cliente antigo sem chave persistida deve atualizar, sem criar inscrição',async()=>{const {db,docs}=fakeDb(base());const b=body();delete b.revocationKey;await assert.rejects(()=>live.registerLiveSubscription(db,'u1',b,NOW),e=>e.status===409);assert.equal([...docs.keys()].filter(k=>k.startsWith(core.LIVE_SUBSCRIPTIONS+'/')).length,0);});
