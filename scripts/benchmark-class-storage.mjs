// Bounded declaration-heavy hierarchy storage, isolated children and exact baseline custody.
// Baseline is an explicitly supplied preserved core output, never rebuilt here.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),harness=fileURLToPath(import.meta.url);
const hash=(data)=>crypto.createHash('sha256').update(data).digest('hex');
function sourceFor(count){let source='open class Root public x: number end\n';for(let i=1;i<=count;i++)source+=`open class C${i} extends ${i===1?'Root':`C${i-1}`} public f${i}: number end\n`;return source+`local last=C${count}\nprint(last)`;}
function collect(){for(let i=0;i<3;i++)global.gc();}
if(process.argv[2]==='--worker'){
 assert.equal(typeof global.gc,'function');const core=path.resolve(process.argv[3]),count=Number(process.argv[4]);assert.ok([64,128,256,512,1024].includes(count));
 const api=await import(pathToFileURL(path.join(core,'index.js'))),{classType}=await import(pathToFileURL(path.join(core,'typing/classMembers.js'))),{sourceMemberOrigins}=await import(pathToFileURL(path.join(core,'slua/sourceOrigins.js')));
 const registry=api.buildSluaRegistryFromLslDefinitions(null),warm=sourceFor(16);api.inferLocalVariableTypes(api.parseSlua(warm).ast,registry);collect();const before=process.memoryUsage().heapUsed;
 const source=sourceFor(count);let start=performance.now();const parsed=api.parseSlua(source);assert.deepEqual(parsed.diagnostics,[]);const parseMs=performance.now()-start;
 start=performance.now();const locals=api.inferLocalVariableTypes(parsed.ast,registry);const inferenceMs=performance.now()-start;
 const info=classType(locals.find(x=>x.name==='last').type).info;assert.equal(info.fields.size,count+1);assert.equal(info.fields.get('x').name,'number');assert.equal(info.fields.get('f'+count).name,'number');assert.equal(sourceMemberOrigins(info.instanceType).get('x').node.location.start.line,1);
 collect();const retainedHeapBytes=process.memoryUsage().heapUsed-before;
 // Request one leaf constructor shape and member list after measuring declarations.
 const display=api.sluaTypeToString(info.constructorType);assert.ok(display.includes(`C${count}`));const keys=[...info.fields.keys()];assert.equal(keys[0],'x');assert.equal(keys.at(-1),'f'+count);assert.equal(keys.length,count+1);
 console.log(JSON.stringify({count,sourceBytes:Buffer.byteLength(source),sourceSha256:hash(source),parseMs,inferenceMs,retainedHeapBytes,fields:keys.length,leafDisplaySha256:hash(display)}));
}else{
 const label=process.argv[2]??'class-storage';assert.match(label,/^[A-Za-z0-9_-]{1,128}$/);
 const baseline=process.env.SLUA_CLASS_STORAGE_BASELINE;assert.ok(baseline,'Set SLUA_CLASS_STORAGE_BASELINE to a preserved prior core output');
 const current=path.join(root,'slua-lsp-core/out');assert.notEqual(path.resolve(baseline),current);
 const destination=path.join(root,'.local/performance',label+'.json');await fs.mkdir(path.dirname(destination),{recursive:true});const handle=await fs.open(destination,'wx');
 const report={passed:false,releaseAcceptance:false,at:new Date().toISOString(),node:process.version,executable:process.execPath,executableSha256:hash(await fs.readFile(process.execPath)),harnessSha256:hash(await fs.readFile(harness)),scope:'Three isolated samples per preserved/current core and64/128/256/512/1024declaration-heavy hierarchy. Forced-GC live graph, one leaf shape and insertion order/origin checks. No native-large-program execution, universal latency, whole-server linearity or full release acceptance claim.',inputs:{},rows:[]};
 async function inputs(folder){const rows=[];async function walk(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&/\.(js|json|yaml)$/.test(entry.name))rows.push({path:path.relative(root,file),sha256:hash(await fs.readFile(file))});}}await walk(folder);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
 try{
  for(const [label,folder]of [['before',path.resolve(baseline)],['after',current]])report.inputs[label]=await inputs(folder);
  for(const count of [64,128,256,512,1024]){
   const row={count,before:[],after:[]};report.rows.push(row);
   for(let sample=0;sample<3;sample++)for(const [label,folder]of (sample%2?[['after',current],['before',path.resolve(baseline)]]:[['before',path.resolve(baseline)],['after',current]])){
    const child=spawnSync(process.execPath,['--expose-gc','--max-old-space-size=512',harness,'--worker',folder,String(count)],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);row[label].push(JSON.parse(child.stdout));
   }
   const all=[...row.before,...row.after];assert.ok(all.every(x=>x.sourceSha256===all[0].sourceSha256&&x.leafDisplaySha256===all[0].leafDisplaySha256));
   row.medians=Object.fromEntries(['before','after'].map(label=>[label,Object.fromEntries(['parseMs','inferenceMs','retainedHeapBytes'].map(key=>[key,row[label].map(x=>x[key]).sort((a,b)=>a-b)[1]]))]));
   assert.ok(row.medians.after.retainedHeapBytes<24*1024*1024);assert.ok(row.medians.after.inferenceMs<2000);
  }
  const largest=report.rows.at(-1);assert.ok(largest.medians.after.retainedHeapBytes<largest.medians.before.retainedHeapBytes/3,'The targeted storage improvement must be supported by observed paired data');report.passed=true;
 }finally{await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.close();}
 console.log(JSON.stringify({passed:report.passed,node:report.node,rows:report.rows.map(({count,medians})=>({count,medians})),evidence:destination}));
}
