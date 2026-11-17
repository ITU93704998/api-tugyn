const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(require.resolve('typescript', { paths: [root] }));
const cache = new Map();
/** Corpo do resultado com o que o formulário viu (adversários e versão do jogo). */
const V = (j, b) => ({ casaEsperada: j.casa, foraEsperada: j.fora, versaoEsperada: j.versao ?? 0, ...b });
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
 get parent(){return new Query(this.db,this.path.split('/').slice(0,-1).join('/'));}
 collection(n){return new Query(this.db,this.path+'/'+n);}
 async get(){return this.db.snap(this.path);}
 async delete(){this.db.data.delete(this.path);}
 async set(v){this.db.data.set(this.path,clone(v));}
 async update(v){const a=this.db.data.get(this.path);if(!a)throw Error("not-found");this.db.data.set(this.path,{...a,...v});}
}
class Query {
 constructor(db,p,filters=[],orders=[],lim=Infinity,cursor=null){Object.assign(this,{db,path:p,filters,orders,lim,cursor});}
 doc(n){return new Ref(this.db,this.path+'/'+n);}
 get id(){return this.path.split('/').at(-1);}
 get parent(){const p=this.path.split('/');return p.length>1?new Ref(this.db,p.slice(0,-1).join('/')):null;}
 where(k,op,v){return new Query(this.db,this.path,[...this.filters,[k,op,v]],this.orders,this.lim,this.cursor);}
 orderBy(k,d='asc'){return new Query(this.db,this.path,this.filters,[...this.orders,[typeof k==='string'?k:'__name__',d]],this.lim,this.cursor);}
 limit(n){return new Query(this.db,this.path,this.filters,this.orders,n,this.cursor);}
 startAfter(...v){if(v.length===1&&typeof v[0]?.get==='function'){const s=v[0];v=[s.get(this.orders[0][0]),s.id];}return new Query(this.db,this.path,this.filters,this.orders,this.lim,v);}
 async get(){
  const grupo=this.path.startsWith('**/')?this.path.slice(3):null;
  let all=[...this.db.data.keys()].filter(p=>grupo?p.split('/').at(-2)===grupo&&p.split('/').length%2===0:p.startsWith(this.path+'/')&&p.split('/').length===this.path.split('/').length+1).map(p=>this.db.snap(p));
  const campo=(s,k)=>k.split('.').reduce((o,p)=>o?.[p],s.data());all=all.filter(s=>this.filters.every(([k,op,v])=>op==='in'?v.includes(campo(s,k)):op==='=='?s.get(k)===v:op==='array-contains'?s.get(k)?.includes(v):op==='<='?s.get(k)<=v:op==='>'?s.get(k)>v:false));
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
 collectionGroup(n){return new Query(this,'**/'+n);}
 snap(p){const v=this.data.get(p);return{id:p.split('/').at(-1),ref:this.doc(p),exists:v!==undefined,data:()=>v===undefined?undefined:clone(v),get:k=>v?.[k]};}
 async runTransaction(fn){
  // Serializa commits e aplica somente depois do callback: detecta leitura após escrita e testa rollback.
  const prior=this.tail;let release;this.tail=new Promise(r=>release=r);await prior;
  const writes=[];let escreveu=false;
  const read=async r=>{assert.equal(escreveu,false,'leitura depois de escrita');return r.get();};
  const tx={get:read,getAll:async(...refs)=>Promise.all(refs.filter(r=>typeof r.get==='function').map(read)),create:(r,d)=>{escreveu=true;writes.push(['create',r,d]);},set:(r,d)=>{escreveu=true;writes.push(['set',r,d]);},update:(r,d)=>{escreveu=true;writes.push(['update',r,d]);},delete:r=>{escreveu=true;writes.push(['delete',r]);}};
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
test('pedido anterior à reserva no pendente (sem trava): só uma aprovação concorrente conclui',async()=>{
 const{db,id,base}=await cenario();db.data.set('times/b_1',time('b',['a','b']));await S.inscreverCT(db,'a',pedido(id,'a'),NOW);
 // Simula um pedido legado do time B com o atleta "a" e sem trava própria (gravado antes desta versão).
 db.data.delete(base+'/atletas/a');db.data.set(base+'/inscricoes/b_1',{...db.data.get(base+'/inscricoes/a_1'),timeId:'b_1',donoId:'b',timeNome:'Time b'});db.data.get(base).pendentes=2;
 const r=await Promise.allSettled(['a','b'].map(w=>S.responderCT(db,'org',{...pedido(id,w),aceitar:true},NOW)));assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(db.data.get('campeonatosTimes/'+id).aprovados,1);
});
test('cancelamento libera vaga e trava do atleta; início incompleto falha sem gravar jogos',async()=>{
 const{db,id,base}=await completo();await S.cancelarInscricaoCT(db,'a',pedido(id,'a'),NOW);assert.equal(db.data.has(base+'/atletas/a'),false);await assert.rejects(S.iniciarCT(db,'org',{campeonatoId:id},NOW),/3 times/);assert.equal([...db.data.keys()].some(p=>p.startsWith(base+'/jogos/')),false);
});
test('último resultado aguarda finalização explícita do organizador',async()=>{
 const{db,id,base}=await completo();await assert.rejects(S.iniciarCT(db,'a',{campeonatoId:id},NOW),/organizador/);await S.iniciarCT(db,'org',{campeonatoId:id},NOW);
 let detalhe=await S.lerDetalheCT(db,'org',{campeonatoId:id});assert.equal(detalhe.jogos.length,3);
 const j=detalhe.jogos[0];await assert.rejects(S.resultadoCT(db,'a',V(j,{campeonatoId:id,jogoId:j.id,golsCasa:2,golsFora:0}),NOW),/organizador/);
 for(const jogo of detalhe.jogos)await S.resultadoCT(db,'org',V(jogo,{campeonatoId:id,jogoId:jogo.id,golsCasa:2,golsFora:0}),NOW);
 assert.equal(db.data.get(base).status,'em_andamento');assert.ok(db.data.get(base).campeaoTimeId);assert.equal(db.data.get('controleCampeonatosTimes/org').ativos,1);
 const revisaoEsperada=db.data.get(base).premiacaoVersao;
 await S.finalizarCT(db,'org',{campeonatoId:id,revisaoEsperada},NOW+1);
 assert.equal(db.data.get(base).status,'encerrado');assert.equal(db.data.get('controleCampeonatosTimes/org').ativos,0);
});
test('privacidade: pedido pendente e pagamento só para organizador e dono da inscrição',async()=>{
 const{db,id,base}=await cenario();await S.inscreverCT(db,'a',pedido(id,'a'),NOW);let d=await S.lerDetalheCT(db,'b',{campeonatoId:id});assert.equal(d.inscricoes.length,0);
 await S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW);await S.administrarCT(db,'org',{acao:'marcarPagamento',campeonatoId:id,timeId:'a_1',pago:true},NOW);
 assert.equal((await S.lerDetalheCT(db,'b',{campeonatoId:id})).inscricoes[0].pago,false);assert.equal((await S.lerDetalheCT(db,'a',{campeonatoId:id})).inscricoes[0].pago,true);assert.equal(db.data.get(base).aprovados,1);
});
const inscritos=n=>Array.from({length:n},(_,i)=>({timeId:'t'+i+'_1',donoId:'d'+i,timeNome:'Time '+i,cor:null,jogadores:[{id:'p'+i,nome:'P'+i}],status:'aprovada'}));
for(const [formato,n]of[['triangular',3],['quadrangular',4],['mata',4],['mata',8],['mata',16],['grupos_mata',8],['grupos_mata',16]])test('fluxo completo legítimo: '+formato+' '+n,()=>{
 const ins=inscritos(n),ordem=ins.map(i=>i.timeId),inicial=D.gerarJogosCT(formato,ordem);let jogos=inicial.jogos;let campeao=null;const camp={formato,ordem,grupos:inicial.grupos};let passos=0;
 while(!campeao&&passos++<70){const j=Object.values(jogos).sort((a,b)=>a.ordem-b.ordem).find(j=>j.casa&&j.fora&&j.golsCasa===null);assert.ok(j,'precisa haver jogo apto');const r=D.registrarResultadoCT(camp,ins,jogos,j.id,V(j,{golsCasa:1,golsFora:0}));jogos=r.jogos;campeao=r.campeaoTimeId;}
 assert.ok(campeao);assert.ok(ordem.includes(campeao));assert.ok(Object.values(jogos).every(j=>j.status==='finalizado'));
 if(formato==='grupos_mata'){assert.equal(Object.values(jogos).filter(j=>!j.grupo).length,n/2-1);const g=Object.values(jogos).find(j=>j.grupo);assert.equal(D.resultadoEditavelCT(g,jogos),false);}
});
test('estatísticas por time, atletas externos e pênaltis inválidos são recusados',()=>{
 const ins=inscritos(4),ordem=ins.map(i=>i.timeId),{jogos}=D.gerarJogosCT('mata',ordem),j=Object.values(jogos)[0],camp={formato:'mata',ordem,grupos:{}};const uid=ins.find(i=>i.timeId===j.casa).jogadores[0].id;
 assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,V(j,{golsCasa:1,golsFora:3,assistencias:{[uid]:2}})),/ultrapassam/);
 assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,V(j,{golsCasa:1,golsFora:0,gols:{intruso:1}})),/inscrito/);
 assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,V(j,{golsCasa:0,golsFora:0,penaltis:[3,3]})));
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
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;
 const db=new DB({'users/org':perfil('Org')});const b=corpo({formato:'grupos_mata',maxTimes:8});await assert.rejects(S.criarCT(db,'org',b,true,NOW),/premium/);
 db.data.set('liberacoesCampeonatosTimes/org',{gruposMata:true,expiraEm:NOW+1000});const r=await S.criarCT(db,'org',b,true,NOW);db.data.delete('liberacoesCampeonatosTimes/org');const repetido=await S.criarCT(db,'org',b,false,NOW+172800000);assert.equal(r.campeonatoId,repetido.campeonatoId);
 P.PREMIUM_CT.gruposParaTodos=true;
});
test('contagem zero do formulário é normalizada e resultado salvo aceita retry idêntico após fechar fase',()=>{
 const ins=inscritos(4),ordem=ins.map(i=>i.timeId);let{jogos}=D.gerarJogosCT('mata',ordem);const camp={formato:'mata',ordem,grupos:{}},j=Object.values(jogos)[0],uid=ins.find(i=>i.timeId===j.casa).jogadores[0].id;
 const body=V(j,{golsCasa:1,golsFora:0,gols:{[uid]:0},assistencias:{[uid]:0}});jogos=D.registrarResultadoCT(camp,ins,jogos,j.id,body).jogos;assert.deepEqual(jogos[j.id].gols,{});
 while(Object.values(jogos).some(j=>j.golsCasa===null)){const p=Object.values(jogos).find(j=>j.casa&&j.fora&&j.golsCasa===null);const r=D.registrarResultadoCT(camp,ins,jogos,p.id,V(p,{golsCasa:1,golsFora:0}));jogos=r.jogos;camp.campeaoTimeId=r.campeaoTimeId;}
 const repetido=D.registrarResultadoCT(camp,ins,jogos,j.id,body);assert.equal(repetido.campeaoTimeId,camp.campeaoTimeId);assert.throws(()=>D.registrarResultadoCT(camp,ins,jogos,j.id,V(jogos[j.id],{golsCasa:0,golsFora:1})),/fechado/);
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

test('catálogo por região: minha cidade e todas as cidades do meu estado, a partir do perfil (nunca do cliente)',async()=>{
 const db=new DB(),id=n=>'ct_'+n.toString(16).padStart(24,'0');
 db.data.set('users/a',{name:'A',status:'active',location:{city:'Palmas',state:'TO',cityId:'palmas_to'}});
 db.data.set('users/semlocal',{name:'B',status:'active'});
 for(const [n,cidade,uf,modalidade]of [[1,'palmas_to','TO','futsal'],[2,'araguaina_to','TO','campo'],[3,'goiania_go','GO','futsal'],[4,'palmas_to','TO','campo']])db.data.set('campeonatosTimes/'+id(n),{status:'inscricoes',envolvidos:[],criadoEm:NOW,inscricoesAte:Date.now()+100000*n,cityId:cidade,estado:uf,modalidade});
 const cidade=await S.listarCT(db,'a',{filtro:'abertos',escopo:'cidade',cityId:'goiania_go'});
 assert.deepEqual(cidade.campeonatos.map(c=>c.id),[id(1),id(4)]);assert.deepEqual({...cidade.local},{cidade:'Palmas',uf:'TO'});
 assert.deepEqual((await S.listarCT(db,'a',{filtro:'abertos',escopo:'estado'})).campeonatos.map(c=>c.id),[id(1),id(2),id(4)]);
 assert.deepEqual((await S.listarCT(db,'a',{filtro:'abertos',escopo:'estado',modalidade:'campo'})).campeonatos.map(c=>c.id),[id(2),id(4)]);
 const sem=await S.listarCT(db,'semlocal',{filtro:'abertos',escopo:'cidade'});assert.equal(sem.campeonatos.length,0);assert.equal(sem.semLocalizacao,true);
 await assert.rejects(S.listarCT(db,'a',{filtro:'abertos',escopo:'pais'}),/Região inválida/);
});

const jogosDe = (x) => Object.fromEntries([...x.db.data].filter(([p]) => p.startsWith(x.base + '/jogos/')).map(([, j]) => [j.id, structuredClone(j)]));

test('CT-A01/A07: chave corrigida recusa formulário antigo da final; outra semifinal não fecha a primeira', async () => {
  const x = await cenario({ formato: 'mata', maxTimes: 4 }); x.db.data.set('users/d', perfil('D')); x.db.data.set('times/d_1', time('d'));
  for (const u of ['a', 'b', 'c', 'd']) { await S.inscreverCT(x.db, u, pedido(x.id, u), NOW); await S.responderCT(x.db, 'org', { ...pedido(x.id, u), aceitar: true }, NOW); }
  await S.iniciarCT(x.db, 'org', { campeonatoId: x.id }, NOW);
  const semis = Object.values(jogosDe(x)).filter((j) => j.casa && j.fora).sort((a, b) => a.ordem - b.ordem);
  for (const j of semis) await S.resultadoCT(x.db, 'org', V(jogosDe(x)[j.id], { campeonatoId: x.id, jogoId: j.id, golsCasa: 1, golsFora: 0 }), NOW);
  let todos = jogosDe(x);
  // A07: com a final ainda sem placar, as duas semifinais continuam corrigíveis.
  for (const j of semis) assert.equal(D.resultadoEditavelCT(todos[j.id], todos), true);
  const aberto = todos.final; // formulário da final aberto no celular 1
  const ultima = semis.at(-1);
  await S.resultadoCT(x.db, 'org', V(todos[ultima.id], { campeonatoId: x.id, jogoId: ultima.id, golsCasa: 0, golsFora: 1, motivo: 'Placar invertido na súmula' }), NOW + 1);
  todos = jogosDe(x);
  assert.notDeepEqual([aberto.casa, aberto.fora], [todos.final.casa, todos.final.fora]);
  assert.equal(todos.final.versao, aberto.versao + 1);
  // A01: o formulário antigo não grava o placar no confronto novo.
  await assert.rejects(S.resultadoCT(x.db, 'org', V(aberto, { campeonatoId: x.id, jogoId: 'final', golsCasa: 4, golsFora: 0 }), NOW + 2),
    (e) => e.status === 409 && e.code === 'jogo_desatualizado');
  assert.equal(x.db.data.get(x.base + '/jogos/final').golsCasa, null);
  // Atualizado, grava; e aí a semifinal que alimenta a final fecha.
  await S.resultadoCT(x.db, 'org', V(todos.final, { campeonatoId: x.id, jogoId: 'final', golsCasa: 4, golsFora: 0 }), NOW + 3);
  todos = jogosDe(x);
  for (const j of semis) assert.equal(D.resultadoEditavelCT(todos[j.id], todos), false);
});

test('CT-A01: segunda edição sobre tela antiga é recusada; retry idêntico continua aceito', async () => {
  const y = await completo(); await S.iniciarCT(y.db, 'org', { campeonatoId: y.id }, NOW);
  const jogo = Object.values(jogosDe(y))[0];
  const corpo = V(jogo, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 0 });
  await S.resultadoCT(y.db, 'org', corpo, NOW);
  await S.resultadoCT(y.db, 'org', corpo, NOW + 1); // resposta perdida: repete igual
  await assert.rejects(S.resultadoCT(y.db, 'org', V(jogo, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 1, golsFora: 0 }), NOW + 2), (e) => e.code === 'jogo_desatualizado');
  assert.equal(y.db.data.get(y.base + '/jogos/' + jogo.id).golsCasa, 2);
  await assert.rejects(S.resultadoCT(y.db, 'org', { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 1, golsFora: 0, casaEsperada: jogo.casa, foraEsperada: jogo.fora }, NOW + 3), /Versão/);
  const atual = jogosDe(y)[jogo.id];
  await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 1, golsFora: 0, motivo: 'Gol anulado depois do jogo' }), NOW + 4);
  assert.equal(y.db.data.get(y.base + '/jogos/' + jogo.id).golsCasa, 1);
});

test('CT-A05: retry da mesma tentativa não reabre pedido recusado; nova tentativa reenvia', async () => {
  const z = await cenario();
  const p = { ...pedido(z.id, 'a'), tentativaId: 'tentativa_0001' };
  await S.inscreverCT(z.db, 'a', p, NOW);
  await S.responderCT(z.db, 'org', { ...pedido(z.id, 'a'), aceitar: false, motivo: 'Elenco incompleto' }, NOW);
  await S.inscreverCT(z.db, 'a', p, NOW + 1);
  assert.equal(z.db.data.get(z.base + '/inscricoes/a_1').status, 'recusada');
  await S.inscreverCT(z.db, 'a', { ...p, tentativaId: 'tentativa_0002' }, NOW + 2);
  assert.equal(z.db.data.get(z.base + '/inscricoes/a_1').status, 'pendente');
  await assert.rejects(S.inscreverCT(z.db, 'a', { ...p, tentativaId: 'x' }, NOW + 3), /Tentativa/);
  const det = await S.lerDetalheCT(z.db, 'org', { campeonatoId: z.id });
  assert.ok(det.inscricoes.every((i) => !('tentativaId' in i)));
});

test('CT-A03: falha numa imagem não interrompe o lote; item volta com espera e sai após várias falhas', async () => {
  const x = await cenario(); const conta = { cloud_name: 'teste', api_key: 'teste', api_secret: 'teste' }; const tentou = [];
  const M = carregar('campeonatosTimesMidia', { 'cloudinary': { v2: { uploader: { destroy: async (id) => { tentou.push(id); if (id.endsWith('imagem0')) throw Error('falha transitória'); return { result: 'ok' }; } } } }, './config': { getAccount: () => conta } }, true);
  for (let i = 0; i < 2; i++) x.db.data.set('midiaCampeonatosTimes/job' + i, { uid: 'org', campeonatoId: x.id, publicId: `turmas/org/campeonatos/${x.id}/imagem${i}`, status: 'pendente', criadoEm: Date.now() - 86400000 - 100 + i, leaseAte: null });
  x.db.data.set('midiaCampeonatosTimes/ruim', { uid: 'org', campeonatoId: x.id, publicId: 'https://fora/x', status: 'pendente', criadoEm: Date.now() - 86400000 - 200, leaseAte: null });
  const r = await M.limparBannersCT(x.db, Date.now() + 10000);
  assert.deepEqual({ ...r }, { apagados: 1, mantidos: 0, falhas: 1, adiados: 0, invalidos: 1 });
  assert.equal(tentou.length, 2); assert.equal(x.db.data.has('midiaCampeonatosTimes/job1'), false);
  const falho = x.db.data.get('midiaCampeonatosTimes/job0');
  assert.equal(falho.tentativas, 1); assert.equal(falho.leaseAte, null); assert.ok(falho.criadoEm > Date.now() - 86400000, 'reagendado para depois');
  assert.equal(x.db.data.get('midiaCampeonatosTimes/ruim').status, 'invalido');
  assert.ok(!/transitória/.test(falho.ultimoErro), 'erro externo não vai cru para o registro');
  // Na oitava falha, sai da fila.
  Object.assign(falho, { tentativas: 7, criadoEm: Date.now() - 86400001 });
  await M.limparBannersCT(x.db, Date.now() + 10000);
  assert.equal(x.db.data.get('midiaCampeonatosTimes/job0').status, 'falhou');
});

test('CT-A04: retry da mesma imagem reaproveita o arquivo; nada novo vai para a fila de exclusão', async () => {
  const x = await cenario(); const conta = { cloud_name: 'teste', api_key: 'teste', api_secret: 'teste' }; const envios = [];
  const M = carregar('campeonatosTimesMidia', { 'cloudinary': { v2: { uploader: { upload: async (_img, o) => { envios.push(o.public_id); return { public_id: o.public_id, secure_url: 'https://res.cloudinary.com/t/' + o.public_id }; } } } }, './config': { getAccount: () => conta } }, true);
  const corpo = { acao: 'patrocinador', campeonatoId: x.id, patrocinadorId: 'p_00000000000000aa', nome: 'Loja', imagem: 'data:image/jpeg;base64,/9j/AAAA' };
  await M.patrocinadorCT(x.db, 'org', corpo);
  await M.patrocinadorCT(x.db, 'org', corpo); // resposta perdida: o app repete
  assert.equal(envios.length, 1);
  const fila = () => [...x.db.data.keys()].filter((p) => p.startsWith('midiaCampeonatosTimes/'));
  assert.deepEqual(fila(), []);
  assert.equal(x.db.data.get(x.base).patrocinadores.length, 1);
  // Upload feito mas resposta final perdida (reserva ficou): o retry renova a reserva em vez de recusar.
  const outra = { ...corpo, imagem: 'data:image/jpeg;base64,/9j/BBBB' };
  await M.patrocinadorCT(x.db, 'org', outra);
  assert.equal(envios.length, 2); assert.notEqual(envios[0], envios[1]);
  assert.equal(fila().length, 1, 'só a imagem substituída vai para exclusão');
});

test('revalidação: T1 atrasada depois de T2 recusada não reabre inscrição e ID não pode mudar elenco', async () => {
 const z=await cenario(),p={...pedido(z.id,'a'),tentativaId:'tentativa_0001'};
 await S.inscreverCT(z.db,'a',p,NOW);
 await S.responderCT(z.db,'org',{...pedido(z.id,'a'),aceitar:false},NOW);
 await S.inscreverCT(z.db,'a',{...p,tentativaId:'tentativa_0002'},NOW+1);
 await S.responderCT(z.db,'org',{...pedido(z.id,'a'),aceitar:false},NOW+2);
 await S.inscreverCT(z.db,'a',p,NOW+3);
 assert.equal(z.db.data.get(z.base+'/inscricoes/a_1').status,'recusada');
 await assert.rejects(S.inscreverCT(z.db,'a',{...p,jogadorIds:['b']},NOW+4),/dados desta tentativa/);
 await assert.rejects(S.inscreverCT(z.db,'a',pedido(z.id,'a'),NOW+4),/nova tentativa/);
 const d=await S.lerDetalheCT(z.db,'org',{campeonatoId:z.id});assert.ok(d.inscricoes.every(i=>!('tentativasTotal' in i)));
});

async function prontoParaFinalizar() {
 const x=await completo();await S.iniciarCT(x.db,'org',{campeonatoId:x.id},NOW);
 const d=await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id});
 for(const j of d.jogos)await S.resultadoCT(x.db,'org',V(j,{campeonatoId:x.id,jogoId:j.id,golsCasa:2,golsFora:0}),NOW);
 return {...x,revisaoEsperada:x.db.data.get(x.base).premiacaoVersao};
}
test('finalização: somente organizador, com todos os jogos e revisão atual',async()=>{
 const x=await completo(),body={campeonatoId:x.id,revisaoEsperada:0};
 await assert.rejects(S.finalizarCT(x.db,'a',body,NOW),e=>e.status===403);
 await assert.rejects(S.finalizarCT(x.db,'org',body,NOW),/em andamento/);
 await S.iniciarCT(x.db,'org',{campeonatoId:x.id},NOW);
 await assert.rejects(S.finalizarCT(x.db,'org',body,NOW),/Conclua todos/);
 assert.equal(x.db.data.get('controleCampeonatosTimes/org').ativos,1);
 const y=await prontoParaFinalizar();
 await assert.rejects(S.finalizarCT(y.db,'org',{campeonatoId:y.id},NOW),/Revise os resultados/);
 await assert.rejects(S.finalizarCT(y.db,'org',{campeonatoId:y.id,revisaoEsperada:y.revisaoEsperada-1},NOW),e=>e.code==='campeonato_desatualizado');
 assert.equal(y.db.data.get(y.base).status,'em_andamento');
});
test('finalização: dados manipulados não geram encerramento nem liberam cota',async()=>{
 const x=await prontoParaFinalizar();x.db.data.get(x.base).campeaoTimeId='falso';
 await assert.rejects(S.finalizarCT(x.db,'org',{campeonatoId:x.id,revisaoEsperada:x.revisaoEsperada},NOW),/validar o campeão/);
 assert.equal(x.db.data.get(x.base).status,'em_andamento');assert.equal(x.db.data.get('controleCampeonatosTimes/org').ativos,1);
});
test('finalização: dois aparelhos e retry não duplicam encerramento/cota; retorno perdido pode ser repetido',async()=>{
 const x=await prontoParaFinalizar(),b={campeonatoId:x.id,revisaoEsperada:x.revisaoEsperada};
 await Promise.all([S.finalizarCT(x.db,'org',b,NOW+1),S.finalizarCT(x.db,'org',b,NOW+2)]);
 await S.finalizarCT(x.db,'org',b,NOW+3);
 assert.equal(x.db.data.get(x.base).finalizadoEm,NOW+1);assert.equal(x.db.data.get('controleCampeonatosTimes/org').ativos,0);
});
test('finalização: corrigir resultado reabre para revisão e exige nova confirmação',async()=>{
 const x=await prontoParaFinalizar(),b={campeonatoId:x.id,revisaoEsperada:x.revisaoEsperada};
 await S.finalizarCT(x.db,'org',b,NOW+1);
 const antes=await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id}),j=antes.jogos[0];
 // Retry idêntico do placar original não reabre o campeonato.
 await S.resultadoCT(x.db,'org',V(j,{campeonatoId:x.id,jogoId:j.id,golsCasa:2,golsFora:0}),NOW+2);
 assert.equal(x.db.data.get(x.base).status,'encerrado');
 await S.resultadoCT(x.db,'org',V(j,{campeonatoId:x.id,jogoId:j.id,golsCasa:0,golsFora:2,motivo:'Placar invertido'}),NOW+3);
 assert.equal(x.db.data.get(x.base).status,'em_andamento');assert.equal(x.db.data.get('controleCampeonatosTimes/org').ativos,1);
 assert.equal(x.db.data.get(x.base).finalizadoEm,null);
 await assert.rejects(S.finalizarCT(x.db,'org',b,NOW+4),e=>e.code==='campeonato_desatualizado');
 const revisaoEsperada=x.db.data.get(x.base).premiacaoVersao;
 await S.finalizarCT(x.db,'org',{campeonatoId:x.id,revisaoEsperada},NOW+5);
 assert.equal(x.db.data.get(x.base).status,'encerrado');assert.equal(x.db.data.get('controleCampeonatosTimes/org').ativos,0);
});
test('finalização: falha de transação não apresenta campeonato encerrado',async()=>{
 const x=await prontoParaFinalizar();x.db.runTransaction=async()=>{throw Error('rede indisponível');};
 await assert.rejects(S.finalizarCT(x.db,'org',{campeonatoId:x.id,revisaoEsperada:x.revisaoEsperada},NOW),/rede indisponível/);
 assert.equal(x.db.data.get(x.base).status,'em_andamento');assert.equal(x.db.data.get('controleCampeonatosTimes/org').ativos,1);
});

const FOTO_A='https://res.cloudinary.com/teste/image/upload/v1/usuarios/a/profile.jpg';
test('fotos: inscrição e aprovação usam perfil canônico já lido, ignorando foto enviada no pedido',async()=>{
 const x=await cenario();x.db.data.get('users/a').profileImage=FOTO_A;
 x.db.data.get('times/a_1').jogadores.a.foto='https://site.invalid/forjada.jpg';
 await S.inscreverCT(x.db,'a',{...pedido(x.id,'a'),foto:'https://site.invalid/injetada.jpg'},NOW);
 assert.equal(x.db.data.get(x.base+'/inscricoes/a_1').jogadores[0].foto,FOTO_A);
 const nova=FOTO_A.replace('/v1/','/v2/');x.db.data.get('users/a').profileImage=nova;
 await S.responderCT(x.db,'org',{...pedido(x.id,'a'),aceitar:true},NOW);
 assert.equal(x.db.data.get(x.base+'/inscricoes/a_1').jogadores[0].foto,nova);
 const d=await S.lerDetalheCT(x.db,'b',{campeonatoId:x.id});assert.equal(d.inscricoes[0].jogadores[0].foto,nova);
});
test('fotos: valida URLs e protocolos de imagens',()=>{
 assert.equal(D.fotoAtletaCT(FOTO_A),FOTO_A);
 for(const v of [null,'','javascript:alert(1)','data:image/png;base64,x','http://res.cloudinary.com/teste/image/upload/a.jpg','https://res.cloudinary.com.evil.invalid/teste/image/upload/a.jpg','https://res.cloudinary.com@evil.invalid/teste/image/upload/a.jpg','https://site.invalid/a.jpg'])assert.equal(D.fotoAtletaCT(v),null);
});

test('FOTO-01/02: inscrição antiga recupera perfil canônico mesmo sem time, persiste e não relê usuários',async()=>{
 const x=await completo(),ir=x.base+'/inscricoes/a_1';delete x.db.data.get(ir).jogadores[0].foto;
 const antes=clone(x.db.data.get(ir)),campeonatoAntes=clone(x.db.data.get(x.base));
 x.db.data.get('users/a').profileImage=FOTO_A;x.db.data.get('users/a').name='Nome atual do perfil';x.db.data.delete('times/a_1');
 const snap=x.db.snap.bind(x.db),lidas=[];x.db.snap=p=>{lidas.push(p);return snap(p);};
 const d=await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id});
 assert.equal(d.inscricoes.find(i=>i.timeId==='a_1').jogadores[0].foto,FOTO_A);
 assert.equal(x.db.data.get(ir).jogadores[0].foto,FOTO_A);
 assert.deepEqual(x.db.data.get(ir),{...antes,jogadores:antes.jogadores.map(j=>({...j,foto:FOTO_A}))});
 assert.deepEqual(x.db.data.get(x.base),campeonatoAntes,'não regrava raiz/títulos/revisão');
 assert.equal(lidas.filter(p=>p==='users/a').length,1);assert.equal(lidas.some(p=>p.startsWith('times/')),false);
 lidas.length=0;
 for(let i=0;i<3;i++)await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id});
 assert.equal(lidas.some(p=>p.startsWith('users/')||p.startsWith('times/')),false,'sem leituras recorrentes de perfil ou time');
});

test('fotos: null explícito não é substituído nem consultado, e conta ausente/em exclusão vira null',async()=>{
 const x=await completo();x.db.data.get('users/a').profileImage=FOTO_A;
 delete x.db.data.get(x.base+'/inscricoes/b_1').jogadores[0].foto;
 delete x.db.data.get(x.base+'/inscricoes/c_1').jogadores[0].foto;
 x.db.data.get('users/b').profileImage=FOTO_A;x.db.data.get('users/b').excluindoEm=NOW;x.db.data.delete('users/c');
 const snap=x.db.snap.bind(x.db),lidas=[];x.db.snap=p=>{lidas.push(p);return snap(p);};
 const d=await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id});
 assert.equal(d.inscricoes.find(i=>i.timeId==='a_1').jogadores[0].foto,null);
 assert.equal(lidas.includes('users/a'),false);
 assert.equal(x.db.data.get(x.base+'/inscricoes/b_1').jogadores[0].foto,null);
 assert.equal(x.db.data.get(x.base+'/inscricoes/c_1').jogadores[0].foto,null);
 assert.equal(x.db.data.has('users/c'),false);
});

test('fotos: visitante não recupera nem recebe pedido pendente de outro dono',async()=>{
 const x=await cenario();await S.inscreverCT(x.db,'a',pedido(x.id,'a'),NOW);
 const ir=x.base+'/inscricoes/a_1';delete x.db.data.get(ir).jogadores[0].foto;x.db.data.get('users/a').profileImage=FOTO_A;
 const d=await S.lerDetalheCT(x.db,'b',{campeonatoId:x.id});assert.equal(d.inscricoes.length,0);
 assert.equal(Object.hasOwn(x.db.data.get(ir).jogadores[0],'foto'),false);
 await S.lerDetalheCT(x.db,'a',{campeonatoId:x.id});assert.equal(x.db.data.get(ir).jogadores[0].foto,FOTO_A);
});

test('fotos: recuperação concorrente é idempotente e não recria inscrição/campeonato excluídos',async()=>{
 const x=await completo(),ir=x.base+'/inscricoes/a_1';delete x.db.data.get(ir).jogadores[0].foto;x.db.data.get('users/a').profileImage=FOTO_A;
 const F=carregar('campeonatosTimesFotos');
 const r=await Promise.all([F.completarFotosInscricoesCT(x.db,x.id,['a_1']),F.completarFotosInscricoesCT(x.db,x.id,['a_1'])]);
 assert.deepEqual(r,[1,0]);assert.equal(x.db.data.get(ir).jogadores[0].foto,FOTO_A);
 x.db.data.delete(ir);assert.equal(await F.completarFotosInscricoesCT(x.db,x.id,['a_1']),0);assert.equal(x.db.data.has(ir),false);
 x.db.data.delete(x.base);assert.equal(await F.completarFotosInscricoesCT(x.db,x.id,['b_1']),0);assert.equal(x.db.data.has(x.base),false);
});

test('fotos: migração com falha pode ser repetida sem declarar gravação antes do commit',async()=>{
 const x=await completo(),ir=x.base+'/inscricoes/a_1';delete x.db.data.get(ir).jogadores[0].foto;x.db.data.get('users/a').profileImage=FOTO_A;
 const real=x.db.runTransaction.bind(x.db);let chamadas=0;x.db.runTransaction=fn=>++chamadas===2?Promise.reject(Error('falha de conexão simulada')):real(fn);
 await assert.rejects(S.lerDetalheCT(x.db,'org',{campeonatoId:x.id}),/conexão simulada/);
 assert.equal(Object.hasOwn(x.db.data.get(ir).jogadores[0],'foto'),false);
 x.db.runTransaction=real;await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id});assert.equal(x.db.data.get(ir).jogadores[0].foto,FOTO_A);
});


test('fotos: excluir conta remove foto da inscrição junto da identidade',async()=>{
 const x=await completo();x.db.data.get(x.base+'/inscricoes/a_1').jogadores[0].foto=FOTO_A;
 const E=carregar('campeonatosTimesExclusao');await E.excluirIdentidadeCT(x.db,'a');
 const a=x.db.data.get(x.base+'/inscricoes/a_1').jogadores[0];assert.equal(a.nome,'Usuário removido');assert.equal(a.foto,null);assert.notEqual(a.id,'a');
});

test('saídas regionais: lista só envolvimentos e inscrições da conta, sem dados privados e sem aceitar filtro forjado',async()=>{
 const R=carregar('saidasRegionaisCT');const id='ct_'+ 'a'.repeat(24), outro='ct_'+'b'.repeat(24);
 const db=new DB({['campeonatosTimes/'+id]:{nome:'Minha copa',envolvidos:['a'],organizadorId:'a',status:'inscricoes',criadoEm:100},['campeonatosTimes/'+outro]:{nome:'Privado',envolvidos:['b'],organizadorId:'b',status:'inscricoes',criadoEm:99},['campeonatosTimes/'+id+'/inscricoes/a_1']:{donoId:'a',timeNome:'Meu time',status:'pendente',pago:true,jogadores:[{id:'segredo'}]},['campeonatosTimes/'+id+'/inscricoes/b_1']:{donoId:'b',timeNome:'Outro time',status:'aprovada',pago:true}});
 const r=await R.listarSaidasRegionaisCT(db,'a',{filtro:'abertos',uid:'b'});
 assert.deepEqual(r.itens,[{id,nome:'Minha copa',podeCancelar:true,inscricoes:[{timeId:'a_1',nome:'Meu time'}]}]);
 assert.equal(JSON.stringify(r).includes('segredo'),false);assert.equal(JSON.stringify(r).includes('pago'),false);
 db.data.get('campeonatosTimes/'+id).status='encerrado';const fim=await R.listarSaidasRegionaisCT(db,'a',{});assert.equal(fim.itens[0].podeCancelar,false);assert.deepEqual(fim.itens[0].inscricoes,[]);
});
test('saídas regionais: cursor pagina sem repetir nem revelar campeonatos de terceiros',async()=>{
 const R=carregar('saidasRegionaisCT'),seed={};for(let i=1;i<=22;i++)seed['campeonatosTimes/ct_'+i.toString(16).padStart(24,'0')]={nome:'Copa '+i,envolvidos:['a'],organizadorId:'b',status:'cancelado',criadoEm:100};
 const db=new DB(seed),p1=await R.listarSaidasRegionaisCT(db,'a',{}),p2=await R.listarSaidasRegionaisCT(db,'a',{cursor:p1.proximoCursor});assert.equal(p1.itens.length,20);assert.equal(p2.itens.length,2);assert.equal(new Set([...p1.itens,...p2.itens].map(c=>c.id)).size,22);
});

test('catálogo: campeonato de teste (testeTugyn) só aparece para conta testadora; "Meus" continua igual',async()=>{
 const db=new DB(),id=n=>'ct_'+n.toString(16).padStart(24,'0');
 db.data.set('users/a',{name:'A',status:'active',location:{city:'Palmas',state:'TO',cityId:'palmas_to'}});
 db.data.set('users/t',{name:'T',status:'active',testadorTugyn:true,location:{city:'Palmas',state:'TO',cityId:'palmas_to'}});
 db.data.set('campeonatosTimes/'+id(1),{status:'inscricoes',envolvidos:['t'],criadoEm:NOW,inscricoesAte:Date.now()+100000,cityId:'palmas_to',estado:'TO',modalidade:'campo'});
 db.data.set('campeonatosTimes/'+id(2),{status:'inscricoes',envolvidos:['t'],criadoEm:NOW,inscricoesAte:Date.now()+200000,cityId:'palmas_to',estado:'TO',modalidade:'campo',testeTugyn:true});
 for(const escopo of ['cidade','estado',undefined]){
  const b={filtro:'abertos',...(escopo?{escopo}:{})};
  assert.deepEqual((await S.listarCT(db,'a',b)).campeonatos.map(c=>c.id),[id(1)],'usuário real não vê teste ('+escopo+')');
  assert.deepEqual((await S.listarCT(db,'t',b)).campeonatos.map(c=>c.id),[id(1),id(2)],'testador vê ('+escopo+')');
 }
 assert.equal((await S.listarCT(db,'t',{filtro:'meus'})).campeonatos.length,2);
});

test('excluir: só o organizador, só cancelado; apaga tudo, enfileira banners e é repetível',async()=>{
 const x=await completo(),{db,id,base}=x;
 // Banco simulado: subcoleções por prefixo do caminho, como o Admin SDK.
 db.recursiveDelete=async col=>{for(const k of [...db.data.keys()])if(k.startsWith(col.path+'/'))db.data.delete(k);};
 const Ref0=Object.getPrototypeOf(db.doc(base));Ref0.listCollections=async function(){const p=this.path+'/',n=new Set();for(const k of db.data.keys())if(k.startsWith(p))n.add(k.slice(p.length).split('/')[0]);return[...n].map(c=>({path:p+c}));};
 if(!Ref0.delete)Ref0.delete=async function(){db.data.delete(this.path);};
 const M=carregar('campeonatosTimesMidia',{'cloudinary':{v2:{uploader:{}}},'./config':{getAccount:()=>null}},true);
 await assert.rejects(M.excluirCT(db,'org',{campeonatoId:id}),/cancelado/);
 await S.administrarCT(db,'org',{acao:'cancelar',campeonatoId:id,motivo:'Chuva forte'},NOW);
 await assert.rejects(M.excluirCT(db,'a',{campeonatoId:id}),e=>e.status===403);
 db.data.get(base).patrocinadores=[{id:'p_0000000000000001',publicId:`turmas/org/campeonatos/${id}/abc`}];
 assert.ok([...db.data.keys()].some(k=>k.startsWith(base+'/inscricoes/')));
 await M.excluirCT(db,'org',{campeonatoId:id});
 assert.equal([...db.data.keys()].some(k=>k===base||k.startsWith(base+'/')),false,'campeonato e subcoleções apagados');
 const fila=[...db.data].filter(([k])=>k.startsWith('midiaCampeonatosTimes/'));assert.equal(fila.length,1);assert.equal(fila[0][1].publicId,`turmas/org/campeonatos/${id}/abc`);
 await M.excluirCT(db,'org',{campeonatoId:id});
});

test('requisitos por posição: criação valida e a inscrição exige linha e goleiros (exemplos A, B e C)',async()=>{
 assert.equal(D.novoCT(corpo(),NOW,true).requisitos,undefined,'campeonato sem requisitos (app antigo) continua igual');
 assert.deepEqual(D.novoCT(corpo({minJogadores:5,requisitos:{linha:4,goleiros:1}}),NOW,true).requisitos,{linha:4,goleiros:1});
 for(const q of [{linha:4,goleiros:2},{linha:0,goleiros:1},{linha:4,goleiros:4},{linha:4.5,goleiros:0},{linha:'4',goleiros:1}])assert.throws(()=>D.novoCT(corpo({minJogadores:5,requisitos:q}),NOW,true),undefined,JSON.stringify(q));
 const camp={modalidade:'futsal',genero:'livre',faixaEtaria:'livre',minJogadores:5,maxJogadores:12,requisitos:{linha:4,goleiros:1}};
 const timeCom=(pos)=>{const ids=pos.map((_,i)=>'p'+i);return{t:{donoId:'d',modalidade:'futsal',genero:'masculino',faixaEtaria:'livre',membros:ids,jogadores:Object.fromEntries(ids.map(id=>[id,{nome:'Atleta '+id}])),camisas:Object.fromEntries(ids.map((id,i)=>[id,pos[i]?{posicao:pos[i]}:{}]))},ids};};
 const A=timeCom(['goleiro','fixo','ala','ala','pivo','ala','fixo']);assert.equal(D.elencoCT(A.t,camp,'d',A.ids).length,7,'A: 6 linha + 1 goleiro');
 const B=timeCom(['fixo','ala','ala','pivo','ala']);assert.throws(()=>D.elencoCT(B.t,camp,'d',B.ids),/goleiro/,'B: sem goleiro');
 const C=timeCom(['goleiro','goleiro','fixo','ala','pivo']);assert.throws(()=>D.elencoCT(C.t,camp,'d',C.ids),/linha.*Faltam 1/,'C: 3 linha + 2 goleiros');
 const semPosicao=timeCom(['goleiro',null,null,null,null]);assert.equal(D.elencoCT(semPosicao.t,camp,'d',semPosicao.ids).length,5,'sem posição conta como linha');
 const antigo={...camp};delete antigo.requisitos;assert.equal(D.elencoCT(B.t,antigo,'d',B.ids).length,5,'campeonato antigo: só mínimo e máximo');
});
test('requisitos: aprovação revalida as posições atuais do elenco',async()=>{
 const db=new DB({'users/org':perfil('Organizador'),'users/a':perfil('A'),'users/g':perfil('G'),'times/a_1':{...time('a',['a','g']),camisas:{g:{posicao:'goleiro'},a:{posicao:'ala'}}}});
 const {campeonatoId:id}=await S.criarCT(db,'org',corpo({minJogadores:2,requisitos:{linha:1,goleiros:1}}),true,NOW);
 assert.deepEqual(db.data.get('campeonatosTimes/'+id).requisitos,{linha:1,goleiros:1});
 await S.inscreverCT(db,'a',{campeonatoId:id,timeId:'a_1',jogadorIds:['a','g'],tentativaId:'tentativa01'},NOW);
 db.data.get('times/a_1').camisas.g={posicao:'fixo'};
 await assert.rejects(S.responderCT(db,'org',{campeonatoId:id,timeId:'a_1',aceitar:true},NOW),/goleiro/);
});

// ── Vínculo exclusivo do atleta por campeonato (reserva no pedido pendente) ──
const comAtleta=(db)=>{db.data.set('times/b_1',time('b',['a','b']));};
test('vínculo 1: mesmo atleta em dois times do mesmo campeonato é bloqueado já no pedido, com o nome e os ids',async()=>{
 const{db,id,base}=await cenario();comAtleta(db);
 await S.inscreverCT(db,'a',pedido(id,'a'),NOW);assert.deepEqual({...db.data.get(base+'/atletas/a'),desde:0,atualizadoEm:0},{timeId:'a_1',status:'pendente',desde:0,atualizadoEm:0});
 await assert.rejects(S.inscreverCT(db,'b',{...pedido(id,'b'),jogadorIds:['a','b'],tentativaId:'tentativa0b'},NOW),e=>e.status===409&&e.code==='atleta_em_outro_time'&&/O jogador a já está inscrito neste campeonato por outro time/.test(e.message)&&e.detalhes.conflitos[0]==='a');
 assert.equal(db.data.has(base+'/inscricoes/b_1'),false,'nada gravado do pedido recusado');assert.equal(db.data.has(base+'/atletas/b'),false);
 await S.inscreverCT(db,'b',{...pedido(id,'b'),jogadorIds:['b'],tentativaId:'tentativa1b'},NOW);assert.equal(db.data.get(base+'/atletas/b').timeId,'b_1','time B participa sem o atleta');
});
test('vínculo 2: o mesmo atleta pode jogar outro campeonato pelo outro time',async()=>{
 const{db,id}=await cenario();comAtleta(db);await S.inscreverCT(db,'a',pedido(id,'a'),NOW);
 const outro=await S.criarCT(db,'org',corpo({chavePedido:'pedido-00000002'}),true,NOW);
 await S.inscreverCT(db,'b',{campeonatoId:outro.campeonatoId,timeId:'b_1',jogadorIds:['a'],tentativaId:'tentativa2b'},NOW);
 assert.equal(db.data.get('campeonatosTimes/'+outro.campeonatoId+'/atletas/a').timeId,'b_1');
});
test('vínculo 3: dois times inscrevendo o mesmo atleta ao mesmo tempo, só um conclui',async()=>{
 const{db,id,base}=await cenario();comAtleta(db);
 const r=await Promise.allSettled([S.inscreverCT(db,'a',pedido(id,'a'),NOW),S.inscreverCT(db,'b',{...pedido(id,'b'),jogadorIds:['a']},NOW)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.code,'atleta_em_outro_time');
 assert.equal([...db.data.keys()].filter(k=>k.startsWith(base+'/inscricoes/')&&!k.includes('/tentativas/')).length,1);
});
test('vínculo 4 e 5: sair do elenco geral não libera; reenvio com atleta de outro time é bloqueado',async()=>{
 const x=await completo(),{db,id,base}=x;db.data.set('users/d',perfil('D'));db.data.set('times/d_1',time('d',['d','a']));
 db.data.get('times/a_1').membros=[];delete db.data.get('times/a_1').jogadores.a;
 assert.equal(db.data.get(base+'/atletas/a').timeId,'a_1','vínculo continua com o time A');
 await assert.rejects(S.inscreverCT(db,'d',{campeonatoId:id,timeId:'d_1',jogadorIds:['d','a'],tentativaId:'tentativa0d'},NOW),/O jogador a já está inscrito/);
 await S.inscreverCT(db,'d',{campeonatoId:id,timeId:'d_1',jogadorIds:['d'],tentativaId:'tentativa1d'},NOW);
 await assert.rejects(S.inscreverCT(db,'d',{campeonatoId:id,timeId:'d_1',jogadorIds:['d','a'],tentativaId:'tentativa2d'},NOW),e=>e.code==='atleta_em_outro_time','acrescentar depois também é bloqueado');
});
test('vínculo 6: reenvio solta quem saiu; recusa e cancelamento antes do início liberam; depois do início não há cancelamento',async()=>{
 const{db,id,base}=await cenario();db.data.set('times/a_1',time('a',['a','b']));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),jogadorIds:['a','b'],tentativaId:'tentativa0a'},NOW);assert.ok(db.data.has(base+'/atletas/b'));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),jogadorIds:['a'],tentativaId:'tentativa1a'},NOW);assert.equal(db.data.has(base+'/atletas/b'),false,'saiu do pedido, vínculo liberado');
 await S.responderCT(db,'org',{...pedido(id,'a'),aceitar:false,motivo:'Elenco incompleto'},NOW);assert.equal(db.data.has(base+'/atletas/a'),false,'recusa libera');
 const hist=[...db.data].filter(([k])=>k.startsWith(base+'/historicoAtletas/')).map(([,v])=>v.acao);assert.deepEqual(hist.sort(),['liberou','reservou','reservou']);
 const y=await completo();assert.equal(y.db.data.get(y.base+'/atletas/b').status,'aprovado');
 await S.cancelarInscricaoCT(y.db,'b',pedido(y.id,'b'),NOW);assert.equal(y.db.data.has(y.base+'/atletas/b'),false,'cancelamento antes do início libera');
 const z=await completo();await S.iniciarCT(z.db,'org',{campeonatoId:z.id},NOW);
 await assert.rejects(S.cancelarInscricaoCT(z.db,'a',pedido(z.id,'a'),NOW),/fechado/);assert.ok(z.db.data.has(z.base+'/atletas/a'),'em andamento: vínculo mantido');
});
test('vínculo 7: gravação direta pelo app é negada pelas regras do Firestore',()=>{
 const regras=fs.readFileSync(path.resolve(__dirname,'../../../teste-regras/firestore-rules/firestore.rules'),'utf8');
 assert.ok(regras.includes('match /campeonatosTimes/{documento=**} { allow read, write: if false; }'),'campeonatos (inclusive atletas e histórico) só pela API');
});
test('transferência: só o organizador, só antes do início, com vínculo, elenco do destino, limites e histórico',async()=>{
 const x=await completo(),{db,id,base}=x;db.data.set('times/b_1',time('b',['b','a']));
 const pedidoT={campeonatoId:id,jogadorId:'a',deTimeId:'a_1',paraTimeId:'b_1',motivo:'Acordo entre os times'};
 await assert.rejects(S.transferirAtletaCT(db,'b',pedidoT,NOW),e=>e.status===403);
 await assert.rejects(S.transferirAtletaCT(db,'org',{...pedidoT,paraTimeId:'c_1'},NOW),/elenco de Time c/);
 await assert.rejects(S.transferirAtletaCT(db,'org',pedidoT,NOW),/menos de 1 atletas/,'origem ficaria abaixo do mínimo');
 db.data.set('users/z',perfil('Z'));db.data.set('times/a_1',time('a',['a','z']));db.data.get(base+'/inscricoes/a_1').jogadores.push({id:'z',nome:'Z',numero:null,posicao:null});
 await S.transferirAtletaCT(db,'org',pedidoT,NOW);
 assert.equal(db.data.get(base+'/atletas/a').timeId,'b_1');assert.deepEqual(db.data.get(base+'/inscricoes/a_1').jogadores.map(j=>j.id),['z']);assert.ok(db.data.get(base+'/inscricoes/b_1').jogadores.some(j=>j.id==='a'));
 assert.ok([...db.data.values()].some(v=>v&&v.acao==='transferiu'&&v.deTimeId==='a_1'&&v.motivo==='Acordo entre os times'));
 await S.iniciarCT(db,'org',{campeonatoId:id},NOW);
 await assert.rejects(S.transferirAtletaCT(db,'org',{...pedidoT,deTimeId:'b_1',paraTimeId:'a_1'},NOW),/antes do início/);
});

// ── Sorteio manual dos times ──
test('sorteio: criação guarda "manual" só quando escolhido e recusa valor inválido',async()=>{
 assert.equal(D.novoCT(corpo({sorteio:'manual'}),NOW,true).sorteio,'manual');
 assert.equal('sorteio' in D.novoCT(corpo({sorteio:'automatico'}),NOW,true),false,'automático continua sem o campo (assinatura antiga igual)');
 assert.equal('sorteio' in D.novoCT(corpo(),NOW,true),false);
 assert.throws(()=>D.novoCT(corpo({sorteio:'roleta'}),NOW,true),/sorteio/);
});
test('sorteio manual: exige a ordem completa, sem repetição e só com aprovados; gera a tabela nessa ordem',async()=>{
 const x=await cenario({sorteio:'manual'}),{db,id,base}=x;
 for(const who of ['a','b','c']){await S.inscreverCT(db,who,pedido(id,who),NOW);await S.responderCT(db,'org',{...pedido(id,who),aceitar:true},NOW);}
 assert.equal(S.detalheCT(id,db.data.get(base)).sorteio,'manual');
 await assert.rejects(S.iniciarCT(db,'org',{campeonatoId:id},NOW),/todos os times/);
 await assert.rejects(S.iniciarCT(db,'org',{campeonatoId:id,ordem:['a_1','b_1']},NOW),/todos os times/);
 await assert.rejects(S.iniciarCT(db,'org',{campeonatoId:id,ordem:['a_1','a_1','b_1']},NOW),/repetido/);
 await assert.rejects(S.iniciarCT(db,'org',{campeonatoId:id,ordem:['a_1','b_1','x_1']},NOW),/não está aprovado/);
 assert.equal(db.data.get(base).status,'inscricoes','nada gerado nas tentativas inválidas');
 await S.iniciarCT(db,'org',{campeonatoId:id,ordem:['c_1','a_1','b_1']},NOW);
 assert.deepEqual(db.data.get(base).ordem,['c_1','a_1','b_1']);assert.equal(db.data.get(base).status,'em_andamento');
});
test('sorteio manual nos grupos: os quatro primeiros formam o Grupo A, os seguintes o Grupo B',()=>{
 const ordem=['t1_1','t2_1','t3_1','t4_1','t5_1','t6_1','t7_1','t8_1'];
 const g=D.gerarJogosCT('grupos_mata',D.ordemManualCT(ordem,[...ordem].reverse()));
 assert.deepEqual(g.grupos,{A:ordem.slice(0,4),B:ordem.slice(4)});
});
test('sorteio automático ignora ordem enviada pelo cliente',async()=>{
 const x=await completo();await S.iniciarCT(x.db,'org',{campeonatoId:x.id,ordem:['a_1','a_1','a_1']},NOW);
 assert.equal(new Set(x.db.data.get(x.base).ordem).size,3);
});

// ── W.O., cartões, suspensão, mesário, avisos, busca, próximos jogos e estatísticas ──
const iniciado=async()=>{const x=await completo();await S.iniciarCT(x.db,'org',{campeonatoId:x.id},NOW);const d=await S.lerDetalheCT(x.db,'org',{campeonatoId:x.id});return{...x,jogos:d.jogos.sort((p,q)=>p.ordem-q.ordem)};};
const filaCT=db=>[...db.data.entries()].filter(([k])=>k.startsWith('pushDedupe/ct_')).map(([k,v])=>({chave:k.slice(11),para:v.aviso.recipientUids,titulo:v.aviso.draft.title,data:v.aviso.draft.data}));
test('W.O.: placar fixo 3 x 0 para quem compareceu, sem estatísticas, cartões nem pênaltis',async()=>{
 const{db,id,base,jogos}=await iniciado();const j=jogos[0];
 await assert.rejects(S.resultadoCT(db,'org',V(j,{campeonatoId:id,jogoId:j.id,wo:'x_1'}),NOW),/W\.O\. inválido/);
 const atleta=j.casa.split('_')[0];
 await S.resultadoCT(db,'org',V(j,{campeonatoId:id,jogoId:j.id,wo:j.fora,golsCasa:5,golsFora:5,gols:{[atleta]:2},amarelos:{[atleta]:1}}),NOW);
 const g=db.data.get(base+'/jogos/'+j.id);
 assert.equal(g.golsCasa,0);assert.equal(g.golsFora,3);assert.equal(g.wo,j.fora);assert.deepEqual(g.gols,{});assert.deepEqual(g.amarelos,{});
 assert.ok(filaCT(db).some(a=>a.titulo==='W.O. registrado'));
});
test('cartões: vermelho suspende no próximo jogo do time; suspenso não pode ter gol; aviso ao atleta',async()=>{
 const{db,id,jogos}=await iniciado();
 const j1=jogos.find(j=>j.casa==='a_1'||j.fora==='a_1'),j2=jogos.find(j=>j!==j1&&(j.casa==='a_1'||j.fora==='a_1'));
 await assert.rejects(S.resultadoCT(db,'org',V(j1,{campeonatoId:id,jogoId:j1.id,golsCasa:1,golsFora:0,amarelos:{a:3}}),NOW),/Estatística/);
 await S.resultadoCT(db,'org',V(j1,{campeonatoId:id,jogoId:j1.id,golsCasa:1,golsFora:0,vermelhos:{a:1}}),NOW);
 const d=await S.lerDetalheCT(db,'b',{campeonatoId:id});
 assert.deepEqual(d.suspensoes.map(s=>[s.atletaId,s.jogoId,s.motivo]),[['a',j2.id,'vermelho']]);
 const atual=d.jogos.find(j=>j.id===j2.id);
 await assert.rejects(S.resultadoCT(db,'org',V(atual,{campeonatoId:id,jogoId:j2.id,golsCasa:1,golsFora:0,gols:{a:1}}),NOW),e=>e.code==='atleta_suspenso'&&/a está suspenso/.test(e.message));
 assert.ok(filaCT(db).some(a=>a.chave.startsWith('ct_suspenso_')&&a.para.join()==='a'));
});
test('cartões: três amarelos em jogos diferentes suspendem; dois no mesmo jogo valem expulsão',()=>{
 const ins=[{timeId:'t',jogadores:[{id:'p'},{id:'q'}]}];
 const jg=(n,st,am={})=>({id:'j'+n,ordem:n,casa:'t',fora:'u',status:st,amarelos:am});
 const m=l=>JSON.parse(JSON.stringify(l));
 assert.deepEqual(m(D.suspensoesCT(ins,{j1:jg(1,'finalizado',{p:1}),j2:jg(2,'finalizado',{p:1}),j3:jg(3,'finalizado',{p:1}),j4:jg(4,'pendente')}).map(s=>[s.atletaId,s.jogoId,s.motivo])),[['p','j4','amarelos']]);
 assert.deepEqual(m(D.suspensoesCT(ins,{j1:jg(1,'finalizado',{q:2}),j2:jg(2,'pendente')}).map(s=>[s.atletaId,s.motivo])),[['q','vermelho']]);
 assert.equal(D.suspensoesCT(ins,{j1:jg(1,'finalizado',{q:2}),j2:jg(2,'finalizado'),j3:jg(3,'pendente')}).length,0,'suspensão já cumprida');
});
test('mesário: organizador convida pelo @usuário (até 3); mesário lança placar e marca jogo, mas não finaliza',async()=>{
 const{db,id,base,jogos}=await iniciado();db.data.set('users/m',perfil('Mesa'));db.data.set('usernames/mesa',{uid:'m'});
 await assert.rejects(S.mesarioCT(db,'a',{campeonatoId:id,userName:'@mesa'},NOW),e=>e.status===403);
 await assert.rejects(S.mesarioCT(db,'org',{campeonatoId:id,userName:'ninguem'},NOW),/Não encontramos/);
 await S.mesarioCT(db,'org',{campeonatoId:id,userName:'@Mesa'},NOW);
 assert.deepEqual(db.data.get(base).mesarios,[{uid:'m',nome:'Mesa',userName:'mesa'}]);assert.ok(db.data.get(base).envolvidos.includes('m'));
 assert.ok(filaCT(db).some(a=>a.chave.startsWith('ct_mesario_')&&a.para.join()==='m'));
 const d=await S.lerDetalheCT(db,'m',{campeonatoId:id});assert.ok(d.jogos.some(j=>j.podeEditarResultado));
 await S.administrarCT(db,'m',{campeonatoId:id,acao:'agendarJogo',jogoId:jogos[0].id,quando:NOW+3600000,local:'Arena'},NOW);
 assert.ok(filaCT(db).some(a=>a.chave.startsWith('ct_jogo_marcado_')));
 for(const j of (await S.lerDetalheCT(db,'m',{campeonatoId:id})).jogos.sort((p,q)=>p.ordem-q.ordem))await S.resultadoCT(db,'m',V(j,{campeonatoId:id,jogoId:j.id,golsCasa:1,golsFora:0}),NOW);
 await assert.rejects(S.finalizarCT(db,'m',{campeonatoId:id,revisaoEsperada:db.data.get(base).premiacaoVersao},NOW),/organizador/);
 for(const n of ['x','y','w']){db.data.set('users/'+n,perfil(n));db.data.set('usernames/user'+n,{uid:n});}
 await S.mesarioCT(db,'org',{campeonatoId:id,userName:'userx'},NOW);await S.mesarioCT(db,'org',{campeonatoId:id,userName:'usery'},NOW);
 await assert.rejects(S.mesarioCT(db,'org',{campeonatoId:id,userName:'userw'},NOW),/até 3/);
 await S.mesarioCT(db,'org',{campeonatoId:id,remover:'m'},NOW);assert.equal(db.data.get(base).mesarios.length,2);
});
test('avisos: pedido ao organizador, aprovação ao dono, início a todos; nunca para quem agiu; toque abre o campeonato',async()=>{
 const{db,id}=await completo();
 const fila=filaCT(db);
 assert.ok(fila.some(a=>a.chave.startsWith('ct_pedido_')&&a.para.join()==='org'));
 assert.ok(fila.some(a=>a.chave.startsWith('ct_aprovada_')));
 assert.ok(fila.filter(a=>a.chave.startsWith('ct_aprovada_')).every(a=>!a.para.includes('org')));
 assert.ok(fila.every(a=>a.data.tipo==='campeonato_times'&&a.data.campeonatoId===id));
 await S.iniciarCT(db,'org',{campeonatoId:id},NOW);
 const ini=filaCT(db).find(a=>a.chave.startsWith('ct_iniciado_'));assert.deepEqual([...ini.para].sort(),['a','b','c']);
});
test('avisos: time que desiste avisa o organizador; removido pelo organizador avisa o time',async()=>{
 const{db,id}=await cenario();
 await S.inscreverCT(db,'a',pedido(id,'a'),NOW);await S.cancelarInscricaoCT(db,'a',pedido(id,'a'),NOW);
 assert.ok(filaCT(db).some(a=>a.chave.startsWith('ct_desistiu_')&&a.para.join()==='org'));
 await S.inscreverCT(db,'b',pedido(id,'b'),NOW);await S.responderCT(db,'org',{...pedido(id,'b'),aceitar:true},NOW);await S.cancelarInscricaoCT(db,'org',pedido(id,'b'),NOW);
 assert.ok(filaCT(db).some(a=>a.chave.startsWith('ct_removida_')&&a.para.join()==='b'));
});
test('busca por nome no catálogo: sem acento, sem maiúscula, mínimo de 2 letras',async()=>{
 const{db}=await cenario({nome:'Copa São João'});
 const ach=async b=>(await S.listarCT(db,'a',{filtro:'abertos',busca:b})).campeonatos.map(c=>c.nome);
 assert.deepEqual(await ach('sao joao'),['Copa São João']);assert.deepEqual(await ach('JOÃO'),['Copa São João']);assert.deepEqual(await ach('zz'),[]);
 await assert.rejects(ach('c'),/2 a 40/);
});
test('meus próximos jogos e estatísticas do atleta (com cache de 1 h)',async()=>{
 const{db,id,jogos}=await iniciado();
 const p=await S.proximosJogosCT(db,'a');assert.equal(p.jogos.length,2);assert.ok(p.jogos.every(j=>j.campeonatoId===id&&(j.casa.timeId==='a_1'||j.fora.timeId==='a_1')));
 const j1=jogos.find(j=>j.casa==='a_1'||j.fora==='a_1');
 await S.resultadoCT(db,'org',V(j1,{campeonatoId:id,jogoId:j1.id,golsCasa:j1.casa==='a_1'?2:1,golsFora:j1.casa==='a_1'?1:2,gols:{a:2},amarelos:{a:1}}),NOW);
 assert.equal((await S.proximosJogosCT(db,'a')).jogos.length,1);
 const e=await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW);
 assert.deepEqual(JSON.parse(JSON.stringify(e.estatisticas)),{campeonatos:1,jogos:1,gols:2,assistencias:0,amarelos:1,vermelhos:0,titulos:0});
 db.data.delete('campeonatosTimes/'+id);
 assert.equal((await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW+1000)).estatisticas.gols,2,'cache');
 assert.equal((await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW+2*3600000)).estatisticas.gols,0,'recalcula depois de 1 h');
 db.data.get('users/a').isPublic=false;
 assert.equal((await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW)).estatisticas,null,'perfil privado: visitante não vê');
 assert.ok((await S.estatisticasAtletaCT(db,'a',{},NOW)).estatisticas,'o dono vê as próprias');
});
test('rotina agendada: prazo encerrado avisa o organizador; véspera do jogo avisa os dois times',async()=>{
 const enviados=[];const A=carregar('campeonatosTimesAvisos');
 const S2=carregar('campeonatosTimesServico',{'./campeonatosTimesAvisos':{...A,dispararAvisosCT:async(_db,l)=>{enviados.push(...l);}}},true);
 const{db,base,jogos}=await iniciado();
 db.data.get(base+'/jogos/'+jogos[0].id).quando=NOW+18*3600000;
 const c2=await S.criarCT(db,'org',corpo({chavePedido:'pedido-00000009',nome:'Outra'}),true,NOW);
 db.data.get('campeonatosTimes/'+c2.campeonatoId).inscricoesAte=NOW-1000;
 const r=await S2.avisosAgendadosCT(db,NOW);
 assert.deepEqual(JSON.parse(JSON.stringify(r)),{prazos:1,lembretes:1,truncado:false});
 assert.deepEqual([...enviados.find(a=>a.dedupeKey.startsWith('ct_prazo_')).recipientUids],['org']);
 const lem=enviados.find(a=>a.dedupeKey.startsWith('ct_lembrete_'));
 assert.equal(lem.recipientUids.length,2);assert.equal(lem.draft.title,'Seu jogo é amanhã');
});
test('exclusão de conta: cartões anonimizados, sai dos mesários e o cache de estatísticas é apagado',async()=>{
 const E=carregar('campeonatosTimesExclusao');
 const{db,id,base,jogos}=await iniciado();db.data.set('users/m',perfil('Mesa'));db.data.set('usernames/mesa',{uid:'m'});
 await S.mesarioCT(db,'org',{campeonatoId:id,userName:'mesa'},NOW);
 const j1=jogos.find(j=>j.casa==='a_1'||j.fora==='a_1');
 await S.resultadoCT(db,'org',V(j1,{campeonatoId:id,jogoId:j1.id,golsCasa:1,golsFora:1,amarelos:{a:1}}),NOW);
 db.data.set('estatisticasAtletasCT/a',{estatisticas:{},calculadoEm:NOW});
 await E.excluirIdentidadeCT(db,'a');await E.excluirIdentidadeCT(db,'m');
 const am=db.data.get(base+'/jogos/'+j1.id).amarelos;assert.equal('a' in am,false);assert.equal(Object.values(am)[0],1);
 assert.deepEqual(db.data.get(base).mesarios,[]);assert.equal(db.data.has('estatisticasAtletasCT/a'),false);
});
test('auditoria: estatísticas de conta em exclusão não aparecem ao visitante, nem do cache',async()=>{
 const{db}=await iniciado();
 db.data.set('estatisticasAtletasCT/a',{estatisticas:{campeonatos:1,gols:7},calculadoEm:NOW});
 db.data.get('users/a').excluindoEm=NOW;
 assert.equal((await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW)).estatisticas,null);
});
test('auditoria: estatísticas vencidas, recálculo já reservado: devolve o último resultado sem recalcular',async()=>{
 const{db}=await iniciado();
 db.data.set('estatisticasAtletasCT/a',{estatisticas:{campeonatos:9},calculadoEm:NOW-2*3600000,calculandoAte:NOW+30000});
 const r=await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW);
 assert.equal(r.estatisticas.campeonatos,9);assert.equal(r.calculadoEm,NOW-2*3600000);
 const r2=await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW+60000);
 assert.equal(r2.estatisticas.campeonatos,1,'reserva vencida: recalcula');assert.equal(db.data.get('estatisticasAtletasCT/a').calculandoAte,undefined);
});
test('auditoria: próximos jogos lê os jogos uma vez e nada de quem não tem time inscrito',async()=>{
 const{db,base}=await iniciado();db.data.get(base).envolvidos.push('z');
 const old=Query.prototype.get;const paths=[];
 Query.prototype.get=async function(){paths.push(this.path);return old.call(this);};
 try{await S.proximosJogosCT(db,'a');await S.proximosJogosCT(db,'z');}finally{Query.prototype.get=old;}
 assert.equal(paths.filter(p=>p===base+'/jogos').length,1);
});
test('auditoria: busca avisa quando só olhou a janela de 100 campeonatos',async()=>{
 const{db}=await cenario({nome:'Copa São João'});
 assert.equal((await S.listarCT(db,'a',{filtro:'abertos',busca:'joao'})).buscaLimitada,false);
});
test('auditoria: rotina de avisos ignora jogos de turma no grupo "jogos" e campeonato que não está em andamento',async()=>{
 const enviados=[];const A=carregar('campeonatosTimesAvisos');
 const S2=carregar('campeonatosTimesServico',{'./campeonatosTimesAvisos':{...A,dispararAvisosCT:async(_db,l)=>{enviados.push(...l);}}},true);
 const{db,base,jogos}=await iniciado();
 db.data.set('turmas/t1/jogos/2026-01-01',{quando:NOW+18*3600000,status:'pendente',casa:'x',fora:'y'});
 db.data.get(base+'/jogos/'+jogos[0].id).quando=NOW+18*3600000;
 db.data.get(base).status='encerrado';
 assert.equal((await S2.avisosAgendadosCT(db,NOW)).lembretes,0);
});
test('revalidação: sem resultado anterior e outro pedido calculando, espera em vez de calcular junto',async()=>{
 const{db}=await iniciado();
 db.data.set('estatisticasAtletasCT/a',{calculandoAte:NOW+30000});
 const old=Query.prototype.get;const paths=[];Query.prototype.get=async function(){paths.push(this.path);return old.call(this);};
 let r;try{r=await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW);}finally{Query.prototype.get=old;}
 assert.equal(r.calculando,true);assert.equal(paths.length,0,'não consultou campeonatos');
});
test('revalidação: outro pedido terminou entre a leitura e a reserva: usa o resultado dele',async()=>{
 const{db}=await iniciado();
 db.data.set('estatisticasAtletasCT/a',{estatisticas:{campeonatos:1},calculadoEm:NOW-2*3600000});
 const real=db.runTransaction.bind(db);db.runTransaction=fn=>{db.data.set('estatisticasAtletasCT/a',{estatisticas:{campeonatos:5},calculadoEm:NOW});return real(fn);};
 assert.equal((await S.estatisticasAtletaCT(db,'b',{uid:'a'},NOW)).estatisticas.campeonatos,5);
});
test('revalidação: busca continua pelo cursor além da janela de 100',async()=>{
 const{db}=await cenario({nome:'Copa Alfa'});
 const ids=[...db.data.keys()].filter(p=>/^campeonatosTimes\/[^/]+$/.test(p));const modelo=db.data.get(ids[0]);
 for(let i=0;i<120;i++){const id='ct_'+String(i).padStart(24,'0');db.data.set('campeonatosTimes/'+id,{...modelo,nome:i===110?'Taça Rara':'Copa '+i,inscricoesAte:modelo.inscricoesAte-1000+i});}
 const p1=await S.listarCT(db,'a',{filtro:'abertos',busca:'rara'});
 assert.equal(p1.campeonatos.length,0);assert.ok(p1.proximoCursor);assert.equal(p1.buscaLimitada,true);
 const p2=await S.listarCT(db,'a',{filtro:'abertos',busca:'rara',cursor:p1.proximoCursor});
 assert.deepEqual(p2.campeonatos.map(c=>c.nome),['Taça Rara']);assert.equal(p2.proximoCursor,null);
});
test('revalidação: lembretes paginados não perdem jogo atrás de muitos jogos de turma na janela',async()=>{
 const enviados=[];const A=carregar('campeonatosTimesAvisos');
 const S2=carregar('campeonatosTimesServico',{'./campeonatosTimesAvisos':{...A,dispararAvisosCT:async(_db,l)=>{enviados.push(...l);}}},true);
 const{db,base,jogos}=await iniciado();
 for(let i=0;i<700;i++)db.data.set('turmas/t'+i+'/jogos/d',{quando:NOW+13*3600000+i});
 db.data.get(base+'/jogos/'+jogos[0].id).quando=NOW+20*3600000;
 const r=await S2.avisosAgendadosCT(db,NOW);assert.equal(r.lembretes,1);assert.equal(r.truncado,false);
});

test('técnico: opcional, precisa ser do elenco do time, pode também jogar e entra nos envolvidos',async()=>{
 const {db,id,base}=await cenario();db.data.set('users/x',perfil('X'));db.data.set('times/a_1',time('a',['a','x']));
 await assert.rejects(S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'b',tentativaId:'tecnico-0001'},NOW),/elenco do time/);
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-0002'},NOW);
 const ins=db.data.get(base+'/inscricoes/a_1');assert.deepEqual({id:ins.treinador.id,nome:ins.treinador.nome},{id:'x',nome:'x'});
 assert.ok(db.data.get(base).envolvidos.includes('x'),'o técnico vê o campeonato e recebe os avisos');
 // Dono como técnico e atleta ao mesmo tempo (reenvio do pedido pendente, nova tentativa).
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'a',tentativaId:'tecnico-0003'},NOW);
 assert.equal(db.data.get(base+'/inscricoes/a_1').treinador.id,'a');
 // Sem técnico: campo nulo (apps antigos não mandam treinadorId).
 await S.inscreverCT(db,'b',pedido(id,'b'),NOW);assert.equal(db.data.get(base+'/inscricoes/b_1').treinador,null);
 const {timeTodo}=carregar('campeonatosTimesAvisos');assert.deepEqual(timeTodo({donoId:'a',jogadores:[{id:'a'}],treinador:{id:'x'}}).sort(),['a','x']);
});

test('técnico: excluir a conta tira nome e foto do técnico sem cancelar o pedido do time (e repetir não quebra)',async()=>{
 const {db,id,base}=await cenario();db.data.set('users/x',perfil('X'));db.data.set('times/a_1',time('a',['a','x']));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-ex01'},NOW);
 const {excluirIdentidadeCT}=carregar('campeonatosTimesExclusao');
 await excluirIdentidadeCT(db,'x');await excluirIdentidadeCT(db,'x');
 const ins=db.data.get(base+'/inscricoes/a_1');assert.equal(ins.treinador,null);assert.equal(ins.status,'pendente','ser só o técnico não cancela o time');
 assert.ok(!JSON.stringify(ins).includes('"X"'),'o nome do técnico não fica na inscrição');assert.ok(!db.data.get(base).envolvidos.includes('x'));
});
test('técnico: a aprovação confere de novo o técnico (fora do time ou suspenso recusa) e avisa quem só treina',async()=>{
 const {db,id,base}=await cenario();db.data.set('users/x',perfil('X'));db.data.set('times/a_1',time('a',['a','x']));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-ap01'},NOW);
 db.data.set('times/a_1',time('a',['a']));
 await assert.rejects(S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW),/técnico escolhido não faz mais parte/);
 db.data.set('times/a_1',time('a',['a','x']));db.data.set('users/x',{...perfil('X'),status:'suspended'});
 await assert.rejects(S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW),/indisponível/);
 db.data.set('users/x',perfil('X'));
 const avisos=await S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW);
 assert.equal(db.data.get(base+'/inscricoes/a_1').status,'aprovada');
 assert.ok(avisos.some(a=>a.recipientUids.includes('x')),'o técnico que não joga recebe "Inscrição aprovada"');
 assert.equal(avisos.flatMap(a=>a.recipientUids).filter(u=>u==='a').length,1,'o dono recebe um aviso só');
});
test('técnico: ao iniciar, técnico que saiu do time deixa de ser técnico (não impede o início)',async()=>{
 const {db,id,base}=await cenario();db.data.set('users/x',perfil('X'));db.data.set('times/a_1',time('a',['a','x']));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-in01'},NOW);
 for(const who of ['a','b','c']){if(who!=='a')await S.inscreverCT(db,who,pedido(id,who),NOW);await S.responderCT(db,'org',{...pedido(id,who),aceitar:true},NOW);}
 db.data.set('times/a_1',time('a',['a']));
 await S.iniciarCT(db,'org',{campeonatoId:id},NOW+2*86400000);
 assert.equal(db.data.get(base).status,'em_andamento');assert.equal(db.data.get(base+'/inscricoes/a_1').treinador,null);
});

test('técnico: ninguém treina um time e joga por outro no mesmo campeonato (inscrição e transferência)',async()=>{
 const {db,id}=await cenario();db.data.set('users/x',perfil('X'));
 db.data.set('times/a_1',time('a',['a','x']));db.data.set('times/b_1',time('b',['b','x']));
 // x é técnico de A (sem jogar): não pode ser atleta de B.
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-trt-a1'},NOW);
 await assert.rejects(S.inscreverCT(db,'b',{...pedido(id,'b'),jogadorIds:['b','x'],tentativaId:'tecnico-trt-b1'},NOW),/técnico de outro time/);
 // Ao contrário: x atleta de B impede ser técnico de A.
 await S.inscreverCT(db,'a',{...pedido(id,'a'),tentativaId:'tecnico-trt-a2'},NOW);
 await S.inscreverCT(db,'b',{...pedido(id,'b'),jogadorIds:['b','x'],tentativaId:'tecnico-trt-b2'},NOW);
 await assert.rejects(S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-trt-a3'},NOW),/atleta por outro time/);
});
test('técnico: removido ao iniciar não recebe "Campeonato iniciado"',async()=>{
 const {db,id}=await cenario();db.data.set('users/x',perfil('X'));db.data.set('times/a_1',time('a',['a','x']));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),treinadorId:'x',tentativaId:'tecnico-trt-in01'},NOW);
 for(const who of ['a','b','c']){if(who!=='a')await S.inscreverCT(db,who,pedido(id,who),NOW);await S.responderCT(db,'org',{...pedido(id,who),aceitar:true},NOW);}
 db.data.set('times/a_1',time('a',['a']));
 const avisos=await S.iniciarCT(db,'org',{campeonatoId:id},NOW+2*86400000);
 assert.equal(avisos.flatMap(a=>a.recipientUids).includes('x'),false);assert.ok(avisos.flatMap(a=>a.recipientUids).includes('a'));
});
test('técnico: quem joga e treina um time não pode ser transferido para outro',async()=>{
 const {db,id}=await cenario();db.data.set('users/x',perfil('X'));
 db.data.set('times/a_1',time('a',['a','x']));db.data.set('times/b_1',time('b',['b','x']));
 await S.inscreverCT(db,'a',{...pedido(id,'a'),jogadorIds:['a','x'],treinadorId:'x',tentativaId:'tecnico-trt-tr1'},NOW);
 await S.inscreverCT(db,'b',pedido(id,'b'),NOW);
 for(const who of ['a','b'])await S.responderCT(db,'org',{...pedido(id,who),aceitar:true},NOW);
 await assert.rejects(S.transferirAtletaCT(db,'org',{campeonatoId:id,jogadorId:'x',deTimeId:'a_1',paraTimeId:'b_1',motivo:'Acordo entre os times'},NOW),/é o técnico de/);
});

test('correção de resultado: motivo obrigatório, histórico no jogo e aviso com o motivo', async () => {
  const y = await completo(); await S.iniciarCT(y.db, 'org', { campeonatoId: y.id }, NOW);
  const jogo = Object.values(jogosDe(y))[0];
  await S.resultadoCT(y.db, 'org', V(jogo, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 1 }), NOW);
  let atual = jogosDe(y)[jogo.id];
  assert.equal(atual.lancadoEm, NOW); assert.equal(atual.correcoes, undefined);
  // Sem motivo (ou curto demais), a correção é recusada e nada muda.
  await assert.rejects(S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 2 }), NOW + 1), /por que o resultado/);
  await assert.rejects(S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 2, motivo: ' ok ' }), NOW + 1), /por que o resultado/);
  await assert.rejects(S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 2, motivo: 'x'.repeat(141) }), NOW + 1), /até 140/);
  assert.equal(jogosDe(y)[jogo.id].golsFora, 1);
  await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 2, motivo: '  Gol do  visitante não anotado ' }), NOW + 5);
  atual = jogosDe(y)[jogo.id];
  assert.equal(atual.lancadoEm, NOW, 'o lançamento original não muda com a correção');
  assert.equal(atual.correcoes.length, 1);
  const c = atual.correcoes[0];
  assert.deepEqual(JSON.parse(JSON.stringify({ em: c.em, por: c.por, motivo: c.motivo, antes: c.antes, depois: c.depois, detalhes: c.detalhes })),
    { em: NOW + 5, por: 'org', motivo: 'Gol do visitante não anotado', antes: { golsCasa: 2, golsFora: 1, penaltis: null, wo: null }, depois: { golsCasa: 2, golsFora: 2, penaltis: null, wo: null }, detalhes: false });
  assert.ok(c.porNome.length > 0);
  // O aviso aos times diz que foi uma correção e traz o motivo.
  const aviso = [...y.db.data.entries()].filter(([k]) => k.startsWith('pushDedupe/ct_resultado_')).map(([, v]) => v.aviso.draft).find((d) => d.title === 'Resultado corrigido');
  assert.ok(aviso, 'aviso de correção enviado'); assert.match(aviso.body, /Motivo: Gol do visitante não anotado/);
  // Retry idêntico da correção não duplica o histórico.
  await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 2, motivo: 'Gol do visitante não anotado' }), NOW + 6);
  assert.equal(jogosDe(y)[jogo.id].correcoes.length, 1);
  // Retry do primeiro lançamento (resposta perdida) não exige motivo.
  const outro = Object.values(jogosDe(y)).find((j) => j.id !== jogo.id && j.casa && j.fora);
  const corpo = V(outro, { campeonatoId: y.id, jogoId: outro.id, golsCasa: 1, golsFora: 0 });
  await S.resultadoCT(y.db, 'org', corpo, NOW + 7); await S.resultadoCT(y.db, 'org', corpo, NOW + 8);
  assert.equal(jogosDe(y)[outro.id].correcoes, undefined);
});

test('correção de resultado: só o placar dos atletas mudou fica marcado como detalhes; histórico guarda as 10 últimas', async () => {
  const y = await completo(); await S.iniciarCT(y.db, 'org', { campeonatoId: y.id }, NOW);
  const jogo = Object.values(jogosDe(y))[0];
  await S.resultadoCT(y.db, 'org', V(jogo, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 0, golsFora: 0 }), NOW);
  for (let i = 1; i <= 12; i++) {
    const atual = jogosDe(y)[jogo.id];
    await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: i, golsFora: 0, motivo: 'Correção número ' + i }), NOW + i);
  }
  const h = jogosDe(y)[jogo.id].correcoes;
  assert.equal(h.length, 10); assert.equal(h[0].motivo, 'Correção número 3'); assert.equal(h.at(-1).motivo, 'Correção número 12');
  const ins = y.db.data.get(y.base + '/inscricoes/' + jogo.casa);
  const atleta = ins.jogadores[0].id, atual = jogosDe(y)[jogo.id];
  await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 12, golsFora: 0, gols: { [atleta]: 1 }, motivo: 'Faltou o autor do gol' }), NOW + 20);
  assert.equal(jogosDe(y)[jogo.id].correcoes.at(-1).detalhes, true);
});

test('correção de resultado: mesário corrige só nas 24 horas depois do lançamento; organizador sempre', async () => {
  const y = await completo(); y.db.data.set('users/m', perfil('Mesa')); y.db.data.set('usernames/mesa', { uid: 'm' });
  await S.mesarioCT(y.db, 'org', { campeonatoId: y.id, userName: 'mesa' }, NOW);
  await S.iniciarCT(y.db, 'org', { campeonatoId: y.id }, NOW);
  const jogo = Object.values(jogosDe(y))[0], H = 60 * 60 * 1000;
  await S.resultadoCT(y.db, 'm', V(jogo, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 1, golsFora: 0 }), NOW);
  let atual = jogosDe(y)[jogo.id];
  // Dentro do prazo, o mesário corrige.
  await S.resultadoCT(y.db, 'm', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 1, golsFora: 1, motivo: 'Gol do empate esquecido' }), NOW + 23 * H);
  atual = jogosDe(y)[jogo.id];
  assert.equal(atual.correcoes[0].por, 'm');
  // Depois do prazo (contado do lançamento, não da última correção), não.
  await assert.rejects(S.resultadoCT(y.db, 'm', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 1, motivo: 'Outro gol esquecido' }), NOW + 25 * H),
    (e) => e.status === 403 && /prazo do mesário/.test(e.message));
  // O detalhe do mesário já não oferece a correção; o do organizador sim.
  const realNow = Date.now; Date.now = () => NOW + 25 * H;
  try {
    const doMesario = await S.lerDetalheCT(y.db, 'm', { campeonatoId: y.id }), doOrg = await S.lerDetalheCT(y.db, 'org', { campeonatoId: y.id });
    const jm = doMesario.jogos.find((j) => j.id === jogo.id), jo = doOrg.jogos.find((j) => j.id === jogo.id);
    assert.equal(jm.podeEditarResultado, false); assert.equal(jm.prazoCorrecaoAte, NOW + 24 * H);
    assert.equal(jo.podeEditarResultado, true); assert.equal(jo.prazoCorrecaoAte, null);
    // Jogo ainda sem resultado: o mesário lança normalmente.
    const pendente = doMesario.jogos.find((j) => j.status === 'pendente' && j.casa && j.fora);
    assert.equal(pendente.podeEditarResultado, true);
  } finally { Date.now = realNow; }
  await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 2, golsFora: 1, motivo: 'Súmula conferida pelo organizador' }), NOW + 30 * H);
  assert.equal(jogosDe(y)[jogo.id].correcoes.length, 2);
});

test('exclusão de conta: quem corrigiu um resultado deixa de ser identificável; o detalhe não expõe o UID', async () => {
  const E = carregar('campeonatosTimesExclusao');
  const { db, id, base, jogos } = await iniciado(); db.data.set('users/m', perfil('Mesa')); db.data.set('usernames/mesa', { uid: 'm' });
  await S.mesarioCT(db, 'org', { campeonatoId: id, userName: 'mesa' }, NOW);
  const j = jogos[0];
  await S.resultadoCT(db, 'm', V(j, { campeonatoId: id, jogoId: j.id, golsCasa: 1, golsFora: 0 }), NOW);
  const salvo = await S.lerDetalheCT(db, 'org', { campeonatoId: id });
  await S.resultadoCT(db, 'm', V(salvo.jogos.find((x) => x.id === j.id), { campeonatoId: id, jogoId: j.id, golsCasa: 2, golsFora: 0, motivo: 'Gol esquecido na súmula' }), NOW + 1000);
  const doDetalhe = (await S.lerDetalheCT(db, 'org', { campeonatoId: id })).jogos.find((x) => x.id === j.id).correcoes[0];
  assert.equal('por' in doDetalhe, false); assert.equal(doDetalhe.porNome, 'Mesa');
  await E.excluirIdentidadeCT(db, 'm');
  const k = db.data.get(base + '/jogos/' + j.id).correcoes[0];
  assert.notEqual(k.por, 'm'); assert.match(k.por, /^removido_/); assert.equal(k.porNome, 'Usuário removido');
  assert.equal(k.motivo, 'Gol esquecido na súmula');
  assert.equal(JSON.stringify(db.data.get(base + '/jogos/' + j.id)).includes('Mesa'), false);
});
test('pagamento e contato: quem vê, "Já paguei", confirmação e limpeza no fim',async()=>{
 const{db,id,base}=await cenario();
 assert.equal(D.whatsappCT('(11) 91234-5678','x'),'5511912345678');assert.equal(D.whatsappCT('','x'),null);assert.throws(()=>D.whatsappCT('123','x'),/DDD/);
 await S.inscreverCT(db,'a',{...pedido(id,'a'),whatsapp:'11 91234-5678'},NOW);await S.inscreverCT(db,'b',pedido(id,'b'),NOW);
 await assert.rejects(S.contatoCT(db,'a',{acao:'pagamentoContato',campeonatoId:id,pagamentoTexto:'Pix'},NOW),/organizador/);
 await S.contatoCT(db,'org',{acao:'pagamentoContato',campeonatoId:id,pagamentoTexto:'Pix: x@y.com\nR$ 150',whatsappOrganizacao:'(63) 98765-4321'},NOW);
 // Pendente: ainda não vê "Como pagar"; o organizador vê o WhatsApp do dono.
 let d=await S.lerDetalheCT(db,'a',{campeonatoId:id});assert.equal(d.campeonato.pagamentoTexto,null);assert.equal(d.inscricoes.find(i=>i.timeId==='a_1').whatsappDono,'5511912345678');
 d=await S.lerDetalheCT(db,'org',{campeonatoId:id});assert.equal(d.inscricoes.find(i=>i.timeId==='a_1').whatsappDono,'5511912345678');assert.equal(d.campeonato.whatsappOrganizacao,'5563987654321');
 await S.responderCT(db,'org',{...pedido(id,'a'),aceitar:true},NOW);await S.responderCT(db,'org',{...pedido(id,'b'),aceitar:true},NOW);
 d=await S.lerDetalheCT(db,'a',{campeonatoId:id});assert.equal(d.campeonato.pagamentoTexto,'Pix: x@y.com\nR$ 150');
 // Outro dono aprovado vê as instruções, mas nunca o telefone de quem não é ele.
 d=await S.lerDetalheCT(db,'b',{campeonatoId:id});assert.equal(d.inscricoes.find(i=>i.timeId==='a_1').whatsappDono,null);assert.equal(d.inscricoes.find(i=>i.timeId==='a_1').pagamentoAvisadoEm,null);
 d=await S.lerDetalheCT(db,'c',{campeonatoId:id});assert.equal(d.campeonato.pagamentoTexto,null);assert.equal(d.campeonato.whatsappOrganizacao,null);
 // "Já paguei": só o dono, um push ao organizador, repetir não duplica.
 await assert.rejects(S.contatoCT(db,'b',{acao:'avisarPagamento',campeonatoId:id,timeId:'a_1'},NOW),/dono/);
 let av=await S.contatoCT(db,'a',{acao:'avisarPagamento',campeonatoId:id,timeId:'a_1'},NOW);assert.deepEqual(av.map(a=>a.recipientUids),[['org']]);
 assert.equal((await S.contatoCT(db,'a',{acao:'avisarPagamento',campeonatoId:id,timeId:'a_1'},NOW+5)).length,0);assert.equal(db.data.get(base+'/inscricoes/a_1').pagamentoAvisadoEm,NOW);
 // "Ainda não": limpa o aviso e avisa o dono; depois confirma.
 av=await S.administrarCT(db,'org',{acao:'marcarPagamento',campeonatoId:id,timeId:'a_1',pago:false},NOW+10);assert.deepEqual(av.map(a=>a.recipientUids),[['a']]);assert.equal(db.data.get(base+'/inscricoes/a_1').pagamentoAvisadoEm,null);
 av=await S.administrarCT(db,'org',{acao:'marcarPagamento',campeonatoId:id,timeId:'a_1',pago:true},NOW+20);assert.match(av[0].draft.title,/confirmado/);
 // Pedir contato: só para quem não informou; o dono preenche depois.
 assert.equal((await S.contatoCT(db,'org',{acao:'pedirContato',campeonatoId:id,timeId:'a_1'},NOW)).length,0);
 av=await S.contatoCT(db,'org',{acao:'pedirContato',campeonatoId:id,timeId:'b_1'},NOW);assert.deepEqual(av.map(a=>a.recipientUids),[['b']]);
 // Repetir no mesmo dia não manda outro aviso; depois de 24 h, pode pedir de novo.
 assert.equal((await S.contatoCT(db,'org',{acao:'pedirContato',campeonatoId:id,timeId:'b_1'},NOW+60_000)).length,0);
 assert.equal((await S.contatoCT(db,'org',{acao:'pedirContato',campeonatoId:id,timeId:'b_1'},NOW+86_400_001)).length,1);
 await S.contatoCT(db,'b',{acao:'contatoDono',campeonatoId:id,timeId:'b_1',whatsapp:'63912345678'},NOW);assert.equal(db.data.get(base+'/inscricoes/b_1').whatsappDono,'5563912345678');
 // Cancelado: telefones saem e nada mais aparece.
 await S.administrarCT(db,'org',{acao:'cancelar',campeonatoId:id,motivo:'Chuva'},NOW+30);
 assert.equal(db.data.get(base+'/inscricoes/a_1').whatsappDono,null);assert.equal(db.data.get(base+'/inscricoes/b_1').whatsappDono,null);
 d=await S.lerDetalheCT(db,'org',{campeonatoId:id});assert.equal(d.campeonato.pagamentoTexto,null);
 await assert.rejects(S.contatoCT(db,'a',{acao:'contatoDono',campeonatoId:id,timeId:'a_1',whatsapp:''},NOW),/terminou/);
});
test('finalizar apaga o WhatsApp de todas as inscrições, inclusive pendentes',async()=>{
 const{db,id,base}=await completo();
 db.data.set('times/d_1',time('d'));db.data.set('users/d',perfil('D'));
 for(const t of ['a_1','b_1','c_1'])db.data.get(base+'/inscricoes/'+t).whatsappDono='5511912345678';
 // Pedido pendente gravado com número (ex.: chegou depois das vagas fechadas).
 db.data.set(base+'/inscricoes/d_1',{...db.data.get(base+'/inscricoes/a_1'),timeId:'d_1',donoId:'d',status:'pendente',whatsappDono:'5511987654321',pagamentoAvisadoEm:null});
 await S.iniciarCT(db,'org',{campeonatoId:id},NOW);
 for(const jogo of (await S.lerDetalheCT(db,'org',{campeonatoId:id})).jogos)await S.resultadoCT(db,'org',V(jogo,{campeonatoId:id,jogoId:jogo.id,golsCasa:2,golsFora:0}),NOW);
 await S.finalizarCT(db,'org',{campeonatoId:id,revisaoEsperada:db.data.get(base).premiacaoVersao},NOW+1);
 for(const t of ['a_1','b_1','c_1','d_1'])assert.equal(db.data.get(base+'/inscricoes/'+t).whatsappDono,null,t);
});
// Banco em memória com getAll e batch (usados pelo módulo de compras).
const dbCompras=seed=>{const db=new DB(seed);db.getAll=(...refs)=>Promise.all(refs.map(r=>r.get()));db.batch=()=>{const ops=[];return{set:(r,v)=>ops.push(()=>db.data.set(r.path,clone(v))),delete:r=>ops.push(()=>db.data.delete(r.path)),commit:async()=>ops.forEach(f=>f())};};return db;};
const compraWebhook=(tipo,uid,transacao)=>({type:tipo,product_id:'campeonato_premium',app_user_id:uid,transaction_id:transacao,environment:'PRODUCTION'});
test('campeonato premium: compra vira crédito uma vez, criação gasta, cancelar antes do início devolve, reembolso retira',async()=>{
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;
 try{
  const db=dbCompras({'users/org':perfil('Org')});const compra={transacao:'GPA.1234-5678',loja:'PLAY_STORE',sandbox:false,compradoEm:NOW};
  // A mesma compra pelo app e pelo webhook conta uma vez só.
  assert.equal(await P.creditarCompraCT(db,'org',compra,'app',NOW),'creditado');
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','org','GPA.1234-5678'),NOW),'repetido');
  assert.equal(await P.creditosDisponiveisCT(db,'org'),1);
  // Compra de teste não vale sem a permissão de sandbox.
  assert.equal(await P.creditarCompraCT(db,'org',{...compra,transacao:'sandbox-0001',sandbox:true},'app',NOW),'sandbox');
  // Criar grupos + mata-mata gasta o crédito; o segundo não tem crédito.
  const c=await S.criarCT(db,'org',corpo({formato:'grupos_mata',maxTimes:8}),false,NOW);
  assert.equal(await P.creditosDisponiveisCT(db,'org'),0);assert.ok(db.data.get('campeonatosTimes/'+c.campeonatoId).creditoPremium);
  await assert.rejects(S.criarCT(db,'org',corpo({chavePedido:'pedido-00000009',formato:'grupos_mata',maxTimes:8}),false,NOW),/premium/);
  // Retry do mesmo pedido não gasta de novo; formatos comuns continuam grátis.
  await S.criarCT(db,'org',corpo({formato:'grupos_mata',maxTimes:8}),false,NOW);assert.equal(await P.creditosDisponiveisCT(db,'org'),0);
  await S.criarCT(db,'org',corpo({chavePedido:'pedido-00000010'}),false,NOW);
  // Cancelado antes do início: o crédito volta.
  await S.administrarCT(db,'org',{acao:'cancelar',campeonatoId:c.campeonatoId,motivo:'Sem times'},NOW+5);
  assert.equal(await P.creditosDisponiveisCT(db,'org'),1);
  // Reembolso pela loja (aviso com conta anônima): o crédito disponível sai.
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('CANCELLATION','$RCAnonymousID:abc','GPA.1234-5678'),NOW+9),'reembolsado');
  assert.equal(await P.creditosDisponiveisCT(db,'org'),0);
  // Outros produtos e compras de conta anônima são ignorados.
  assert.equal(await P.processarAvisoLojaCT(db,{...compraWebhook('NON_RENEWING_PURCHASE','org','x-000001'),product_id:'outro'},NOW),'ignorado');
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','$RCAnonymousID:abc','x-000002'),NOW),'ignorado');
 }finally{P.PREMIUM_CT.gruposParaTodos=true;}
});
test('campeonato premium (PREM-01): a mesma compra nunca vira crédito em duas contas',async()=>{
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;
 try{
  const db=dbCompras({'users/a':perfil('A'),'users/b':perfil('B')});const compra={transacao:'1000000555',loja:'app_store',sandbox:false,compradoEm:NOW};
  assert.equal(await P.creditarCompraCT(db,'a',compra,'app',NOW),'creditado');
  assert.equal(await P.creditarCompraCT(db,'b',compra,'app',NOW),'outra_conta');
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','b','1000000555'),NOW),'outra_conta');
  assert.equal(await P.creditosDisponiveisCT(db,'a'),1);assert.equal(await P.creditosDisponiveisCT(db,'b'),0);
  // Concorrência: duas contas ao mesmo tempo, um crédito só.
  const r=await Promise.all(['a','b'].map(u=>P.creditarCompraCT(db,u,{...compra,transacao:'1000000556'},'webhook',NOW)));
  assert.equal(r.filter(x=>x==='creditado').length,1);
 }finally{P.PREMIUM_CT.gruposParaTodos=true;}
});
test('campeonato premium (PREM-02): sincronização sem o id da loja não credita; com o id, coincide com o aviso',async()=>{
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;const antes=process.env.REVENUECAT_SECRET_KEY;process.env.REVENUECAT_SECRET_KEY='sk_teste';
 try{
  const db=dbCompras({'users/u1':perfil('U')});
  const resposta=itens=>async()=>({ok:true,status:200,json:async()=>({subscriber:{non_subscriptions:{campeonato_premium:itens}}})});
  // Só o id interno do RevenueCat: nada é creditado pela consulta.
  let r=await P.sincronizarCreditosCT(db,'u1',resposta([{id:'rc-interno-002',store:'app_store',is_sandbox:false}]),NOW);assert.equal(r.creditos,0);
  // O aviso com o id da loja credita uma vez; a consulta com o mesmo id da loja não duplica.
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','u1','10000000002'),NOW),'creditado');
  r=await P.sincronizarCreditosCT(db,'u1',resposta([{id:'rc-interno-002',store_transaction_id:'10000000002',store:'app_store',is_sandbox:false}]),NOW);
  assert.equal(r.novos,0);assert.equal(r.creditos,1);
 }finally{P.PREMIUM_CT.gruposParaTodos=true;if(antes===undefined)delete process.env.REVENUECAT_SECRET_KEY;else process.env.REVENUECAT_SECRET_KEY=antes;}
});
test('campeonato premium (PREM-03): reembolso antes da compra fica registrado e a compra atrasada não credita',async()=>{
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;
 try{
  const db=dbCompras({'users/u1':perfil('U')});
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('CANCELLATION','u1','GPA.9999-0001'),NOW),'reembolsado');
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','u1','GPA.9999-0001'),NOW+1),'ja_reembolsado');
  assert.equal(await P.creditarCompraCT(db,'u1',{transacao:'GPA.9999-0001',loja:'play_store',sandbox:false,compradoEm:NOW},'app',NOW+2),'ja_reembolsado');
  assert.equal(await P.creditosDisponiveisCT(db,'u1'),0);
  // Reentrega do reembolso não muda nada.
  await P.processarAvisoLojaCT(db,compraWebhook('CANCELLATION','u1','GPA.9999-0001'),NOW+3);assert.equal(await P.creditosDisponiveisCT(db,'u1'),0);
 }finally{P.PREMIUM_CT.gruposParaTodos=true;}
});
test('campeonato premium (PREM-04): depois da exclusão da conta, aviso atrasado não recria crédito nem histórico',async()=>{
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;
 try{
  const db=dbCompras({'users/u1':perfil('U')});
  assert.equal(await P.creditarCompraCT(db,'u1',{transacao:'1000000777',loja:'app_store',sandbox:false,compradoEm:NOW},'app',NOW),'creditado');
  db.data.get('users/u1').excluindoEm=NOW+1;
  await P.excluirCreditosCT(db,'u1');db.data.delete('users/u1');
  const registro=db.data.get(P.refCompraCT(db,'1000000777').path);
  assert.deepEqual(Object.keys(registro).sort(),['criadoEm','estado','uid']);assert.equal(registro.uid,null);
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','u1','1000000777'),NOW+2),'sem_conta');
  // Compra nova de conta inexistente: só um registro vazio, sem uid nem dados da compra.
  assert.equal(await P.processarAvisoLojaCT(db,compraWebhook('NON_RENEWING_PURCHASE','u1','1000000778'),NOW+3),'sem_conta');
  assert.equal(db.data.get(P.refCompraCT(db,'1000000778').path).uid,null);
  assert.equal(await P.creditosDisponiveisCT(db,'u1'),0);
 }finally{P.PREMIUM_CT.gruposParaTodos=true;}
});
test('campeonato premium: sincronização consulta só a conta logada e webhook exige o cabeçalho',async()=>{
 const P=carregar('campeonatosTimesPremium');P.PREMIUM_CT.gruposParaTodos=false;const antes=process.env.REVENUECAT_SECRET_KEY;process.env.REVENUECAT_SECRET_KEY='sk_teste';
 try{
  const db=dbCompras({'users/user123':perfil('U')});let url='';
  const buscar=async(u,init)=>{url=u;assert.equal(init.headers.Authorization,'Bearer sk_teste');return{ok:true,status:200,json:async()=>({subscriber:{non_subscriptions:{campeonato_premium:[{id:'rc1',store_transaction_id:'1000000123',purchase_date:'2026-11-17T12:00:00Z',store:'app_store',is_sandbox:false},{id:'rc2',store_transaction_id:'1000000124',store:'app_store',is_sandbox:false}],outro:[{id:'z',store_transaction_id:'999999'}]}}})};};
  let r=await P.sincronizarCreditosCT(db,'user123',buscar,NOW);assert.equal(r.creditos,2);assert.equal(r.novos,2);assert.ok(url.endsWith('/subscribers/user123'));
  r=await P.sincronizarCreditosCT(db,'user123',buscar,NOW);assert.equal(r.novos,0);assert.equal(r.creditos,2);
  // Na fase gratuita, o saldo não é consultado.
  P.PREMIUM_CT.gruposParaTodos=true;assert.equal(await P.creditosDisponiveisCT(db,'user123'),0);
  assert.equal(P.webhookAutorizado('Bearer certo-e-comprido-000000000000','Bearer certo-e-comprido-000000000000'),true);
  assert.equal(P.webhookAutorizado('errado','Bearer certo-e-comprido-000000000000'),false);
  assert.equal(P.webhookAutorizado('curto','curto'),false);
 }finally{P.PREMIUM_CT.gruposParaTodos=true;if(antes===undefined)delete process.env.REVENUECAT_SECRET_KEY;else process.env.REVENUECAT_SECRET_KEY=antes;}
});
