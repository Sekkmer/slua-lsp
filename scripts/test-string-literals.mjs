import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_STRINGS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_STRINGS_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_STRINGS_EVIDENCE ?? path.join(root, '.local/logs/string-literals.json');
const fixture = path.join(root, 'scripts/fixtures/string-literals.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/string-literals-'));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], protocol: [],
	scope: 'Verified pinned native pure local byte-value executions, core AST values, actual CLI file/stdin syntax and stdio LSP recovery. No native rebuild, FS IPC, viewer or host effects.' };
function run(command, args, input) {
	const child = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
	assert.ifError(child.error); assert.equal(child.signal, null);
	return { exit: child.status, stdout: child.stdout, stderr: child.stderr };
}
function agent(args, input) {
	const value = run(process.execPath, [cli, ...args, '--json'], input);
	assert.equal(value.stderr, ''); return { exit: value.exit, data: JSON.parse(value.stdout) };
}
let lsp;
try {
	const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
	const verified = run('python3', ['scripts/prepare-oracle.py', '--local-dir', local, '--check']); assert.equal(verified.exit, 0);
	report.sourceVerification = JSON.parse(verified.stdout); report.build = build;
	assert.equal(report.sourceVerification.contentSha256, build.inputs.sourceContentSha256);
	for (const name of ['slua', 'slua-compile']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
		const source = 'local value=' + item.literal + '\nprint(value)', file = path.join(folder, item.name + '.luau');
		await fs.writeFile(file, source, { flag: 'wx' });
		const syntax = run(path.join(bin, 'slua-compile'), ['--null', file]); assert.equal(syntax.exit, item.valid ? 0 : 1);
		const parsed = parseSlua(source); assert.equal(parsed.diagnostics.length === 0, item.valid);
		const disk = agent(['symbols', file]), stdin = agent(['symbols', '-', '--stdin-filepath', file], source);
		assert.equal(disk.exit, item.valid ? 0 : 1); assert.deepEqual(disk, stdin); assert.equal(disk.data.sourceSha256, hash(Buffer.from(source)));
		const record = { name: item.name, valid: item.valid, file, sha256: hash(Buffer.from(source)), syntax, agent: disk };
		if (item.valid) {
			const values = [];
			function visit(node) { if (!node || typeof node !== 'object') return; if (node.type === 'String') values.push(node.value); for (const [key, value] of Object.entries(node)) if (key !== 'location') { if (Array.isArray(value)) value.forEach(visit); else visit(value); } }
			visit(parsed.ast); assert.deepEqual(values, [item.value]);
			// Surrogate escapes encode invalid bytes, while every other code point
			// is UTF-8. This checks byte identity independently of the core decoder.
			const bytes = [];
			for (const char of item.value) { const code = char.codePointAt(0); if (code >= 0xdc80 && code <= 0xdcff) bytes.push(code - 0xdc00); else bytes.push(...Buffer.from(char)); }
			record.expectedHex = Buffer.from(bytes).toString('hex');
			const runtimeFile = path.join(folder, item.name + '-runtime.luau');
			const program = 'local value=' + item.literal + '\nlocal bytes={}\nfor i=1,#value do bytes[i]=string.format("%02x",string.byte(value,i)) end\nprint(table.concat(bytes))';
			await fs.writeFile(runtimeFile, program, { flag: 'wx' }); record.runtimeFile = runtimeFile; record.runtimeSourceSha256 = hash(Buffer.from(program));
			record.runtime = run(path.join(bin, 'slua'), ['--sl', runtimeFile]);
			assert.equal(record.runtime.exit, 0); assert.equal(record.runtime.stdout, record.expectedHex + '\n'); assert.equal(record.runtime.stderr, '');
		}
		report.results.push(record);
	}
	const source = 'math["\\x61bs"]("bad")', checked = agent(['check', '-', '--warnings-as-errors'], source);
	assert.equal(checked.exit, 1); assert.deepEqual(checked.data.diagnostics.map((d) => d.code), ['call-argument-type-mismatch']); report.cliDiagnostics = checked;
	const main = path.join(folder, 'main.luau'), module = path.join(folder, 'mod.luau');
	const imported = 'local value=require("\\x6dod")\nmath["\\x61bs"]("bad")\nprint(value)';
	await fs.writeFile(main, imported, { flag: 'wx' }); await fs.writeFile(module, 'return 42', { flag: 'wx' });
	const graph = agent(['modules', main]); assert.equal(graph.exit, 0); assert.equal(graph.data.edges[0].target, module); report.cliModules = graph;
	lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
	const uri = pathToFileURL(main).href;
	let pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.diagnostics.some((d) => d.code === 'call-argument-type-mismatch'));
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: imported } });
	const found = await pending; assert.equal(found.diagnostics.length, 1); assert.equal(found.diagnostics[0].range.start.line, 1);
	const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 24 } }); assert.equal(definition.uri, pathToFileURL(module).href);
	report.protocol.push('Escaped module path definition and escaped builtin argument diagnostic');
	pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.diagnostics.some((d) => d.code === 'parse-error'));
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'print("\\xGG")' }] }); await pending;
	pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === 3 && params.diagnostics.length === 0);
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'math["\\097bs"](42)' }] }); await pending;
	report.protocol.push('Malformed escape refuses parsing and subsequent decimal escape repair clears diagnostics');
	assert.equal(await fs.readFile(main, 'utf8'), imported); report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
	try { await lsp?.close(); } catch (error) { report.shutdownError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
	await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
if (!report.passed) process.stderr.write(JSON.stringify(report) + '\n');
else console.log(JSON.stringify({ passed: true, cases: report.results.length, protocol: report.protocol.length, report: output }));
