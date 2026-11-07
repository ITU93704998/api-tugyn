const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');
// Compila apenas em memória. Nenhuma credencial, rede ou Firestore real é usado.
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const c = require('../api/_lib/contratoConfiguracao.ts');
const modelo = require('../api/_lib/contratoModelo.ts');
const contratos = require('../api/_lib/contratos.ts');
const admin = require('../api/_lib/contratoConfiguracaoAdmin.ts');
const fase = require('../api/_lib/contratosFase2.ts');
const { PDFDocument } = require('pdf-lib');
const cloud = require('cloudinary').v2;
let seq = 0; const uploads = [], removidos = [];
cloud.uploader.upload = async (data, options) => { const public_id = options.folder + '/teste-' + (++seq) + '.pdf'; uploads.push({ data, options, public_id }); return { public_id }; };
cloud.uploader.destroy = async id => { removidos.push(id); return {}; };
cloud.utils.private_download_url = id => 'https://exemplo.test/' + id;
process.env.CLOUDINARY_NAME_ANUNCIOS = 'fake'; process.env.CLOUDINARY_KEY_ANUNCIOS = 'fake'; process.env.CLOUDINARY_SECRET_ANUNCIOS = 'fake';
function config() { const x = c.configuracaoInicial(); Object.assign(x.empresa, { razao_social: 'Tugyn Serviços Ltda', nome_fantasia: 'Tugyn', cnpj: '00.000.000/0001-00', endereco: 'Rua de Exemplo, 123', email: 'ads@example.com', telefone: '(11) 9 1234-5678', foro: 'São Paulo/SP', privacidade_url: 'https://example.com/privacidade', data_versao: '2026-11-07', horario_inicio: '09:00', horario_fim: '18:00' }); for (const k in x.politicas) x.politicas[k] = 'Condição comercial de teste revisada.'; return x; }
function dbFake(initial = {}) {
 const docs = new Map(Object.entries(initial).map(([k,v])=>[k,structuredClone(v)])); let fila = Promise.resolve();
 const snap = key => ({ exists: docs.has(key), data: () => structuredClone(docs.get(key)) });
 const db = { doc: key => ({ key, id: key.split('/').pop(), get: async () => snap(key), set: async v => { docs.set(key, structuredClone(v)); } }), runTransaction: async f => { const prev=fila; let fim; fila=new Promise(r=>fim=r); await prev; const writes=[]; try { const result=await f({ get: async ref=>snap(ref.key), set: (r,v,o)=>writes.push(()=>docs.set(r.key,o?.merge?{...docs.get(r.key),...structuredClone(v)}:structuredClone(v))), update: (r,v)=>writes.push(()=>docs.set(r.key,{...docs.get(r.key),...structuredClone(v)})), create: (r,v)=>{if(docs.has(r.key))throw Error('already exists');writes.push(()=>docs.set(r.key,structuredClone(v)));} });writes.forEach(f=>f());return result; }finally{fim();} } }; return { db, docs };
}
const response = () => ({ code:0, body:null, status(n){this.code=n;return this;}, json(b){this.body=b;return this;} });
const invoke = async (db, acao, body={}) => { const r=response(); await admin.adminConfiguracaoContrato(db,acao,body,'admin-teste',Date.parse('2026-11-07T12:00:00Z'),r); return r; };
const contrato = () => contratos.parseContrato({ status:'aguardando_pagamento', codigo:'ABC123', tokenHash:'token-hash', tokenExpiresAt:Date.now()+86400000, cliente:{nome:'João da Silva',email:'joao@example.com',whatsapp:'11999999999'}, pedido:{ modelo:'text', telas:['partidas'], escopo:'todas', cidade:null, inicioMs:Date.now()+86400000, fimMs:Date.now()+8*86400000, dias:7 }, preco:{total:12345,valorPorDia:1764}, historico:[] });
test('rascunho permite campos vazios, publicação exige empresa e políticas completas',()=>{assert.equal(c.validarConfiguracao(c.configuracaoInicial()).ok,true);assert.equal(c.validarConfiguracao(c.configuracaoInicial(),true).ok,false);assert.equal(c.validarConfiguracao(config(),true).ok,true);});
test('rejeita prazo, URL, horário, data e variáveis inválidos',()=>{for(const mudar of [x=>x.prazos.analise_horas=-1,x=>x.prazos.reembolso_dias=1.5,x=>x.empresa.email='ruim',x=>x.empresa.privacidade_url='javascript:alert(1)',x=>x.empresa.horario_fim='08:00',x=>x.empresa.data_versao='2026-02-30',x=>x.texto+=' {{segredo}}',x=>x.texto+=' {{cnpj']){const x=config();mudar(x);assert.equal(c.validarConfiguracao(x,true).ok,false);}});
test('substituição literal preserva $ e dados do pedido, sem executar HTML',()=>{const x=config();x.empresa.razao_social='$& <script>';const texto=c.preencherTexto(x,admin.exemploPedido(3));assert.ok(texto.includes('$& <script>'));assert.ok(texto.includes('versão 3'));assert.ok(!texto.includes('{{'));});
test('PDF válido com acentos, paginação e palavras extensas sem estourar largura',async()=>{const texto=c.preencherTexto(config(),admin.exemploPedido(2))+'\n'+('A'.repeat(1000)+'\n').repeat(5);const b=await c.gerarPdfContrato(texto);assert.equal(b.subarray(0,5).toString(),'%PDF-');const p=await PDFDocument.load(b);assert.ok(p.getPageCount()>1);assert.equal(c.hashPdf(new Uint8Array(b)).length,64);});
test('rejeita caractere incompatível e excesso de páginas explicitamente',async()=>{await assert.rejects(()=>c.gerarPdfContrato('teste ⚽'),/caractere/);await assert.rejects(()=>c.gerarPdfContrato(('x\n').repeat(3000)),/35 páginas/);});
test('salvar rascunho não publica; grava autoria e revisão',async()=>{const {db,docs}=dbFake();const r=await invoke(db,'contrato_config_salvar',{configuracao:config(),revisao:0});assert.equal(r.code,200);assert.equal(docs.has(modelo.MODELO_DOC),false);assert.equal(docs.get(c.CONFIG_CONTRATO_DOC).atualizadoPor,'admin-teste');assert.equal(r.body.revisao,1);});
test('revisão antiga recebe 409 sem sobrescrever dados',async()=>{const {db,docs}=dbFake();await invoke(db,'contrato_config_salvar',{configuracao:config(),revisao:0});const x=config();x.empresa.razao_social='Não sobrescrever';const r=await invoke(db,'contrato_config_salvar',{configuracao:x,revisao:0});assert.equal(r.code,409);assert.notEqual(docs.get(c.CONFIG_CONTRATO_DOC).rascunho.empresa.razao_social,x.empresa.razao_social);});
test('prévia não grava nem sobe arquivo; publicação exige confirmação',async()=>{const {db,docs}=dbFake();const antes=uploads.length;const r=await invoke(db,'contrato_config_previa',{configuracao:config()});assert.equal(r.code,200);assert.ok(r.body.pdf.startsWith('JVBER'));assert.equal(docs.size,0);assert.equal(uploads.length,antes);assert.equal((await invoke(db,'contrato_config_publicar',{configuracao:config(),revisao:0})).code,400);});
test('publicação cria versão privada e conserva anteriores',async()=>{const {db,docs}=dbFake();for(let i=0;i<2;i++){const r=await invoke(db,'contrato_config_publicar',{configuracao:config(),revisao:i,revisado:true});assert.equal(r.code,200);assert.equal(r.body.versao,i+1);}assert.ok(docs.has('adsContratoVersoes/1'));assert.ok(docs.has('adsContratoVersoes/2'));assert.equal(docs.get(modelo.MODELO_DOC).configuracao.empresa.razao_social,'Tugyn Serviços Ltda');assert.equal(uploads.at(-1).options.type,'authenticated');});
test('duas publicações simultâneas: uma vence e outra é recusada, upload órfão removido',async()=>{const {db,docs}=dbFake();const rs=await Promise.all([invoke(db,'contrato_config_publicar',{configuracao:config(),revisao:0,revisado:true}),invoke(db,'contrato_config_publicar',{configuracao:config(),revisao:0,revisado:true})]);assert.deepEqual(rs.map(r=>r.code).sort(),[200,409]);assert.equal(docs.get(modelo.MODELO_DOC).versao,1);assert.ok(removidos.length>0);});
test('cliente recebe PDF preenchido uma vez e mantém hash após publicação nova',async()=>{const {db,docs}=dbFake();await invoke(db,'contrato_config_publicar',{configuracao:config(),revisao:0,revisado:true});const d=contrato();docs.set('contratos/teste',d);const ref=db.doc('contratos/teste'),configGeral=require('../api/_lib/contratoCore.ts').configPadrao();const contexto=()=>({db,res:response(),body:{},agora:Date.now(),encontrado:{ref,data:contratos.parseContrato(docs.get(ref.key))},config:configGeral,ipHash:'ip_teste'});const antes=uploads.length;const a=contexto();await fase.clientePdf(a);assert.equal(a.res.code,200);const congelado=docs.get(ref.key).documentoContrato;assert.equal(congelado.preenchivel,true);assert.equal(uploads.length,antes+1);const b=contexto();await fase.clientePdf(b);assert.equal(uploads.length,antes+1);const aceite=contexto();aceite.body={aceito:true,sha256:congelado.sha256};await fase.clienteAceitarContrato(aceite);assert.equal(aceite.res.code,200);assert.equal(docs.get(ref.key).aceite.sha256,congelado.sha256);await invoke(db,'contrato_config_publicar',{configuracao:config(),revisao:1,revisado:true});const m=await admin.modeloDoCliente(db,contratos.parseContrato(docs.get(ref.key)));assert.equal(m.versao,1);assert.equal(m.sha256,congelado.sha256);});
test('aceite sem abrir PDF não é permitido',async()=>{const {db,docs}=dbFake();const d=contrato();docs.set('contratos/t',d);const ctx={db,res:response(),body:{aceito:true},agora:Date.now(),encontrado:{ref:db.doc('contratos/t'),data:d},config:require('../api/_lib/contratoCore.ts').configPadrao(),ipHash:'ip_teste'};await fase.clienteAceitarContrato(ctx);assert.equal(ctx.res.code,409);assert.equal(docs.get('contratos/t').aceite,null);});
test('modelo legado aceito é encontrado no arquivo sem exigir versão atual',async()=>{const {db}=dbFake({[modelo.MODELO_DOC]:{versao:25,nome:'novo.pdf',publicId:'novo',bytes:1,sha256:'a'.repeat(64),enviadoEm:1,anteriores:[]},'adsContratoVersoes/1':{versao:1,nome:'antigo.pdf',publicId:'antigo',bytes:1,sha256:'b'.repeat(64),enviadoEm:1}});const d=contrato();d.aceite={versao:1};assert.equal((await admin.modeloDoCliente(db,d)).publicId,'antigo');});

test('aceite com hash de outro documento é recusado',async()=>{const {db,docs}=dbFake();const d=contrato();d.documentoContrato={versao:1,nome:'contrato.pdf',publicId:'pdf',sha256:'a'.repeat(64),bytes:100,enviadoEm:1,preenchivel:true};d.pdfSolicitado={versao:1,em:1};docs.set('contratos/t',d);const ctx={db,res:response(),body:{aceito:true,sha256:'b'.repeat(64)},agora:Date.now(),encontrado:{ref:db.doc('contratos/t'),data:d},config:require('../api/_lib/contratoCore.ts').configPadrao(),ipHash:'ip_teste'};await fase.clienteAceitarContrato(ctx);assert.equal(ctx.res.code,409);assert.equal(docs.get('contratos/t').aceite,null);});
test('rotas administrativas de configuração rejeitam anônimo e não-admin antes de acessar banco',async()=>{const auth=require('../api/_lib/auth.ts');const original=auth.requireUser;const handler=require('../api/contratos.ts').default;try{for(const acao of ['contrato_config_ver','contrato_config_salvar','contrato_config_previa','contrato_config_publicar']){const anon=response();anon.setHeader=()=>anon;auth.requireUser=async(_req,res)=>{res.status(401).json({error:'Login obrigatório'});return null;};await handler({method:'POST',headers:{},body:{action:acao}},anon);assert.equal(anon.code,401);const naoAdmin=response();naoAdmin.setHeader=()=>naoAdmin;auth.requireUser=async()=>({uid:'comum',admin:false});await handler({method:'POST',headers:{},body:{action:acao}},naoAdmin);assert.equal(naoAdmin.code,403);}}finally{auth.requireUser=original;}});

test('admin abre a cópia preenchida aceita, não o PDF genérico da versão',async()=>{const d=contrato();d.documentoContrato={versao:1,nome:'preenchido.pdf',publicId:'privado-cliente',sha256:'b'.repeat(64),bytes:100,enviadoEm:1,preenchivel:true};d.aceite={versao:1,sha256:'b'.repeat(64)};const {db}=dbFake({'contratos/abcdefghij':d,[modelo.MODELO_DOC]:{versao:1,nome:'exemplo.pdf',publicId:'generico',bytes:100,sha256:'a'.repeat(64),enviadoEm:1,anteriores:[]}});const r=response();await fase.adminModeloUrl(db,{contratoId:'abcdefghij',versao:1},Date.now(),r);assert.equal(r.code,200);assert.ok(r.body.url.includes('privado-cliente'));});
test('pedido alterado conserva todos os dados do aceite anterior para arquivamento',()=>{const d=contrato();d.aceite={versao:1,sha256:'a'.repeat(64),aceitoEm:Date.now()};d.documentoContrato={versao:1,publicId:'privado'};const registro=admin.registroAceiteAnterior(d);assert.equal(registro.aceite.sha256,d.aceite.sha256);assert.equal(registro.documentoContrato.publicId,'privado');assert.equal(registro.preco.total,12345);assert.equal(admin.registroAceiteAnterior(contrato()),null);});

test('modelo inicial: disponibilização (sem impressões garantidas), interrupção relevante, alterações, métricas e aceite', async () => {
  const t = c.TEXTO_INICIAL;
  for (const trecho of ['Não constitui compra de quantidade determinada de impressões', 'Considera-se interrupção relevante', 'ALTERAÇÕES DO ANÚNCIO', 'filtragem de tráfego inválido', 'começa desmarcada', 'CPF/CNPJ', 'Antes do início da veiculação: {{cancelamento_antes}}']) {
    assert.ok(t.includes(trecho), trecho);
  }
  assert.equal(c.validarConfiguracao(config(), true).ok, true, 'o modelo novo continua válido');
  // Gera o PDF com o texto novo e as sugestões (só caracteres suportados pela fonte do PDF).
  const x = config(); Object.assign(x.politicas, c.SUGESTOES_POLITICAS);
  const b = await c.gerarPdfContrato(c.preencherTexto(x, admin.exemploPedido(1)));
  assert.equal(b.subarray(0, 5).toString(), '%PDF-');
});

test('sugestões das políticas não têm campos {{}} e não cobrem a nota fiscal', () => {
  for (const [k, v] of Object.entries(c.SUGESTOES_POLITICAS)) { assert.ok(!v.includes('{{'), k); assert.ok(v.length <= 2000, k); }
  assert.equal(c.SUGESTOES_POLITICAS.nota_fiscal, undefined);
  assert.equal(c.configuracaoInicial().politicas.cancelamento_antes, '', 'nada é preenchido sozinho');
});

test('identificação: aceita CPF (pessoa física) ou CNPJ; recusa outros tamanhos', () => {
  for (const [doc, ok] of [['123.456.789-09', true], ['12.ABC.345/01DE-35', true], ['00.000.000/0001-00', true], ['1234567890', false], ['123456789012', false]]) {
    const x = config(); x.empresa.cnpj = doc;
    assert.equal(c.validarConfiguracao(x, true).ok, ok, doc);
  }
});

// ── Logo do contrato (PNG sem fundo) ──
const zlib = require('node:zlib');
function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(tipo, dados) { const t = Buffer.from(tipo, 'ascii'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(dados.length); crc.writeUInt32BE(crc32(Buffer.concat([t, dados]))); return Buffer.concat([len, t, dados, crc]); }
function png(largura, altura, colorType = 6) {
  const canais = colorType === 6 ? 4 : 3, ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const linha = Buffer.alloc(1 + largura * canais); for (let x = 0; x < largura; x++) { linha[1 + x * canais] = 254; linha[2 + x * canais] = 117; linha[3 + x * canais] = 82; if (canais === 4) linha[4 + x * canais] = x % 2 ? 255 : 0; }
  const bruto = Buffer.concat(Array.from({ length: altura }, () => linha));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(bruto)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUri = b => 'data:image/png;base64,' + b.toString('base64');

test('logo: valida PNG, detecta transparência e recusa outros formatos ou tamanho excessivo', () => {
  const ok = c.validarLogoPng(dataUri(png(40, 20)));
  assert.equal(ok.ok, true); assert.equal(ok.transparente, true); assert.equal(ok.largura, 40); assert.equal(ok.altura, 20); assert.equal(ok.sha256.length, 64);
  assert.equal(c.validarLogoPng(dataUri(png(40, 20, 2))).transparente, false, 'RGB sem canal alfa: com fundo');
  assert.equal(c.validarLogoPng('data:image/jpeg;base64,' + Buffer.from('nao e png').toString('base64')).ok, false);
  assert.equal(c.validarLogoPng(dataUri(Buffer.from('nao e png'))).ok, false);
  assert.equal(c.validarLogoPng(dataUri(png(2500, 1))).ok, false, 'dimensão máxima');
  assert.equal(c.validarLogoPng(dataUri(Buffer.concat([png(10, 10), Buffer.alloc(c.LOGO_MAX_BYTES)]))).ok, false, 'tamanho máximo');
  assert.equal(c.validarLogoPng(123).ok, false);
});

test('logo: aparece só no topo da 1ª página do PDF (demais páginas com cabeçalho pequeno)', async () => {
  const texto = c.preencherTexto(config(), admin.exemploPedido(1)) + '\n' + ('linha\n').repeat(200);
  const comLogo = await c.gerarPdfContrato(texto, png(300, 100));
  const p = await PDFDocument.load(comLogo);
  assert.ok(p.getPageCount() > 1);
  const semLogo = await c.gerarPdfContrato(texto);
  assert.ok(comLogo.length > semLogo.length, 'a imagem foi embutida');
});

test('logo: envio guarda por hash; prévia e publicação usam a logo; versão publicada preserva a logo', async () => {
  const { db, docs } = dbFake();
  const imagem = png(120, 40);
  const env = await invoke(db, 'contrato_config_logo', { png: dataUri(imagem) });
  assert.equal(env.code, 200); assert.equal(env.body.transparente, true);
  const sha = env.body.logo;
  assert.ok(docs.has(c.COLECAO_LOGOS + '/' + sha));
  const x = config(); x.logo = sha;
  const previa = await invoke(db, 'contrato_config_previa', { configuracao: x });
  assert.equal(previa.code, 200);
  const pub = await invoke(db, 'contrato_config_publicar', { configuracao: x, revisao: 0, revisado: true });
  assert.equal(pub.code, 200);
  assert.equal(docs.get(modelo.MODELO_DOC).configuracao.logo, sha);
  assert.equal(docs.get('adsContratoVersoes/1').configuracao.logo, sha);
  // Nova logo no rascunho não altera a versão 1 nem apaga a logo antiga.
  const outra = await invoke(db, 'contrato_config_logo', { png: dataUri(png(80, 30)) });
  assert.notEqual(outra.body.logo, sha);
  assert.ok(docs.has(c.COLECAO_LOGOS + '/' + sha));
  assert.equal(docs.get('adsContratoVersoes/1').configuracao.logo, sha);
  // A tela recebe a logo do rascunho para mostrar.
  await invoke(db, 'contrato_config_salvar', { configuracao: { ...x, logo: outra.body.logo }, revisao: 1 });
  const ver = await invoke(db, 'contrato_config_ver');
  assert.equal(ver.body.configuracao.logo, outra.body.logo);
  assert.ok(ver.body.logoPng.startsWith('data:image/png;base64,'));
});

test('logo: hash inexistente bloqueia prévia/publicação; arquivo inválido é recusado', async () => {
  const { db } = dbFake();
  const x = config(); x.logo = 'c'.repeat(64);
  const previa = await invoke(db, 'contrato_config_previa', { configuracao: x });
  assert.equal(previa.code, 400); assert.match(previa.body.error, /logo/);
  assert.equal((await invoke(db, 'contrato_config_publicar', { configuracao: x, revisao: 0, revisado: true })).code, 400);
  assert.equal((await invoke(db, 'contrato_config_logo', { png: 'data:image/png;base64,AAAA' })).code, 400);
  const semLogo = config(); delete semLogo.logo;
  assert.equal(c.validarConfiguracao(semLogo, true).ok, true, 'configurações antigas sem logo continuam válidas');
  const ruim = config(); ruim.logo = 'xyz';
  assert.equal(c.validarConfiguracao(ruim).ok, false);
});
