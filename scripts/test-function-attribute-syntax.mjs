// Qualifies attribute syntax and preserved function bindings; deprecation lint is separate.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const destination=process.env.SLUA_ATTRIBUTES_EVIDENCE??path.join(root,'.local/logs/function-attribute-syntax.json');
const hash=(data)=>crypto.createHash('sha256').update(data).digest('hex');
const fileHash=async(file)=>hash(await fs.readFile(file));
await fs.mkdir(path.dirname(destination),{recursive:true});const output=await fs.open(destination,'wx');
const baseline=destination+'.observations-'+crypto.randomUUID()+'.json';
function run(args,input,env=process.env,timeout=30000){const p=spawnSync(process.execPath,args,{cwd:root,input,env,encoding:'utf8',timeout,maxBuffer:16*1024*1024});assert.ifError(p.error);assert.equal(p.signal,null);return{exit:p.status,stdout:p.stdout,stderr:p.stderr};}
let report={passed:false,syntaxProfilePassed:false,implementationAcceptance:false,releaseAcceptance:false},lsp;
try{
 const child=run(['scripts/research-function-attributes.mjs'],undefined,{...process.env,SLUA_ATTRIBUTES_EVIDENCE:baseline},500000);report.observationRun=child;assert.equal(child.exit,0,child.stderr);
 const bytes=await fs.readFile(baseline),data=JSON.parse(bytes);assert.equal(data.passed,true);
 report={...data,passed:false,syntaxProfilePassed:false,baseline:{path:baseline,sha256:hash(bytes)},qualificationHarnessSha256:await fileHash(fileURLToPath(import.meta.url)),inspection:[]};
 for(const row of report.cases){
  // DebugLuauNoInline is an explicit native experiment, not the ordinary source profile.
  const parseValid=row.expectedNative.syntax===0&&row.name!=='debugnoinline-enabled';
  const syntaxErrors=row.check.disk.data.diagnostics.filter((d)=>d.code==='parse-error');
  assert.equal(syntaxErrors.length===0,parseValid,row.name);
  assert.equal(row.symbols.disk.exit,parseValid?0:1,row.name+':symbols');
  assert.equal(row.preprocess.disk.exit,parseValid?0:1,row.name+':preprocess');
  if(parseValid){assert.ok(row.generated,row.name);assert.equal(row.generated.compile.exit,0,row.name);}
 }
 const folder=path.dirname(report.cases[0].file),file=path.join(folder,'navigation.luau');
 const literalsFile=path.join(root,'scripts/fixtures/function-attribute-literals.json');
 report.literalFixtureSha256=await fileHash(literalsFile);report.additional=[];
 const compile=path.join(process.env.SLUA_ORACLE_LOCAL??path.join(root,'.local'),'build/slua-oracle/slua-compile');
 report.additionalBinaries={'slua-compile':await fileHash(compile)};assert.equal(report.additionalBinaries['slua-compile'],report.build.binaries['slua-compile']);
 let literalReuse;
 if(process.env.SLUA_ATTRIBUTES_LITERAL_REUSE){const file=process.env.SLUA_ATTRIBUTES_LITERAL_REUSE,bytes=await fs.readFile(file);literalReuse=JSON.parse(bytes);assert.deepEqual(literalReuse.additionalBinaries??literalReuse.binaries,report.additionalBinaries);report.literalNativeReuse={path:file,sha256:hash(bytes)};}
 for(const item of JSON.parse(await fs.readFile(literalsFile,'utf8'))){
  const file=path.join(folder,'literal-'+item.name+'.luau');await fs.writeFile(file,item.source,{flag:'wx'});
  const row={...item,file,sourceSha256:hash(item.source),native:{}};report.additional.push(row);
  const prior=(literalReuse?.additional??literalReuse?.cases??[]).find((x)=>x.name===item.name&&x.sourceSha256===row.sourceSha256);
  if(prior){assert.equal(await fileHash(path.resolve(root,prior.file)),row.sourceSha256);row.native=structuredClone(prior.native);row.nativeReused=true;row.nativeInput=prior.file;}
  else for(const [name,args]of [['syntax',['--only-parse','--null']],['compile',['--null']]]){const p=spawnSync(compile,[...args,file],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});assert.ifError(p.error);assert.equal(p.signal,null);row.native[name]={exit:p.status,stdout:p.stdout,stderr:p.stderr};}
  assert.deepEqual(Object.fromEntries(Object.entries(row.native).map(([name,result])=>[name,result.exit])),item.expectedNative,item.name);
  const parseValid=item.expectedNative.syntax===0;
  for(const command of ['check','symbols','preprocess']){
   const agent=(input)=>{report.cliProcesses++;const p=run([report.cli,command,input===undefined?file:'-',...(input===undefined?[]:['--stdin-filepath',file]),'--json',...(command==='check'?['--warnings-as-errors']:[])],input);assert.equal(p.stderr,'');const data=JSON.parse(p.stdout);assert.equal(data.exitCode,p.exit);return{exit:p.exit,data};};
   row[command]={disk:agent(),stdin:agent(item.source)};assert.deepEqual(row[command].disk,row[command].stdin);
   if(command==='check')assert.equal(!row[command].disk.data.diagnostics.some((d)=>d.code==='parse-error'),parseValid,item.name);
   else assert.equal(row[command].disk.exit,parseValid?0:1,item.name+':'+command);
  }
  if(parseValid)assert.equal(row.preprocess.disk.data.content,item.source);
 }

 const source='@[native,checked]\nlocal function double(value: number): number return value*2 end\nlocal alias=double\nassert(alias(21)==42)\n';
 await fs.writeFile(file,source,{flag:'wx'});
 function agent(args,input){report.cliProcesses++;const p=run([report.cli,...args,'--json'],input);assert.equal(p.stderr,'');const data=JSON.parse(p.stdout);assert.equal(p.exit,data.exitCode);return{exit:p.exit,data};}
 const positions={hover:'3:9',definition:'2:14',references:'2:14',rename:'2:14'};
 for(const [command,position]of Object.entries(positions)){
  const extra=['--position',position,...(command==='rename'?['--new-name','twice']:[])];
  const disk=agent([command,file,...extra]),stdin=agent([command,'-','--stdin-filepath',file,...extra],source);assert.deepEqual(disk,stdin);assert.equal(disk.exit,0,command);
  if(command==='definition')assert.equal(disk.data.result.range.start.line,1);
  if(command==='hover')assert.match(disk.data.result.markdown,/number/);
  if(command==='references'||command==='rename')assert.equal(disk.data.result.length,2);
  report.inspection.push({command,disk,stdin});
 }
 lsp=launchServer(report.server,root);const uri=pathToFileURL(file).href;
 await lsp.request('initialize',{processId:process.pid,rootUri:pathToFileURL(folder).href,capabilities:{workspace:{workspaceEdit:{documentChanges:true}}}});lsp.notify('initialized',{});
 let version=0;
 async function change(text,expected){version++;const pending=lsp.notification('textDocument/publishDiagnostics',(p)=>p.uri===uri&&p.version===version);lsp.notify(version===1?'textDocument/didOpen':'textDocument/didChange',version===1?{textDocument:{uri,languageId:'luau',version,text}}:{textDocument:{uri,version},contentChanges:[{text}]});const diagnostics=(await pending).diagnostics;assert.deepEqual(diagnostics.map((d)=>d.code).sort(),expected);report.protocol.push({uri,version,sourceSha256:hash(text),diagnostics});}
 await change(source,[]);
 const request=(name,position,extra={})=>lsp.request('textDocument/'+name,{textDocument:{uri},position,...extra});
 const definition=await request('definition',{line:2,character:14});assert.equal(definition.range.start.line,1);
 const references=await request('references',{line:2,character:14},{context:{includeDeclaration:true}});assert.equal(references.length,2);
 const rename=await request('rename',{line:2,character:14},{newName:'twice'});assert.equal(rename.documentChanges[0].edits.length,2);assert.equal(rename.documentChanges[0].textDocument.version,1);
 const hover=await request('hover',{line:3,character:9});assert.match(hover.contents.value,/number/);
 const signature=await request('signatureHelp',{line:3,character:13});assert.equal(signature.signatures[0].parameters.length,1);
 const completion=await request('completion',{line:4,character:0});assert.ok((Array.isArray(completion)?completion:completion.items).some((item)=>item.label==='double'));
 report.protocol.push({definition,references,rename,hover,signature,completion});
 await change(source.replace('alias(21)','alias("bad")'),['call-argument-type-mismatch']);
 await change(source.replace('@[native,checked]','@unknown'),['parse-error']);
 for(const row of report.additional){const expected=row.check.disk.data.diagnostics.map((d)=>d.code).sort();await change(row.source,expected);}
 await change(source,[]);assert.deepEqual(await request('definition',{line:2,character:14}),definition);
 lsp.notify('textDocument/didClose',{textDocument:{uri}});
 report.scope='Ordinary attribute syntax matches 108 original plus 14 additional pinned native syntax programs; the DebugLuauNoInline enabled experiment remains explicitly unsupported. Parsed function bindings and file/stdin CLI navigation/rename and unsaved stdio aliases/signatures/diagnostics/recovery are qualified. Source deprecation warnings, attribute completion/hover/semantic presentation, packaged editor/GUI and broader release acceptance remain separate.';
 report.syntaxProfilePassed=true;report.passed=true;
}catch(error){report.error=error.stack??String(error);throw error;}
finally{if(lsp)await lsp.close();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();}
console.log(JSON.stringify({passed:report.passed,syntaxProfilePassed:report.syntaxProfilePassed,cases:report.cases.length,additional:report.additional.length,cliProcesses:report.cliProcesses,protocolRecords:report.protocol.length,evidence:destination}));
