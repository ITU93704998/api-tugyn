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
 collection(n){return new Query(this.db,this.path+'/'+n);}
 async get(){return this.db.snap(this.path);}
 async delete(){this.db.data.delete(this.path);}
 async update(v){const a=this.db.data.get(this.path);if(!a)throw Error("not-found");this.db.data.set(this.path,{...a,...v});}
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
 const db=new DB({'users/org':perfil('Org')});const b=corpo({formato:'grupos_mata',maxTimes:8});await assert.rejects(S.criarCT(db,'org',b,true,NOW),/liberação/);
 db.data.set('liberacoesCampeonatosTimes/org',{gruposMata:true,expiraEm:NOW+1000});const r=await S.criarCT(db,'org',b,true,NOW);db.data.delete('liberacoesCampeonatosTimes/org');const repetido=await S.criarCT(db,'org',b,false,NOW+172800000);assert.equal(r.campeonatoId,repetido.campeonatoId);
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
  await S.resultadoCT(x.db, 'org', V(todos[ultima.id], { campeonatoId: x.id, jogoId: ultima.id, golsCasa: 0, golsFora: 1 }), NOW + 1);
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
  await S.resultadoCT(y.db, 'org', V(atual, { campeonatoId: y.id, jogoId: jogo.id, golsCasa: 1, golsFora: 0 }), NOW + 4);
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
 await S.resultadoCT(x.db,'org',V(j,{campeonatoId:x.id,jogoId:j.id,golsCasa:0,golsFora:2}),NOW+3);
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
