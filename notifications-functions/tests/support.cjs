const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '..'), process.cwd()] }));
const root = path.resolve(__dirname, '../..');
const REMOVE = Symbol('delete');
const clone = value => value instanceof Date ? new Date(value) : Array.isArray(value) ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,clone(item)])) : value;
function fixture(sender) {
  const records = new Map(), logs = [], modules = new Map(), calls = [];
  let clock = Date.UTC(2026,9,30,15), fail = () => false;
  function ref(key) { return { id:key.split('/').at(-1), path:key, get:async()=>snapshot(key), delete:async()=>records.delete(key) }; }
  function snapshot(key) { const data=clone(records.get(key)?.data); return { exists:!!data, ref:ref(key), id:ref(key).id, data:()=>clone(data), get:field=>data?.[field] }; }
  function put(key,data,merge=false) {
    const previous=records.get(key), next=merge ? {...previous?.data} : {};
    for(const [field,value] of Object.entries(data)) { if(value===REMOVE) delete next[field]; else next[field]=clone(value); }
    records.set(key,{data:next,version:(previous?.version??0)+1});
  }
  const db={
    doc:ref,
    async runTransaction(callback) {
      for(let attempt=0;attempt<100;attempt++) {
        const reads=new Map(), writes=[];
        const result=await callback({ get:async doc=>{reads.set(doc.path,records.get(doc.path)?.version??0);return snapshot(doc.path);}, set:(doc,data)=>writes.push([doc.path,data,false]), update:(doc,data)=>writes.push([doc.path,data,true]), delete:doc=>writes.push([doc.path,REMOVE,false]) });
        if([...reads].some(([key,version])=>(records.get(key)?.version??0)!==version))continue;
        if(fail(writes))throw Error('simulated commit failure');
        for(const [key,data,merge] of writes) { if(data===REMOVE) records.delete(key); else put(key,data,merge); }
        return result;
      }
      throw Error('transaction contention');
    },
    collection(name) {
      const filters=[]; let maximum=Infinity,order;
      const query={ where(field,op,value){filters.push([field,op,value]);return query;},orderBy(field){order=field;return query;},limit(value){maximum=value;return query;},async get(){
        let keys=[...records.keys()].filter(key=>key.startsWith(name+'/'));
        keys=keys.filter(key=>filters.every(([field,op,value])=>{const actual=records.get(key).data[field];return op==='in'?value.includes(actual):op==='=='?actual===value:typeof actual==='number'&&actual<=value;}));
        if(order)keys.sort((a,b)=>records.get(a).data[order]-records.get(b).data[order]);
        const docs=keys.slice(0,maximum).map(snapshot);return{docs,size:docs.length};
      }};return query;
    },
  };
  function load(file) {
    const filename=path.resolve(root,file);
    if(modules.has(filename))return modules.get(filename).exports;
    const module={exports:{}};modules.set(filename,module);
    const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    vm.runInNewContext(code,{module,exports:module.exports,Date,Buffer,process,AbortController,setTimeout,clearTimeout,fetch,console:{log:(...values)=>logs.push(values),warn:(...values)=>logs.push(values),error:(...values)=>logs.push(values)},require(name){
      if(name==='node:crypto')return require(name);
      if(name==='firebase-admin/firestore')return{FieldValue:{delete:()=>REMOVE}};
      if(name.startsWith('.'))return load(path.relative(root,path.resolve(path.dirname(filename),name+'.ts')));
      throw Error('Unexpected dependency '+name);
    }},{filename});
    return module.exports;
  }
  const push=load('api/_lib/push.ts');
  const consumer=load('api/_lib/pushEnvio.ts');
  const outbox=load('notifications-functions/src/outbox.ts');
  const events=load('notifications-functions/src/events.ts');
  const options={now:()=>clock,send:async messages=>{
    calls.push(messages.map(message=>({...message})));
    return sender?sender(messages,calls.length):messages.map(message=>({token:message.to,ok:true,invalid:false}));
  }};
  return {db,push,consumer,outbox,events,options,calls,logs,put,get:key=>clone(records.get(key)?.data),fail:callback=>{fail=callback;},advance:ms=>{clock+=ms;},token:(token,uid)=>put('pushTokens/'+push.tokenDocId(token),{token,uid,updatedAt:clock})};
}
module.exports={fixture};
