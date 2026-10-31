import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions } from '../slua-lsp-core/out/index.js';
import { SourceTextIndex } from '../slua-lsp-core/out/parser/sourceTextIndex.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_GOTCHAS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_GOTCHAS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_GOTCHAS_EVIDENCE ?? path.join(root, '.local/logs/gotchas.json');
const fixture = path.join(root, 'scripts/fixtures/gotchas.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/gotchas-'));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), bin = path.join(local, 'build/slua-oracle');
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], protocol: [],
	scope: 'Custom advice on native-valid programs, not compiler errors or native lint parity. Independent native syntax/compile/local-runtime, exact CLI file/stdin warnings-as-errors and LSP suppression/repair. No viewer/FS IPC, simulator or native rebuild.' };
function run(command, args, input) {
	const child = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
	assert.ifError(child.error); assert.equal(child.signal, null);
	return { exit: child.status, stdout: child.stdout, stderr: child.stderr };
}
function agent(args, input) {
	const value = run(process.execPath, [cli, ...args, '--json'], input);
	assert.equal(value.stderr, ''); return { exit: value.exit, data: JSON.parse(value.stdout) };
}
function apply(text, edits) {
	const index = new SourceTextIndex(text);
	for (const edit of edits) { assert.notEqual(index.offsetAt(edit.range.start), undefined); assert.notEqual(index.offsetAt(edit.range.end), undefined); }
	for (const edit of [...edits].sort((a, b) => index.offsetAt(b.range.start) - index.offsetAt(a.range.start))) {
		text = text.slice(0, index.offsetAt(edit.range.start)) + edit.newText + text.slice(index.offsetAt(edit.range.end));
	}
	return text;
}
let lsp;
try {
	const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
	const verified = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(verified.exit, 0);
	report.sourceVerification = JSON.parse(verified.stdout); report.build = build;
	assert.equal(report.sourceVerification.contentSha256, build.inputs.sourceContentSha256);
	for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	const registry = buildSluaRegistryFromLslDefinitions(null);
	for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
		const file = path.join(folder, item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
		const record = { ...item, file, sha256: hash(Buffer.from(item.source)), agents: [] }; report.results.push(record);
		record.syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]); assert.equal(record.syntax.exit, 0, item.name);
		record.compile = run(path.join(bin, 'slua-compile'), ['--null', file]); assert.equal(record.compile.exit, 0, item.name);
		record.runtime = run(path.join(bin, 'slua'), ['--sl', file]); assert.equal(record.runtime.exit, 0, item.name + ': ' + record.runtime.stderr);
		assert.equal(record.runtime.stdout, item.stdout); assert.equal(record.runtime.stderr, '');
		const parsed = parseSlua(item.source); assert.deepEqual(parsed.diagnostics, []);
		record.diagnostics = analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry }); assert.deepEqual(record.diagnostics.map((d) => d.code).sort(), [...item.codes].sort(), item.name);
		for (const command of ['symbols', 'check']) {
			const extra = command === 'check' ? ['--warnings-as-errors'] : [];
			const disk = agent([command, file, ...extra]), stdin = agent([command, '-', '--stdin-filepath', file, ...extra], item.source);
			record.agents.push({ command, disk, stdin }); assert.deepEqual(disk, stdin);
			assert.equal(disk.exit, command === 'check' && item.codes.length ? 1 : 0, item.name + ': ' + JSON.stringify(disk));
			if (command === 'check') assert.deepEqual(disk.data.diagnostics.map((d) => d.code).sort(), [...item.codes].sort(), item.name);
			else assert.equal(disk.data.sourceSha256, hash(Buffer.from(item.source)));
		}
		if (item.codes.length) {
			record.defaultCheck = agent(['check', file]); record.defaultStdin = agent(['check', '-', '--stdin-filepath', file], item.source);
			assert.deepEqual(record.defaultCheck, record.defaultStdin); assert.equal(record.defaultCheck.exit, 0);
			assert.equal(record.defaultCheck.data.summary.errors, 0); assert.equal(record.defaultCheck.data.summary.warnings, item.codes.length);
		}
	}
	const original = '-- 😀\r\nif 0 then print("taken") end\r\nfor k,v in ipairs({name=42}) do print(k,v) end';
	const file = path.join(folder, 'protocol.luau'), uri = pathToFileURL(file).href; await fs.writeFile(file, original, { flag: 'wx' });
	lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } }); lsp.notify('initialized', {});
	let version = 1;
	let pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === version);
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version, text: original } });
	let diagnostics = (await pending).diagnostics;
	assert.deepEqual(diagnostics.map((d) => d.code).sort(), ['ipairs-literal-hole', 'truthy-literal']);
	assert.deepEqual(diagnostics.find((d) => d.code === 'truthy-literal').range.start, { line: 1, character: 3 });
	report.protocol.push('Both custom warnings publish on native-valid original CRLF source');
	let source = original;
	for (const code of ['truthy-literal', 'ipairs-literal-hole']) {
		const diagnostic = diagnostics.find((d) => d.code === code); assert.ok(diagnostic);
		const actions = await lsp.request('textDocument/codeAction', { textDocument: { uri }, range: diagnostic.range, context: { diagnostics: [diagnostic], only: ['quickfix'] } });
		const action = actions.find((item) => item.title === `Suppress '${code}' on this line`); assert.ok(action);
		const change = action.edit.documentChanges[0]; assert.deepEqual(change.textDocument, { uri, version });
		source = apply(source, change.edits); assert.ok(source.includes('-- slua-lsp:disable-next-line ' + code + '\r\n'));
		version++; pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === version);
		lsp.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: source }] }); diagnostics = (await pending).diagnostics;
		assert.ok(!diagnostics.some((d) => d.code === code)); report.protocol.push(code + ': versioned generic suppression edit preserves CRLF and clears that warning');
	}
	assert.equal(diagnostics.length, 0);
	version++; pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === version);
	lsp.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: original.replace('if 0 then', 'if 0 == 0 then').replace('ipairs(', 'pairs(') }] });
	assert.equal((await pending).diagnostics.length, 0); report.protocol.push('Explicit comparison and pairs repair advice without suppression');
	assert.equal(await fs.readFile(file, 'utf8'), original); report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
	try { await lsp?.close(); } catch (error) { report.shutdownError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
	await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.results.length, protocol: report.protocol.length, output }));
