import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_EXPORTS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_EXPORTS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const destination = process.env.SLUA_EXPORTS_EVIDENCE ?? path.join(root, '.local/logs/value-exports.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const flags = '--fflags=LuauExportValueSyntax=true,DebugLuauUserDefinedClasses=true';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/value-exports.json');
await fs.mkdir(path.dirname(destination), { recursive: true });
const output = await fs.open(destination, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/value-exports-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath, executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), cases: [], protocol: [], cliProcesses: 0,
 scope: 'Explicit native value-export flags; 36 owned grammar/binding fixtures, file/stdin CLI, generated syntax/runtime, stdio diagnostics/navigation/rename/hover/recovery and ordinary source-module frozen surfaces. No GUI, FS IPC, world effects or native rebuild. No arbitrary closure execution or full compiler equivalence claim.' };
function run(exe, args, input) { const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); assert.ifError(p.error); assert.equal(p.signal, null); return { exit: p.status, stdout: p.stdout, stderr: p.stderr }; }
function agent(args, input) { report.cliProcesses++; const p = run(process.execPath, [cli, ...args, '--json'], input); assert.equal(p.stderr, ''); return { exit: p.exit, data: JSON.parse(p.stdout) }; }
let lsp;
try {
 const check = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(check.exit, 0); report.sourceVerification = JSON.parse(check.stdout);
 report.build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8')); assert.equal(report.sourceVerification.contentSha256, report.build.inputs.sourceContentSha256);
 for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), report.build.binaries[name]);
 let previous;
 if (process.env.SLUA_EXPORTS_NATIVE_REUSE) {
  const bytes = await fs.readFile(process.env.SLUA_EXPORTS_NATIVE_REUSE); previous = JSON.parse(bytes); assert.equal(previous.passed, true);
  assert.equal(previous.build.inputSha256, report.build.inputSha256); assert.deepEqual(previous.build.binaries, report.build.binaries);
  report.nativeReuse = { path: process.env.SLUA_EXPORTS_NATIVE_REUSE, sha256: hash(bytes), scope: 'Exact native observations only; CLI/server always execute.' };
 }
 for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
  const file = path.join(folder, item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
  const row = { ...item, file, sourceSha256: hash(item.source) }; report.cases.push(row);
  const prior = previous?.cases.find((x) => x.name === item.name && x.sourceSha256 === row.sourceSha256);
  if (prior) {
   assert.equal(hash(await fs.readFile(path.resolve(root, prior.file))), row.sourceSha256);
   row.native = prior.native ?? Object.fromEntries(['syntax', 'compile', 'strict', 'execution'].filter((key) => prior[key]).map((key) => [key, prior[key]])); row.nativeReused = true;
  } else row.native = { syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flags, file]), compile: run(path.join(bin, 'slua-compile'), ['--null', flags, file]), strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flags, file]) };
  assert.equal(row.native.syntax.exit, item.parseValid ? 0 : 1); assert.equal(row.native.compile.exit, item.parseValid ? 0 : 1); assert.equal(row.native.strict.exit, item.parseValid ? 0 : 1);
  row.check = { disk: agent(['check', file, '--warnings-as-errors']), stdin: agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], item.source) }; assert.deepEqual(row.check.disk, row.check.stdin); assert.equal(row.check.disk.exit, item.parseValid ? 0 : 1);
  if (!item.parseValid) { assert.ok(row.check.disk.data.diagnostics.some((x) => x.code === 'parse-error')); continue; }
  assert.deepEqual(row.check.disk.data.diagnostics, []);
  for (const command of ['symbols', 'preprocess']) {
   row[command] = { disk: agent([command, file]), stdin: agent([command, '-', '--stdin-filepath', file], item.source) }; assert.deepEqual(row[command].disk, row[command].stdin); assert.equal(row[command].disk.exit, 0);
  }
  const content = row.preprocess.disk.data.content, generated = path.join(folder, item.name + '.generated.luau'); await fs.writeFile(generated, content, { flag: 'wx' });
  if (prior?.generated?.sha256 === hash(content)) { assert.equal(hash(await fs.readFile(prior.generated.file)), prior.generated.sha256); row.generated = { ...prior.generated, file: generated, reused: true }; }
  else row.generated = { file: generated, sha256: hash(content), compile: run(path.join(bin, 'slua-compile'), ['--null', flags, generated]) };
  assert.equal(row.generated.compile.exit, 0);
  if (item.runtime) {
   row.native.execution ??= run(path.join(bin, 'slua'), ['--sl', flags + ',DebugLuauUserDefinedClassesRuntime=true', file]);
   row.generated.execution ??= run(path.join(bin, 'slua'), ['--sl', flags + ',DebugLuauUserDefinedClassesRuntime=true', generated]);
   assert.equal(row.native.execution.exit, 0); assert.deepEqual(row.generated.execution, row.native.execution);
  }
 }
 lsp = launchServer(server, root); const uri = pathToFileURL(path.join(folder, 'recovery.luau')).href;
 await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 let version = 0;
 async function change(source, valid, codes) {
  version++; const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text: source } } : { textDocument: { uri, version }, contentChanges: [{ text: source }] });
  const diagnostics = (await pending).diagnostics;
  if (codes) assert.deepEqual(diagnostics.map((x) => x.code).sort(), [...codes].sort());
  else if (valid) assert.deepEqual(diagnostics, []); else assert.ok(diagnostics.some((x) => x.code === 'parse-error'));
  report.protocol.push({ version, sourceSha256: hash(source), diagnostics });
 }
 const request = (method, position, extra = {}) => lsp.request('textDocument/' + method, { textDocument: { uri }, position, ...extra });
 for (const row of report.cases) await change(row.source, row.parseValid);
 const navigation = 'export function double(value: number): number return value*2 end\nprint(double(3))\ndo local double=2 print(double) end';
 const navFile = path.join(folder, 'navigation.luau'); await fs.writeFile(navFile, navigation, { flag: 'wx' }); await change(navigation, true);
 const definition = await request('definition', { line: 1, character: 8 }); assert.equal(definition.range.start.character, 16);
 const refs = await request('references', { line: 1, character: 8 }, { context: { includeDeclaration: true } }); assert.equal(refs.length, 2);
 const hover = await request('hover', { line: 1, character: 8 }); assert.match(hover.contents.value, /const double/);
 const rename = await request('rename', { line: 1, character: 8 }, { newName: 'twice' }); assert.equal(rename.changes[uri].length, 2);
 for (const command of ['definition', 'references', 'hover', 'rename']) {
  const row = agent([command, navFile, '--position', '1:8', ...(command === 'rename' ? ['--new-name', 'twice'] : [])]); assert.equal(row.exit, 0); report.protocol.push({ command, cli: row });
 }
 report.protocol.push({ definition, refs, hover, rename });
 await change('export local first=1\nexport local second=2', true); assert.equal(await request('rename', { line: 0, character: 14 }, { newName: 'second' }), null);
 await change(navigation + '\nreturn 1', false); await change(navigation, true); assert.deepEqual(await request('definition', { line: 1, character: 8 }), definition);
 const apiFile = path.join(folder, 'api.luau'), mainFile = path.join(folder, 'main.luau');
 await fs.writeFile(apiFile, 'export local count=1\ncount=2\nexport function double(value: number): number return value*2 end\nlocal count="shadow"\nprint(count)', { flag: 'wx' });
 const main = 'local api=require("api")\nlocal count: string=api.count\napi.double("wrong")\napi.count=2\nprint(count)'; await fs.writeFile(mainFile, main, { flag: 'wx' });
 const module = { disk: agent(['check', mainFile, '--warnings-as-errors']), stdin: agent(['check', '-', '--stdin-filepath', mainFile, '--warnings-as-errors'], main) }; assert.deepEqual(module.disk, module.stdin); assert.equal(module.disk.exit, 1); assert.deepEqual(module.disk.data.diagnostics.map((x) => x.code).sort(), ['assignment-type-mismatch', 'call-argument-type-mismatch', 'readonly-write']);
 const origin = agent(['definition', mainFile, '--position', '1:25']); assert.equal(origin.exit, 0); assert.equal(origin.data.result.file, apiFile); assert.equal(origin.data.result.sourceSha256, hash(await fs.readFile(apiFile)));
 await change(main, false, ['assignment-type-mismatch', 'call-argument-type-mismatch', 'readonly-write']);
 const wireOrigin = await request('definition', { line: 1, character: 25 }); assert.equal(wireOrigin.uri, pathToFileURL(apiFile).href); assert.equal(wireOrigin.range.start.character, 13);
 report.protocol.push({ module, origin, wireOrigin });
 lsp.notify('textDocument/didClose', { textDocument: { uri } }); report.passed = true;
} finally { if (lsp) await lsp.close(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); }
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, actualCliProcesses: report.cliProcesses, protocolRecords: report.protocol.length, evidence: destination }));
