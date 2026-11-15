const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),ts=require('typescript'),antes=require.extensions['.ts'];
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {calcularTrofeusTimes:calcular,chaveTrofeuTimes}=require('../api/_lib/campeonatosTimesTrofeus.ts');
const {sincronizarTrofeusTimes:sync}=require('../api/_lib/campeonatosTimesTrofeusSync.ts');
const {gerarJogosCT,registrarResultadoCT}=require('../api/_lib/campeonatosTimesDominio.ts');
if(antes)require.extensions['.ts']=antes;else delete require.extensions['.ts'];
const id='ct_'+'a'.repeat(24),p=`campeonatosTimes/${id}`,key=chaveTrofeuTimes(id),ledger=`${p}/premiacaoControle/estado`;
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(formato='triangular',n=3){
 const ins=Array.from({length:n},(_,i)=>({timeId:`t${i}`,timeNome:`Time ${i}`,status:'aprovada',cor:'#123456',jogadores:[{id:`u${i}`,nome:`Atleta ${i}`}]}));
 const ordem=ins.map(i=>i.timeId),gerado=gerarJogosCT(formato,ordem);
 const camp={nome:'Copa',formato,ordem,grupos:gerado.grupos,status:'em_andamento'};
 let jogos=gerado.jogos;
 for(let rodada=0;rodada<100;rodada++){
  const j=Object.values(jogos).find(j=>j.casa&&j.fora&&j.status!=='finalizado');if(!j)break;
  const uid=ins.find(i=>i.timeId===j.casa).jogadores[0].id;
  const r=registrarResultadoCT(camp,ins,jogos,j.id,{casaEsperada:j.casa,foraEsperada:j.fora,versaoEsperada:j.versao??0,golsCasa:1,golsFora:0,gols:{[uid]:1},assistencias:{[uid]:1}});
  jogos=r.jogos;camp.campeaoTimeId=r.campeaoTimeId;
 }
 camp.status='encerrado';return {camp,ins,jogos};
}
test('times: premia formatos reais e todos os atletas inscritos do campeão',()=>{
 for(const [f,n] of [['triangular',3],['quadrangular',4],['mata',4],['grupos_mata',8]]){
  const x=fixture(f,n),r=calcular(id,x.camp,x.ins,x.jogos),u=x.ins.find(i=>i.timeId===x.camp.campeaoTimeId).jogadores[0].id;
  assert.ok(r.get(u).titulos.includes('campeao'),f);assert.equal(r.get(u).origem,'times');
  x.ins.find(i=>i.timeId===x.camp.campeaoTimeId).jogadores.push({id:'reserva',nome:'Reserva'});
  assert.ok(calcular(id,x.camp,x.ins,x.jogos).get('reserva').titulos.includes('campeao'));
 }
});
test('times: líderes empatados recebem, zero não dá prêmio e pênaltis não são gols',()=>{
 const x=fixture();for(const j of Object.values(x.jogos)){j.gols={};j.assistencias={};}
 const j=Object.values(x.jogos)[0];j.golsCasa=1;j.golsFora=1;
 const a=x.ins.find(i=>i.timeId===j.casa).jogadores[0].id,b=x.ins.find(i=>i.timeId===j.fora).jogadores[0].id;
 j.gols={[a]:1,[b]:1};j.penaltis=[9,8];
 // Mantém o campeão recalculado para esta tabela, sem depender de escolher um vencedor manualmente.
 const {campeaoDe}=loadPure();x.camp.campeaoTimeId=campeaoDe({times:Object.fromEntries(x.ins.map(i=>[i.timeId,{nome:i.timeNome,elenco:i.jogadores}])),jogos:x.jogos,sorteio:x.camp.ordem,regras:{pontosVitoria:3,pontosEmpate:1}});
 const r=calcular(id,x.camp,x.ins,x.jogos);assert.ok(r.get(a).titulos.includes('artilheiro'));assert.ok(r.get(b).titulos.includes('artilheiro'));
 assert.equal([...r.values()].some(t=>t.titulos.includes('garcom')),false);assert.equal(r.get(a).gols,1);
});
function loadPure(){const old=require.extensions['.ts'];require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,f);const r=require('../api/_lib/campeonato/classificacao.ts');if(old)require.extensions['.ts']=old;else delete require.extensions['.ts'];return r;}
test('times: recusa campeão adulterado, estatísticas de terceiros, soma excessiva e campeonato aberto',()=>{
 for(const mut of [x=>x.camp.campeaoTimeId='estranho',x=>Object.values(x.jogos)[0].gols={fora:1},x=>{const j=Object.values(x.jogos)[0];j.gols={[x.ins.find(i=>i.timeId===j.casa).jogadores[0].id]:99};},x=>x.camp.status='cancelado',x=>x.ins[1].jogadores.push(x.ins[0].jogadores[0])]){
 const x=fixture();mut(x);assert.equal(calcular(id,x.camp,x.ins,x.jogos).size,0);}
});
const {FieldValue}=require('firebase-admin/firestore'),DEL=FieldValue.delete(),NOW=FieldValue.serverTimestamp();
function fake(x){
 const docs=new Map([[p,clone(x.camp)],...x.ins.map(i=>[`${p}/inscricoes/${i.timeId}`,clone(i)]),...Object.entries(x.jogos).map(([id,j])=>[`${p}/jogos/${id}`,clone(j)]),...x.ins.map(i=>[`users/${i.jogadores[0].id}`,{}])]);
 const db={docs,writes:0,revision:1,fail:null,beforeUser:null,consultas:[]};
 const merge=(a,b)=>{for(const[k,v]of Object.entries(b)){if(v?.isEqual?.(DEL))delete a[k];else if(v?.isEqual?.(NOW))a[k]='timestamp';else if(v&&typeof v==='object'&&!Array.isArray(v))a[k]=merge(a[k]??{},v);else a[k]=clone(v);}return a;};
 const consulta=(path,filtro=null)=>({path,filtro,where:(k,_op,v)=>consulta(path,[k,v]),limit:()=>consulta(path,filtro)});
 const ref=p=>({path:p,collection:n=>({...consulta(`${p}/${n}`),doc:id=>ref(`${p}/${n}/${id}`)})});
 const snap=p=>({id:p.split('/').pop(),exists:docs.has(p),updateTime:docs.has(p)?{seconds:db.revision,nanoseconds:0}:undefined,data:()=>docs.has(p)?clone(docs.get(p)):undefined});
 db.doc=ref;
 db.runTransaction=async fn=>{
  const queued=[];const result=await fn({getAll:async(...rs)=>{if(rs.length===4&&db.beforeUser){const f=db.beforeUser;db.beforeUser=null;f();}return rs.map(r=>snap(r.path));},get:async r=>{db.consultas.push(r.path+(r.filtro?'?'+r.filtro.join('='):''));return{docs:[...docs.keys()].filter(k=>k.startsWith(r.path+'/')&&k.slice(r.path.length+1).indexOf('/')<0&&(!r.filtro||docs.get(k)?.[r.filtro[0]]===r.filtro[1])).map(snap)};},set:(r,d,o)=>queued.push(()=>{if(db.fail?.(r.path))throw Error('falha simulada');db.writes++;docs.set(r.path,merge(o?.merge?docs.get(r.path)??{}:{},d));}),delete:r=>queued.push(()=>{db.writes++;docs.delete(r.path);})});
  for(const f of queued)f();return result;
 };return db;
}
test('sync times: idempotência, data preservada, correção e cancelamento sem tocar troféus de turma',async()=>{
 const db=fake(fixture());db.docs.set('users/u0/restrito/trofeus',{itens:{T_C:{campeonato:'Turma'}}});
 assert.ok((await sync(db,id)).gravados>0);const em=db.docs.get('users/u0/restrito/trofeus').itens[key]?.em;
 db.writes=0;await sync(db,id);assert.equal(db.writes,0);
 db.docs.get(p).nome='Copa corrigida';db.revision++;await sync(db,id);
 assert.equal(db.docs.get('users/u0/restrito/trofeus').itens[key]?.em,em);
 db.docs.get(p).status='cancelado';db.revision++;assert.ok((await sync(db,id)).removidos>0);
 assert.equal(db.docs.get('users/u0/restrito/trofeus').itens[key],undefined);assert.ok(db.docs.get('users/u0/restrito/trofeus').itens.T_C);
});
test('sync times: falha parcial é recuperável e exclusão retira prêmios',async()=>{
 const db=fake(fixture());db.fail=s=>s==='users/u1/restrito/trofeus';await assert.rejects(sync(db,id),/falha simulada/);
 assert.equal(db.docs.get(ledger).concluido,false);db.fail=null;await sync(db,id);assert.equal(db.docs.get(ledger).concluido,true);
 db.docs.delete(p);db.revision++;await sync(db,id);assert.equal(db.docs.has(ledger),false);
 for(const [k,v]of db.docs)if(k.endsWith('/restrito/trofeus'))assert.equal(v.itens[key],undefined);
});
test('sync times: conta ausente/em exclusão não é recriada e plano antigo não grava após correção',async()=>{
 const db=fake(fixture());db.docs.delete('users/u0');db.docs.set('users/u1',{excluindoEm:1});await sync(db,id);
 assert.equal(db.docs.has('users/u0/restrito/trofeus'),false);assert.equal(db.docs.has('users/u1/restrito/trofeus'),false);
 const other=fake(fixture());other.beforeUser=()=>{other.docs.get(p).status='cancelado';other.revision++;};
 await assert.rejects(sync(other,id),/Premiação mudou/);await sync(other,id);
 assert.equal([...other.docs.keys()].some(k=>k.endsWith('/restrito/trofeus')),false);
});
test('Functions: gatilho durável cobre resultados, correções e exclusão, com retry',()=>{
 const fonte=fs.readFileSync(path.join(root,'notifications-functions/src/index.ts'),'utf8');
 assert.match(fonte,/syncCampeonatoTimesTrofeus = onDocumentWritten\(\{ \.\.\.triggerOptions, document: "campeonatosTimes\/\{campeonatoId\}"/);
 assert.match(fonte,/retry: true/);assert.match(fonte,/sincronizarTrofeusTimes\(db, event.params.campeonatoId\)/);
});
test('FIN-01: galeria com falha persistente não bloqueia os demais atletas nem os lotes seguintes',async()=>{
 const x=fixture();
 for(const [i,ins]of x.ins.entries())ins.jogadores=Array.from({length:30},(_,n)=>({id:`p${i}_${n}`,nome:'Atleta'}));
 for(const j of Object.values(x.jogos)){
  j.golsCasa=30;j.golsFora=30;j.gols={};j.assistencias={};
  for(const ins of x.ins.filter(i=>i.timeId===j.casa||i.timeId===j.fora))for(const a of ins.jogadores)j.gols[a.id]=1;
 }
 const {campeaoDe}=loadPure();x.camp.campeaoTimeId=campeaoDe({times:Object.fromEntries(x.ins.map(i=>[i.timeId,{nome:i.timeNome,elenco:i.jogadores}])),jogos:x.jogos,sorteio:x.camp.ordem,regras:{pontosVitoria:3,pontosEmpate:1}});
 const db=fake(x);for(const i of x.ins)for(const a of i.jogadores)db.docs.set(`users/${a.id}`,{});
 const ids=[...calcular(id,x.camp,x.ins,x.jogos).keys()];assert.equal(ids.length,90);
 db.fail=s=>s===`users/${ids[40]}/restrito/trofeus`;
 await assert.rejects(sync(db,id),/Premiação parcial: 1 galeria.*falha simulada/);
 const recebidos=()=>ids.filter(uid=>db.docs.get(`users/${uid}/restrito/trofeus`)?.itens?.[key]).length;
 assert.equal(recebidos(),89,'só o atleta com falha fica sem o título');
 assert.deepEqual([...db.docs.get(ledger).pendentes],[ids[40]]);assert.equal(db.docs.get(ledger).falhas[ids[40]].tentativas,1);
 assert.equal(db.docs.get(ledger).concluido,false);
 // Falha persistente: o retry repete só o pendente, sem reler nem regravar os outros 89.
 db.writes=0;await assert.rejects(sync(db,id),/Premiação parcial/);
 assert.equal(db.docs.get(ledger).falhas[ids[40]].tentativas,2);assert.ok(db.writes<=2,'só o ledger e o plano');
 db.fail=null;await sync(db,id);assert.equal(db.docs.get(ledger).concluido,true);assert.equal(db.docs.get(ledger).falhas,undefined,'concluído limpa as falhas');
 assert.equal(recebidos(),90);
 assert.ok(db.consultas.some(c=>c.endsWith('/inscricoes?status=aprovada')),'FIN-04: só inscrições aprovadas');
 assert.ok(!db.consultas.some(c=>c.endsWith('/inscricoes')),'FIN-04: nunca todas as inscrições');
});
test('API: resultado tem revisão monotônica independente do relógio para disparar a premiação',()=>{
 const fonte=fs.readFileSync(path.join(root,'api/_lib/campeonatosTimesServico.ts'),'utf8');
 assert.match(fonte,/premiacaoVersao: Number\(camp\.premiacaoVersao \?\? 0\) \+ 1/);
});
