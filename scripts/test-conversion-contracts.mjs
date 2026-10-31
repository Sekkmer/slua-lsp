import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_CONVERSIONS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_CONVERSIONS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_CONVERSIONS_EVIDENCE ?? path.join(root, '.local/logs/conversion-contracts.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/conversion-contracts.json');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/conversions-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
 executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], lookups: [], cliProcesses: 0,
 scope: 'Owned pure local conversion programs: native syntax/compilation/runtime, generated runtime, shared diagnostics, actual CLI file/stdin and stdio recovery/hover/signatures/completion. Static accepted input types are separate from invalid-value runtime outcomes and erased annotations. No ordinary native strict custom-global claim, rebuild, FS IPC, GUI or host effects.' };
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
  const row = { ...item, file, sourceSha256: hash(item.source), syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]), compile: run(path.join(bin, 'slua-compile'), ['--null', file]), runtime: run(path.join(bin, 'slua'), ['--sl', file]), diagnostics: analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry }) }; report.cases.push(row);
  assert.deepEqual(parsed.diagnostics, []); assert.equal(row.syntax.exit, 0); assert.equal(row.compile.exit, 0);
  assert.equal(row.runtime.exit, item.runtimeAccepted ? 0 : 1, JSON.stringify(row));
  assert.deepEqual(row.diagnostics.map((d) => d.code), item.codes, item.name);
  row.disk = agent(['check', file, '--warnings-as-errors']); row.stdin = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], item.source);
  assert.deepEqual(row.disk, row.stdin); assert.equal(row.disk.exit, item.codes.length ? 1 : 0, JSON.stringify(row));
  assert.deepEqual(row.disk.data.diagnostics.map((d) => d.code), item.codes, item.name);
  row.preprocess = { disk: agent(['preprocess', file]), stdin: agent(['preprocess', '-', '--stdin-filepath', file], item.source) };
  assert.deepEqual(row.preprocess.disk, row.preprocess.stdin); assert.equal(row.preprocess.disk.exit, 0);
  const generated = path.join(folder, `case-${i}.generated.luau`); await fs.writeFile(generated, row.preprocess.disk.data.content, { flag: 'wx' });
  row.generated = { file: generated, sha256: hash(row.preprocess.disk.data.content), compile: run(path.join(bin, 'slua-compile'), ['--null', generated]), runtime: run(path.join(bin, 'slua'), ['--sl', generated]) };
  assert.equal(row.generated.compile.exit, 0); assert.equal(row.generated.runtime.exit, row.runtime.exit); assert.equal(row.generated.runtime.stdout, row.runtime.stdout);
 }
 for (const name of ['uuid', 'uuid.create', 'touuid', 'tovector', 'toquaternion', 'torotation']) {
  const value = agent(['lookup', name]); assert.equal(value.exit, 0);
  if (name.startsWith('to')) assert.ok(value.data.signature.includes('nil'));
  else assert.ok(value.data.signature.includes('buffer') && value.data.signature.includes('uuid'));
  report.lookups.push({ name, value });
 }
 const source = 'local convert=tovector\nlocal value: vector=convert("invalid")\nprint(value)';
 const file = path.join(folder, 'recovery.luau'), uri = pathToFileURL(file).href; await fs.writeFile(file, source, { flag: 'wx' });
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 async function change(version, text, expected) {
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  const diagnostics = (await pending).diagnostics; assert.deepEqual(diagnostics.map((d) => d.code), expected); report.protocol.push({ version, text, diagnostics });
 }
 await change(1, source, ['assignment-type-mismatch']);
 const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 16 } });
 assert.ok(JSON.stringify(hover).includes('nil')); report.protocol.push({ hover });
 await change(2, 'local value=tovector(nil)\nif value~=nil then local checked: vector=value; print(checked) end', []);
 const signature = await lsp.request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 0, character: 22 } });
 assert.ok(signature.signatures[0].label.includes('nil')); assert.ok(!signature.signatures[0].label.includes('arg1?')); report.protocol.push({ signature });
 await change(3, 'tovector()', ['call-argument-count-mismatch']);
 await change(4, 'local value: uuid=uuid(buffer.create(16))\nprint(value)', []);
 await change(5, 'local value=touuid()\nprint(value)', []);
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, runtimeAccepted: report.cases.filter((x) => x.runtimeAccepted).length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
