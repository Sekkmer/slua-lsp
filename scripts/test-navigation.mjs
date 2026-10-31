import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = process.env.SLUA_NAVIGATION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_NAVIGATION_EVIDENCE ?? path.join(root, '.local/logs/navigation.json');
const source = [
	'local value = "x"',
	'local object = {[value] = 1, value = value}',
	'while false do local value = "inner"; print(value); break end',
	'object[value] = object[value] + 1',
	'print("😀", value, object.value, object.x)'
].join('\r\n');
function apply(text, edits) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	for (const edit of [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
		text = text.slice(0, starts[edit.range.start.line] + edit.range.start.character) + edit.newText + text.slice(starts[edit.range.end.line] + edit.range.end.character);
	}
	return text;
}
const results = [];
let renamedSource;
for (const versioned of [true, false]) {
	const lsp = launchServer(entry, root);
	const uri = pathToFileURL(path.join(root, '.local/fixtures/navigation-primary.luau')).href;
	const other = pathToFileURL(path.join(root, '.local/fixtures/navigation-other.luau')).href;
	async function change(method, params) {
		const event = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === (params.textDocument?.uri ?? uri));
		lsp.notify(method, params); await event;
	}
	const request = (method, position, extra = {}) => lsp.request(`textDocument/${method}`, { textDocument: { uri }, position, ...extra });
	try {
		await lsp.request('initialize', { processId: process.pid, rootUri: null, capabilities: { workspace: { workspaceEdit: { documentChanges: versioned } } } });
		lsp.notify('initialized', {});
		await change('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: source } });
		await change('textDocument/didOpen', { textDocument: { uri: other, languageId: 'luau', version: 1, text: 'local value = 2\nprint(value)' } });
		assert.equal((await request('definition', { line: 3, character: 1 })).range.start.line, 1);
		assert.equal((await request('definition', { line: 0, character: 7 })).range.start.line, 0);
		const refs = await request('references', { line: 0, character: 7 }, { context: { includeDeclaration: true } });
		assert.equal(refs.length, 6);
		assert.ok(refs.every((ref) => ref.uri === uri));
		assert.ok(refs.some((ref) => ref.range.start.line === 4 && ref.range.start.character === 12));
		assert.equal((await request('references', { line: 0, character: 7 }, { context: { includeDeclaration: false } })).length, 5);
		assert.equal(await request('prepareRename', { line: 1, character: source.split('\r\n')[1].lastIndexOf('value =') }), null);
		results.push({ versioned, check: 'declaration/LHS/computed key/UTF-16 references; field and second-document isolation' });
		const edit = await request('rename', { line: 0, character: 7 }, { newName: 'key' });
		const edits = versioned ? edit.documentChanges[0].edits : edit.changes[uri];
		if (versioned) { assert.deepEqual(edit.documentChanges[0].textDocument, { uri, version: 1 }); assert.equal(edit.changes, undefined); }
		assert.equal(edits.length, 6);
		renamedSource = apply(source, edits);
		assert.ok(renamedSource.includes('{[key] = 1, value = key}'));
		assert.ok(renamedSource.includes('local value = "inner"'));
		assert.ok(renamedSource.includes('object.value'));
		await change('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: renamedSource }] });
		assert.equal((await request('references', { line: 0, character: 7 }, { context: { includeDeclaration: true } })).length, 6);
		results.push({ versioned, check: 'rename proposal re-applies and resolves; versioned edits when supported' });
		await change('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'local source = 1\ndo local target = 2; print(source, target) end' }] });
		assert.equal(await request('rename', { line: 0, character: 7 }, { newName: 'target' }), null);
		await change('textDocument/didChange', { textDocument: { uri, version: 4 }, contentChanges: [{ text: 'local source = 1\nlocal =' }] });
		assert.equal(await request('prepareRename', { line: 0, character: 7 }), null);
		assert.equal(await request('rename', { line: 0, character: 7 }, { newName: 'target' }), null);
		results.push({ versioned, check: 'binding capture and recovered syntax-error buffers refuse rename' });
		await change('textDocument/didClose', { textDocument: { uri } });
		assert.equal(await request('definition', { line: 0, character: 7 }), null);
		assert.deepEqual(await request('references', { line: 0, character: 7 }, { context: { includeDeclaration: true } }), []);
		await change('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'luau', text: 'local fresh = 1\nprint(fresh)' } });
		assert.equal((await request('references', { line: 0, character: 7 }, { context: { includeDeclaration: true } })).length, 2);
		results.push({ versioned, check: 'close/reopen same version uses the new lexical snapshot' });
	} finally { await lsp.close(); }
}

// The only native operations are syntax compilation and executing this pure local program.
const bin = path.join(process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), 'build/slua-oracle');
const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
const native = [];
const dir = path.join(root, '.local/navigation-native');
await fs.mkdir(dir, { recursive: true });
for (const name of ['slua', 'slua-compile']) assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(bin, name))).digest('hex'), build.binaries[name]);
for (const [label, text] of [['original', source], ['renamed', renamedSource]]) {
	const file = path.join(dir, `${label}.luau`); await fs.writeFile(file, text);
	const syntax = spawnSync(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file], { encoding: 'utf8', timeout: 15000 });
	assert.equal(syntax.status, 0, syntax.stderr);
	const runtime = spawnSync(path.join(bin, 'slua'), [file], { encoding: 'utf8', timeout: 15000 });
	assert.equal(runtime.status, 0, runtime.stderr);
	native.push({ label, sourceSha256: crypto.createHash('sha256').update(text).digest('hex'), syntaxExit: syntax.status, runtimeExit: runtime.status, stdout: runtime.stdout, stderr: runtime.stderr });
}
assert.equal(native[0].stdout, native[1].stdout);
const report = { passed: true, measuredAt: new Date().toISOString(), entry, entrySha256: crypto.createHash('sha256').update(await fs.readFile(entry)).digest('hex'), results,
	native, nativeBuildInputSha256: build.inputSha256, scope: 'Local lexical value bindings and pure local runtime equivalence. No viewer/FS IPC or simulator API calls.' };
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
