// Native differential observations used by the function-attribute qualification driver.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_ATTRIBUTES_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_ATTRIBUTES_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const destination = process.env.SLUA_ATTRIBUTES_EVIDENCE ?? path.join(root, '.local/logs/function-attributes-native.json');
const fixture = path.join(root, 'scripts/fixtures/function-attributes.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = async (file) => hash(await fs.readFile(file));
const errors = (row) => [...(row.stdout + row.stderr).matchAll(/: (TypeError|SyntaxError): (.*)/g)].map((m) => [m[1], m[2]]);
await fs.mkdir(path.dirname(destination), { recursive: true });
const output = await fs.open(destination, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/attributes-native-'));
const report = { passed: false, releaseAcceptance: false, implementationAcceptance: false,
 scope: 'Function attributes syntax/compilation/strict checking and selected pure local runtime are independent observations. Green verifies recorded native observations and candidate transport parity, not implementation acceptance. Syntax support is qualified separately. Agent CLI file/stdin and stdio diagnostics are compared as a baseline, without treating native/tool agreement or accepted syntax as implementation acceptance. No FS IPC, world effects, native rebuild or GUI.',
 node: process.version, executable: process.execPath, executableSha256: await fileHash(process.execPath),
 cli, cliSha256: await fileHash(cli), server, serverSha256: await fileHash(server),
 harnessSha256: await fileHash(fileURLToPath(import.meta.url)), fixtureSha256: await fileHash(fixture),
 cases: [], protocol: [], cliProcesses: 0, nativeReuses: [] };
function run(exe, args, input) {
 const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
 assert.ifError(p.error); assert.equal(p.signal, null);
 return { exit: p.status, stdout: p.stdout, stderr: p.stderr };
}
function agent(command, file, source) {
 report.cliProcesses++;
 const args = [cli, command, source === undefined ? file : '-', ...(source === undefined ? [] : ['--stdin-filepath', file]), '--json', ...(command === 'check' ? ['--warnings-as-errors'] : [])];
 const p = run(process.execPath, args, source); assert.equal(p.stderr, '');
 const data = JSON.parse(p.stdout); assert.equal(data.command, command); assert.equal(data.exitCode, p.exit);
 assert.ok([0, 1].includes(p.exit), 'An operational CLI failure is not a language baseline');
 return { exit: p.exit, data };
}
const previous = [];
let lsp;
try {
 const preparation = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(preparation.exit, 0);
 report.sourceVerification = JSON.parse(preparation.stdout);
 report.build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
 assert.equal(report.sourceVerification.contentSha256, report.build.inputs.sourceContentSha256);
 for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(await fileHash(path.join(bin, name)), report.build.binaries[name]);
 if (process.env.SLUA_ATTRIBUTES_NATIVE_REUSE) {
  const paths = JSON.parse(process.env.SLUA_ATTRIBUTES_NATIVE_REUSE); assert.ok(Array.isArray(paths));
  for (const file of paths) {
   assert.equal(typeof file, 'string'); const bytes = await fs.readFile(file), data = JSON.parse(bytes);
   assert.equal(data.passed, true); assert.equal(data.build.inputSha256, report.build.inputSha256);
   assert.deepEqual(data.build.binaries, report.build.binaries);
   assert.equal(data.sourceVerification.contentSha256, report.sourceVerification.contentSha256);
   previous.push(...data.cases); report.nativeReuses.push({ path: file, sha256: hash(bytes) });
  }
 }
 for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
  const file = path.join(folder, item.name + '.luau'); assert.match(item.name, /^[A-Za-z0-9_-]+$/);
  await fs.writeFile(file, item.source, { flag: 'wx' });
  const row = { ...item, file, sourceSha256: hash(item.source) }; report.cases.push(row);
  const prior = previous.find((p) => p.name === item.name && p.sourceSha256 === row.sourceSha256 && p.flags === item.flags);
  if (prior) {
   assert.equal(await fileHash(path.resolve(root, prior.file)), row.sourceSha256);
   row.native = structuredClone(prior.native); row.nativeReused = true; row.nativeInput = prior.file;
  } else {
   row.native = {
    syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', item.flags, file]),
    compile: run(path.join(bin, 'slua-compile'), ['--null', item.flags, file]),
    strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', item.flags, file])
   };
   if (item.runtime) row.native.execution = run(path.join(bin, 'slua'), ['--sl', item.flags + ',DebugLuauUserDefinedClassesRuntime=true', file]);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(row.native).map(([k, v]) => [k, v.exit])), item.expectedNative, item.name);
  assert.deepEqual(errors(row.native.strict), item.expectedStrictErrors, item.name);
  for (const command of ['check', 'symbols', 'preprocess']) {
   row[command] = { disk: agent(command, file), stdin: agent(command, file, item.source) };
   assert.deepEqual(row[command].disk, row[command].stdin, item.name + ':' + command);
  }
  if (row.preprocess.disk.exit === 0 && item.expectedNative.syntax === 0) {
   const content = row.preprocess.disk.data.content;
   assert.equal(typeof content, 'string'); const generated = path.join(folder, item.name + '.generated.luau');
   await fs.writeFile(generated, content, { flag: 'wx' });
   row.generated = { file: generated, sha256: hash(content) };
   const oldGenerated = prior?.generated;
   if (oldGenerated?.sha256 === row.generated.sha256) {
    assert.equal(await fileHash(path.resolve(root, oldGenerated.file)), oldGenerated.sha256);
    row.generated = { ...structuredClone(oldGenerated), file: generated, reused: true };
   } else if (row.generated.sha256 === row.sourceSha256) {
    row.generated.compile = structuredClone(row.native.compile);
    if (row.native.execution) row.generated.execution = structuredClone(row.native.execution);
    row.generated.reusedExactSource = true;
   } else {
    row.generated.compile = run(path.join(bin, 'slua-compile'), ['--null', item.flags, generated]);
    if (item.runtime) row.generated.execution = run(path.join(bin, 'slua'), ['--sl', item.flags + ',DebugLuauUserDefinedClassesRuntime=true', generated]);
   }
   assert.equal(row.generated.compile.exit, row.native.compile.exit);
   if (item.runtime) { assert.equal(row.generated.execution.exit, row.native.execution.exit); assert.equal(row.generated.execution.stdout, row.native.execution.stdout); }
  }
 }
 lsp = launchServer(server, root);
 const uri = pathToFileURL(path.join(folder, 'unsaved-attributes.luau')).href;
 await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 let version = 0;
 for (const row of report.cases) {
  version++;
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1
   ? { textDocument: { uri, languageId: 'luau', version, text: row.source } }
   : { textDocument: { uri, version }, contentChanges: [{ text: row.source }] });
  const diagnostics = (await pending).diagnostics;
  assert.deepEqual(diagnostics.map((d) => d.code).sort(), row.check.disk.data.diagnostics.map((d) => d.code).sort(), row.name);
  report.protocol.push({ name: row.name, version, sourceSha256: row.sourceSha256, diagnostics });
 }
 lsp.notify('textDocument/didClose', { textDocument: { uri } });
 report.summary = { programs: report.cases.length,
  nativeSyntaxAccepted: report.cases.filter((x) => x.native.syntax.exit === 0).length,
  nativeStrictAccepted: report.cases.filter((x) => x.native.strict.exit === 0).length,
  selectedRuntimePrograms: report.cases.filter((x) => x.runtime).length,
  nativeRuntimeSucceeded: report.cases.filter((x) => x.native.execution?.exit === 0).length,
  generatedPrograms: report.cases.filter((x) => x.generated).length,
  strictAcceptedButRuntimeRefused: report.cases.filter((x) => x.native.strict.exit === 0 && x.native.execution && x.native.execution.exit !== 0).map((x) => x.name),
  nativeStrictAcceptedWithCliDiagnostics: report.cases.filter((x) => x.native.strict.exit === 0 && x.check.disk.exit !== 0).map((x) => x.name),
  toolCleanButNativeStrictRefused: report.cases.filter((x) => x.native.strict.exit !== 0 && x.check.disk.exit === 0).map((x) => x.name),
  nativeStrictRuntimeDifferences: report.cases.filter((x) => x.runtime && x.native.strict.exit !== x.native.execution.exit).map((x) => x.name) };
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close();
}
console.log(JSON.stringify({ passed: report.passed, implementationAcceptance: false, releaseAcceptance: false, ...report.summary, cliProcesses: report.cliProcesses, protocolRecords: report.protocol.length, evidence: destination }));
