import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, getSignatureHelp } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_JSON_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_JSON_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_JSON_EVIDENCE ?? path.join(root, '.local/logs/json-options.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/json-options.json');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/json-options-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
 executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], cliProcesses: 0,
 scope: 'Native JSON argument presence/types versus shared core and actual CLI file/stdin, original/generated safe local execution, and stdio diagnostic/signature recovery. Native runtime acceptance is separate from ordinary strict C++ analysis with no custom globals. No native rebuild, host calls, FS IPC or GUI.' };
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
 const cases = JSON.parse(await fs.readFile(fixture, 'utf8'));
 const matrixSource = 'local results={}\n' + cases.map((item) => `do\nlocal ok,value=pcall(function() ${item.source}\nend)\ntable.insert(results,{name=${JSON.stringify(item.name)},ok=ok,error=if ok then nil else tostring(value)})\nend`).join('\n') + '\nprint(lljson.encode(results))';
 const matrix = path.join(folder, 'matrix.luau'); await fs.writeFile(matrix, matrixSource, { flag: 'wx' });
 report.nativeMatrix = { file: matrix, sourceSha256: hash(matrixSource), runtime: run(path.join(bin, 'slua'), ['--sl', matrix]) };
 assert.equal(report.nativeMatrix.runtime.exit, 0); assert.equal(report.nativeMatrix.runtime.stderr, '');
 report.nativeCases = JSON.parse(report.nativeMatrix.runtime.stdout); assert.equal(report.nativeCases.length, cases.length);
 const registry = buildSluaRegistryFromLslDefinitions(null);
 for (const [i, item] of cases.entries()) {
  const file = path.join(folder, `case-${i}.luau`); await fs.writeFile(file, item.source, { flag: 'wx' });
  const parsed = parseSlua(item.source);
  const row = { ...item, file, sourceSha256: hash(item.source), native: report.nativeCases[i], syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]), diagnostics: analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry }) }; report.cases.push(row);
  assert.deepEqual(parsed.diagnostics, []); assert.equal(row.syntax.exit, 0); assert.equal(row.native.name, item.name); assert.equal(row.native.ok, item.valid, JSON.stringify(row.native));
  const codes = row.diagnostics.filter((d) => d.code.startsWith('call-argument-')).map((d) => d.code); assert.deepEqual(codes, item.codes, item.name);
  row.disk = agent(['check', file, '--warnings-as-errors']); row.stdin = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], item.source);
  assert.deepEqual(row.disk, row.stdin); assert.equal(row.disk.exit, item.valid ? 0 : 1, JSON.stringify(row));
  assert.deepEqual(row.disk.data.diagnostics.filter((d) => d.code.startsWith('call-argument-')).map((d) => d.code), item.codes, item.name);
  if (item.valid) {
   row.compile = run(path.join(bin, 'slua-compile'), ['--null', file]); row.runtime = run(path.join(bin, 'slua'), ['--sl', file]);
   assert.equal(row.compile.exit, 0); assert.deepEqual(row.runtime, { exit: 0, stdout: '', stderr: '' });
   row.preprocess = { disk: agent(['preprocess', file]), stdin: agent(['preprocess', '-', '--stdin-filepath', file], item.source) };
   assert.deepEqual(row.preprocess.disk, row.preprocess.stdin); assert.equal(row.preprocess.disk.exit, 0);
   const generated = path.join(folder, `case-${i}.generated.luau`); await fs.writeFile(generated, row.preprocess.disk.data.content, { flag: 'wx' });
   row.generated = { file: generated, sha256: hash(row.preprocess.disk.data.content), compile: run(path.join(bin, 'slua-compile'), ['--null', generated]), runtime: run(path.join(bin, 'slua'), ['--sl', generated]) };
   assert.equal(row.generated.compile.exit, 0); assert.deepEqual(row.generated.runtime, row.runtime);
  } else {
   row.normal = agent(['check', file]); row.normalStdin = agent(['check', '-', '--stdin-filepath', file], item.source);
   assert.deepEqual(row.normal, row.normalStdin); assert.equal(row.normal.exit, 0);
  }
 }
 const source = 'local encode=lljson.encode\nlocal result=encode(42,nil)\nprint(result)';
 const file = path.join(folder, 'recovery.luau'), uri = pathToFileURL(file).href; await fs.writeFile(file, source, { flag: 'wx' });
 const signatureSource = 'lljson.encode(42, {})'; report.signature = getSignatureHelp(parseSlua(signatureSource).ast, { line: 0, character: 18 }, registry, signatureSource);
 assert.ok(report.signature.signatures[0].label.includes('arg2?: table'));
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 async function change(version, text, expected) {
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  const diagnostics = (await pending).diagnostics; assert.deepEqual(diagnostics.filter((d) => d.code.startsWith('call-argument-')).map((d) => d.code), expected); report.protocol.push({ version, text, diagnostics });
 }
 await change(1, source, ['call-argument-type-mismatch']);
 const signature = await lsp.request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 1, character: 23 } }); assert.ok(signature.signatures[0].label.includes('arg2?: table')); report.protocol.push({ signature });
 await change(2, source.replace('42,nil', '42,{}'), []);
 await change(3, source.replace('42,nil', '42,{},1'), ['call-argument-count-mismatch']);
 await change(4, source.replace('42,nil', '42'), []);
 await change(5, 'local result=lljson.decode("42",function(key,value) print(key);return value end)\nprint(result)', []);
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, valid: report.cases.filter((x) => x.valid).length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
