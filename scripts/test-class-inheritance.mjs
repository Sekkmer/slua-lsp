// Qualifies the reviewed known-source inheritance profile, preserving native differences.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.env.SLUA_INHERITANCE_EVIDENCE ?? path.join(root, '.local/logs/class-inheritance.json');
const fixture = path.join(root, 'scripts/fixtures/class-inheritance-support.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = async (file) => hash(await fs.readFile(file));
await fs.mkdir(path.dirname(destination), { recursive: true }); const output = await fs.open(destination, 'wx');
const baseline = destination + '.baseline-' + crypto.randomUUID() + '.json';
function run(exe, args, input, env = process.env, timeout = 30000) {
 const child = spawnSync(exe, args, { cwd: root, input, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
 assert.ifError(child.error); assert.equal(child.signal, null); return { exit: child.status, stdout: child.stdout, stderr: child.stderr };
}
let report = { passed: false, implementationAcceptance: false, releaseAcceptance: false, profileChecksPassed: false, additional: [], protocol: [] }, lsp;
try {
 const child = run(process.execPath, [path.join(root, 'scripts/research-class-inheritance.mjs')], undefined, { ...process.env, SLUA_INHERITANCE_EVIDENCE: baseline }, 500000);
 report.baselineRun = child; assert.equal(child.exit, 0, child.stderr);
 const bytes = await fs.readFile(baseline), data = JSON.parse(bytes); assert.equal(data.passed, true);
 report = { ...data, passed: false, baseline: { path: baseline, sha256: hash(bytes) }, qualificationHarnessSha256: await fileHash(fileURLToPath(import.meta.url)), expectationsSha256: await fileHash(fixture), profileChecksPassed: false, additional: [], inspection: [] };
 const expected = JSON.parse(await fs.readFile(fixture, 'utf8'));
 assert.equal(expected.cases.length, report.cases.length);
 for (const [i, item] of expected.cases.entries()) {
  const row = report.cases[i]; assert.equal(row.name, item.name);
  const diagnostics = row.check.disk.data.diagnostics;
  assert.equal(!diagnostics.some((d) => d.code === 'parse-error'), item.parseValid, item.name);
  if (item.parseValid) assert.deepEqual(diagnostics.map((d) => d.code).sort(), item.codes, item.name);
  assert.equal(row.symbols.disk.exit, item.parseValid ? 0 : 1, item.name);
  assert.equal(row.preprocess.disk.exit, item.parseValid ? 0 : 1, item.name);
 }
 const folder = path.dirname(report.cases[0].file), bin = path.join(process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), 'build/slua-oracle');
 const flags = '--fflags=DebugLuauUserDefinedClasses=true,LuauExportValueSyntax=true';
 function agent(args, input) {
  report.cliProcesses++;
  const result = run(process.execPath, [report.cli, ...args, '--json'], input); assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout); assert.equal(parsed.exitCode, result.exit); return { exit: result.exit, data: parsed };
 }
 let old;
 if (process.env.SLUA_INHERITANCE_ADDITIONAL_REUSE) {
  const file = process.env.SLUA_INHERITANCE_ADDITIONAL_REUSE, previous = await fs.readFile(file); old = JSON.parse(previous);
  assert.ok(old.passed === true || old.nativePrefixQualified === true); assert.deepEqual(old.build.binaries, report.build.binaries); assert.equal(old.build.inputSha256, report.build.inputSha256);
  report.additionalReuse = { path: file, sha256: hash(previous) };
 }
 for (const item of expected.additional) {
  const file = path.join(folder, item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
  const row = { ...item, file, sourceSha256: hash(item.source), flags }; report.additional.push(row);
  const prior = old?.additional.find((x) => x.name === item.name && x.sourceSha256 === row.sourceSha256 && x.flags === flags);
  if (prior) { assert.equal(await fileHash(prior.file), row.sourceSha256); row.native = prior.native; row.nativeReused = true; row.nativeInput = prior.file; }
  else row.native = {
   syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flags, file]), compile: run(path.join(bin, 'slua-compile'), ['--null', flags, file]),
   strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flags, file]),
   execution: run(path.join(bin, 'slua'), ['--sl', flags + ',DebugLuauUserDefinedClassesRuntime=true', file])
  };
  assert.deepEqual(Object.fromEntries(Object.entries(row.native).map(([k,v]) => [k,v.exit])), item.expectedNative, item.name);
  for (const command of ['check','symbols','preprocess']) {
   const extras = command === 'check' ? ['--warnings-as-errors'] : [];
   row[command] = { disk: agent([command,file,...extras]), stdin: agent([command,'-','--stdin-filepath',file,...extras],item.source) };
   assert.deepEqual(row[command].disk,row[command].stdin);
  }
  assert.deepEqual(row.check.disk.data.diagnostics.map((d) => d.code).sort(),item.codes);
  assert.equal(row.preprocess.disk.exit,0); assert.equal(row.symbols.disk.exit,0);
  assert.equal(hash(row.preprocess.disk.data.content),row.sourceSha256); row.generatedReusesExactOriginal = true;
 }
 const source = 'open class Base\npublic x: number\nfunction get(self): number return self.x end\nend\nclass Child extends Base end\nlocal value=Child{x=42}\nassert(value:get()==42)';
 const file = path.join(folder,'navigation.luau'); await fs.writeFile(file,source,{flag:'wx'});
 for (const [command,position,extras] of [['definition','6:14',[]],['references','4:21',[]],['rename','4:21',['--new-name','Root']],['hover','6:14',[]]]) {
  const disk = agent([command,file,'--position',position,...extras]), stdin = agent([command,'-','--stdin-filepath',file,'--position',position,...extras],source);
  assert.deepEqual(disk,stdin); assert.equal(disk.exit,0);
  if (command === 'definition') assert.equal(disk.data.result.range.start.line,2);
  if (command === 'references' || command === 'rename') assert.equal(disk.data.result.length,2);
  if (command === 'hover') assert.match(disk.data.result.markdown,/number/);
  report.inspection.push({command,disk,stdin});
 }
 lsp = launchServer(report.server,root); const uri = pathToFileURL(file).href;
 await lsp.request('initialize',{processId:process.pid,rootUri:pathToFileURL(folder).href,capabilities:{workspace:{workspaceEdit:{documentChanges:true}}}}); lsp.notify('initialized',{});
 const versions = new Map();
 async function change(uri,text,codes) {
  const version=(versions.get(uri)??0)+1;versions.set(uri,version);
  const pending=lsp.notification('textDocument/publishDiagnostics',(p)=>p.uri===uri&&p.version===version);
  lsp.notify(version===1?'textDocument/didOpen':'textDocument/didChange',version===1?{textDocument:{uri,languageId:'luau',version,text}}:{textDocument:{uri,version},contentChanges:[{text}]});
  const diagnostics=(await pending).diagnostics;assert.deepEqual(diagnostics.map((d)=>d.code).sort(),codes);
  report.protocol.push({uri,version,sourceSha256:hash(text),diagnostics});
 }
 await change(uri,source,[]);
 const request=(name,position,extra={})=>lsp.request('textDocument/'+name,{textDocument:{uri},position,...extra});
 const definition=await request('definition',{line:6,character:14});assert.equal(definition.range.start.line,2);
 const refs=await request('references',{line:4,character:21},{context:{includeDeclaration:true}});assert.equal(refs.length,2);
 const rename=await request('rename',{line:4,character:21},{newName:'Root'});assert.equal(rename.documentChanges[0].edits.length,2);assert.equal(rename.documentChanges[0].textDocument.version,1);
 const completion=await request('completion',{line:6,character:13});assert.ok((Array.isArray(completion)?completion:completion.items).some((x)=>x.label==='get'));
 const signature=await request('signatureHelp',{line:6,character:17});assert.equal(signature.signatures[0].parameters.length,0);
 const hover=await request('hover',{line:6,character:14});assert.match(hover.contents.value,/number/);
 report.protocol.push({definition,references:refs,rename,completion,signature,hover});
 await change(uri,source.replace('open class','class'),['class-closed-base']);
 await change(uri,'open class Base\nfunction __init(self) end\nend\nclass Child extends Base end\nChild{}',['class-constructor-required']);
 await change(uri,source,[]);const recovered=await request('definition',{line:6,character:14});assert.deepEqual(recovered,definition);report.protocol.push({recovered});
 const baseFile=path.join(folder,'base.luau'),mainFile=path.join(folder,'main.luau');
 const base='export open class Base\npublic x: number\nfunction get(self): number return self.x end\nend';
 const main='local api=require("base")\nclass Child extends api.Base end\nlocal value=Child{x=42}\nassert(value:get()==42)';
 await fs.writeFile(baseFile,base,{flag:'wx'});await fs.writeFile(mainFile,main,{flag:'wx'});
 const baseUri=pathToFileURL(baseFile).href,mainUri=pathToFileURL(mainFile).href;
 await change(mainUri,main,[]);
 async function moduleDefinition(line) {
  const result=await lsp.request('textDocument/definition',{textDocument:{uri:mainUri},position:{line:3,character:14}});
  assert.equal(result.uri,baseUri);assert.equal(result.range.start.line,line);report.protocol.push({moduleDefinition:result});
 }
 await moduleDefinition(2);await change(baseUri,'-- unsaved\n'+base,[]);await moduleDefinition(3);
 await change(baseUri,base.replace('export open class','export class'),[]);await change(mainUri,main,['class-closed-base']);
 await change(baseUri,base,[]);await change(mainUri,main,[]);await moduleDefinition(2);
 const disk=agent(['definition',mainFile,'--position','3:14']),stdin=agent(['definition','-','--stdin-filepath',mainFile,'--position','3:14'],main);
 assert.deepEqual(disk,stdin);assert.equal(disk.exit,0);assert.equal(disk.data.result.file,baseFile);assert.equal(disk.data.result.range.start.line,2);report.inspection.push({command:'module-definition',disk,stdin});
 for (const current of versions.keys()) lsp.notify('textDocument/didClose',{textDocument:{uri:current}});
 report.scope='Known-source inheritance qualification: native102baseline preserved, explicit candidate diagnostic decisions, two complete-return-pack controls, actual file/stdin check/symbols/preprocess/navigation and stdio inheritance/member origins/signatures/rename/runtime-specific diagnostics/unsaved-module recovery. Opaque computed ancestry is not invented; broader compiler, performance and GUI/release acceptance remain separate.';
 report.profileChecksPassed=true;report.passed=true;
} catch(error) {report.error=error.stack??String(error);throw error;}
finally {
 if(lsp)await lsp.close();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();
}
console.log(JSON.stringify({passed:report.passed,profileChecksPassed:report.profileChecksPassed,cases:report.cases.length,additionalPrograms:report.additional.length,cliProcesses:report.cliProcesses,protocolRecords:report.protocol.length,nativeStrictAcceptedWithCliDiagnostics:report.summary.nativeStrictAcceptedWithCliDiagnostics.length,implementationAcceptance:false,releaseAcceptance:false,evidence:destination}));
