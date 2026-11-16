const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),ts=require('typescript'),old=require.extensions['.ts'];
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const{listarTitulosTime,mesmaGeracaoDoTime}=require('../api/_lib/galeriaTimes.ts');if(old)require.extensions['.ts']=old;else delete require.extensions['.ts'];
function banco(){const dados=new Map([['times/dono_1',{linkId:'LinkDoTime00000X',criadoEm:1000,membros:['membro'],chave:'ABC123'}],['chavesTime/ABC123',{timeId:'dono_1'}]]),lidas=[];const ref=p=>({path:p,get:async()=>{lidas.push(p);return{exists:dados.has(p),data:()=>dados.get(p)};},collection:n=>query(p+'/'+n)});
 function query(p,filtro=null,cursor=null,limite=Infinity){return{where:(k,_op,v)=>query(p,[k,v],cursor,limite),orderBy:()=>query(p,filtro,cursor,limite),limit:n=>query(p,filtro,cursor,n),startAfter:c=>query(p,filtro,c,limite),get:async()=>{lidas.push(p);const docs=[...dados.entries()].filter(([k,v])=>k.startsWith(p+'/')&&k.slice(p.length+1).indexOf('/')<0&&(!filtro||v[filtro[0]]===filtro[1])&&(!cursor||k.split('/').at(-1)>cursor)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limite).map(([k,v])=>({id:k.split('/').at(-1),data:()=>v}));return{docs};}};}
 return{doc:ref,dados,lidas};}
test('galeria: só membro por id ou chave pública válida; nega estranho e chave antiga',async()=>{
 const db=banco();await assert.rejects(listarTitulosTime(db,'estranho',{timeId:'dono_1'}),e=>e.status===403);assert.equal(db.lidas.some(p=>p.endsWith('/titulosCampeonatos')),false);
 assert.deepEqual((await listarTitulosTime(db,'membro',{timeId:'dono_1'})).itens,[]);assert.deepEqual((await listarTitulosTime(db,'visitante',{chave:'abc123'})).itens,[]);
 await assert.rejects(listarTitulosTime(db,'membro',{timeId:'dono_1',geracao:'identidade-antiga'}),e=>e.status===404);
 db.dados.get('times/dono_1').chave='XYZ456';await assert.rejects(listarTitulosTime(db,'visitante',{chave:'ABC123'}),e=>e.status===403);
 await assert.rejects(listarTitulosTime(db,'membro',{timeId:'../../users'}),e=>e.status===404);
});
test('galeria: pagina seis títulos, separa geração do time e não envia dados internos',async()=>{
 const db=banco(),prefix='times/dono_1/titulosCampeonatos/';for(let i=1;i<=8;i++)db.dados.set(prefix+'ct_'+i.toString(16).padStart(24,'0'),{timeLinkId:'LinkDoTime00000X',timeCriadoEm:1000,campeonato:'Copa '+i,campeonatoId:'forjado',conquistadoEm:1000,pago:true,jogadores:['segredo'],donoId:'segredo'});
 db.dados.set(prefix+'ct_'+'0'.repeat(24),{timeLinkId:'time-antigo',campeonato:'Time antigo'});
 const p1=await listarTitulosTime(db,'membro',{timeId:'dono_1'}),p2=await listarTitulosTime(db,'membro',{timeId:'dono_1',cursor:p1.proximoCursor});assert.equal(p1.itens.length,6);assert.equal(p2.itens.length,2);assert.equal(new Set([...p1.itens,...p2.itens].map(t=>t.campeonatoId)).size,8);
 assert.equal(JSON.stringify(p1).includes('segredo'),false);assert.equal(JSON.stringify(p1).includes('timeLinkId'),false);assert.equal(JSON.stringify(p1).includes('Time antigo'),false);assert.equal(p2.proximoCursor,null);
 await assert.rejects(listarTitulosTime(db,'membro',{timeId:'dono_1',cursor:'../qualquer'}),e=>e.status===400);
});
test('galeria: identidade atual ou inscrição legada comprovada, sem herança por recriação',()=>{
 const t={timeLinkId:'LinkDoTime00000X',timeCriadoEm:1000,inscritoEm:2000},L='LinkDoTime00000X';
 assert.equal(mesmaGeracaoDoTime({linkId:L,criadoEm:1000},t),true);assert.equal(mesmaGeracaoDoTime({linkId:'OutroTime0000000X',criadoEm:1000},t),false);
 assert.equal(mesmaGeracaoDoTime({linkId:L,criadoEm:3000},t),false,'TIT-01: link reaproveitado em time recriado');assert.equal(mesmaGeracaoDoTime({linkId:L},t),false,'sem criação não há prova');
 assert.equal(mesmaGeracaoDoTime({linkId:L,criadoEm:3000},{...t,timeCriadoEm:null}),false,'inscrição antiga com link igual exige prova temporal');
 assert.equal(mesmaGeracaoDoTime({linkId:L,criadoEm:1000},{...t,timeCriadoEm:null}),true);
 assert.equal(mesmaGeracaoDoTime({linkId:'LinkDoTime00000X',criadoEm:{toMillis:()=>1000}},{...t,timeLinkId:null}),true);assert.equal(mesmaGeracaoDoTime({linkId:'LinkDoTime00000X',criadoEm:3000},{...t,timeLinkId:null}),false);
});

test('TIT-01: listagem aceita geração link:criação ou só link, recusa outra criação e esconde títulos de outra criação',async()=>{
 const db=banco(),prefix='times/dono_1/titulosCampeonatos/';
 db.dados.set(prefix+'ct_'+'1'.repeat(24),{timeLinkId:'LinkDoTime00000X',timeCriadoEm:1000,campeonato:'Desta criação'});
 db.dados.set(prefix+'ct_'+'2'.repeat(24),{timeLinkId:'LinkDoTime00000X',timeCriadoEm:500,campeonato:'Criação anterior'});
 db.dados.set(prefix+'ct_'+'3'.repeat(24),{timeLinkId:'LinkDoTime00000X',campeonato:'Antigo sem criação'});
 const r=await listarTitulosTime(db,'membro',{timeId:'dono_1',geracao:'LinkDoTime00000X:1000'});
 assert.deepEqual(r.itens.map(i=>i.campeonato),['Desta criação']);assert.equal(JSON.stringify(r).includes('timeCriadoEm'),false);
 assert.equal((await listarTitulosTime(db,'membro',{timeId:'dono_1',geracao:'LinkDoTime00000X'})).itens.length,1,'apps anteriores');
 await assert.rejects(listarTitulosTime(db,'membro',{timeId:'dono_1',geracao:'LinkDoTime00000X:500'}),e=>e.status===404);
});
