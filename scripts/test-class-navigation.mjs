import { SourceTextIndex } from '../slua-lsp-core/out/parser/sourceTextIndex.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_CLASS_NAVIGATION_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_CLASS_NAVIGATION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const destination = process.env.SLUA_CLASS_NAVIGATION_EVIDENCE ?? path.join(root, '.local/logs/class-navigation.json');
const bin = path.join(process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), 'build/slua-oracle');
const flag = '--fflags=DebugLuauUserDefinedClasses=true';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fixture = path.join(root, 'scripts/fixtures/class-navigation.json');
await fs.mkdir(path.dirname(destination), { recursive: true }); const output = await fs.open(destination, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true }); const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/class-navigation-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath, executableSha256: hash(await fs.readFile(process.execPath)),
 cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)), folder, cases: [], protocol: [], cliProcesses: 0,
 scope: 'Exact document-local class type/value navigation and capture-safe rename with generic/typeof lexical identity. Actual CLI file/stdin proposals, versioned stdio unsaved buffers, recovery and fresh reopen; pinned native syntax/bytecode/strict and pure local original/renamed runtime. An explicitly bound prior profile may supply unchanged native observations; actual CLI/protocol observations always execute. No GUI, FS IPC, world effects or unchanged native rebuild.' };
let lsp, version = 0;
function run(exe, args, input) { const p = spawnSync(exe, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); assert.ifError(p.error); assert.equal(p.signal, null); return { exit: p.status, stdout: p.stdout, stderr: p.stderr }; }
function agent(args, input) { report.cliProcesses++; const p = run(process.execPath, [cli, ...args, '--json'], input); assert.equal(p.stderr, ''); return { exit: p.exit, data: JSON.parse(p.stdout) }; }
function range(index, offset) { const start = index.positionAt(offset); return { start, end: { ...start, character: start.character + 3 } }; }
function apply(source, edits) {
 const index = new SourceTextIndex(source); let last = source.length;
 for (const edit of [...edits].sort((a, b) => index.offsetAt(b.range.start) - index.offsetAt(a.range.start))) { const start = index.offsetAt(edit.range.start), end = index.offsetAt(edit.range.end); assert.ok(start !== undefined && end !== undefined && end <= last); assert.equal(source.slice(start, end), 'Box'); source = source.slice(0, start) + edit.newText + source.slice(end); last = start; }
 return source;
}
function native(file) {
 const result = { syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flag, file]), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, file]), strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flag, file]), execution: run(path.join(bin, 'slua'), ['--sl', flag + ',DebugLuauUserDefinedClassesRuntime=true', file]) };
 for (const [key, row] of Object.entries(result)) assert.equal(row.exit, 0, key + ': ' + JSON.stringify(row)); return result;
}
try {
 report.build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
 for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), report.build.binaries[name]);
 let previous;
 if (process.env.SLUA_CLASS_NAVIGATION_NATIVE_REUSE || process.env.SLUA_CLASS_NAVIGATION_NATIVE_PREFIX) {
  const file = process.env.SLUA_CLASS_NAVIGATION_NATIVE_REUSE ?? process.env.SLUA_CLASS_NAVIGATION_NATIVE_PREFIX, bytes = await fs.readFile(file); previous = JSON.parse(bytes);
  assert.ok(previous.passed === true || process.env.SLUA_CLASS_NAVIGATION_NATIVE_PREFIX && previous.nativePrefixComplete === true); if (!process.env.SLUA_CLASS_NAVIGATION_NATIVE_PREFIX) assert.equal(previous.fixtureSha256, report.fixtureSha256); assert.deepEqual(previous.build, report.build);
  report.nativeReuse = { file, sha256: hash(bytes), completedPrefix: Boolean(process.env.SLUA_CLASS_NAVIGATION_NATIVE_PREFIX) };
 } else {
  const checked = run('python3', ['scripts/prepare-oracle.py', '--local-dir', path.dirname(path.dirname(bin)), '--check']); assert.equal(checked.exit, 0, checked.stderr);
  report.sourceVerification = JSON.parse(checked.stdout); assert.equal(report.sourceVerification.contentSha256, report.build.inputs.sourceContentSha256);
 }
 const registry = buildSluaRegistryFromLslDefinitions(null);
 const file = path.join(folder, 'unsaved.luau'), uri = pathToFileURL(file).href;
 await fs.writeFile(file, '-- disk intentionally differs from all unsaved buffers\nprint("disk")', { flag: 'wx' });
 lsp = launchServer(server, root); const initialized = await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } }); lsp.notify('initialized', {});
 async function change(source, recovery = false) {
  version++; const pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === version);
  lsp.notify(version === 1 ? 'textDocument/didOpen' : 'textDocument/didChange', version === 1 ? { textDocument: { uri, languageId: 'luau', version, text: source } } : { textDocument: { uri, version }, contentChanges: [{ text: source }] });
  const diagnostics = (await pending).diagnostics;
  if (recovery) assert.ok(diagnostics.some((d) => d.code === 'parse-error')); else assert.deepEqual(diagnostics, []);
  report.protocol.push({ version, sourceSha256: hash(source), diagnostics });
 }
 for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
  const original = path.join(folder, item.name + '.luau'); await fs.writeFile(original, item.source, { flag: 'wx' });
  const index = new SourceTextIndex(item.source), position = index.positionAt(item.source.indexOf('class Box') + 6), point = `${position.line}:${position.character}`;
  const row = { ...item, file: original, sourceSha256: hash(item.source) }; report.cases.push(row);
  const parsed = parseSlua(item.source); assert.deepEqual(parsed.diagnostics, []); assert.deepEqual(analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry }), []);
  row.rename = { disk: agent(['rename', original, '--position', point, '--new-name', item.newName]), stdin: agent(['rename', '-', '--stdin-filepath', original, '--position', point, '--new-name', item.newName], item.source) };
  assert.deepEqual(row.rename.disk, row.rename.stdin); assert.equal(row.rename.disk.data.sourceSha256, row.sourceSha256); assert.equal(row.rename.disk.exit, item.expectSafeRename ? 0 : 1);
  assert.equal(row.rename.disk.data.status, item.expectSafeRename ? 'found' : 'binding-conflict');
  const proposed = row.rename.disk.data.result ?? [];
  assert.deepEqual(proposed.map((e) => index.offsetAt(e.range.start)).sort((a, b) => a - b), item.expectedRenameOffsets);
  const prior = previous?.cases.find((x) => x.name === item.name);
  if (previous && !report.nativeReuse.completedPrefix) assert.ok(prior);
  if (prior) { assert.equal(prior.sourceSha256, row.sourceSha256); for (const item of Object.values(prior.native)) assert.equal(item.exit, 0); row.native = prior.native; }
  else row.native = native(original);
  if (item.expectSafeRename) {
   const source = apply(item.source, proposed); assert.equal(source, item.expectedRenamedSource);
   const reparsed = parseSlua(source); assert.deepEqual(reparsed.diagnostics, []); assert.deepEqual(analyzeTextWithDirectives(source, { ast: reparsed.ast, registry }), []);
   const renamed = path.join(folder, item.name + '.renamed.luau'); await fs.writeFile(renamed, source, { flag: 'wx' });
   row.renamed = { file: renamed, sourceSha256: hash(source), source, native: prior ? prior.renamed.native : native(renamed) };
   assert.deepEqual(row.renamed.native.execution, row.native.execution);
   if (prior) { assert.equal(prior.renamed.sourceSha256, row.renamed.sourceSha256); for (const item of Object.values(prior.renamed.native)) assert.equal(item.exit, 0); }
   const selected = index.positionAt(item.expectedRenameOffsets[1] ?? item.expectedRenameOffsets[0]), other = `${selected.line}:${selected.character}`;
   row.selected = selected; row.navigation = {};
   for (const command of ['definition', 'references', 'hover', 'rename']) {
    const flags = ['--position', other, ...(command === 'rename' ? ['--new-name', item.newName] : [])];
    const disk = agent([command, original, ...flags]), stdin = agent([command, '-', '--stdin-filepath', original, ...flags], item.source); assert.deepEqual(disk, stdin); assert.equal(disk.exit, 0); row.navigation[command] = disk;
   }
   assert.deepEqual(row.navigation.rename.data.result, proposed);
   assert.deepEqual(row.navigation.definition.data.result.range, range(index, item.source.indexOf('class Box') + 6));
   assert.deepEqual(row.navigation.references.data.result.map((x) => index.offsetAt(x.range.start)).sort((a, b) => a - b), item.expectedRenameOffsets);
   await change(item.source);
   const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: selected }); assert.equal(definition.uri, uri); assert.deepEqual(definition.range, row.navigation.definition.data.result.range);
   const refs = await lsp.request('textDocument/references', { textDocument: { uri }, position: selected, context: { includeDeclaration: true } }); assert.equal(refs.length, proposed.length);
   assert.deepEqual(refs.map((x) => index.offsetAt(x.range.start)).sort((a, b) => a - b), item.expectedRenameOffsets);
   const prepare = await lsp.request('textDocument/prepareRename', { textDocument: { uri }, position: selected }); assert.deepEqual(prepare, { placeholder: 'Box', range: range(index, item.expectedRenameOffsets[1] ?? item.expectedRenameOffsets[0]) });
   const edit = await lsp.request('textDocument/rename', { textDocument: { uri }, position: selected, newName: item.newName }); assert.deepEqual(edit.documentChanges[0].textDocument, { uri, version });
   assert.deepEqual(edit.documentChanges[0].edits, proposed.map(({ range, newText }) => ({ range, newText })));
   const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: selected }); assert.equal(hover.contents.value, row.navigation.hover.data.result.markdown);
   row.protocol = { definition, references: refs, prepare, edit, hover };
   await change(source);
   const semantic = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } });
   const legend = initialized.capabilities.semanticTokensProvider.legend, readonly = legend.tokenModifiers.indexOf('readonly'); assert.ok(readonly >= 0);
   let line = 0, character = 0; const decoded = [];
   for (let i = 0; i < semantic.data.length; i += 5) { const delta = semantic.data[i]; line += delta; character = delta ? semantic.data[i + 1] : character + semantic.data[i + 1]; decoded.push({ line, character, length: semantic.data[i + 2], type: legend.tokenTypes[semantic.data[i + 3]], readonly: Boolean(semantic.data[i + 4] & (1 << readonly)) }); }
   const renamedIndex = new SourceTextIndex(source);
   for (const [i, offset] of item.expectedRenameOffsets.entries()) { const position = renamedIndex.positionAt(offset + i * (item.newName.length - 3)); const token = decoded.find((entry) => entry.line === position.line && entry.character === position.character); assert.ok(token?.readonly, JSON.stringify({ name: item.name, position, token })); assert.notEqual(token.type, 'keyword'); }
   row.protocol.renamedSemantic = { version, tokens: decoded };
  } else {
   await change(item.source); const edit = await lsp.request('textDocument/rename', { textDocument: { uri }, position, newName: item.newName }); assert.equal(edit, null); row.protocol = { edit };
  }
 }
 const invalidSelf = 'class self\nfunction change() self=nil end\nend', invalidFile = path.join(folder, 'invalid-static-self.luau');
 await fs.writeFile(invalidFile, invalidSelf, { flag: 'wx' });
 const invalid = { sourceSha256: hash(invalidSelf), file: invalidFile, disk: agent(['check', invalidFile, '--warnings-as-errors']), stdin: agent(['check', '-', '--stdin-filepath', invalidFile, '--warnings-as-errors'], invalidSelf) };
 assert.deepEqual(invalid.disk, invalid.stdin); assert.equal(invalid.disk.exit, 1); assert.ok(invalid.disk.data.diagnostics.some((d) => d.code === 'parse-error'));
 if (previous?.invalidStaticSelf) { assert.equal(previous.invalidStaticSelf.sourceSha256, invalid.sourceSha256); invalid.native = previous.invalidStaticSelf.native; }
 else invalid.native = { syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flag, invalidFile]), strict: run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flag, invalidFile]) };
 assert.equal(invalid.native.syntax.exit, 1); assert.equal(invalid.native.strict.exit, 1); report.invalidStaticSelf = invalid; await change(invalidSelf, true);
 await change('class Broken\n', true); await change(report.cases[0].source);
 const restored = await lsp.request('textDocument/references', { textDocument: { uri }, position: { line: 1, character: 12 }, context: { includeDeclaration: true } }); assert.equal(restored.length, 3); report.protocol.push({ recoveryReferences: restored });
 const closed = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri); lsp.notify('textDocument/didClose', { textDocument: { uri } }); await closed;
 assert.deepEqual(await lsp.request('textDocument/references', { textDocument: { uri }, position: { line: 0, character: 6 }, context: { includeDeclaration: true } }), []);
 version = 0; await change('class Fresh end\nlocal item: Fresh=Fresh{}\nprint(item)');
 const reopened = await lsp.request('textDocument/rename', { textDocument: { uri }, position: { line: 1, character: 12 }, newName: 'Final' }); assert.equal(reopened.documentChanges[0].edits.length, 3); report.protocol.push({ freshReopen: reopened });
 report.passed = true;
} finally { if (lsp) await lsp.close(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); }
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, cliProcesses: report.cliProcesses, protocol: report.protocol.length, nativeReused: Boolean(report.nativeReuse), evidence: destination }));
