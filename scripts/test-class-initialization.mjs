import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_INITIALIZATION_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_INITIALIZATION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_INITIALIZATION_EVIDENCE ?? path.join(root, '.local/logs/class-initialization.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const flag = '--fflags=DebugLuauUserDefinedClasses=true';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/class-initialization.json');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/class-initialization-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
 executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], cliProcesses: 0,
 scope: 'Native experimental constructor field reads and self escape, direct versus nested assignments, closures/shadows, nilable known annotations and native cast boundary. Actual CLI file/stdin check/symbols/preprocess and original/generated native compilation, selected safe local runtime and stdio buffer recovery/navigation/signature. Opaque type aliases and full control-flow/subtyping remain conservative; no deployed flags, GUI, FS IPC or host effects.' };
function run(exe, args, input) {
 const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
 assert.ifError(p.error); assert.equal(p.signal, null); return { exit: p.status, stdout: p.stdout, stderr: p.stderr };
}
function agent(args, input) {
 report.cliProcesses++; const p = run(process.execPath, [cli, ...args, '--json'], input);
 assert.equal(p.stderr, ''); return { exit: p.exit, data: JSON.parse(p.stdout) };
}
let lsp;
try {
 const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
 const verification = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(verification.exit, 0);
 report.sourceVerification = JSON.parse(verification.stdout); report.build = build;
 assert.equal(report.sourceVerification.contentSha256, build.inputs.sourceContentSha256);
 for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
 const registry = buildSluaRegistryFromLslDefinitions(null);
 for (const [i, item] of JSON.parse(await fs.readFile(fixture, 'utf8')).entries()) {
  const file = path.join(folder, `case-${i}.luau`); await fs.writeFile(file, item.source, { flag: 'wx' });
  const parsed = parseSlua(item.source);
  const row = { ...item, file, sourceSha256: hash(item.source), syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flag, file]), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, file]), strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flag, file]), diagnostics: analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry }) }; report.cases.push(row);
  assert.deepEqual(parsed.diagnostics, []); assert.equal(row.syntax.exit, 0); assert.equal(row.compile.exit, 0);
  assert.equal(row.strict.exit, item.nativeValid ? 0 : 1, JSON.stringify(row));
  assert.deepEqual(row.diagnostics.map((d) => d.code).sort(), [...item.codes].sort(), item.name);
  row.disk = agent(['check', file, '--warnings-as-errors']); row.stdin = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], item.source);
  assert.deepEqual(row.disk, row.stdin); assert.equal(row.disk.exit, item.codes.length ? 1 : 0, JSON.stringify(row));
  assert.deepEqual(row.disk.data.diagnostics.map((d) => d.code).sort(), [...item.codes].sort(), item.name);
  row.symbols = { disk: agent(['symbols', file]), stdin: agent(['symbols', '-', '--stdin-filepath', file], item.source) };
  assert.deepEqual(row.symbols.disk, row.symbols.stdin); assert.equal(row.symbols.disk.exit, 0); assert.equal(row.symbols.disk.data.sourceSha256, row.sourceSha256);
  row.preprocess = { disk: agent(['preprocess', file]), stdin: agent(['preprocess', '-', '--stdin-filepath', file], item.source) };
  assert.deepEqual(row.preprocess.disk, row.preprocess.stdin); assert.equal(row.preprocess.disk.exit, 0);
  const generated = path.join(folder, `case-${i}.generated.luau`); await fs.writeFile(generated, row.preprocess.disk.data.content, { flag: 'wx' });
  row.generated = { file: generated, sha256: hash(row.preprocess.disk.data.content), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, generated]) };
  assert.equal(row.generated.compile.exit, 0);
  if (item.runtime) {
   row.execution = run(path.join(bin, 'slua'), ['--sl', flag + ',DebugLuauUserDefinedClassesRuntime=true', file]);
   row.generated.execution = run(path.join(bin, 'slua'), ['--sl', flag + ',DebugLuauUserDefinedClassesRuntime=true', generated]);
   assert.equal(row.execution.exit, 0); assert.deepEqual(row.generated.execution, row.execution);
  }
 }
 const original = report.cases.find((item) => item.name === 'read-after').source;
 const file = path.join(folder, 'recovery.luau'), uri = pathToFileURL(file).href; await fs.writeFile(file, original, { flag: 'wx' });
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 let version = 0;
 async function change(text, expected) {
  version++; const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  const diagnostics = (await pending).diagnostics; assert.deepEqual(diagnostics.map((d) => d.code).sort(), [...expected].sort()); report.protocol.push({ version, text, diagnostics });
 }
 for (const item of report.cases) await change(item.source, item.codes);
 await change(original, []);
 const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 9, character: 1 } });
 assert.equal(definition.uri, uri); assert.deepEqual(definition.range.start, { line: 1, character: 6 }); report.protocol.push({ definition });
 const signature = await lsp.request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 9, character: 4 } });
 assert.deepEqual(signature?.signatures[0]?.parameters.map((p) => p.label), []); report.protocol.push({ signature });
 assert.equal(await fs.readFile(file, 'utf8'), original);
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, nativeValid: report.cases.filter((x) => x.nativeValid).length, runtimePrograms: report.cases.filter((x) => x.runtime).length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
