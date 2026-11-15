const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(file,stubs){const f=path.resolve(__dirname,'../api',file),m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,require:n=>stubs[n]??{},process,console,Buffer});return m.exports;}
const res=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;}});
test('regional: versão sinaliza falha sem converter ausência de leitura em liberação',async()=>{
 const h=load('version.ts',{'./_lib/regioesTimes':{lerRegioesTimes:async()=>{throw Error('Firestore indisponível');}},'firebase-admin/firestore':{getFirestore:()=>({})},'./_lib/auth':{getFirebaseApp:()=>({})},'./_lib/sistema':{CONFIG_PADRAO:{},lerConfig:async()=>({}),aplicarConfigRemota:b=>b},'./_lib/version':{parsePlatform:()=> 'android',resolvePolicy:()=>({policy:{minVersion:null},warnings:[]})}}).default;
 const r=res();await h({method:'GET',query:{}},r);assert.equal(r.statusCode,200);assert.equal(r.body.regioesTimesIndisponiveis,true);assert.equal(r.body.minVersion,null);assert.equal(r.body.regioesTimes,undefined);
});
test('regional: exceção de saída não libera catálogo/criação/edição e usa uid autenticado',async()=>{
 class Regional extends Error {constructor(){super('Região bloqueada');this.status=403;this.code='regiao_nao_liberada';}}
 const recebidos=[];let logado=true,appCheck=true,checagens=0;
 const h=load('_lib/campeonatosTimesApi.ts',{'./saidasRegionaisCT':{listarSaidasRegionaisCT:async(db,uid,b)=>{recebidos.push(uid);return{itens:[],proximoCursor:null};}},'./regioesTimes':{ErroRegioesTimes:Regional,exigirRegiaoTimes:async()=>{checagens++;throw new Regional();}},'firebase-admin/firestore':{getFirestore:()=>({})},'./auth':{getFirebaseApp:()=>({}),requireUser:async(req,r)=>{if(!logado){r.status(401).json({error:'Login'});return null;}return{uid:'conta-autenticada'};}},'./appCheck':{verificarAppCheck:async()=>appCheck},'./cors':{handleCors:()=>false},'./rateLimit':{dentroDoLimite:async()=>true},'./campeonatosTimesDominio':{exigirCT:(ok)=>assert.ok(ok),objetoCT:b=>b}}).handleCampeonatosTimes;
 for(const acao of ['listar','detalhe','criar','inscrever','resultado','iniciar','finalizar']){const r=res();await h({method:'POST',body:{acao}},r);assert.equal(r.statusCode,403);assert.equal(r.body.code,'regiao_nao_liberada');}
 assert.equal(checagens,7);let r=res();await h({method:'POST',body:{acao:'saidasRegionais',uid:'outra',filtro:'abertos'}},r);assert.equal(r.statusCode,200);assert.deepEqual(recebidos,['conta-autenticada']);
 logado=false;r=res();await h({method:'POST',body:{acao:'saidasRegionais'}},r);assert.equal(r.statusCode,401);assert.equal(recebidos.length,1);
 logado=true;appCheck=false;r=res();await h({method:'POST',body:{acao:'saidasRegionais'}},r);assert.equal(r.body,undefined);assert.equal(recebidos.length,1);
});
