// Native-reviewed source deprecation, attribute presentation and agent/editor parity.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const cli=process.env.SLUA_FUNCTION_METADATA_CLI??path.join(root,'slua-lsp-cli/out/index.js');
const server=process.env.SLUA_FUNCTION_METADATA_SERVER??path.join(root,'slua-lsp-server/out/index.js');
const local=process.env.SLUA_ORACLE_LOCAL??path.join(root,'.local'),bin=path.join(local,'build/slua-oracle');
const destination=process.env.SLUA_FUNCTION_METADATA_EVIDENCE??path.join(root,'.local/logs/function-metadata.json');
const fixture=path.join(root,'scripts/fixtures/function-metadata.json');
const hash=(data)=>crypto.createHash('sha256').update(data).digest('hex');const fileHash=async(file)=>hash(await fs.readFile(file));
await fs.mkdir(path.dirname(destination),{recursive:true});const output=await fs.open(destination,'wx');
await fs.mkdir(path.join(root,'.local/fixtures'),{recursive:true});const folder=await fs.mkdtemp(path.join(root,'.local/fixtures/function-metadata-'));
const report={passed:false,profileChecksPassed:false,releaseAcceptance:false,implementationAcceptance:false,node:process.version,executable:process.execPath,executableSha256:await fileHash(process.execPath),cli,cliSha256:await fileHash(cli),server,serverSha256:await fileHash(server),harnessSha256:await fileHash(fileURLToPath(import.meta.url)),fixtureSha256:await fileHash(fixture),flags:[],cases:[],protocol:[],inspection:[],cliProcesses:0};
function run(exe,args,input){const p=spawnSync(exe,args,{cwd:root,input,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});assert.ifError(p.error);assert.equal(p.signal,null);return{exit:p.status,stdout:p.stdout,stderr:p.stderr};}
function agent(command,file,input,extra=[]){report.cliProcesses++;const p=run(process.execPath,[cli,command,input===undefined?file:'-',...(input===undefined?[]:['--stdin-filepath',file]),...extra,'--json'],input);assert.equal(p.stderr,'');const data=JSON.parse(p.stdout);assert.equal(data.exitCode,p.exit);return{exit:p.exit,data};}
const nativeWarnings=(row)=>[...(row.stdout+row.stderr).matchAll(/:(\d+)\.(\d+)-(\d+)\.(\d+): DeprecatedApi: ([^\n]*)/g)].map((m)=>({message:m[5],range:{start:{line:Number(m[1])-1,character:Number(m[2])-1},end:{line:Number(m[3])-1,character:Number(m[4])}}}));
let lsp;
try{
 const preparation=run('python3',['scripts/prepare-oracle.py','--local-dir',local,'--check']);assert.equal(preparation.exit,0);report.sourceVerification=JSON.parse(preparation.stdout);
 report.build=JSON.parse(await fs.readFile(path.join(bin,'oracle-build.json'),'utf8'));assert.equal(report.sourceVerification.contentSha256,report.build.inputs.sourceContentSha256);
 for(const [name,expected]of Object.entries(report.build.binaries))assert.equal(await fileHash(path.join(bin,name)),expected);
 let prior;
 if(process.env.SLUA_FUNCTION_METADATA_NATIVE_REUSE){const file=process.env.SLUA_FUNCTION_METADATA_NATIVE_REUSE,bytes=await fs.readFile(file);prior=JSON.parse(bytes);assert.equal(prior.build.inputSha256,report.build.inputSha256);assert.deepEqual(prior.build.binaries,report.build.binaries);assert.deepEqual(prior.flags,[]);report.nativeReuse={path:file,sha256:hash(bytes)};}
 for(const item of JSON.parse(await fs.readFile(fixture,'utf8'))){
  assert.match(item.name,/^[A-Za-z0-9_-]+$/);const file=path.join(folder,item.name+'.luau');await fs.writeFile(file,item.source,{flag:'wx'});
  const row={...item,file,sourceSha256:hash(item.source),native:{}};report.cases.push(row);
  const old=prior?.cases.find((p)=>p.name===item.name&&p.sourceSha256===row.sourceSha256);
  if(old){assert.equal(await fileHash(path.resolve(root,old.file)),row.sourceSha256);row.native=structuredClone(old.native);row.nativeReused=true;row.nativeInput=old.file;}
  else for(const [mode,exe,args]of [['syntax','slua-compile',['--only-parse','--null']],['compile','slua-compile',['--null']],['strict','slua-analyze',['--mode=strict','--formatter=gnu','-j1']]])row.native[mode]=run(path.join(bin,exe),[...args,file]);
  assert.deepEqual(Object.fromEntries(Object.entries(row.native).map(([name,p])=>[name,p.exit])),item.expectedNative,item.name);assert.deepEqual(nativeWarnings(row.native.strict),item.deprecations,item.name);
  for(const command of ['check','symbols','preprocess']){row[command]={disk:agent(command,file),stdin:agent(command,file,item.source)};assert.deepEqual(row[command].disk,row[command].stdin,item.name+':'+command);}
  row.strictCheck={disk:agent('check',file,undefined,['--warnings-as-errors']),stdin:agent('check',file,item.source,['--warnings-as-errors'])};assert.deepEqual(row.strictCheck.disk,row.strictCheck.stdin);
  const valid=item.expectedNative.syntax===0;assert.equal(!row.check.disk.data.diagnostics.some((d)=>d.code==='parse-error'),valid,item.name);
  if(valid){const diagnostics=row.check.disk.data.diagnostics;assert.deepEqual(diagnostics.map(({message,range})=>({message,range})),item.deprecations,item.name);assert.ok(diagnostics.every((d)=>d.code==='deprecated-function'&&d.severity==='warning'&&d.tags?.includes('deprecated')));assert.equal(row.check.disk.exit,0);assert.equal(row.strictCheck.disk.exit,item.deprecations.length?1:0);assert.equal(row.preprocess.disk.data.content,item.source);}
  assert.equal(row.symbols.disk.exit,valid?0:1);assert.equal(row.preprocess.disk.exit,valid?0:1);
 }
 lsp=launchServer(server,root);const file=path.join(folder,'unsaved.luau'),uri=pathToFileURL(file).href;
 await lsp.request('initialize',{processId:process.pid,rootUri:pathToFileURL(folder).href,capabilities:{workspace:{workspaceEdit:{documentChanges:true}}}});lsp.notify('initialized',{});
 const versions=new Map();
 async function change(uri,text,expected){const version=(versions.get(uri)??0)+1;versions.set(uri,version);const pending=lsp.notification('textDocument/publishDiagnostics',(p)=>p.uri===uri&&p.version===version);lsp.notify(version===1?'textDocument/didOpen':'textDocument/didChange',version===1?{textDocument:{uri,languageId:'luau',version,text}}:{textDocument:{uri,version},contentChanges:[{text}]});const diagnostics=(await pending).diagnostics;assert.deepEqual(diagnostics.map((d)=>d.code).sort(),expected);report.protocol.push({uri,version,sourceSha256:hash(text),diagnostics});return diagnostics;}
 for(const row of report.cases){const actual=await change(uri,row.source,row.check.disk.data.diagnostics.map((d)=>d.code).sort());if(row.expectedNative.syntax===0){assert.deepEqual(actual.map(({message,range})=>({message,range})),row.deprecations,row.name);assert.ok(actual.every((d)=>d.tags?.includes(2)));}}
 const source='@[deprecated{use="fresh",reason="old API"}]\nlocal function old(n: number): number if n==0 then return 42 end return old(n-1) end\nlocal alias=old\nprint(alias(2))\n';await fs.writeFile(file,source,{flag:'wx'});
 for(const [command,position]of [['hover','3:8'],['hover','0:5'],['definition','2:13'],['references','2:13'],['rename','2:13']]){const extra=['--position',position,...(command==='rename'?['--new-name','priorApi']:[])];const disk=agent(command,file,undefined,extra),stdin=agent(command,file,source,extra);assert.deepEqual(disk,stdin);assert.equal(disk.exit,0,command);if(command==='hover')assert.match(disk.data.result.markdown,position==='0:5'?/@deprecated/:/\*\*Deprecated\*\*/);report.inspection.push({command,position,disk,stdin});}
 const diagnostics=await change(uri,source,['deprecated-function','deprecated-function']);assert.deepEqual(diagnostics.map((d)=>d.range.start.line),[2,3]);
 const hover=await lsp.request('textDocument/hover',{textDocument:{uri},position:{line:3,character:8}});assert.match(hover.contents.value,/\*\*Deprecated\*\*/);
 const completion=await lsp.request('textDocument/completion',{textDocument:{uri},position:{line:4,character:0}});const items=Array.isArray(completion)?completion:completion.items;assert.ok(items.find((item)=>item.label==='alias')?.tags?.includes(1));
 const actions=await lsp.request('textDocument/codeAction',{textDocument:{uri},range:{start:{line:3,character:6},end:{line:3,character:11}},context:{diagnostics}});const suppress=actions.find((item)=>item.title==="Suppress 'deprecated-function' on this line");assert.ok(suppress);const edits=suppress.edit.documentChanges[0];assert.equal(edits.textDocument.version,versions.get(uri));assert.ok(suppress.diagnostics.every((d)=>d.tags?.includes(2)));report.protocol.push({hover,completion,suppress});
 const suppressed=source.split('\n');suppressed.splice(3,0,'-- slua-lsp:disable-next-line deprecated-function');await change(uri,suppressed.join('\n'),['deprecated-function']);await change(uri,source.slice(source.indexOf('\n')+1),[]);await change(uri,source,['deprecated-function','deprecated-function']);
 await change(uri,'@[',['parse-error']);const attrs=await lsp.request('textDocument/completion',{textDocument:{uri},position:{line:0,character:2}});assert.deepEqual((Array.isArray(attrs)?attrs:attrs.items).map((x)=>x.label).sort(),['checked','deprecated','native']);report.protocol.push({attributeCompletion:attrs});
 await change(uri,'@[native,checked] local function answer():number return 42 end\nprint(answer())',[]);const attrHover=await lsp.request('textDocument/hover',{textDocument:{uri},position:{line:0,character:4}});assert.match(attrHover.contents.value,/@native/);report.protocol.push({attributeHover:attrHover});
 const module=path.join(folder,'module.luau'),main=path.join(folder,'main.luau');const moduleText='@deprecated export function old(): number return 42 end';const mainText='local api=require("module")\nprint(api.old())';await fs.writeFile(module,moduleText,{flag:'wx'});await fs.writeFile(main,mainText,{flag:'wx'});const moduleUri=pathToFileURL(module).href,mainUri=pathToFileURL(main).href;
 await change(mainUri,mainText,['deprecated-function']);const memberHover=await lsp.request('textDocument/hover',{textDocument:{uri:mainUri},position:{line:1,character:11}});assert.match(memberHover.contents.value,/\*\*Deprecated\*\*/);report.protocol.push({memberHover});
 await change(moduleUri,moduleText.replace('@deprecated ',''),[]);await change(mainUri,mainText,[]);await change(moduleUri,moduleText,[]);await change(mainUri,mainText,['deprecated-function']);
 report.scope='32 owned native parse/compile/strict programs, exact deprecation messages/ranges, CLI file/stdin JSON/exits/warnings-as-errors/generation/inspection, stdio warning tags/hover/completions/suppression/recovery and unsaved exported-module metadata. Native metadata boundaries (annotated aliases, reassigned locals, named-property contracts, bracket access and distinct flow origins) are preserved. No native codegen/runtime-guard, FS IPC/world, full-solver, GUI or release acceptance.';report.profileChecksPassed=true;report.passed=true;
}catch(error){report.error=error.stack??String(error);throw error;}
finally{if(lsp)await lsp.close();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();}
console.log(JSON.stringify({passed:report.passed,profileChecksPassed:report.profileChecksPassed,cases:report.cases.length,cliProcesses:report.cliProcesses,protocolRecords:report.protocol.length,evidence:destination}));
