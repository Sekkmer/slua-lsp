import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_METHODS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_METHODS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_METHODS_EVIDENCE ?? path.join(root, '.local/logs/method-call-grammar.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/method-call-grammar.json');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/method-call-grammar-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
 executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], cliProcesses: 0,
 scope: 'Pinned native syntax versus shared parser and actual agent CLI file/stdin, followed by stdio diagnostics/recovery. Syntax acceptance does not claim runtime/type acceptance of every example. No native rebuild, host calls, FS IPC or GUI.' };
function run(exe, args, input) {
 const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
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
 for (const [i, item] of JSON.parse(await fs.readFile(fixture, 'utf8')).entries()) {
  const file = path.join(folder, `case-${i}.luau`); await fs.writeFile(file, item.source, { flag: 'wx' });
  const row = { ...item, file, sourceSha256: hash(item.source), native: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]), diagnostics: parseSlua(item.source).diagnostics }; report.cases.push(row);
  assert.equal(row.native.exit === 0, item.valid, JSON.stringify(row));
  assert.equal(row.diagnostics.some((d) => d.code === 'parse-error'), !item.valid, item.name);
  row.disk = agent(['check', file]); row.stdin = agent(['check', '-', '--stdin-filepath', file], item.source);
  assert.deepEqual(row.disk, row.stdin); assert.equal(row.disk.exit, item.valid ? 0 : 1, item.name);
  assert.equal(row.disk.data.diagnostics.some((d) => d.code === 'parse-error'), !item.valid, item.name);
 }
 const file = path.join(folder, 'recovery.luau'), uri = pathToFileURL(file).href;
 const source = 'local object={run=function(self) return self end}\nlocal result=object:run\nprint(result)';
 await fs.writeFile(file, source, { flag: 'wx' });
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 async function change(version, text, invalid) {
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  const diagnostics = (await pending).diagnostics; assert.equal(diagnostics.some((d) => d.code === 'parse-error'), invalid); report.protocol.push({ version, text, diagnostics });
 }
 await change(1, source, true);
 const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 15 } });
 assert.equal(definition.range.start.line, 0); report.protocol.push({ definition });
 await change(2, source.replace('object:run\n', 'object:run()\n'), false);
 await change(3, source.replace('object:run\n', 'object:run.field\n'), true);
 await change(4, source.replace('object:run\n', 'object.run\n'), false);
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
