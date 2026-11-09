const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),vm=require('node:vm');
require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,p);
const sync=require('../api/_lib/perfilSync.ts');
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
function fakeDb(initial={}){
 const docs=new Map(Object.entries(initial).map(([k,v])=>[k,clone(v)])),writes=[];let tail=Promise.resolve(),fail=null;
 const snapshot=k=>({id:k.split('/').pop(),ref:ref(k),exists:docs.has(k),data:()=>clone(docs.get(k))});
 const ref=k=>({path:k,get:async()=>snapshot(k)});
 const query=(c,filters=[],after=null,max=Infinity)=>({where:(f,op,v)=>query(c,[...filters,[f,op,v]],after,max),orderBy:()=>query(c,filters,after,max),startAfter:id=>query(c,filters,id,max),limit:n=>query(c,filters,after,n),get:async()=>{
  const rows=[...docs].filter(([k,v])=>k.startsWith(c+'/')&&k.split('/').length===c.split('/').length+1&&(!after||k.split('/').pop()>after)&&filters.every(([f,op,x])=>op==='=='?v[f]===x:op==='array-contains'?Array.isArray(v[f])&&v[f].includes(x):op==='<='?v[f]<=x:false)).sort(([a],[b])=>a.localeCompare(b)).slice(0,max).map(([k])=>snapshot(k));
  return{docs:rows,size:rows.length,empty:!rows.length};
 }});
 const db={doc:ref,collection:query,runTransaction:async fn=>{
  const previous=tail;let release;tail=new Promise(r=>release=r);await previous;
  const ops=[];let writing=false;
  try{
   const out=await fn({get:async r=>{assert.equal(writing,false,'todas as leituras antes de gravar');return r.get();},set:(r,v)=>{writing=true;ops.push(['set',r.path,clone(v)]);},delete:r=>{writing=true;ops.push(['delete',r.path]);},update:(r,v)=>{writing=true;if(fail===r.path){fail=null;throw Error('falha simulada');}ops.push(['update',r.path,clone(v)]);}});
   for(const [op,k,value]of ops){writes.push([op,k,value]);if(op==='delete'){docs.delete(k);continue;}if(op==='set'){docs.set(k,value);continue;}const data=docs.get(k);assert.ok(data,'não criar alvo removido');for(const [field,v]of Object.entries(value)){const parts=field.split('.');let parent=data;for(const part of parts.slice(0,-1))parent=parent[part]??(parent[part]={});parent[parts.at(-1)]=v;}}
   return out;
  }finally{release();}
 }};
 return{db,docs,writes,failOnce:p=>fail=p};
}
const today=()=>new Date(Date.now()-3*3600000).toISOString().slice(0,10).replaceAll('-','');
const base=()=>({
 'users/ana':{name:'Ana Nova',profileImage:'nova.jpg',userName:'ana.nova'},
 'turmas/t1':{participantes:['ana'],pendingParticipants:[],creatorId:'org'},
 'turmas/t1/participantes/ana':{nome:'Ana Antiga',urlPhoto:'antiga.jpg',status:'aprovado',gols:7,jogos:3},
 'turmas/t1/resumo/atual':{membros:{ana:{nome:'Ana Antiga',urlPhoto:'antiga.jpg',gols:7,jogos:3},outro:{nome:'Outro',urlPhoto:'outro.jpg'}}},
 ['turmas/t1/jogos/'+today()]:{status:'aberta',confirmados:{ana:{nome:'Ana Antiga',urlPhoto:'antiga.jpg',em:123}}},
 'times/time1':{membros:['ana'],jogadores:{ana:{nome:'Ana Antiga',foto:'antiga.jpg',userName:'ana.antiga',entrouEm:123}},camisas:{ana:{numero:9}}},
 'desafios/d1':{participantes:['ana','outro'],desafianteId:'ana',desafiadoId:'outro',desafiante:{nome:'Ana Antiga',foto:'antiga.jpg'},desafiado:{nome:'Outro',foto:'outro.jpg'},status:'finalizado',resultado:{pontos:99}},
});
test('atualiza identidade em turma/resumo/jogo, elenco e desafios sem tocar estatísticas ou adversário',async()=>{
 const {db,docs,writes}=fakeDb(base());await sync.enfileirarPerfil(db,'ana');await sync.processarPerfil(db,'ana');
 assert.equal(docs.get('turmas/t1/participantes/ana').urlPhoto,'nova.jpg');
 assert.equal(docs.get('turmas/t1/participantes/ana').gols,7);
 assert.equal(docs.get('turmas/t1/resumo/atual').membros.ana.nome,'Ana Nova');
 assert.equal(docs.get('turmas/t1/resumo/atual').membros.ana.gols,7);
 assert.equal(docs.get('turmas/t1/resumo/atual').membros.outro.urlPhoto,'outro.jpg');
 assert.equal(docs.get('turmas/t1/jogos/'+today()).confirmados.ana.em,123);
 assert.equal(docs.get('times/time1').jogadores.ana.foto,'nova.jpg');
 assert.equal(docs.get('times/time1').jogadores.ana.entrouEm,123);
 assert.equal(docs.get('times/time1').camisas.ana.numero,9);
 assert.equal(docs.get('desafios/d1').desafiante.foto,'nova.jpg');
 assert.equal(docs.get('desafios/d1').desafiado.foto,'outro.jpg');
 assert.equal(docs.get('desafios/d1').resultado.pontos,99);
 assert.equal(docs.get('perfilSyncJobs/ana').concluido,true);
 const n=writes.length;assert.equal(await sync.enfileirarPerfil(db,'ana'),false);await sync.processarPerfil(db,'ana');assert.equal(writes.length,n);
});
test('mudança sem identidade não gera trabalho; remoção de foto propaga vazio',async()=>{
 assert.equal(sync.mudouIdentidade({name:'Ana',profileImage:'x',estatisticas:{}},{name:'Ana',profileImage:'x',estatisticas:{gols:3}}),false);
 const data=base();data['users/ana'].profileImage='';const {db,docs}=fakeDb(data);
 await sync.enfileirarPerfil(db,'ana');await sync.processarPerfil(db,'ana');
 assert.equal(docs.get('desafios/d1').desafiante.foto,'');assert.equal(docs.get('turmas/t1/resumo/atual').membros.ana.urlPhoto,'');
});
test('paginação alcança mais que uma página e concorrência compartilha lease',async()=>{
 const data=base();for(let i=0;i<34;i++)data['desafios/p'+String(i).padStart(3,'0')]={...clone(data['desafios/d1'])};
 const {db,docs,writes}=fakeDb(data);await sync.enfileirarPerfil(db,'ana');await Promise.all([sync.processarPerfil(db,'ana'),sync.processarPerfil(db,'ana')]);
 for(const [k,v]of docs)if(k.startsWith('desafios/'))assert.equal(v.desafiante.foto,'nova.jpg');
 assert.equal(writes.filter(([op,k])=>op==='update'&&k==='desafios/d1').length,1);
});
test('falha parcial mantém cursor recuperável, sem regravar alvos já atualizados',async()=>{
 const data=base();data['desafios/d2']=clone(data['desafios/d1']);const a=fakeDb(data);await sync.enfileirarPerfil(a.db,'ana');a.failOnce('desafios/d2');
 await assert.rejects(()=>sync.processarPerfil(a.db,'ana'),/simulada/);
 assert.equal(a.docs.get('perfilSyncJobs/ana').concluido,false);assert.equal(a.docs.get('perfilSyncJobs/ana').lease,null);
 a.docs.get('perfilSyncJobs/ana').nextAttemptAt=0;await sync.recuperarPerfis(a.db);
 assert.equal(a.docs.get('desafios/d2').desafiante.foto,'nova.jpg');
 assert.equal(a.writes.filter(([op,k])=>op==='update'&&k==='desafios/d1').length,1);
});
test('evento antigo usa perfil atual e conta excluída não deixa tarefa repetindo',async()=>{
 const a=fakeDb(base());await sync.enfileirarPerfil(a.db,'ana');
 a.docs.get('users/ana').profileImage='mais-nova.jpg';await sync.enfileirarPerfil(a.db,'ana');await sync.processarPerfil(a.db,'ana');
 assert.equal(a.docs.get('desafios/d1').desafiante.foto,'mais-nova.jpg');
 a.docs.delete('users/ana');await sync.enfileirarPerfil(a.db,'ana');assert.equal(a.docs.has('perfilSyncJobs/ana'),false);
});
test('convocações e pedidos atualizam sem recriar jogador removido ou resumo ausente',async()=>{
 const data=base();data['times/convite']={membros:[],convidados:['ana'],convites:{ana:{nome:'Antes',foto:'antes',em:123}}};
 data['times/pedido']={membros:[],solicitantes:['ana'],pedidos:{ana:{nome:'Antes',foto:'antes',em:456}}};
 delete data['turmas/t1/resumo/atual'];delete data['turmas/t1/participantes/ana'];
 const {db,docs}=fakeDb(data);await sync.enfileirarPerfil(db,'ana');await sync.processarPerfil(db,'ana');
 assert.equal(docs.get('times/convite').convites.ana.foto,'nova.jpg');assert.equal(docs.get('times/pedido').pedidos.ana.em,456);
 assert.equal(docs.has('turmas/t1/resumo/atual'),false);assert.equal(docs.has('turmas/t1/participantes/ana'),false);
});
test('rota rejeita anônimo e método errado; só enfileira o uid autenticado',async()=>{
 let logged=false,called=null;const deps={'./cors':{handleCors:()=>false},'./auth':{getFirebaseApp:()=>({}),requireUser:async(_q,res,action)=>{assert.equal(action,'perfil-sync');if(!logged){res.status(401).json({});return null;}return{uid:'ana'};}},'firebase-admin/firestore':{getFirestore:()=>({})},'./rateLimit':{dentroDoLimite:async()=>true},'./perfilSync':{enfileirarPerfil:async(_db,uid)=>called=uid}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../api/_lib/perfilSyncApi.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require:n=>deps[n],console});
 const response=()=>({setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});
 let r=response();await module.exports.handlePerfilSync({method:'GET'},r);assert.equal(r.code,405);
 r=response();await module.exports.handlePerfilSync({method:'POST'},r);assert.equal(r.code,401);assert.equal(called,null);
 logged=true;r=response();await module.exports.handlePerfilSync({method:'POST',body:{uid:'vitima',foto:'injetada'}},r);assert.equal(r.code,200);assert.equal(called,'ana');
});
