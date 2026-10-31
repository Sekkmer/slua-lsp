import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_INTERPOLATION_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_INTERPOLATION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_INTERPOLATION_EVIDENCE ?? path.join(root, '.local/logs/interpolation.json');
const fixture = path.join(root, 'scripts/fixtures/interpolation.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/interpolation-'));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], protocol: [],
	scope: 'Verified native interpolation syntax, separate compilation/runtime, strict type checks and actual CLI/stdin/stdio recovery. No native rebuild, FS IPC, viewer or host effects.' };
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
	for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	for (const item of JSON.parse(await fs.readFile(fixture, 'utf8'))) {
		const source = item.source, file = path.join(folder, item.name + '.luau'); await fs.writeFile(file, source, { flag: 'wx' });
		const syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]); assert.equal(syntax.exit, item.valid ? 0 : 1);
		const parsed = parseSlua(source); assert.equal(parsed.diagnostics.length === 0, item.valid);
		const disk = agent(['symbols', file]), stdin = agent(['symbols', '-', '--stdin-filepath', file], source);
		assert.equal(disk.exit, item.valid ? 0 : 1); assert.deepEqual(disk, stdin); assert.equal(disk.data.sourceSha256, hash(Buffer.from(source)));
		const check = agent(['check', file, '--warnings-as-errors']);
		assert.equal(check.exit, item.valid && item.name !== 'one-result' ? 0 : 1);
		if (item.name === 'one-result') assert.deepEqual(check.data.diagnostics.map((d) => d.code), ['assignment-return-count-mismatch']);
		const record = { name: item.name, valid: item.valid, file, sha256: hash(Buffer.from(source)), syntax, agent: disk, check };
		if (item.valid) {
			record.compile = run(path.join(bin, 'slua-compile'), ['--null', file]); assert.equal(record.compile.exit, item.compileExit ?? 0);
			record.runtime = run(path.join(bin, 'slua'), ['--sl', file]); assert.equal(record.runtime.exit, item.runtimeExit ?? 0);
			if (item.runtimeError) assert.ok(record.runtime.stderr.includes(item.runtimeError));
			else { assert.equal(record.runtime.stdout, item.stdout); assert.equal(record.runtime.stderr, ''); }
		}
		report.results.push(record);
	}
	report.types = [];
	for (const item of [
		{ name: 'number', source: 'local value: string=`{42}`\nstring.lower(value)', valid: true },
		{ name: 'boolean', source: 'local value: string=`{false}`\nstring.lower(value)', valid: true },
		{ name: 'nil', source: 'local value: string=`{nil}`\nstring.lower(value)', valid: true },
		{ name: 'return', source: 'local function message(): string return `{42}` end\nstring.lower(message())', valid: true },
		{ name: 'wrong-number', source: 'math.abs(`{42}`)', valid: false }
	]) {
		const file = path.join(folder, 'type-' + item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
		const native = run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', file]);
		assert.equal(native.exit, item.valid ? 0 : 1);
		const cli = agent(['check', '-', '--stdin-filepath', file, '--warnings-as-errors'], item.source); assert.equal(cli.exit, item.valid ? 0 : 1);
		report.types.push({ ...item, file, sha256: hash(Buffer.from(item.source)), native, agent: cli });
	}
	const source = 'const value=42\r\nlocal message=`outer {`inner {value} {"}"}`} end`\r\nmath.abs(message)';
	const file = path.join(folder, 'navigation.luau'); await fs.writeFile(file, source, { flag: 'wx' }); const uri = pathToFileURL(file).href;
	lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
	let pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.diagnostics.some((d) => d.code === 'call-argument-type-mismatch'));
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: source } });
	const found = await pending; assert.equal(found.diagnostics.length, 1); assert.equal(found.diagnostics[0].range.start.line, 2);
	const position = { line: 1, character: source.split('\r\n')[1].indexOf('value}') + 2 }, request = { textDocument: { uri }, position };
	const definition = await lsp.request('textDocument/definition', request); assert.equal(definition.uri, uri); assert.deepEqual(definition.range.start, { line: 0, character: 6 });
	const references = await lsp.request('textDocument/references', { ...request, context: { includeDeclaration: true } }); assert.equal(references.length, 2);
	const rename = await lsp.request('textDocument/rename', { ...request, newName: 'changed' }); assert.equal(rename.changes[uri].length, 2);
	report.protocol.push('Nested interpolation navigation, references and proposed rename retain original CRLF source positions');
	const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 2, character: 11 } }); assert.ok(JSON.stringify(hover).includes('message: string'));
	report.protocol.push('Single string result type is visible in hover and argument diagnostics');
	pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.diagnostics.some((d) => d.code === 'parse-error'));
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'print(`{{42}}`)' }] }); await pending;
	pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === 3 && params.diagnostics.length === 0);
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'string.lower(`{false}`)' }] }); await pending;
	report.protocol.push('Double-brace syntax refusal followed by clean buffer repair');
	assert.equal(await fs.readFile(file, 'utf8'), source); report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
	try { await lsp?.close(); } catch (error) { report.shutdownError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
	await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
if (!report.passed) process.stderr.write(JSON.stringify(report) + '\n');
else console.log(JSON.stringify({ passed: true, cases: report.results.length, types: report.types.length, protocol: report.protocol.length, report: output }));
