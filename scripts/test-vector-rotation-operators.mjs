import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, inferLocalVariableTypes, buildSluaRegistryFromLslDefinitions, sluaTypeToString, slua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_OPERATORS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_OPERATORS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_OPERATORS_EVIDENCE ?? path.join(root, '.local/logs/vector-rotation-operators.json');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/vector-rotation-operators.json');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/vector-rotation-operators-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
 executableSha256: hash(await fs.readFile(process.execPath)), cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)),
 harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], cliProcesses: 0,
 scope: '63 pinned native runtime operator combinations versus core result types and actual CLI file/stdin. Valid source and generated programs execute locally. Pinned ordinary strict vector controls are separate. No host ll calls, FS IPC, GUI, native rebuild or general solver claim.' };
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
 const cases = JSON.parse(await fs.readFile(fixture, 'utf8'));
 const matrix = cases.flatMap((item) => ['do', `local ok,kind,value=pcall(function() ${item.source.replace('print(result)', 'return typeof(result), tostring(result)')} end)`,
  `table.insert(results,{name=${JSON.stringify(item.name)},ok=ok,kind=kind,value=value})`, 'end']);
 const matrixFile = path.join(folder, 'matrix.luau'), matrixSource = ['local results={}', ...matrix, 'print(lljson.encode(results))'].join('\n');
 await fs.writeFile(matrixFile, matrixSource, { flag: 'wx' }); report.matrixSourceSha256 = hash(matrixSource);
 report.nativeMatrix = run(path.join(bin, 'slua'), ['--sl', matrixFile]); assert.equal(report.nativeMatrix.exit, 0); assert.equal(report.nativeMatrix.stderr, '');
 report.nativeCases = JSON.parse(report.nativeMatrix.stdout);
 const registry = buildSluaRegistryFromLslDefinitions(null);
 for (const [i, item] of cases.entries()) {
  const native = report.nativeCases[i], valid = item.expected !== 'unknown';
  assert.equal(native.name, item.name); assert.equal(native.ok, valid, JSON.stringify(native));
  if (valid) assert.equal(native.kind === 'quaternion' ? 'rotation' : native.kind, item.expected);
  const file = path.join(folder, `case-${i}.luau`); await fs.writeFile(file, item.source, { flag: 'wx' });
  const parsed = parseSlua(item.source), inferred = inferLocalVariableTypes(parsed.ast, registry).find((v) => v.name === 'result')?.type ?? slua.unknown();
  const row = { ...item, file, sourceSha256: hash(item.source), inferred: sluaTypeToString(inferred), native, agents: [] }; report.cases.push(row);
  assert.deepEqual(parsed.diagnostics, []); assert.equal(row.inferred, item.expected);
  row.syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]); assert.equal(row.syntax.exit, 0);
  for (const command of ['check', 'hover']) {
   const flags = command === 'check' ? ['--warnings-as-errors'] : ['--position', '3:7'];
   const disk = agent([command, file, ...flags]), stdin = agent([command, '-', '--stdin-filepath', file, ...flags], item.source);
   assert.deepEqual(disk, stdin); assert.equal(disk.exit, command === 'check' && !valid ? 1 : 0, item.name); row.agents.push({ command, disk, stdin });
   if (command === 'hover') assert.ok(disk.data.result.markdown.includes(`result: ${item.expected}`));
   if (command === 'check' && !valid) assert.equal(JSON.stringify(disk.data).match(/native-operator/g)?.length, 1);
  }
  if (valid) {
   row.compile = run(path.join(bin, 'slua-compile'), ['--null', file]); assert.equal(row.compile.exit, 0);
   row.execute = run(path.join(bin, 'slua'), ['--sl', file]); assert.equal(row.execute.exit, 0); assert.equal(row.execute.stdout, native.value + '\n'); assert.equal(row.execute.stderr, '');
   const disk = agent(['preprocess', file]), stdin = agent(['preprocess', '-', '--stdin-filepath', file], item.source); assert.deepEqual(disk, stdin); assert.equal(disk.exit, 0);
   const generated = path.join(folder, `case-${i}.generated.luau`); await fs.writeFile(generated, disk.data.content, { flag: 'wx' });
   row.generated = { file: generated, sha256: hash(disk.data.content), compile: run(path.join(bin, 'slua-compile'), ['--null', generated]), execute: run(path.join(bin, 'slua'), ['--sl', generated]) };
   assert.equal(row.generated.compile.exit, 0); assert.equal(row.generated.execute.exit, 0); assert.equal(row.generated.execute.stdout, native.value + '\n'); assert.equal(row.generated.execute.stderr, '');
   row.preprocess = { disk, stdin };
  }
 }
 report.strictTypes = [];
 for (const [name, source, valid] of [
  ['vector-product', 'local result: vector=vector.create(1,2,3)*vector.create(3,2,1); print(result)', true],
  ['not-dot-product', 'local result: number=vector.create(1,2,3)*vector.create(3,2,1); print(result)', false],
  ['vector-floor', 'local result: vector=vector.create(1,2,3)//vector.create(3,2,1); print(result)', true],
  ['number-floor', 'local result: number=6//2; print(result)', true]
 ]) {
  const file = path.join(folder, name + '.luau'); await fs.writeFile(file, source, { flag: 'wx' });
  const row = { name, source, valid, native: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', file]) }; report.strictTypes.push(row);
  assert.equal(row.native.exit, valid ? 0 : 1, JSON.stringify(row));
  const disk = agent(['check', file, '--warnings-as-errors']), stdin = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], source);
  assert.deepEqual(disk, stdin); assert.equal(disk.exit, valid ? 0 : 1); row.disk = disk; row.stdin = stdin;
 }
 const invalid = cases.find((item) => item.expected === 'unknown');
 const warningFile = path.join(folder, 'warning.luau'); await fs.writeFile(warningFile, invalid.source, { flag: 'wx' });
 const normal = agent(['check', warningFile]), normalStdin = agent(['check', '-', '--stdin-filepath', warningFile], invalid.source);
 assert.deepEqual(normal, normalStdin); assert.equal(normal.exit, 0); assert.ok(JSON.stringify(normal.data).includes('native-operator'));
 const suppressedSource = '-- slua-lsp:disable native-operator\n' + invalid.source, suppressedFile = path.join(folder, 'suppressed.luau'); await fs.writeFile(suppressedFile, suppressedSource, { flag: 'wx' });
 const suppressed = agent(['check', suppressedFile, '--warnings-as-errors']), suppressedStdin = agent(['check', '-', '--stdin-filepath', suppressedFile, '--warnings-as-errors'], suppressedSource);
 assert.deepEqual(suppressed, suppressedStdin); assert.equal(suppressed.exit, 0); assert.deepEqual(suppressed.data.diagnostics, []);
 report.warningPolicy = { normal, normalStdin, suppressed, suppressedStdin };
 const control = 'local a,b=vector(1,2,3),vector(4,5,6)\nassert(a*b==vector(4,10,18))\nassert(vector.dot(a,b)==32)\nassert(a%b==vector(-3,6,-3))\nassert(a%b==vector.cross(a,b))\nassert(-7//4==-2 and 7//-4==-2 and -7%4==1 and 7%-4==-1)\nlocal original=false\nassert((original ~= nil or true)==true)\nassert((if original==nil then true else original)==false)\nprint("PASS")';
 const controlFile = path.join(folder, 'controls.luau'); await fs.writeFile(controlFile, control, { flag: 'wx' });
 report.controls = { source: control, sourceSha256: hash(control), native: run(path.join(bin, 'slua'), ['--sl', controlFile]) }; assert.equal(report.controls.native.exit, 0); assert.equal(report.controls.native.stdout, 'PASS\n');
 const source = 'local product=vector(1,2,3)*vector(3,2,1)\nmath.abs(product)';
 const file = path.join(folder, 'editor.luau'); await fs.writeFile(file, source, { flag: 'wx' }); const uri = pathToFileURL(file).href;
 report.inspection = [];
 for (const command of ['definition', 'references', 'rename']) {
  const flags = ['--position', '1:10', ...(command === 'rename' ? ['--new-name', 'components'] : [])];
  const disk = agent([command, file, ...flags]), stdin = agent([command, '-', '--stdin-filepath', file, ...flags], source); assert.deepEqual(disk, stdin); assert.equal(disk.exit, 0);
  if (command === 'definition') assert.deepEqual(disk.data.result.range.start, { line: 0, character: 6 });
  else assert.equal(disk.data.result.length, 2);
  report.inspection.push({ command, disk, stdin });
 }
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } }); lsp.notify('initialized', {});
 async function change(version, text) {
  const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text } } : { textDocument: { uri, version }, contentChanges: [{ text }] });
  return (await pending).diagnostics;
 }
 const request = (method, position, extra = {}) => lsp.request(`textDocument/${method}`, { textDocument: { uri }, position, ...extra });
 assert.ok((await change(1, source)).some((d) => d.code === 'call-argument-type-mismatch')); report.protocol.push('Component vector product rejects a number argument');
 assert.ok(JSON.stringify(await request('hover', { line: 1, character: 10 })).includes('product: vector')); report.protocol.push('Native product hover type');
 const completions = await request('completion', { line: 1, character: 10 }); assert.ok((completions.items ?? completions).some((v) => v.label === 'product' && v.detail.includes('vector'))); report.protocol.push('Native product completion type');
 assert.deepEqual((await request('definition', { line: 1, character: 10 })).range.start, { line: 0, character: 6 });
 assert.equal((await request('rename', { line: 1, character: 10 }, { newName: 'components' })).documentChanges[0].edits.length, 2); report.protocol.push('Lexical navigation and versioned rename');
 const good = source.replace('math.abs(product)', 'math.abs(vector.dot(product, product))'); assert.deepEqual(await change(2, good), []); report.protocol.push('Dot conversion repairs argument diagnostic');
 assert.ok((await change(3, good + '\nlocal bad=rotation(0,0,0,1)//rotation(0,0,0,1)\nprint(bad)')).some((d) => d.code === 'native-operator')); report.protocol.push('Rotation floor division warning after edit');
 assert.deepEqual(await change(4, good + '\nlocal good=rotation(0,0,0,1)/rotation(0,0,0,1)\nprint(good)'), []); report.protocol.push('Supported rotation division repairs warning');
 report.passed = true;
} finally {
 if (lsp) await lsp.close();
 await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, valid: report.cases.filter((c) => c.expected !== 'unknown').length, strictTypes: report.strictTypes.length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, evidence: output }));
