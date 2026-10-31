import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_INTEGER_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_INTEGER_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_INTEGER_EVIDENCE ?? path.join(root, '.local/logs/integer-literals.json');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/integer-literals.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle'), flag = '--fflags=LuauIntegerType2=true';
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/integer-literals-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath, executableSha256: hash(await fs.readFile(process.execPath)),
 cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], types: [], protocol: [], cliProcesses: 0,
 scope: 'Pinned integer flag, exact literals, native syntax/type/local runtime versus shared CLI file/stdin and stdio recovery. Runtime conversions are separate from strict type acceptance. No FS IPC, simulator, GUI or native rebuild.' };
function run(exe, args, input) {
 const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
 assert.ifError(p.error); assert.equal(p.signal, null); return { exit: p.status, stdout: p.stdout, stderr: p.stderr };
}
function agent(args, input) {
 report.cliProcesses++; const p = run(process.execPath, [cli, ...args, '--json'], input);
 assert.equal(p.stderr, ''); return { exit: p.exit, data: JSON.parse(p.stdout) };
}
let lsp;
try {
 const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
 const verified = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(verified.exit, 0);
 report.sourceVerification = JSON.parse(verified.stdout); report.build = build;
 assert.equal(report.sourceVerification.contentSha256, build.inputs.sourceContentSha256);
 for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
 for (const [i, item] of JSON.parse(await fs.readFile(fixture, 'utf8')).entries()) {
  const source = item.source ?? `local value=${item.literal}\nprint(type(value), tostring(value))`, file = path.join(folder, `case-${i}.luau`);
  await fs.writeFile(file, source, { flag: 'wx' });
  const row = { ...item, file, sourceSha256: hash(source), agents: [] }; report.cases.push(row);
  row.syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flag, file]); assert.equal(row.syntax.exit, item.valid ? 0 : 1, JSON.stringify(row));
  row.disabled = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', '--fflags=LuauIntegerType2=false', file]); assert.equal(row.disabled.exit, 1);
  row.coreDiagnostics = parseSlua(source).diagnostics; assert.equal(row.coreDiagnostics.length === 0, item.valid, item.literal);
  for (const command of ['check', 'symbols', 'preprocess']) {
   const disk = agent([command, file]), stdin = agent([command, '-', '--stdin-filepath', file], source);
   row.agents.push({ command, disk, stdin }); assert.deepEqual(disk, stdin); assert.equal(disk.exit, item.valid ? 0 : 1, JSON.stringify(row));
   if (command === 'symbols') assert.equal(disk.data.sourceSha256, row.sourceSha256);
   if (command === 'preprocess' && item.valid) {
    const generated = path.join(folder, `case-${i}.generated.luau`); await fs.writeFile(generated, disk.data.content, { flag: 'wx' });
    row.generated = { file: generated, sha256: hash(disk.data.content), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, generated]), execute: run(path.join(bin, 'slua'), ['--sl', flag, generated]) };
    assert.equal(row.generated.compile.exit, 0); assert.equal(row.generated.execute.exit, 0); assert.equal(row.generated.execute.stdout, `integer\t${item.value}\n`); assert.equal(row.generated.execute.stderr, '');
   }
  }
  if (item.valid) {
   row.compile = run(path.join(bin, 'slua-compile'), ['--null', flag, file]); assert.equal(row.compile.exit, 0);
   row.execute = run(path.join(bin, 'slua'), ['--sl', flag, file]); assert.equal(row.execute.exit, 0); assert.equal(row.execute.stdout, `integer\t${item.value}\n`); assert.equal(row.execute.stderr, '');
  }
 }
 for (const [name, source, valid] of [
  ['integer-annotation', 'local value: integer=42i; print(value)', true],
  ['number-annotation', 'local value: number=42i; print(value)', false],
  ['number-call', 'math.abs(42i)', false],
  ['negative-literal', 'local value: integer=-42i; print(value)', true],
  ['negative-group', 'local value=-(42i); print(value)', false],
  ['negative-variable', 'local value=42i; print(-value)', false],
  ['integer-call', 'integer.add(42i, 42i)', true],
  ['integer-call-number', 'integer.add(42i, 42)', false],
  ['add', 'local value=42i+1i; print(value)', false],
  ['compare', 'print(42i<1i)', false],
  ['length', 'print(#42i)', false],
  ['concat', 'print(42i.."x")', false],
  ['equality', 'print(42i==42i, 42i~=1i, not 42i)', true],
  ['table-overload', 'local object=setmetatable({}, {__add=function(self, other: integer) return other end}); print(object+42i)', true]
 ]) {
  const file = path.join(folder, name + '.luau'); await fs.writeFile(file, source, { flag: 'wx' });
  const row = { name, source, sourceSha256: hash(source), valid, native: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flag, file]) }; report.types.push(row);
  assert.equal(row.native.exit, valid ? 0 : 1, JSON.stringify(row));
  const disk = agent(['check', file, '--warnings-as-errors']), stdin = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], source);
  row.disk = disk; row.stdin = stdin; assert.deepEqual(disk, stdin); assert.equal(disk.exit, valid ? 0 : 1, JSON.stringify(row));
  if (name === 'number-call') { row.runtimeConversion = run(path.join(bin, 'slua'), ['--sl', flag, file]); assert.equal(row.runtimeConversion.exit, 0); }
  if (name === 'negative-group' || name === 'negative-variable') { row.runtimeRejection = run(path.join(bin, 'slua'), ['--sl', flag, file]); assert.equal(row.runtimeRejection.exit, 1); }
 }
 report.hostConversions = [];
 for (const [name, source, valid] of [
  ['host-union', 'local value=if math.random()>0 then 42i else 42\nll.Abs(value)', true],
  ['user-union', 'local value=if math.random()>0 then 42i else 42\nlocal function use(n: number) print(n) end\nuse(value)', false]
 ]) {
  const file = path.join(folder, name + '.luau'); await fs.writeFile(file, source, { flag: 'wx' });
  const disk = agent(['check', file, '--warnings-as-errors']), stdin = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], source);
  assert.deepEqual(disk, stdin); assert.equal(disk.exit, valid ? 0 : 1, name);
  report.hostConversions.push({ name, source, sourceSha256: hash(source), file, valid, disk, stdin, hostExecuted: false });
 }
 const source = 'local value=9007199254740993i\nlocal negative=-42i\ninteger.add(value, negative)';
 const file = path.join(folder, 'editor.luau'); await fs.writeFile(file, source, { flag: 'wx' }); const uri = pathToFileURL(file).href;
 report.inspection = [];
 for (const command of ['hover', 'definition', 'references', 'rename']) {
  const flags = ['--position', '2:14', ...(command === 'rename' ? ['--new-name', 'wide'] : [])];
  const disk = agent([command, file, ...flags]), stdin = agent([command, '-', '--stdin-filepath', file, ...flags], source);
  assert.deepEqual(disk, stdin); assert.equal(disk.exit, 0); assert.equal(disk.data.sourceSha256, hash(source));
  if (command === 'hover') assert.ok(disk.data.result.markdown.includes('value: integer'));
  if (command === 'definition') assert.deepEqual(disk.data.result.range.start, { line: 0, character: 6 });
  if (command === 'references' || command === 'rename') assert.equal(disk.data.result.length, 2);
  report.inspection.push({ command, disk, stdin });
 }
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } }); lsp.notify('initialized', {});
 async function change(version, text, valid) {
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  const diagnostics = (await pending).diagnostics; assert.equal(diagnostics.length === 0, valid, JSON.stringify(diagnostics)); return diagnostics;
 }
 assert.deepEqual(await change(1, source, true), []); report.protocol.push('Exact large integer source opens without diagnostics');
 const request = (method, position, extra = {}) => lsp.request(`textDocument/${method}`, { textDocument: { uri }, position, ...extra });
 assert.ok(JSON.stringify(await request('hover', { line: 2, character: 14 })).includes('value: integer')); report.protocol.push('Literal-derived integer hover');
 assert.deepEqual((await request('definition', { line: 2, character: 14 })).range.start, { line: 0, character: 6 });
 assert.equal((await request('rename', { line: 2, character: 14 }, { newName: 'wide' })).documentChanges[0].edits.length, 2); report.protocol.push('Lexical definition and versioned rename');
 const bad = source + '\nmath.abs(value)'; assert.ok((await change(2, bad, false)).some((d) => d.code === 'call-argument-type-mismatch')); report.protocol.push('Number-call mismatch after edit');
 await change(3, source + '\nmath.abs(integer.tonumber(value))', true); report.protocol.push('Explicit conversion repairs diagnostics');
 assert.ok((await change(4, source.replace('9007199254740993i', '9223372036854775808i'), false)).some((d) => d.code === 'parse-error')); report.protocol.push('Overflow is a parser diagnostic');
 await change(5, source, true); report.protocol.push('Recovery clears parser diagnostic');
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, valid: report.cases.filter((c) => c.valid).length, types: report.types.length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
