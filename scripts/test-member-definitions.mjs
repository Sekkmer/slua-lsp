import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, findDefinitionAtPosition, buildSluaRegistryFromLslDefinitions, SourceTextIndex } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_MEMBERS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_MEMBERS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_MEMBERS_EVIDENCE ?? path.join(root, '.local/logs/member-definitions.json');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/member-definitions.json');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true }); const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/member-definitions-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath, executableSha256: hash(await fs.readFile(process.execPath)),
 cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
 fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], cliProcesses: 0,
 scope: 'Known source member origins versus actual CLI file/stdin and stdio LSP, aliases, reexports, unsaved/dependency/config changes, native generated local programs. References/rename stay lexical. No FS IPC or host ll call.' };
function run(exe, args, input) {
 const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); assert.ifError(p.error); assert.equal(p.signal, null);
 return { exit: p.status, stdout: p.stdout, stderr: p.stderr };
}
function agent(args, input) { report.cliProcesses++; const p = run(process.execPath, [cli, ...args, '--json'], input); assert.equal(p.stderr, ''); return { exit: p.exit, data: JSON.parse(p.stdout) }; }
const base = buildSluaRegistryFromLslDefinitions(null); let lsp;
try {
 lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } }); lsp.notify('initialized', {});
 async function open(file, text, version = 1, change = false) {
  const uri = pathToFileURL(file).href, pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(change ? 'textDocument/didChange' : 'textDocument/didOpen', change ? { textDocument: { uri, version }, contentChanges: [{ text }] } : { textDocument: { uri, languageId: 'luau', version, text } });
  return (await pending).diagnostics;
 }
 async function close(file) { const uri = pathToFileURL(file).href, pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.diagnostics.length === 0); lsp.notify('textDocument/didClose', { textDocument: { uri } }); await pending; }
 const request = (method, file, position, extra = {}) => lsp.request(`textDocument/${method}`, { textDocument: { uri: pathToFileURL(file).href }, position, ...extra });
 for (const [i, item] of JSON.parse(await fs.readFile(fixture, 'utf8')).entries()) {
  const file = path.join(folder, `case-${i}.luau`), source = item.source, index = new SourceTextIndex(source), position = index.positionAt(source.lastIndexOf(item.query));
  const expected = item.target === null ? null : index.positionAt(item.targetLast ? source.lastIndexOf(item.target) : source.indexOf(item.target));
  await fs.writeFile(file, source, { flag: 'wx' }); const parsed = parseSlua(source); assert.deepEqual(parsed.diagnostics, []);
  const core = findDefinitionAtPosition(parsed.ast, position, base); const row = { ...item, file, sourceSha256: hash(source), position, expected, core, agents: [] }; report.cases.push(row);
  assert.equal(core === null, expected === null); if (expected) assert.deepEqual(core.identifier.location.start, { line: expected.line + 1, column: expected.character + 1 });
  for (const command of ['definition', 'references', 'rename']) {
   const flags = ['--position', `${position.line}:${position.character}`, ...(command === 'rename' ? ['--new-name', 'differentField'] : [])];
   const disk = agent([command, file, ...flags]), stdin = agent([command, '-', '--stdin-filepath', file, ...flags], source); assert.deepEqual(disk, stdin); assert.equal(disk.data.sourceSha256, hash(source));
   assert.equal(disk.exit, command === 'definition' && expected ? 0 : 1, item.name); row.agents.push({ command, disk, stdin });
   if (command === 'definition' && expected) { assert.equal(disk.data.result.kind, 'field'); assert.equal(disk.data.result.file, file); assert.deepEqual(disk.data.result.range.start, expected); }
   if (command === 'references') assert.deepEqual(disk.data.result, []);
  }
  await open(file, source); row.definition = await request('definition', file, position);
  if (expected) { assert.equal(row.definition.uri, pathToFileURL(file).href); assert.deepEqual(row.definition.range.start, expected); } else assert.equal(row.definition, null);
  assert.deepEqual(await request('references', file, position, { context: { includeDeclaration: true } }), []); assert.equal(await request('prepareRename', file, position), null); await close(file);
 }
 report.protocol.push('28 source cases: core/CLI/stdio exact member positions or conservative refusal, with lexical references/rename isolation');
 const library = path.join(folder, 'library'); await fs.mkdir(library);
 const api = path.join(library, 'api.luau'), bridge = path.join(folder, 'bridge.luau'), main = path.join(folder, 'main.luau'), config = path.join(folder, '.luaurc');
 const module = 'local M={}\nM.field=42\nfunction M.double(n: number): number return n*2 end\nreturn M';
 const source = 'local api=require("bridge")\nprint(api.field,api.double(2))\nlocal key="field"\nlocal sample={field=1,[key]="changed"}\nassert(sample.field=="changed")';
 await fs.writeFile(api, module); await fs.writeFile(bridge, 'return require("@lib/api")'); await fs.writeFile(main, source); await fs.writeFile(config, '{"aliases":{"lib":"library"}}');
 const fieldPosition = { line: 1, character: 10 }, methodPosition = { line: 1, character: 20 };
 async function target(file, line, character, targetText, cliToo = true) {
  const value = await request('definition', main, fieldPosition); assert.equal(value.uri, pathToFileURL(file).href); assert.deepEqual(value.range.start, { line, character });
  const row = { file, line, character, targetSha256: hash(targetText), lsp: value };
  if (cliToo) {
   row.disk = agent(['definition', main, '--position', '1:10']); row.stdin = agent(['definition', '-', '--stdin-filepath', main, '--position', '1:10'], source); assert.deepEqual(row.disk, row.stdin);
   assert.equal(row.disk.exit, 0); assert.equal(row.disk.data.result.file, file); assert.equal(row.disk.data.result.sourceSha256, hash(targetText)); assert.deepEqual(row.disk.data.result.range.start, { line, character });
  }
  report.protocol.push(row); return row;
 }
 await open(main, source); await target(api, 1, 2, module); report.protocol.push('Module reexport and JSONC alias source origin with target SHA256 in CLI');
 const method = await request('definition', main, methodPosition); assert.equal(method.uri, pathToFileURL(api).href); assert.deepEqual(method.range.start, { line: 2, character: 11 });
 assert.deepEqual(await request('references', main, fieldPosition, { context: { includeDeclaration: true } }), []); assert.equal(await request('prepareRename', main, fieldPosition), null); report.protocol.push('Exported method token and field rename/reference refusal');
 await open(api, '-- unsaved\r\n' + module); await target(api, 2, 2, '-- unsaved\r\n' + module, false); report.protocol.push('Unsaved dependency origin shifts in editor while CLI retains disk custody');
 const disk = agent(['definition', main, '--position', '1:10']); assert.deepEqual(disk.data.result.range.start, { line: 1, character: 2 }); assert.equal(disk.data.result.sourceSha256, hash(module)); report.unsavedDiskControl = disk;
 await open(api, 'local broken=', 2, true); assert.equal(await request('definition', main, fieldPosition), null); report.protocol.push('Malformed imported buffer cannot retain a stale field origin');
 await open(api, '-- repaired\n' + module, 3, true); await target(api, 2, 2, '-- repaired\n' + module, false);
 await close(api); await target(api, 1, 2, module); report.protocol.push('Dependency buffer repair and close return to exact disk origin');
 const shifted = '-- disk changed\n\n' + module;
 let changed = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === pathToFileURL(main).href);
 await fs.writeFile(api, shifted); await changed; await target(api, 3, 2, shifted); report.protocol.push('Ordinary dependency watcher invalidates source origin and hash');
 await fs.mkdir(path.join(folder, 'alternate')); const alternate = path.join(folder, 'alternate/api.luau'), alternativeSource = 'return {field=42,double=function(n: number): number return n*2 end}'; await fs.writeFile(alternate, alternativeSource);
 changed = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === pathToFileURL(main).href); await fs.writeFile(config, '{"aliases":{"lib":"alternate"}}'); await changed; await target(alternate, 0, 8, alternativeSource); report.protocol.push('Ordinary config watcher moves member origin to the selected module');
 const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), bin = path.join(local, 'build/slua-oracle'), build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
 const verification = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(verification.exit, 0); report.sourceVerification = JSON.parse(verification.stdout); report.build = build;
 assert.equal(report.sourceVerification.contentSha256, build.inputs.sourceContentSha256); for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
 report.generated = [];
 for (const [label, contents] of [['alternative', '{"aliases":{"lib":"alternate"}}'], ['original', '{"aliases":{"lib":"library"}}']]) {
  await fs.writeFile(config, contents);
  const result = agent(['preprocess', main]); assert.equal(result.exit, 0); const file = path.join(folder, label + '.generated.luau'); await fs.writeFile(file, result.data.content, { flag: 'wx' });
  const compile = run(path.join(bin, 'slua-compile'), ['--null', file]), execute = run(path.join(bin, 'slua'), ['--sl', file]); assert.equal(compile.exit, 0); assert.equal(execute.exit, 0); assert.equal(execute.stdout, '42\t4\n'); assert.equal(execute.stderr, '');
  report.generated.push({ label, file, sha256: hash(result.data.content), compile, execute });
 }
 await close(main); await open(main, source); await target(api, 3, 2, shifted); report.protocol.push('Importer close/reopen restores fresh member navigation');
 const raceFile = path.join(folder, 'race.luau'), raceUri = pathToFileURL(raceFile).href;
 // Cold project I/O gives a real await boundary. The next version is observed
 // before accepting the old response; the original disk source resolves in CLI.
 await fs.writeFile(path.join(folder, 'cold.luau'), '--' + 'x'.repeat(1024*1024) + '\nreturn {field=42}');
 const raceSource = 'local api=require("cold")\nprint(api.field)'; await fs.writeFile(raceFile, raceSource);
 const raceControl = agent(['definition', raceFile, '--position', '1:10']); assert.equal(raceControl.exit, 0); report.raceControl = raceControl;
 lsp.notify('textDocument/didOpen', { textDocument: { uri: raceUri, languageId: 'luau', version: 1, text: raceSource } });
 const stale = request('definition', raceFile, fieldPosition);
 let observed = false; const acknowledged = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === raceUri && p.version === 2).then(() => { observed = true; });
 lsp.notify('textDocument/didChange', { textDocument: { uri: raceUri, version: 2 }, contentChanges: [{ text: 'print("new-buffer")' }] });
 await acknowledged; const staleResult = await stale; assert.ok(observed); assert.equal(staleResult, null); report.protocol.push('Changed importer version refuses its in-flight old definition');
 await close(raceFile);
 report.passed = true;
} finally { if (lsp) await lsp.close(); await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close(); }
console.log(JSON.stringify({ passed: report.passed, sourceCases: report.cases.length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, generatedPrograms: report.generated?.length, evidence: output }));
