const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const ts=require(require.resolve('typescript',{paths:[root]}));
const anterior=require.extensions['.ts'];require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const S=require(path.join(root,'api/_lib/campeonatosTimesServico.ts'));
if(anterior)require.extensions['.ts']=anterior;else delete require.extensions['.ts'];
async function main(){
 if(!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Só pode rodar com emulador local.');
 const {initializeApp,deleteApp}=require('firebase-admin/app'),{getFirestore}=require('firebase-admin/firestore');
 const app=initializeApp({projectId:'demo-tugyn-campeonatos-api'}),db=getFirestore(app);
 const nonce=Date.now().toString(36),org='org_'+nonce,a='a_'+nonce,b='b_'+nonce,c='c_'+nonce;
 const perfil=n=>({name:n,status:'active',location:{city:'Palmas',state:'TO',cityId:'palmas_to'}});
 const time=(u,membros)=>({donoId:u,nome:'Time '+u,modalidade:'futsal',genero:'masculino',faixaEtaria:'livre',membros,jogadores:Object.fromEntries(membros.map(id=>[id,{nome:id}])),camisas:{}});
 const agora=Date.now(),body=n=>({chavePedido:'emulador-pedido-'+n,nome:'Teste concorrência',modalidade:'futsal',formato:'triangular',maxTimes:3,inscricoesAte:agora+86400000,locais:[{nome:'Arena'}],minJogadores:1,maxJogadores:5});
 const limpar=[];
 try{
  for(const u of [org,a,b,c]){await db.doc('users/'+u).set(perfil(u));limpar.push(db.doc('users/'+u));}
  for(const [u,membros]of [[a,[a]],[b,[a,b]],[c,[c]]]){await db.doc('times/'+u+'_1').set(time(u,membros));limpar.push(db.doc('times/'+u+'_1'));}
  const r=await Promise.allSettled([1,2,3,4].map(n=>S.criarCT(db,org,body(n),false,agora)));
  assert.equal(r.filter(x=>x.status==='fulfilled').length,3,'limite atômico em transações reais');
  for(const x of r)if(x.status==='fulfilled')limpar.push(db.doc('campeonatosTimes/'+x.value.campeonatoId));
  assert.equal((await db.doc('controleCampeonatosTimes/'+org).get()).get('ativos'),3);
  const id=r.find(x=>x.status==='fulfilled').value.campeonatoId,ref=db.doc('campeonatosTimes/'+id);
  for(const [u,jogador]of [[a,a],[b,a],[c,c]])await S.inscreverCT(db,u,{campeonatoId:id,timeId:u+'_1',jogadorIds:[jogador],tentativaId:"inicial_"+u},agora);
  const aprovacoes=await Promise.allSettled([a,b].map(u=>S.responderCT(db,org,{campeonatoId:id,timeId:u+'_1',aceitar:true},agora)));
  assert.equal(aprovacoes.filter(x=>x.status==='fulfilled').length,1,'um atleta só em um time');
  assert.equal((await ref.get()).get('aprovados'),1,'contagem não diverge');
  const ganhou=aprovacoes[0].status==='fulfilled'?a:b,perdeu=ganhou===a?b:a;
  if(perdeu===a){await S.cancelarInscricaoCT(db,org,{campeonatoId:id,timeId:b+'_1'},agora);await S.inscreverCT(db,b,{campeonatoId:id,timeId:b+'_1',jogadorIds:[b],tentativaId:"corrigir_"+b},agora);await S.responderCT(db,org,{campeonatoId:id,timeId:b+'_1',aceitar:true},agora);}
  else await S.inscreverCT(db,b,{campeonatoId:id,timeId:b+'_1',jogadorIds:[b],tentativaId:"corrigir_"+b},agora);
  for(const u of [a,b,c])await S.responderCT(db,org,{campeonatoId:id,timeId:u+'_1',aceitar:true},agora);
  await Promise.all([S.iniciarCT(db,org,{campeonatoId:id},agora),S.iniciarCT(db,org,{campeonatoId:id},agora)]);
  const jogos=await ref.collection('jogos').get();assert.equal(jogos.size,3,'duplo toque não duplica tabela');
  await Promise.all(jogos.docs.map(j=>S.resultadoCT(db,org,{campeonatoId:id,jogoId:j.id,golsCasa:1,golsFora:0,casaEsperada:j.get("casa"),foraEsperada:j.get("fora"),versaoEsperada:Number(j.get("versao")??0)},agora)));
  const pronto=await ref.get();assert.equal(pronto.get('status'),'em_andamento');assert.ok(pronto.get('campeaoTimeId'));
  await Promise.all([1,2].map(()=>S.finalizarCT(db,org,{campeonatoId:id,revisaoEsperada:Number(pronto.get('premiacaoVersao')??0)},agora)));
  const final=await ref.get();assert.equal(final.get('status'),'encerrado');assert.ok(final.get('campeaoTimeId'));
  const detalhe=await S.lerDetalheCT(db,org,{campeonatoId:id});assert.equal(detalhe.campeonato.status,'encerrado');assert.equal(detalhe.jogos.length,3);assert.equal(detalhe.classificacao.length,3);
  assert.equal((await db.doc('controleCampeonatosTimes/'+org).get()).get('ativos'),2,'encerramento decrementa cota só uma vez');
  console.log('Emulador API: criação concorrente, atleta duplicado, aprovação, início concorrente e resultados concorrentes aprovados.');
 }finally{for(const r of limpar)await db.recursiveDelete(r);await db.doc('controleCampeonatosTimes/'+org).delete();await deleteApp(app);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
