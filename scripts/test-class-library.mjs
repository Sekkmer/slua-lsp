import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_CLASS_LIBRARY_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_CLASS_LIBRARY_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const destination = process.env.SLUA_CLASS_LIBRARY_EVIDENCE ?? path.join(root, '.local/logs/class-library.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const flag = '--fflags=DebugLuauUserDefinedClasses=true';
const runtimeFlag = flag + ',DebugLuauUserDefinedClassesRuntime=true';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/class-library.json');
await fs.mkdir(path.dirname(destination), { recursive: true });
const output = await fs.open(destination, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/class-library-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath, executableSha256: hash(await fs.readFile(process.execPath)),
 cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)),
 folder, cases: [], protocol: [], lookups: [], cliProcesses: 0,
 scope: 'Experimental native class inspection, argument presence, safe known-instance constructor identity and aliases/shadows. Actual file/stdin CLI and stdio diagnostics, hover/signatures/member origins/recovery. Native strict outcomes remain distinct from runtime and bounded source inference. Explicit exact native reuse never substitutes for current CLI/server observations. No GUI, FS IPC, world effects or native rebuild.' };
function run(exe, args, input) { const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); assert.ifError(p.error); assert.equal(p.signal, null); return { exit: p.status, stdout: p.stdout, stderr: p.stderr }; }
function agent(args, input) { report.cliProcesses++; const p = run(process.execPath, [cli, ...args, '--json'], input); assert.equal(p.stderr, ''); return { exit: p.exit, data: JSON.parse(p.stdout) }; }
let lsp;
try {
 const verified = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(verified.exit, 0);
 report.sourceVerification = JSON.parse(verified.stdout); report.build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
 assert.equal(report.sourceVerification.contentSha256, report.build.inputs.sourceContentSha256);
 for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), report.build.binaries[name]);
 let previous;
 if (process.env.SLUA_CLASS_LIBRARY_NATIVE_REUSE) {
  const bytes = await fs.readFile(process.env.SLUA_CLASS_LIBRARY_NATIVE_REUSE); previous = JSON.parse(bytes);
  assert.ok(previous.passed === true || previous.investigation === true);
  assert.equal(previous.build.inputSha256, report.build.inputSha256); assert.deepEqual(previous.build.binaries, report.build.binaries);
  report.nativeReuse = { path: process.env.SLUA_CLASS_LIBRARY_NATIVE_REUSE, sha256: hash(bytes), scope: 'Exact native observations only; CLI/server commands always run.' };
 }
 const registry = buildSluaRegistryFromLslDefinitions(null);
 for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
  const file = path.join(folder, item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
  const row = { ...item, file, sourceSha256: hash(item.source) }; report.cases.push(row);
  const parsed = parseSlua(item.source); assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry }).map((d) => d.code).sort(), [...item.codes].sort(), item.name);
  const prior = previous?.cases.find((x) => x.name === item.name && x.sourceSha256 === row.sourceSha256);
  if (prior) {
   assert.equal(hash(await fs.readFile(prior.original ?? prior.file)), row.sourceSha256);
   const native = prior.native ?? prior;
   row.native = { syntax: native.syntax, compile: native.compile, strict: native.strict, ...(native.execution ? { execution: native.execution } : {}) };
   row.nativeOriginalReused = true;
  } else row.native = { syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flag, file]), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, file]), strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flag, file]) };
  assert.equal(row.native.syntax.exit, 0); assert.equal(row.native.compile.exit, 0); assert.equal(row.native.strict.exit, item.nativeValid ? 0 : 1, JSON.stringify(row));
  row.check = { disk: agent(['check', file, '--warnings-as-errors']), stdin: agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], item.source) };
  assert.deepEqual(row.check.disk, row.check.stdin); assert.equal(row.check.disk.exit, item.codes.length ? 1 : 0);
  assert.deepEqual(row.check.disk.data.diagnostics.map((d) => d.code).sort(), [...item.codes].sort());
  row.symbols = { disk: agent(['symbols', file]), stdin: agent(['symbols', '-', '--stdin-filepath', file], item.source) }; assert.deepEqual(row.symbols.disk, row.symbols.stdin); assert.equal(row.symbols.disk.exit, 0);
  row.preprocess = { disk: agent(['preprocess', file]), stdin: agent(['preprocess', '-', '--stdin-filepath', file], item.source) }; assert.deepEqual(row.preprocess.disk, row.preprocess.stdin); assert.equal(row.preprocess.disk.exit, 0);
  const content = row.preprocess.disk.data.content, generated = path.join(folder, item.name + '.generated.luau'); await fs.writeFile(generated, content, { flag: 'wx' });
  if (prior?.generated?.sha256 === hash(content)) { assert.equal(hash(await fs.readFile(prior.generated.file)), prior.generated.sha256); row.generated = { ...prior.generated, file: generated, reused: true }; }
  else row.generated = { file: generated, sha256: hash(content), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, generated]) };
  assert.equal(row.generated.compile.exit, 0);
  if (item.runtime) {
   row.native.execution ??= run(path.join(bin, 'slua'), ['--sl', runtimeFlag, file]);
   row.generated.execution ??= run(path.join(bin, 'slua'), ['--sl', runtimeFlag, generated]);
   assert.equal(row.native.execution.exit, 0); assert.deepEqual(row.generated.execution, row.native.execution);
  }
 }
 for (const name of ['class', 'class.classof', 'class.isinstance']) { const row = agent(['lookup', name]); assert.equal(row.exit, 0); report.lookups.push({ name, ...row }); }
 lsp = launchServer(server, root); const uri = pathToFileURL(path.join(folder, 'recovery.luau')).href;
 await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 let version = 0;
 async function change(source, codes) {
  version++; const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text: source } } : { textDocument: { uri, version }, contentChanges: [{ text: source }] });
  const diagnostics = (await pending).diagnostics; assert.deepEqual(diagnostics.map((d) => d.code).sort(), [...codes].sort()); report.protocol.push({ version, sourceSha256: hash(source), diagnostics });
 }
 for (const row of report.cases) await change(row.source, row.codes);
 const prefix = report.cases[0].source.split('\n').slice(0, 5).join('\n') + '\n';
 const source = prefix + 'local inspect=class.classof\nlocal Make=inspect(item)\nprint(Make.answer())';
 await change(source, []);
 const completion = await lsp.request('textDocument/completion', { textDocument: { uri }, position: { line: 7, character: 11 } });
 assert.ok((Array.isArray(completion) ? completion : completion.items).some((x) => x.label === 'answer'));
 const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 7, character: 12 } }); assert.equal(definition.range.start.line, 2);
 const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 5, character: 23 } }); assert.match(JSON.stringify(hover), /Experimental class runtime flag/);
 report.protocol.push({ completion, definition, hover });
 await change(prefix + 'class.isinstance(item,Box)', []);
 const signature = await lsp.request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 5, character: 17 } }); assert.equal(signature.signatures[0].parameters.length, 2); report.protocol.push({ signature });
 await change('class Box\n', ['parse-error']); await change(source, []);
 const recovered = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 7, character: 12 } }); assert.deepEqual(recovered, definition); report.protocol.push({ recovered });
 lsp.notify('textDocument/didClose', { textDocument: { uri } });
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, strictValid: report.cases.filter((x) => x.nativeValid).length, runtimePrograms: report.cases.filter((x) => x.runtime).length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: destination }));
