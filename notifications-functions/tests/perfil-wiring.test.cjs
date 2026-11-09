const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load({pushFails=false,profileFails=false,liveFails=false}={}){
 const schedules=[],calls=[],exports={},module={exports};
 const deps={
  '../../api/_lib/liveActivities':{invalidateLiveUser:async()=>{calls.push('live');if(liveFails)throw Error('live falhou');}},'firebase-admin/app':{getApps:()=>[{}]},'firebase-admin/firestore':{getFirestore:()=>({})},
  'firebase-functions/v2/firestore':{onDocumentCreated:(_o,f)=>f,onDocumentWritten:(_o,f)=>f},
  'firebase-functions/v2/scheduler':{onSchedule:(_o,f)=>{schedules.push(f);return f;}},'firebase-functions/params':{defineSecret:()=>({})},
  './events':{},'./outbox':{sweepEvents:async()=>{calls.push('outbox');return{};}},'../../api/_lib/validation':{isSafeUid:()=>true},
  '../../api/_lib/pushEnvio':{recuperarAvisosPendentes:async()=>{calls.push('push');if(pushFails)throw Error('push falhou');return{};}},
  '../../api/_lib/sistema':{registrarRotina:async()=>{}},
  '../../api/_lib/perfilSync':{recuperarPerfis:async()=>{calls.push('perfil');if(profileFails)throw Error('perfil falhou');},mudouIdentidade:(a,b)=>a?.profileImage!==b?.profileImage,enfileirarPerfil:async()=>calls.push('fila'),processarPerfil:async()=>calls.push('processar')},
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/index.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module,exports,require:n=>deps[n],process,console:{log(){},error(){}},Date});
 return{calls,module:module.exports};
}
test('falha do Expo não impede recuperação das fotos',async()=>{const a=load({pushFails:true});await assert.rejects(()=>a.module.retryTurmaNotifications(),/push falhou/);assert.ok(a.calls.includes('perfil'));});
test('falha da fila de fotos não interrompe notificações',async()=>{const a=load({profileFails:true});await a.module.retryTurmaNotifications();assert.ok(a.calls.includes('push'));assert.ok(a.calls.includes('outbox'));});
test('gatilho do perfil processa troca de foto e ignora alterações só de estatísticas',async()=>{
 const a=load(),event=photo=>({params:{uid:'ana'},data:{before:{data:()=>({profileImage:'antiga.jpg'})},after:{exists:true,data:()=>({profileImage:photo,estatisticas:{gols:4}})}}});
 await a.module.invalidateAccountLiveActivities(event('nova.jpg'));assert.deepEqual(a.calls,['fila','processar']);a.calls.length=0;
 await a.module.invalidateAccountLiveActivities(event('antiga.jpg'));assert.equal(a.calls.length,0);
});
test('falha das Live Activities não pula a atualização de nome/foto',async()=>{
 const a=load({liveFails:true}),ev={params:{uid:'ana'},data:{before:{data:()=>({profileImage:'antiga.jpg',status:'active'})},after:{exists:true,data:()=>({profileImage:'nova.jpg',status:'inactive'})}}};
 await assert.rejects(()=>a.module.invalidateAccountLiveActivities(ev),/live falhou/);
 assert.deepEqual(a.calls,['live','fila','processar']);
});
