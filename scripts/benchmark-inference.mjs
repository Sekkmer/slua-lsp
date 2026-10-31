import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url),root=process.cwd();
const folder=process.env.SLUA_INFERENCE_PERF_CORE??path.join(root,'slua-lsp-core/out');
const {analyzeSourceProject}=require(path.join(folder,'workspace/analyzeSourceProject.js'));
const {parseSlua}=require(path.join(folder,'parser/parseSlua.js'));
const {inferValueExports}=require(path.join(folder,'typing/inferLocals.js'));
const {buildSluaRegistryFromLslDefinitions}=require(path.join(folder,'slua/registry.js'));
const {sluaTypeToString}=require(path.join(folder,'slua/types.js'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const label=process.argv[2]??'inference';assert.match(label,/^[a-zA-Z0-9-]{1,128}$/);assert.equal(typeof global.gc,'function','Run with node --expose-gc');
const registry=buildSluaRegistryFromLslDefinitions(null),rows=[];
const verify=(type,count)=>{assert.equal(type.kind,'table');assert.equal(Object.keys(type.fields).length,count*2);for(let i=0;i<count;i++){assert.deepEqual(type.fields['value'+i],{kind:'primitive',name:'number'});assert.equal(sluaTypeToString(type.fields['get'+i]),'() -> number');}return hash(JSON.stringify(Object.entries(type.fields).map(([name,type])=>[name,sluaTypeToString(type)])));};
for(const count of [25,50,100,200,400])for(const annotated of [true,false]){
 const source=Array.from({length:count},(_,i)=>`export local value${i}=${i}\nexport function get${i}()${annotated?': number':''} return value${i} end`).join('\n');
 let parsed=parseSlua(source);assert.deepEqual(parsed.diagnostics,[]);const times=[],inference=[],cpu=[];let resultHash;
 global.gc();const before=process.memoryUsage().heapUsed;
 for(let repeat=0;repeat<3;repeat++){
  let start=performance.now(),usage=process.cpuUsage();let type=inferValueExports(parsed.ast,registry);inference.push(performance.now()-start);resultHash=verify(type,count);type=null;
  start=performance.now();let project=await analyzeSourceProject('/owned/main.luau',registry,{entryText:'local api=require("api")\nprint(api.value0,api.get0())',readFile:async file=>file==='/owned/api.luau'?source:undefined});times.push(performance.now()-start);const delta=process.cpuUsage(usage);cpu.push((delta.user+delta.system)/1000);assert.deepEqual(project.diagnostics,[]);assert.equal(verify(project.exports.get('/owned/api.luau'),count),resultHash);project=null;
 }
 parsed=null;global.gc();const retained=process.memoryUsage().heapUsed-before;assert.ok(retained<16*1024*1024);
 const median=a=>[...a].sort((x,y)=>x-y)[1];rows.push({count,annotated,exportedValues:count*2,bytes:Buffer.byteLength(source),sourceSha256:hash(source),resultHash,projectMs:times,inferenceMs:inference,projectMedianMs:median(times),inferenceMedianMs:median(inference),processCpuMs:cpu,retainedHeapBytes:retained});
}
const entry=path.join(folder,'typing/inferLocals.js'),inputs=[];
async function inventory(directory){for(const file of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const absolute=path.join(directory,file.name);if(file.isDirectory())await inventory(absolute);else if(file.isFile()&&/\.(?:js|json|yaml)$/.test(file.name)){const bytes=await fs.readFile(absolute);inputs.push({path:path.relative(folder,absolute),bytes:bytes.length,sha256:hash(bytes)});}}}
await inventory(folder);
const destination=process.env.SLUA_INFERENCE_PERF_EVIDENCE??path.join(root,'.local/performance',label+'.json');await fs.mkdir(path.dirname(destination),{recursive:true});
await fs.writeFile(destination,JSON.stringify({passed:true,label,node:process.version,executable:process.execPath,executableSha256:hash(await fs.readFile(process.execPath)),harnessSha256:hash(await fs.readFile(fileURLToPath(import.meta.url))),coreInputs:inputs,coreFolder:folder,inferenceEntry:entry,inferenceSha256:hash(await fs.readFile(entry)),rows,scope:'Exact owned exported-value fixtures, three fresh full project and pre-parsed inference observations per case. Native register limits are not tested. Shared CPU/JIT/GC variance, processCpu includes both measured operations and assertions; not route main-thread accounting. No code execution or arbitrary closure effects.'},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({label,evidence:destination,rows:rows.map(({count,annotated,inferenceMedianMs,projectMedianMs})=>({count,annotated,inferenceMedianMs,projectMedianMs}))}));
