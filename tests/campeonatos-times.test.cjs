const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const cache = new Map();
function carregar(nome, stubs = {}, fresh = false) {
  const f = path.join(root, 'api/_lib', nome+'.ts');
  if(!fresh && cache.has(f))return cache.get(f).exports;
  const m={exports:{}}; if(!fresh)cache.set(f,m);
  const req = createRequire(f);
  const local = n => n in stubs ? stubs[n] : n.startsWith('.') && fs.existsSync(path.resolve(path.dirname(f), n)+'.ts') ? carregar(path.relative(path.join(root,'api/_lib'),path.resolve(path.dirname(f),n)).replaceAll('\\','/')) : req(n);
  const src = ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInThisContext('(function(require,module,exports){'+src+'\n})',{filename:f})(local,m,m.exports);return m.exports;
}
const D=carregar('campeonatosTimesDominio');
const S=carregar('campeonatosTimesServico');
const clone=x=>structuredClone(x);
class Ref {
 constructor(db,p){this.db=db;this.path=p;this.id=p.split('/').at(-1);}
 collection(n){return new Query(this.db,this.path+'/'+n);}
 async get(){return this.db.snap(this.path);}
 async delete(){this.db.data.delete(this.path);}
}
class Query {
 constructor(db,p,filters=[],orders=[],lim=Infinity,cursor=null){Object.assign(this,{db,path:p,filters,orders,lim,cursor});}
 doc(n){return new Ref(this.db,this.path+'/'+n);}
 where(k,op,v){return new Query(this.db,this.path,[...this.filters,[k,op,v]],this.orders,this.lim,this.cursor);}
 orderBy(k,d='asc'){return new Query(this.db,this.path,this.filters,[...this.orders,[typeof k==='string'?k:'__name__',d]],this.lim,this.cursor);}
 limit(n){return new Query(this.db,this.path,this.filters,this.orders,n,this.cursor);}
 startAfter(...v){return new Query(this.db,this.path,this.filters,this.orders,this.lim,v);}
 async get(){
  let all=[...this.db.data.keys()].filter(p=>p.startsWith(this.path+'/')&&p.split('/').length===this.path.split('/').length+1).map(p=>this.db.snap(p));
  all=all.filter(s=>this.filters.every(([k,op,v])=>op==='=='?s.get(k)===v:op==='array-contains'?s.get(k)?.includes(v):op==='<='?s.get(k)<=v:op==='>'?s.get(k)>v:false));
  const cmp=(s,t)=>{for(const [k,d]of this.orders){const a=k==='__name__'?s.id:s.get(k), b=k==='__name__'?t.id:t.get(k);if(a!==b)return(a<b?-1:1)*(d==='desc'?-1:1);}return 0;};
  all.sort(cmp);
  if(this.cursor){const fake={id:this.cursor[1],get:()=>this.cursor[0]};all=all.filter(s=>cmp(s,fake)>0);}
  const docs=all.slice(0,this.lim);return{docs,size:docs.length,empty:!docs.length};
 }
}
class DB {
 constructor(seed={}){this.data=new Map(Object.entries(clone(seed)));this.tail=Promise.resolve();}
 doc(p){return new Ref(this,p);}
 collection(p){return new Query(this,p);}
 snap(p){const v=this.data.get(p);return{id:p.split('/').at(-1),ref:this.doc(p),exists:v!==undefined,data:()=>v===undefined?undefined:clone(v),get:k=>v?.[k]};}
 async runTransaction(fn){
  // Serializa commits e aplica somente depois do callback: detecta leitura após escrita e testa rollback.
  const prior=this.tail;let release;this.tail=new Promise(r=>release=r);await prior;
  const writes=[];let escreveu=false;
  const read=async r=>{assert.equal(escreveu,false,'leitura depois de escrita');return r.get();};
  const tx={get:read,getAll:async(...refs)=>Promise.all(refs.map(read)),create:(r,d)=>{escreveu=true;writes.push(['create',r,d]);},set:(r,d)=>{escreveu=true;writes.push(['set',r,d]);},update:(r,d)=>{escreveu=true;writes.push(['update',r,d]);},delete:r=>{escreveu=true;writes.push(['delete',r]);}};
  try{const result=await fn(tx);for(const [op,r,d]of writes){if(op==='create')assert.equal(this.data.has(r.path),false);if(op==='update')assert.equal(this.data.has(r.path),true);if(op==='delete')this.data.delete(r.path);else this.data.set(r.path,clone(op==='update'?{...this.data.get(r.path),...d}:d));}return result;}finally{release();}
 }
}
const NOW=1_800_000_000_000;
const corpo=(extra={})=>({chavePedido:'pedido-00000001',nome:'Copa Tugyn',descricao:'Amador',modalidade:'futsal',formato:'triangular',maxTimes:3,inscricoesAte:NOW+86400000,dataInicio:null,locais:[{nome:'Arena'}],minJogadores:1,maxJogadores:5,...extra});
const perfil=n=>({name:n,status:'active',location:{city:'Palmas',state:'TO',cityId:'palmas_to'}});
const time=(dono,ids=[dono])=>({donoId:dono,nome:'Time '+dono,modalidade:'futsal',genero:'masculino',faixaEtaria:'livre',membros:ids,jogadores:Object.fromEntries(ids.map(id=>[id,{nome:id}])),camisas:{}});
async function cenario(extra={}){const db=new DB({'users/org':perfil('Organizador'),'users/a':perfil('A'),'users/b':perfil('B'),'users/c':perfil('C'),'times/a_1':time('a'),'times/b_1':time('b'),'times/c_1':time('c')});const c=await S.criarCT(db,'org',corpo(extra),true,NOW);return{db,id:c.campeonatoId,base:'campeonatosTimes/'+c.campeonatoId};}
const pedido=(id,who)=>({campeonatoId:id,timeId:who+'_1',jogadorIds:[who]});
async function completo(){const x=await cenario();for(const who of ['a','b','c']){await S.inscreverCT(x.db,who,pedido(x.id,who),NOW);await S.responderCT(x.db,'org',{...pedido(x.id,who),aceitar:true},NOW);}return x;}
test('criação herda cidade do perfil, ignora organizador e contadores forjados e é idempotente',async()=>{
 const {db,id,base}=await cenario({cityId:'outra',organizadorId:'atacante',aprovados:16});const c=db.data.get(base);assert.equal(c.cityId,'palmas_to');assert.equal(c.organizadorId,'org');assert.equal(c.aprovados,0);
 const r=await S.criarCT(db,'org',corpo(),true,NOW);assert.equal(r.campeonatoId,id);assert.equal(db.data.get('controleCampeonatosTimes/org').ativos,1);
 await assert.rejects(S.criarCT(db,'org',corpo({nome:'Outro'}),true,NOW),/outros dados/);
});
test('limite de organizador é atômico em criações concorrentes',async()=>{const {db}=await cenario();const r=await Promise.allSettled([2,3,4].map(n=>S.criarCT(db,'org',corpo({chavePedido:'pedido-0000000'+n}),true,NOW)));assert.equal(r.filter(x=>x.status==='fulfilled').length,2);assert.equal(db.data.get('controleCampeonatosTimes/org').ativos,3);});
test('formato pago e campos monetários/datas não podem ser forjados',()=>{
 assert.throws(()=>D.novoCT(corpo({formato:'grupos_mata',maxTimes:8}),NOW,false),/liberação/);
 for(const alteracao of [{inscricaoCentavos:1.2},{premiacao:{valorCentavos:-1}},{inscricoesAte:NOW-1},{maxTimes:4},{minJogadores:0}])assert.throws(()=>D.novoCT(corpo(alteracao),NOW,true));
});
test('inscrição exige dono, modalidade, membros reais e atletas sem repetição/treinador',async()=>{
 const {db,id}=await cenario();await assert.rejects(S.inscreverCT(db,'b',pedido(id,'a'),NOW),/dono/);
 await assert.rejects(S.inscreverCT(db,'a',{...pedido(id,'a'),jogadorIds:['b']},NOW),/elenco/);
 await assert.rejects(S.inscreverCT(db,'a',{...pedido(id,'a'),jogadorIds:['a','a']},NOW),/repetida/);
 db.data.get('times/a_1').camisas={a:{posicao:'treinador'}};await assert.rejects(S.inscreverCT(db,'a',pedido(id,'a'),NOW),/Treinador/);
 db.data.get('times/a_1').modalidade='campo';await assert.rejects(S.inscreverCT(db,'a',pedido(id,'a'),NOW),/modalidade/);
});
test('aprovação exige organizador e revalida contas/elenco no servidor',async()=>{const{db,id}=await cenario();await S.inscreverCT(db,'a',pedido(id,'a'),NOW);await assert.rejects(S.responderCT(db,'b',{...pedido(id,'a'),aceitar:true},NOW),/organizador/);db.data.get('users/a').excluindoEm=NOW;await assert.rejects(S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW),/indisponível/);assert.equal(db.data.get('campeonatosTimes/'+id).aprovados,0);});
test('mesmo atleta não é aprovado por dois times em pedidos concorrentes',async()=>{
 const{db,id}=await cenario();db.data.set('times/b_1',time('b',['a','b']));await S.inscreverCT(db,'a',pedido(id,'a'),NOW);await S.inscreverCT(db,'b',{...pedido(id,'b'),jogadorIds:['a']},NOW);
 const r=await Promise.allSettled(['a','b'].map(w=>S.responderCT(db,'org',{...pedido(id,w),aceitar:true},NOW)));assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(db.data.get('campeonatosTimes/'+id).aprovados,1);
});
test('cancelamento libera vaga e trava do atleta; início incompleto falha sem gravar jogos',async()=>{
 const{db,id,base}=await completo();await S.cancelarInscricaoCT(db,'a',pedido(id,'a'),NOW);assert.equal(db.data.has(base+'/atletas/a'),false);await assert.rejects(S.iniciarCT(db,'org',{campeonatoId:id},NOW),/3 times/);assert.equal([...db.data.keys()].some(p=>p.startsWith(base+'/jogos/')),false);
});
test('início e resultado confirmam gravação, controlam proprietário e encerram campeonato',async()=>{
 const{db,id,base}=await completo();await assert.rejects(S.iniciarCT(db,'a',{campeonatoId:id},NOW),/organizador/);await S.iniciarCT(db,'org',{campeonatoId:id},NOW);
 let detalhe=await S.lerDetalheCT(db,'org',{campeonatoId:id});assert.equal(detalhe.jogos.length,3);
 const j=detalhe.jogos[0];await assert.rejects(S.resultadoCT(db,'a',{campeonatoId:id,jogoId:j.id,golsCasa:2,golsFora:0},NOW),/organizador/);
 for(const jogo of detalhe.jogos)await S.resultadoCT(db,'org',{campeonatoId:id,jogoId:jogo.id,golsCasa:2,golsFora:0},NOW);
 assert.equal(db.data.get(base).status,'encerrado');assert.ok(db.data.get(base).campeaoTimeId);assert.equal(db.data.get('controleCampeonatosTimes/org').ativos,0);
});
test('privacidade: pedido pendente e pagamento só para organizador e dono da inscrição',async()=>{
 const{db,id,base}=await cenario();await S.inscreverCT(db,'a',pedido(id,'a'),NOW);let d=await S.lerDetalheCT(db,'b',{campeonatoId:id});assert.equal(d.inscricoes.length,0);
 await S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW);await S.administrarCT(db,'org',{acao:'marcarPagamento',campeonatoId:id,timeId:'a_1',pago:true},NOW);
 assert.equal((await S.lerDetalheCT(db,'b',{campeonatoId:id})).inscricoes[0].pago,false);assert.equal((await S.lerDetalheCT(db,'a',{campeonatoId:id})).inscricoes[0].pago,true);assert.equal(db.data.get(base).aprovados,1);
});
const inscritos=n=>Array.from({length:n},(_,i)=>({timeId:'t'+i+'_1',donoId:'d'+i,timeNome:'Time '+i,cor:null,jogadores:[{id:'p'+i,nome:'P'+i}],status:'aprovada'}));
for(const [formato,n]of[['triangular',3],['quadrangular',4],['mata',4],['mata',8],['mata',16],['grupos_mata',8],['grupos_mata',16]])test('fluxo completo legítimo: '+formato+' '+n,()=>{
 const ins=inscritos(n),ordem=ins.map(i=>i.timeId),inicial=D.gerarJogosCT(formato,ordem);let jogos=inicial.jogos;let campeao=null;const camp={formato,ordem,grupos:inicial.grupos};let passos=0;
 while(!campeao&&passos++<70){const j=Object.values(jogos).sort((a,b)=>a.ordem-b.ordem).find(j=>j.casa&&j.fora&&j.golsCasa===null);assert.ok(j,'precisa haver jogo apto');const r=D.registrarResultadoCT(camp,ins,jogos,j.id,{golsCasa:1,golsFora:0});jogos=r.jogos;campeao=r.campeaoTimeId;}
 assert.ok(campeao);assert.ok(ordem.includes(campeao));assert.ok(Object.values(jogos).every(j=>j.status==='finalizado'));
 if(formato==='grupos_mata'){assert.equal(Object.values(jogos).filter(j=>!j.grupo).length,n/2-1);const g=Object.values(jogos).find(j=>j.grupo);assert.equal(D.resultadoEditavelCT(g,jogos),false);}
});
test('estatísticas por time, atletas externos e pênaltis inválidos são recusados',()=>{
 const ins=inscritos(4),ordem=ins.map(i=>i.timeId),{jogos}=D.gerarJogosCT('mata',ordem),j=Object.values(jogos)[0],camp={formato:'mata',ordem,grupos:{}};const uid=ins.find(i=>i.timeId===j.casa).jogadores[0].id;
 assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,{golsCasa:1,golsFora:3,assistencias:{[uid]:2}}),/ultrapassam/);
 assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,{golsCasa:1,golsFora:0,gols:{intruso:1}}),/inscrito/);
 assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,{golsCasa:0,golsFora:0,penaltis:[3,3]}));
});
test('paginação por cursor preserva campeonatos criados no mesmo milissegundo',async()=>{
 const db=new DB();for(let n=0;n<23;n++){const id='ct_'+n.toString(16).padStart(24,'0');db.data.set('campeonatosTimes/'+id,{status:'inscricoes',criadoEm:NOW,inscricoesAte:Date.now()+86400000});}
 const a=await S.listarCT(db,'a',{filtro:'abertos'}),b=await S.listarCT(db,'a',{filtro:'abertos',cursor:a.proximoCursor});assert.equal(a.campeonatos.length,20);assert.equal(b.campeonatos.length,3);assert.equal(new Set([...a.campeonatos,...b.campeonatos].map(c=>c.id)).size,23);
});
test('exclusão de conta cancela campeonato do organizador e anonimiza atleta sem recriar referências',async()=>{
 const{db,id,base}=await completo();const {excluirIdentidadeCT}=carregar('campeonatosTimesExclusao');await excluirIdentidadeCT(db,'a');assert.equal(db.data.get(base+'/inscricoes/a_1').status,'cancelada');assert.equal(db.data.get(base+'/inscricoes/a_1').donoId,'');assert.equal(db.data.get(base).envolvidos.includes('a'),false);await excluirIdentidadeCT(db,'org');assert.equal(db.data.get(base).status,'cancelado');assert.equal(db.data.get(base).organizadorId,'');await excluirIdentidadeCT(db,'org');
});
test('handler bloqueia sem autenticação/AppCheck antes de executar operação',async()=>{
 let chamou=false;const res={setHeader(){},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};
 const h=carregar('campeonatosTimesApi',{'./auth':{requireUser:async()=>null},'./cors':{handleCors:()=>false}},true);await h.handleCampeonatosTimes({method:'POST',headers:{},body:{acao:'criar'}},res);assert.equal(res.body,undefined);
 const h2=carregar('campeonatosTimesApi',{'./auth':{requireUser:async()=>({uid:'a'})},'./cors':{handleCors:()=>false},'./appCheck':{verificarAppCheck:async()=>false},'./rateLimit':{dentroDoLimite:async()=>{chamou=true;return true;}}},true);await h2.handleCampeonatosTimes({method:'POST',headers:{},body:{acao:'criar'}},res);assert.equal(chamou,false);
});
test('banner recusa URL remota e usuário que não organiza antes de chamar Cloudinary',async()=>{
 const{db,id}=await cenario();let uploads=0;const M=carregar('campeonatosTimesMidia',{'cloudinary':{v2:{uploader:{upload:async()=>{uploads++;}}}},'./config':{getAccount:()=>({cloud_name:'teste',api_key:'nao-secreto',api_secret:'nao-secreto'})}},true);
 await assert.rejects(M.patrocinadorCT(db,'org',{acao:'patrocinador',campeonatoId:id,nome:'Loja',imagem:'https://site/imagem.jpg'}),/Formato/);
 await assert.rejects(M.patrocinadorCT(db,'a',{acao:'patrocinador',campeonatoId:id,nome:'Loja'}),/organizador/);assert.equal(uploads,0);
});
test('liberação de grupos é conferida em transação e retry já criado não depende de nova liberação',async()=>{
 const db=new DB({'users/org':perfil('Org')});const b=corpo({formato:'grupos_mata',maxTimes:8});await assert.rejects(S.criarCT(db,'org',b,true,NOW),/liberação/);
 db.data.set('liberacoesCampeonatosTimes/org',{gruposMata:true,expiraEm:NOW+1000});const r=await S.criarCT(db,'org',b,true,NOW);db.data.delete('liberacoesCampeonatosTimes/org');const repetido=await S.criarCT(db,'org',b,false,NOW+172800000);assert.equal(r.campeonatoId,repetido.campeonatoId);
});
test('contagem zero do formulário é normalizada e resultado salvo aceita retry idêntico após fechar fase',()=>{
 const ins=inscritos(4),ordem=ins.map(i=>i.timeId);let{jogos}=D.gerarJogosCT('mata',ordem);const camp={formato:'mata',ordem,grupos:{}},j=Object.values(jogos)[0],uid=ins.find(i=>i.timeId===j.casa).jogadores[0].id;
 const body={golsCasa:1,golsFora:0,gols:{[uid]:0},assistencias:{[uid]:0}};jogos=D.registrarResultadoCT(camp,ins,jogos,j.id,body).jogos;assert.deepEqual(jogos[j.id].gols,{});
 while(Object.values(jogos).some(j=>j.golsCasa===null)){const p=Object.values(jogos).find(j=>j.casa&&j.fora&&j.golsCasa===null);const r=D.registrarResultadoCT(camp,ins,jogos,p.id,{golsCasa:1,golsFora:0});jogos=r.jogos;camp.campeaoTimeId=r.campeaoTimeId;}
 const repetido=D.registrarResultadoCT(camp,ins,jogos,j.id,body);assert.equal(repetido.campeaoTimeId,camp.campeaoTimeId);assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,{golsCasa:0,golsFora:1}),/fechado/);
});
test('banner com falha fica na fila durável; limpeza recupera órfão e preserva mídia referenciada',async()=>{
 const{db,id,base}=await cenario();let destruicoes=0;
 const conta={cloud_name:'teste',api_key:'teste',api_secret:'teste'};
 const U=carregar('campeonatosTimesMidia',{'cloudinary':{v2:{uploader:{upload:async()=>{throw Error('queda');}}}},'./config':{getAccount:()=>conta}},true);
 await assert.rejects(U.patrocinadorCT(db,'org',{acao:'patrocinador',campeonatoId:id,nome:'Loja',imagem:'data:image/jpeg;base64,/9j/AAAA'}),/queda/);
 const [p,job]=[...db.data].find(([p])=>p.startsWith('midiaCampeonatosTimes/'));job.criadoEm=Date.now()-86400001;
 const M=carregar('campeonatosTimesMidia',{'cloudinary':{v2:{uploader:{destroy:async()=>{destruicoes++;return{result:'ok'};}}}},'./config':{getAccount:()=>conta}},true);
 db.data.get(base).patrocinadores=[{id:'p_0000000000000001',publicId:job.publicId}];await M.limparBannersCT(db,Date.now()+10000);assert.equal(destruicoes,0);assert.equal(db.data.has(p),false);
 db.data.get(base).patrocinadores=[];db.data.set(p,{...job,leaseAte:null});await M.limparBannersCT(db,Date.now()+10000);assert.equal(destruicoes,1);assert.equal(db.data.has(p),false);
});
test('catálogo exclui prazos vencidos, meus mantém o histórico e filtros respeitam modalidade/cidade',async()=>{
 const db=new DB(),id=n=>'ct_'+n.toString(16).padStart(24,'0');
 for(const [n,prazo,cidade,modalidade]of [[1,-100,'palmas_to','futsal'],[2,100000,'palmas_to','futsal'],[3,200000,'goiania_go','campo']])db.data.set('campeonatosTimes/'+id(n),{status:'inscricoes',envolvidos:['a'],criadoEm:NOW,inscricoesAte:Date.now()+prazo,cityId:cidade,modalidade});
 assert.equal((await S.listarCT(db,'a',{filtro:'abertos'})).campeonatos.length,2);assert.equal((await S.listarCT(db,'a',{filtro:'meus'})).campeonatos.length,3);assert.equal((await S.listarCT(db,'a',{filtro:'abertos',cityId:'palmas_to',modalidade:'futsal'})).campeonatos.length,1);
});
