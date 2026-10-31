// Bounded hierarchy scaling and generation-retention probe; not a universal performance claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSlua, buildSluaRegistryFromLslDefinitions, getCompletions, findDefinitionAtPosition, getRenameEdits } from '../slua-lsp-core/out/index.js';
import { analyzeTextWithDirectives } from '../slua-lsp-core/out/diagnostics/engine.js';
const root=fileURLToPath(new URL('../',import.meta.url)),label=process.argv[2]??'class-inheritance';
assert.match(label,/^[A-Za-z0-9_-]{1,128}$/);assert.equal(typeof global.gc,'function','Run node --expose-gc');
const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const local=process.env.SLUA_ORACLE_LOCAL??path.join(root,'.local'),bin=path.join(local,'build/slua-oracle');
const flag='--fflags=DebugLuauUserDefinedClasses=true';
await fs.mkdir(path.join(root,'.local/performance'),{recursive:true});const destination=path.join(root,'.local/performance',label+'.json'),output=await fs.open(destination,'wx');
await fs.mkdir(path.join(root,'.local/fixtures'),{recursive:true});const folder=await fs.mkdtemp(path.join(root,'.local/fixtures/inheritance-scaling-'));
const report={passed:false,releaseAcceptance:false,scope:'8/16/32/64-known-class hierarchy parsing/diagnostics/completion/definition/lexical rename, separate native syntax/compile/strict/purelocal runtime and six discarded analysis generations. Flattened member maps can use quadratic total storage; these bounded observations do not prove arbitrary hierarchy linearity or full performance acceptance.',node:process.version,executable:process.execPath,executableSha256:hash(await fs.readFile(process.execPath)),harnessSha256:hash(await fs.readFile(fileURLToPath(import.meta.url))),inputs:[],rows:[]};
function run(exe,args){const p=spawnSync(exe,args,{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});assert.ifError(p.error);assert.equal(p.signal,null);return{exit:p.status,stdout:p.stdout,stderr:p.stderr};}
function sourceFor(count){let source='open class Root\npublic x: number\nfunction get(self): number return self.x end\nend\n';for(let i=1;i<=count;i++)source+=`open class C${i} extends ${i===1?'Root':`C${i-1}`}\npublic f${i}: number\nend\n`;return source+`local value=C${count}{x=42,`+Array.from({length:count},(_,i)=>`f${i+1}=${i+1}`).join(',')+'}\nassert(value:get()==42)';}
function position(source,offset){const parts=source.slice(0,offset).split('\n');return{line:parts.length-1,character:parts.at(-1).length};}
const registry=buildSluaRegistryFromLslDefinitions(null);
function measure(source,count){const timings={};let t=performance.now();const parsed=parseSlua(source);timings.parseMs=performance.now()-t;assert.deepEqual(parsed.diagnostics,[]);
 t=performance.now();assert.deepEqual(analyzeTextWithDirectives(source,{ast:parsed.ast,registry}),[]);timings.analysisMs=performance.now()-t;
 const completionSource=source+'\nvalue.',completionAst=parseSlua(completionSource).ast;
 t=performance.now();const completion=getCompletions(completionAst,position(completionSource,completionSource.length),registry,{sourceText:completionSource});timings.completionMs=performance.now()-t;assert.equal(completion.length,count+2);
 t=performance.now();const definition=findDefinitionAtPosition(parsed.ast,position(source,source.lastIndexOf('value:get')+7),registry);timings.definitionMs=performance.now()-t;assert.equal(definition?.identifier.location.start.line,3);
 t=performance.now();const rename=getRenameEdits(parsed.ast,{line:0,character:12},'Origin',registry);timings.renameMs=performance.now()-t;assert.equal(rename.length,2);assert.ok(timings.analysisMs<2000);return timings;}
try{
 const check=run('python3',['scripts/prepare-oracle.py','--local-dir',local,'--check']);assert.equal(check.exit,0);report.sourceVerification=JSON.parse(check.stdout);report.build=JSON.parse(await fs.readFile(path.join(bin,'oracle-build.json'),'utf8'));assert.equal(report.sourceVerification.contentSha256,report.build.inputs.sourceContentSha256);
 for(const name of ['slua','slua-compile','slua-analyze'])assert.equal(hash(await fs.readFile(path.join(bin,name))),report.build.binaries[name]);
 async function walk(folder){for(const entry of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&/\.(js|json|yaml)$/.test(entry.name))report.inputs.push({path:path.relative(root,file),sha256:hash(await fs.readFile(file))});}}
 await walk(path.join(root,'slua-lsp-core/out'));
 measure(sourceFor(8),8);global.gc();const before=process.memoryUsage().heapUsed;
 for(const count of [8,16,32,64]){const source=sourceFor(count),file=path.join(folder,'hierarchy-'+count+'.luau');await fs.writeFile(file,source,{flag:'wx'});const row={count,file,sourceSha256:hash(source),samples:[]};report.rows.push(row);
  row.native={syntax:run(path.join(bin,'slua-compile'),['--only-parse','--null',flag,file]),compile:run(path.join(bin,'slua-compile'),['--null',flag,file]),strict:run(path.join(bin,'slua-analyze'),['--mode=strict','--formatter=gnu','-j1',flag,file]),execution:run(path.join(bin,'slua'),['--sl',flag+',DebugLuauUserDefinedClassesRuntime=true',file])};for(const x of Object.values(row.native))assert.equal(x.exit,0);
  for(let i=0;i<3;i++)row.samples.push(measure(source,count));row.medians=Object.fromEntries(Object.keys(row.samples[0]).map((k)=>[k,row.samples.map((x)=>x[k]).sort((a,b)=>a-b)[1]]));
 }
 for(let i=0;i<6;i++)measure(sourceFor(8)+'\n-- generation '+i,8);
 global.gc();report.retainedHeapBytes=process.memoryUsage().heapUsed-before;assert.ok(report.retainedHeapBytes<16*1024*1024);report.passed=true;
}finally{await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();}
console.log(JSON.stringify({passed:report.passed,rows:report.rows.map(({count,medians})=>({count,medians})),retainedHeapBytes:report.retainedHeapBytes,evidence:destination}));
