import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_CONTEXT_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_CONTEXT_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_CONTEXT_EVIDENCE ?? path.join(root, '.local/logs/source-context.json');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/source-context-'));
const bin = path.join(process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), 'build/slua-oracle');
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], protocol: [],
	scope: 'Explicit source context in ordinary CLI checks/hover and LSP config transitions, with independently parsed/compiled/executed generated local programs. No full native analyzer equivalence, GUI, viewer/FS IPC, host API or native rebuild.' };
function run(command, args, input) {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
	assert.ifError(result.error); assert.equal(result.signal, null);
	return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}
function agent(args, input) {
	const result = run(process.execPath, [cli, ...args, '--json'], input); assert.equal(result.stderr, '');
	return { exit: result.exit, data: JSON.parse(result.stdout) };
}
let lsp;
try {
	const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
	const verified = run('python3', ['scripts/prepare-oracle.py', '--local-dir', path.dirname(path.dirname(bin)), '--check']); assert.equal(verified.exit, 0);
	report.sourceVerification = JSON.parse(verified.stdout); report.build = build;
	assert.equal(report.sourceVerification.contentSha256, build.inputs.sourceContentSha256);
	for (const name of ['slua', 'slua-compile', 'slua-analyze']) assert.equal(hash(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	const full = { agentId: '12345678-1234-1234-1234-123456789abc', agentName: 'Owned \\"😀 fixture', timestamp: '2026-10-30T00:00:00Z' };
	const cases = [
		{ name: 'location', source: 'local line: number = __LINE__\r\nassert(line == 1 and __LINE__ == 2)\r\nprint("location-ok")', context: {}, codes: [], stdout: 'location-ok\n' },
		{ name: 'identity-time', source: `assert(tostring(__AGENTKEY__) == __AGENTID__)\nassert(__AGENTNAME__ == ${JSON.stringify(full.agentName)})\nassert(__DATE__ == "2026-10-30" and __TIME__ == "00:00:00" and __TIMESTAMP__ == "2026-10-30T00:00:00.000Z")\nassert(__UNIXTIME__ == ${Date.parse(full.timestamp) / 1000})\nprint("identity-time-ok")`, context: full, codes: [], stdout: 'identity-time-ok\n' },
		{ name: 'file', source: 'assert(type(__FILE__) == "string" and __SHORTFILE__ == "file.luau")\nprint("file-ok")', context: {}, codes: [], stdout: 'file-ok\n' },
		{ name: 'shadows', source: 'local __LINE__ = 4\n__LINE__ += 1\nlocal function f(__AGENTID__: number) return __AGENTID__ end\nassert(__LINE__ == 5 and f(3) == 3)\nprint("shadows-ok")', context: {}, codes: [], stdout: 'shadows-ok\n' },
		{ name: 'imports', source: 'local line: number = require("helper")\nassert(line == 2)\nprint("imports-ok")', context: {}, codes: [], stdout: 'imports-ok\n' },
		{ name: 'missing', source: 'print(__AGENTID__)', context: {}, codes: ['preprocessor-context'], generationFailure: true },
		{ name: 'write', source: '__LINE__ += 1', context: {}, codes: ['preprocessor-context'], generationFailure: true },
		{ name: 'raw', source: 'print(__AGENTIDRAW__)', context: full, codes: ['preprocessor-context'], generationFailure: true },
		{ name: 'constructor-shadow', source: 'local function uuid(_: string): number return 42 end\nlocal n: number = __AGENTKEY__\nprint(n)', context: full, codes: ['preprocessor-context'], generationFailure: true },
		{ name: 'constructor-after', source: 'print(__AGENTKEY__)\nlocal function uuid() return 42 end\nprint(uuid())', context: full, codes: [], stdout: full.agentId + '\n42\n' },
		{ name: 'typed', source: 'local line: string = __LINE__\nprint(line)', context: {}, codes: ['assignment-type-mismatch'], stdout: '1\n' },
		{ name: 'disabled', source: 'print(__LINE__)', codes: ['undeclared-name'], stdout: 'nil\n' }
	];
	await fs.writeFile(path.join(folder, 'helper.luau'), '-- own module\nreturn __LINE__', { flag: 'wx' });
	for (const item of cases) {
		const file = path.join(folder, item.name + '.luau'); await fs.writeFile(file, item.source, { flag: 'wx' });
		const flags = [];
		if (item.context !== undefined) { const contextFile = path.join(folder, item.name + '.json'); await fs.writeFile(contextFile, JSON.stringify(item.context), { flag: 'wx' }); flags.push('--preprocessor-context', contextFile); }
		const record = { ...item, file, sha256: hash(Buffer.from(item.source)) }; report.results.push(record);
		record.disk = agent(['check', file, ...flags, '--warnings-as-errors']); record.stdin = agent(['check', '-', '--stdin-filepath', file, ...flags, '--warnings-as-errors'], item.source);
		assert.deepEqual(record.disk, record.stdin); assert.equal(record.disk.exit, item.codes.length ? 1 : 0);
		assert.deepEqual(record.disk.data.diagnostics.map((d) => d.code), item.codes);
		if (item.name === 'file') {
			const position = `0:${item.source.indexOf('__FILE__') + 3}`;
			record.hover = agent(['hover', file, '--position', position, ...flags]);
			record.hoverStdin = agent(['hover', '-', '--stdin-filepath', file, '--position', position, ...flags], item.source);
			assert.deepEqual(record.hover, record.hoverStdin); assert.equal(record.hover.exit, 0); assert.ok(record.hover.data.result.markdown.includes(file));
		}
		record.generated = agent(['preprocess', file, ...flags]); record.generatedStdin = agent(['preprocess', '-', '--stdin-filepath', file, ...flags], item.source);
		assert.deepEqual(record.generated, record.generatedStdin);
		assert.equal(record.generated.exit, item.generationFailure ? 1 : 0);
		if (item.generationFailure) { assert.equal(record.generated.data.content, null); continue; }
		const generated = path.join(folder, item.name + '.generated.luau'); await fs.writeFile(generated, record.generated.data.content, { flag: 'wx' });
		record.syntax = run(path.join(bin, 'slua-compile'), ['--only-parse', '--null', generated]); assert.equal(record.syntax.exit, 0);
		record.compile = run(path.join(bin, 'slua-compile'), ['--null', generated]); assert.equal(record.compile.exit, 0);
		record.runtime = run(path.join(bin, 'slua'), ['--sl', generated]); assert.equal(record.runtime.exit, 0, record.runtime.stderr); assert.equal(record.runtime.stdout, item.stdout); assert.equal(record.runtime.stderr, '');
	}
	const uri = pathToFileURL(path.join(folder, 'protocol.luau')).href, source = 'print(__LINE__, __AGENTKEY__, __FILE__)';
	await fs.writeFile(fileURLToPath(uri), source, { flag: 'wx' });
	lsp = launchServer(server, root);
	const definitionsPath = path.join(root, 'third_party/lsl-definitions/lsl_definitions.yaml');
	await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {}, initializationOptions: { definitionsPath } }); lsp.notify('initialized', {});
	const publication = (codes) => lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.version === 1 && JSON.stringify(p.diagnostics.map((d) => d.code)) === JSON.stringify(codes));
	let pending = publication(['undeclared-name', 'undeclared-name', 'undeclared-name']);
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: source } }); await pending; report.protocol.push('Disabled names remain ordinary undeclared identifiers');
	pending = publication(['preprocessor-context']); assert.equal((await lsp.request('slua/setPreprocessorContext', { context: {} })).accepted, true); await pending;
	report.protocol.push('Empty context enables location macros and diagnoses missing identity without duplicate warnings');
	pending = publication([]); const accepted = await lsp.request('slua/setPreprocessorContext', { context: full }); assert.equal(accepted.accepted, true); await pending;
	const generated = await lsp.request('slua/preprocess', { uri }); assert.equal(generated.success, true); assert.equal(generated.contextSha256, accepted.contextSha256);
	const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: source.indexOf('__AGENTKEY__') + 3 } }); assert.ok(JSON.stringify(hover).includes('uuid'));
	report.protocol.push('Complete context shares normalized generation identity and UUID hover');
	const rejected = await lsp.request('slua/setPreprocessorContext', { context: { agentId: 'bad' } }); assert.equal(rejected.accepted, false);
	assert.equal((await lsp.request('slua/setPreprocessorContext', {})).accepted, false);
	assert.equal((await lsp.request('slua/preprocess', { uri })).contextSha256, accepted.contextSha256); report.protocol.push('Rejected context retains the preceding accepted context');
	pending = publication(['preprocessor-context']); lsp.notify('workspace/didChangeConfiguration', { settings: { slua: { preprocessor: { context: {} } } } }); await pending;
	assert.equal((await lsp.request('slua/getDefinitions')).definitionsPath, definitionsPath); report.protocol.push('Standard context configuration revalidates and preserves active definitions');
	pending = publication(['undeclared-name', 'undeclared-name', 'undeclared-name']); await lsp.request('slua/setPreprocessorContext', { context: null }); await pending;
	report.protocol.push('Disabling context removes its names and facts');
	lsp.notify('textDocument/didClose', { textDocument: { uri } });
	for (const item of report.results) assert.equal(hash(await fs.readFile(item.file)), item.sha256);
	report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await lsp?.close(); await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close(); }
console.log(JSON.stringify({ passed: report.passed, cases: report.results.length, protocol: report.protocol.length, output, error: report.error }));
