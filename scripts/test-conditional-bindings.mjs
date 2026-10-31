import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_CONDITIONAL_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_CONDITIONAL_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_CONDITIONAL_EVIDENCE ?? path.join(root, '.local/logs/conditional-bindings.json');
const fixture = path.join(root, 'scripts/fixtures/conditional-bindings.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/conditional-bindings-'));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = path.join(local, 'build/slua-oracle');
const syntaxFlag = '--fflags=LuauExperimentalIfLocalSyntax=true';
const analysisFlags = syntaxFlag + ',LuauExperimentalIfLocalAnalysis=true';
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: hash(await fs.readFile(fixture)),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], types: [], protocol: [], cliProcesses: 0,
	scope: 'Pinned experimental native conditional binding syntax/analysis flags, single-value runtime and generated output; actual CLI file/stdin and stdio edits/navigation/recovery. Explicit flag-disabled controls do not establish deployed SLua host flags. No FS IPC, simulator, GUI or native rebuild.' };
function run(command, args, input) {
	const child = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
	assert.ifError(child.error); assert.equal(child.signal, null);
	return { exit: child.status, stdout: child.stdout, stderr: child.stderr };
}
function agent(args, input) {
	report.cliProcesses++;
	const value = run(process.execPath, [cli, ...args, '--json'], input);
	assert.equal(value.stderr, ''); return { exit: value.exit, data: JSON.parse(value.stdout) };
}
function position(source, text, last = false) {
	const offset = last ? source.lastIndexOf(text) : source.indexOf(text); assert.ok(offset >= 0, text);
	const lines = source.slice(0, offset).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length };
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
		record.syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', syntaxFlag, file]);
		assert.equal(record.syntax.exit, item.valid ? 0 : 1, item.name + ': ' + record.syntax.stderr);
		record.disabledSyntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', '--fflags=LuauExperimentalIfLocalSyntax=false', file]);
		assert.equal(record.disabledSyntax.exit, item.disabled ? 0 : 1, item.name + '/disabled');
		const parsed = parseSlua(source); record.coreDiagnostics = parsed.diagnostics;
		assert.equal(parsed.diagnostics.length === 0, item.valid, item.name + ': ' + JSON.stringify(parsed.diagnostics));
		for (const command of ['symbols', 'check', 'preprocess']) {
			const disk = agent([command, file]), stdin = agent([command, '-', '--stdin-filepath', file], source);
			record.agents.push({ command, disk, stdin }); assert.deepEqual(disk, stdin);
			assert.equal(disk.exit, item.valid ? 0 : 1, item.name + '/' + command + ': ' + JSON.stringify(disk));
			if (command === 'symbols') assert.equal(disk.data.sourceSha256, record.sha256);
			if (command === 'preprocess' && item.stdout !== undefined) {
				const generated = path.join(folder, item.name + '.generated.luau');
				await fs.writeFile(generated, disk.data.content, { flag: 'wx' });
				record.generated = { file: generated, sha256: hash(Buffer.from(disk.data.content)), compile: run(path.join(bin, 'slua-compile'), ['--null', syntaxFlag, generated]), execute: run(path.join(bin, 'slua'), ['--sl', syntaxFlag, generated]) };
				assert.equal(record.generated.compile.exit, 0, item.name + '/generated-compile');
				assert.equal(record.generated.execute.exit, 0, item.name + ': ' + record.generated.execute.stderr);
				assert.equal(record.generated.execute.stdout, item.stdout); assert.equal(record.generated.execute.stderr, '');
			}
		}
		if (item.valid) { record.compile = run(path.join(bin, 'slua-compile'), ['--null', syntaxFlag, file]); assert.equal(record.compile.exit, 0, item.name); }
		if (item.stdout !== undefined) {
			record.execute = run(path.join(bin, 'slua'), ['--sl', syntaxFlag, file]);
			assert.equal(record.execute.exit, 0, item.name + ': ' + record.execute.stderr); assert.equal(record.execute.stdout, item.stdout); assert.equal(record.execute.stderr, '');
		}
	}
	for (const item of [
		{ name: 'optional-local', source: 'local function f(v: number?) if local x=v then math.abs(x) end end\nf(nil)', valid: true },
		{ name: 'optional-const', source: 'local function f(v: number?) if const x: number?=v then math.abs(x) end end\nf(nil)', valid: true },
		{ name: 'expression-optional', source: 'local function f(v: number?) return if local x=v then math.abs(x) else 0 end\nmath.abs(f(nil))', valid: true },
		{ name: 'annotation-mismatch', source: 'if local x: number="bad" then print(x) end', valid: false },
		{ name: 'expression-annotation-mismatch', source: 'local result=if const x: number="bad" then x else 0\nprint(result)', valid: false },
		{ name: 'else-scope', source: 'if local x=math.random() then print(x) else print(x) end', valid: false },
		{ name: 'initializer-scope', source: 'if local x=x then print(x) end', valid: false },
		{ name: 'after-scope', source: 'if const x=42 then print(x) end\nprint(x)', valid: false },
		{ name: 'elseif-scope', source: 'if local x=math.random() then print(x) elseif x then print(0) end', valid: false }
	]) {
		const file = path.join(folder, 'type-' + item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
		const native = run(path.join(bin, 'slua-analyze'), ['--mode=strict', '--formatter=gnu', '-j1', analysisFlags, file]);
		const record = { ...item, file, sha256: hash(Buffer.from(item.source)), native }; report.types.push(record);
		assert.equal(native.exit, item.valid ? 0 : 1, item.name + ': ' + native.stderr);
		record.agent = agent(['check', file, '--warnings-as-errors']); assert.equal(record.agent.exit, item.valid ? 0 : 1, JSON.stringify(record));
	}
	const conformanceFile = path.join(build.inputs.sourceRoot, 'tests/conformance/iflocal.luau');
	// Reviewed upstream file: local values, functions and standard-library operations only.
	report.upstreamConformance = { file: conformanceFile, sha256: hash(await fs.readFile(conformanceFile)), syntax: run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', syntaxFlag, conformanceFile]), compile: run(path.join(bin, 'slua-compile'), ['--null', syntaxFlag, conformanceFile]), execute: run(path.join(bin, 'slua'), ['--sl', syntaxFlag, conformanceFile]) };
	assert.equal(report.upstreamConformance.syntax.exit, 0); assert.equal(report.upstreamConformance.compile.exit, 0); assert.equal(report.upstreamConformance.execute.exit, 0); assert.equal(report.upstreamConformance.execute.stderr, '');
	const source = 'local value="outer"\nlocal function use(input: number?)\nif const value=input then\nmath.abs(value)\nreturn value\nelse\nprint(value)\nend\nreturn 0\nend\nmath.abs(use(nil))';
	const file = path.join(folder, 'editor.luau'); await fs.writeFile(file, source, { flag: 'wx' }); const uri = pathToFileURL(file).href;
	report.inspection = [];
	for (const command of ['hover', 'definition', 'references', 'rename']) {
		const flags = ['--position', '3:10', ...(command === 'rename' ? ['--new-name', 'bound'] : [])];
		const disk = agent([command, file, ...flags]), stdin = agent([command, '-', '--stdin-filepath', file, ...flags], source);
		assert.deepEqual(disk, stdin); assert.equal(disk.exit, 0); assert.equal(disk.data.sourceSha256, hash(Buffer.from(source)));
		if (command === 'hover') assert.ok(disk.data.result.markdown.includes('const value: number'));
		if (command === 'definition') assert.deepEqual(disk.data.result.range.start, { line: 2, character: 9 });
		if (command === 'references' || command === 'rename') assert.equal(disk.data.result.length, 3);
		report.inspection.push({ command, disk, stdin });
	}
	lsp = launchServer(server, root); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: { workspace: { workspaceEdit: { documentChanges: true } } } }); lsp.notify('initialized', {});
	let pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === 1);
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: source } }); assert.deepEqual((await pending).diagnostics, []);
	report.protocol.push('Conditional declaration opens with no diagnostics');
	const innerPos = position(source, 'value)', false);
	const hovered = await lsp.request('textDocument/hover', { textDocument: { uri }, position: innerPos }); assert.ok(JSON.stringify(hovered).includes('const value: number')); report.protocol.push('Truthy readonly conditional binding hover');
	const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: innerPos }); assert.deepEqual(definition.range.start, { line: 2, character: 9 });
	const outside = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 6, character: 7 } }); assert.deepEqual(outside.range.start, { line: 0, character: 6 }); report.protocol.push('Branch definition and independent outer else definition');
	const references = await lsp.request('textDocument/references', { textDocument: { uri }, position: innerPos, context: { includeDeclaration: true } }); assert.equal(references.length, 3);
	const renamed = await lsp.request('textDocument/rename', { textDocument: { uri }, position: innerPos, newName: 'bound' }); assert.equal(renamed.documentChanges[0].edits.length, 3); report.protocol.push('References and versioned rename exclude outer binding');
	const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri } }); assert.ok(JSON.stringify(symbols).includes('const')); report.protocol.push('Conditional binding appears inside function outline');
	const bad = source.replace('math.abs(value)', 'value=2');
	pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === 2 && p.diagnostics.some((d) => d.code === 'parse-error'));
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: bad }] }); await pending; report.protocol.push('Native const reassignment is published after buffer edit');
	pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === 3 && p.diagnostics.length === 0);
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: source }] }); await pending; report.protocol.push('Repaired buffer clears old diagnostics');
	const blank = source.replace('math.abs(value)', 'math.abs(value)\n  ');
	pending = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === 4 && p.diagnostics.length === 0);
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 4 }, contentChanges: [{ text: blank }] }); await pending;
	const completions = await lsp.request('textDocument/completion', { textDocument: { uri }, position: { line: 4, character: 1 }, context: { triggerKind: 1 } });
	const valueCompletion = (Array.isArray(completions) ? completions : completions.items).find((item) => item.label === 'value');
	assert.equal(valueCompletion.kind, 21); assert.ok(valueCompletion.detail.includes('number'));
	report.protocol.push('Blank-line completion before else retains the readonly successful-branch binding');
	assert.equal(await fs.readFile(file, 'utf8'), source); report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
	try { await lsp?.close(); } catch (error) { report.shutdownError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
	await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
console.log(JSON.stringify({ passed: report.passed, cases: report.results.length, types: report.types.length, protocol: report.protocol.length, cliProcesses: report.cliProcesses, output }));
