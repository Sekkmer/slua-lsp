import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_PACKS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_PACKS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_PACKS_EVIDENCE ?? path.join(root, '.local/logs/open-return-packs.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/open-return-packs.json');
const stdlibFixture = path.join(root, 'scripts/fixtures/stdlib-return-packs.json');
const boundedFixture = path.join(root, 'scripts/fixtures/bounded-return-packs.json');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/return-packs-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
 executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), stdlibFixtureSha256: hash(await fs.readFile(stdlibFixture)), boundedFixtureSha256: hash(await fs.readFile(boundedFixture)), folder, cases: [], protocol: [], lookups: [], cliProcesses: 0,
 scope: 'Owned local variable string/stdlib return packs: pinned native syntax/compile/runtime and generated runtime, shared diagnostics, actual source/packaged CLI check/preprocess file/stdin, raw lookup, stdio diagnostics/hover/edit recovery. No literal range/capture/format/callback-sensitive full inference, strict custom-global equivalence, rebuild, FS IPC, GUI or host effects.' };
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
 const cases = [...JSON.parse(await fs.readFile(fixture, 'utf8')), ...JSON.parse(await fs.readFile(stdlibFixture, 'utf8')), ...JSON.parse(await fs.readFile(boundedFixture, 'utf8'))];
 for (const [i, item] of cases.entries()) {
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
 for (const [name, minimum, tail] of [
  ['string.find', 1, 'unknown'], ['string.unpack', 1, 'unknown'], ['string.byte', 0, 'number'], ['utf8.codepoint', 0, 'number'],
  ['string.match', 1, 'unknown'], ['unpack', 0, 'unknown'], ['table.unpack', 0, 'unknown'], ['select', 0, 'unknown'],
  ['pcall', 1, 'unknown'], ['xpcall', 1, 'unknown'], ['coroutine.resume', 1, 'unknown'], ['coroutine.yield', 0, 'unknown']
 ]) {
  const value = agent(['lookup', name]); assert.equal(value.exit, 0);
  assert.ok(value.data.signature.includes(`...${tail}`)); assert.equal(value.data.definition.signature.returns.minimum, minimum);
  report.lookups.push({ name, value });
 }
 for (const name of ['next', 'utf8.len', 'coroutine.close']) {
  const value = agent(['lookup', name]); assert.equal(value.exit, 0);
  const returns = value.data.definition.signature.returns;
  assert.equal(returns.minimum, 1); assert.equal(returns.items.length, 2); assert.equal(returns.variadic, undefined);
  assert.ok(value.data.signature.includes('[')); report.lookups.push({ name, value });
 }
 for (const name of ['debug.info', 'debug.traceback']) {
  const value = agent(['lookup', name]); assert.equal(value.exit, 0);
  assert.equal(value.data.definition.signature.kind, 'union'); assert.equal(value.data.definition.signature.items.length, 2);
  report.lookups.push({ name, value });
 }
 const wrapped = agent(['lookup', 'coroutine.wrap']); assert.equal(wrapped.exit, 0);
 assert.equal(wrapped.data.definition.signature.returns.returns.minimum, 0);
 report.lookups.push({ name: 'coroutine.wrap', value: wrapped });
 const source = 'local first,last,capture=string.find("a12", "(%d+)")\nprint(first,last,capture)';
 const file = path.join(folder, 'recovery.luau'), uri = pathToFileURL(file).href; await fs.writeFile(file, source, { flag: 'wx' });
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
 async function change(version, text, expected) {
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  const diagnostics = (await pending).diagnostics; assert.deepEqual(diagnostics.map((d) => d.code), expected); report.protocol.push({ version, text, diagnostics });
 }
 await change(1, source, []);
 const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 33 } });
 assert.ok(JSON.stringify(hover).includes('...unknown')); report.protocol.push({ hover });
 await change(2, 'local first,last=(string.find("abc","a"))\nprint(first,last)', ['assignment-return-count-mismatch']);
 await change(3, 'local a,b,c,nextByte=string.unpack("BBB","abc")\nprint(a,b,c,nextByte)', []);
 await change(4, 'lljson.encode(42,{},string.unpack("",""))', ['call-argument-count-mismatch']);
 await change(5, 'local a=lljson.encode(string.unpack("",""))\nprint(a)', []);
 await change(6, 'local ok,a,b=pcall(function() return 1,"two" end)\nprint(ok,a,b)', []);
 await change(7, 'local a,b=(string.byte("ab",1,2))\nprint(a,b)', ['assignment-return-count-mismatch']);
 await change(8, 'local a,b=string.byte("ab",1,2)\nif a~=nil then local n:number=a; print(n) end\nif b~=nil then local n:number=b; print(n) end', []);
 await change(9, 'local a:number,b:string=string.match("abc","()(%a+)")\nprint(a,b)', []);
 await change(10, 'local ok:string,a,b=pcall(function() return 1,2 end)\nprint(ok,a,b)', ['assignment-type-mismatch']);
 await change(11, 'local ok,a,b=xpcall(function() return 1,2 end,function(err) return err end)\nprint(ok,a,b)', []);
 await change(12, 'local n=utf8.len("abc")\nprint(n)', []);
 await change(13, 'local a,b,c=utf8.len("abc")\nprint(a,b,c)', ['assignment-return-count-mismatch']);
 await change(14, 'local co=coroutine.create(function() end)\nlocal source=debug.info(co,0,"s")\nprint(source)', []);
 const signature = await lsp.request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 1, character: 30 } });
 assert.equal(signature?.signatures[0]?.parameters.length, 3); report.protocol.push({ signature });
 await change(15, 'debug.info(true,"s")', ['call-argument-type-mismatch']);
 await change(16, 'local text=debug.traceback()\nprint(text)', []);
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, runtimeAccepted: report.cases.filter((x) => x.runtimeAccepted).length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
