import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_CLASSES_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_CLASSES_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_CLASSES_EVIDENCE ?? path.join(root, '.local/logs/classes.json');
const fixture = path.join(root, 'scripts/fixtures/classes.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/classes-'));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle'), flag = '--fflags=DebugLuauUserDefinedClasses=true';
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], protocol: [],
	scope: 'Explicitly experimental native class flag, syntax and separate safe local runtime; actual CLI file/stdin and stdio recovery. Native default rejection is retained, not proof of deployed host support. No FS IPC, simulator, GUI or native rebuild.' };
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
		const record = { name: item.name, valid: item.valid, file, sha256: hash(Buffer.from(source)), agents: [] }; report.results.push(record);
		record.syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', flag, file]); assert.equal(record.syntax.exit, item.valid ? 0 : 1, item.name + ': ' + record.syntax.stderr);
		record.defaultSyntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', file]); assert.equal(record.defaultSyntax.exit, 1);
		const parsed = parseSlua(source); record.coreDiagnostics = parsed.diagnostics; assert.equal(parsed.diagnostics.length === 0, item.valid, item.name);
		for (const command of ['symbols', 'check']) {
			const disk = agent([command, file]), stdin = agent([command, '-', '--stdin-filepath', file], source);
			record.agents.push({ command, disk, stdin }); assert.deepEqual(disk, stdin);
			assert.equal(disk.exit, item.valid ? 0 : 1, item.name + '/' + command + ': ' + JSON.stringify(disk));
			if (command === 'symbols') assert.equal(disk.data.sourceSha256, hash(Buffer.from(source)));
			else assert.equal(disk.data.summary.files, 1);
			if (item.message) assert.ok(disk.data.diagnostics.some((d) => d.code === 'parse-error' && d.message.includes(item.message)), item.name);
		}
	}
	report.types = [];
	for (const item of [
		{ name: 'new-number', source: 'class Box\n\tfunction new(): number return 42 end\nend\nmath.abs(Box.new())', valid: true },
		{ name: 'new-string', source: 'class Box\n\tfunction new(): string return "value" end\nend\nstring.lower(Box.new())', valid: true },
		{ name: 'new-string-number-error', source: 'class Box\n\tfunction new(): string return "value" end\nend\nmath.abs(Box.new())', valid: false },
		{ name: 'new-instance', source: 'class Box\n\tpublic x: number\n\tfunction new(): Box return Box {x=42} end\nend\nlocal b=Box.new()\nmath.abs(b.x)', valid: true }
	]) {
		const file = path.join(folder, 'type-' + item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
		const native = run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', flag, file]);
		const record = { ...item, file, sha256: hash(Buffer.from(item.source)), native }; report.types.push(record);
		assert.equal(native.exit, item.valid ? 0 : 1, item.name + ': ' + native.stderr);
		record.agent = agent(['check', file, '--warnings-as-errors']); assert.equal(record.agent.exit, item.valid ? 0 : 1, JSON.stringify(record));
	}
	const source = 'class Point\npublic x: number\npublic function new(x: number)\nreturn Point {x=x}\nend\nfunction value(self) return self.x end\nend\nlocal p=Point.new(42)\nassert(p:value()==42)\nprint(p:value())';
	const file = path.join(folder, 'runtime.luau'); await fs.writeFile(file, source, { flag: 'wx' });
	report.runtime = { file, sha256: hash(Buffer.from(source)), compile: run(path.join(bin, 'slua-compile'), ['--null', flag, file]), syntaxFlagOnly: run(path.join(bin, 'slua'), ['--sl', flag, file]), execute: run(path.join(bin, 'slua'), ['--sl', flag + ',DebugLuauUserDefinedClassesRuntime=true', file]) };
	assert.equal(report.runtime.syntaxFlagOnly.exit, 1); assert.ok(report.runtime.syntaxFlagOnly.stderr.includes("attempt to index class with 'new'"));
	assert.equal(report.runtime.compile.exit, 0); assert.equal(report.runtime.execute.exit, 0); assert.equal(report.runtime.execute.stdout, '42\n'); assert.equal(report.runtime.execute.stderr, '');
	const uri = pathToFileURL(file).href; lsp = launchServer(server, root);
	await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
	let pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === 1);
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: source } });
	assert.equal((await pending).diagnostics.length, 0);
	const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 7, character: 10 } });
	assert.equal(definition.uri, uri); assert.deepEqual(definition.range.start, { line: 0, character: 6 });
	report.protocol.push('Valid constructor retains class-name definition in the original source');
	let version = 1;
	for (const item of JSON.parse(await fs.readFile(fixture, 'utf8')).filter((item) => ['duplicate-field', 'reserved-property', 'unterminated', 'self-annotation', 'arbitrary-body'].includes(item.name))) {
		version++; pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === version && params.diagnostics.some((d) => d.code === 'parse-error'));
		lsp.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: item.source }] }); await pending;
		report.protocol.push(item.name + ': actual buffer edit publishes a parse error');
	}
	version++; pending = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === uri && params.version === version && params.diagnostics.length === 0);
	lsp.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: source }] }); await pending;
	report.protocol.push('Invalid class buffer repairs to the valid program without stale diagnostics');
	assert.equal(await fs.readFile(file, 'utf8'), source); report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
	try { await lsp?.close(); } catch (error) { report.shutdownError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
	await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.results.length, protocol: report.protocol.length, output }));
