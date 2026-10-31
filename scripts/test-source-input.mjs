import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_INPUT_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_INPUT_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const output = process.env.SLUA_INPUT_EVIDENCE ?? path.join(root, '.local/logs/source-input.json');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/source-input-'));
const report = { passed: false, releaseAcceptance: false, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
	cli, cliSha256: hash(await fs.readFile(cli)), server, serverSha256: hash(await fs.readFile(server)), folder, results: [], protocol: [],
	scope: 'Owned ordinary source files, stdin, strict Unicode/byte limits, hashes and actual LSP stdio request recovery. No FS IPC, viewer, simulator, user-source execution or network.' };
const commands = ['check', 'symbols', 'hover', 'definition', 'references', 'rename', 'modules', 'preprocess'];
function run(command, file, input, flags = [], position = '0:6') {
	const args = [cli, command, input === undefined ? file : '-', '--json', ...flags];
	if (input !== undefined) args.push('--stdin-filepath', file);
	if (['hover', 'definition', 'references', 'rename'].includes(command)) args.push('--position', position);
	if (command === 'rename') args.push('--new-name', 'changed');
	const child = spawnSync(process.execPath, args, { cwd: root, input, timeout: 30000, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
	assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.stderr, '');
	const data = JSON.parse(child.stdout); assert.equal(data.schema, 'slua-lsp.cli.v1'); assert.equal(data.exitCode ?? child.status, child.status);
	report.results.push({ name: `${command}:${path.basename(file)}:${input === undefined ? 'file' : 'stdin'}`, exit: child.status,
		error: data.error, diagnosticCodes: (data.diagnostics ?? []).map((d) => d.code), sourceSha256: data.sourceSha256 });
	return { exit: child.status, data };
}
let lsp;
try {
	const source = 'local value = "😀\ufeff"\r\nprint(value)\r\n', file = path.join(folder, 'valid.luau');
	await fs.writeFile(file, source, { flag: 'wx' });
	for (const command of commands) {
		const disk = run(command, file), stdin = run(command, file, Buffer.from(source));
		assert.equal(disk.exit, 0); assert.deepEqual(stdin, disk);
		const graph = disk.data.graph ?? disk.data;
		if (graph.modules) assert.equal(graph.modules[0].sourceSha256, hash(await fs.readFile(file)));
		if (disk.data.sourceSha256) assert.equal(disk.data.sourceSha256, hash(await fs.readFile(file)));
	}
	const bom = path.join(folder, 'bom.luau'), bomBytes = Buffer.from('\ufeffprint("owned")');
	await fs.writeFile(bom, bomBytes, { flag: 'wx' });
	for (const command of ['check', 'modules', 'preprocess']) {
		const disk = run(command, bom), stdin = run(command, bom, bomBytes); assert.equal(disk.exit, 1); assert.deepEqual(disk, stdin);
		if (command !== 'check') {
			const graph = disk.data.graph ?? disk.data;
			assert.equal(graph.modules[0].sourceSha256, hash(bomBytes)); assert.equal(graph.modules[0].bytes, bomBytes.length);
		}
	}
	for (const [name, bytes] of [['bad-byte', [0xff]], ['overlong', [0xc0, 0xaf]], ['truncated', [0xf0, 0x9f, 0x98]],
		['surrogate', [0xed, 0xa0, 0x80]], ['binary', [0]]]) {
		const invalid = path.join(folder, name + '.luau'), content = Buffer.concat([Buffer.from('print("'), Buffer.from(bytes), Buffer.from('")')]);
		await fs.writeFile(invalid, content, { flag: 'wx' });
		for (const command of commands) for (const stdin of [undefined, content]) {
			const result = run(command, invalid, stdin); assert.equal(result.exit, 2); assert.equal(result.data.sourceSha256, undefined);
			if (command === 'preprocess' && stdin === undefined) { assert.equal(result.data.content, null); assert.deepEqual(result.data.graph.modules, []); }
			else assert.ok(result.data.error || result.data.diagnostics?.length);
		}
	}
	const maximum = path.join(folder, 'maximum.luau'), maxBytes = Buffer.from('--' + 'x'.repeat(8388608 - 2));
	await fs.writeFile(maximum, maxBytes, { flag: 'wx' });
	for (const input of [undefined, maxBytes]) {
		const result = run('symbols', maximum, input); assert.equal(result.exit, 0); assert.deepEqual(result.data.result, []);
		assert.equal(result.data.sourceSha256, hash(maxBytes));
	}
	const oversized = path.join(folder, 'oversized.luau'), oversizeBytes = Buffer.concat([maxBytes, Buffer.from('x')]);
	await fs.writeFile(oversized, oversizeBytes, { flag: 'wx' });
	for (const command of commands) for (const input of [undefined, oversizeBytes]) assert.equal(run(command, oversized, input).exit, 2);
	const link = path.join(folder, 'linked.luau'); await fs.symlink('valid.luau', link);
	assert.equal(run('symbols', link).data.sourceSha256, hash(await fs.readFile(file)));
	for (const [name, eol] of [['lf', '\n'], ['cr', '\r'], ['crlf', '\r\n']]) {
		const text = ['-- header', 'local value=42', 'print(value)'].join(eol), input = path.join(folder, name + '-navigation.luau');
		await fs.writeFile(input, text, { flag: 'wx' });
		for (const command of ['definition', 'references', 'hover', 'rename']) {
			const disk = run(command, input, undefined, [], '2:8'), stdin = run(command, input, Buffer.from(text), [], '2:8');
			assert.equal(disk.exit, 0); assert.deepEqual(stdin, disk); assert.equal(disk.data.sourceSha256, hash(await fs.readFile(input)));
		}
	}
	const context = path.join(folder, 'context.json'); await fs.writeFile(context, '\ufeff{}', { flag: 'wx' });
	assert.equal(run('preprocess', file, undefined, ['--preprocessor-context', context]).exit, 2);
	for (const command of ['modules', 'preprocess']) {
		const failed = spawnSync(process.execPath, [cli, command, '-', '--format=text'], { input: Buffer.from([0xff]), encoding: 'utf8', timeout: 30000 });
		assert.ifError(failed.error); assert.equal(failed.signal, null); assert.equal(failed.status, 2); assert.equal(failed.stderr, '');
		assert.equal(JSON.parse(failed.stdout).command, command);
		report.results.push({ name: `${command}:implicit-json-error-even-with-text`, exit: failed.status });
	}
	lsp = launchServer(server, root);
	await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
	const uri = pathToFileURL(bom).href;
	const closed = await lsp.request('slua/preprocess', { uri }); assert.equal(closed.success, false);
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: bomBytes.toString('utf8') } });
	assert.deepEqual(await lsp.request('slua/preprocess', { uri }), closed);
	report.protocol.push('BOM bytes/hash/syntax identical for closed disk source and open text buffer');
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'print("\ud800")' }] });
	const malformed = await lsp.request('slua/preprocess', { uri }); assert.equal(malformed.success, false);
	assert.deepEqual(malformed.graph.modules, []); assert.ok(malformed.diagnostics.some((d) => d.message.includes('Unicode')));
	report.protocol.push('Unpaired UTF-16 surrogate refused before snapshot encoding/hash');
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: source }] });
	const recovered = await lsp.request('slua/preprocess', { uri }); assert.equal(recovered.success, true);
	assert.equal(recovered.graph.modules[0].sourceSha256, hash(Buffer.from(source))); assert.equal(recovered.content, source);
	report.protocol.push('Fresh valid unsaved buffer recovers after malformed text without writing input');
	const crFile = path.join(folder, 'cr-navigation.luau'), crUri = pathToFileURL(crFile).href;
	lsp.notify('textDocument/didOpen', { textDocument: { uri: crUri, languageId: 'luau', version: 1, text: await fs.readFile(crFile, 'utf8') } });
	const request = { textDocument: { uri: crUri }, position: { line: 2, character: 8 } };
	const definition = await lsp.request('textDocument/definition', request); assert.equal(definition.uri, crUri); assert.deepEqual(definition.range.start, { line: 1, character: 6 });
	const references = await lsp.request('textDocument/references', { ...request, context: { includeDeclaration: true } });
	assert.deepEqual(references.map((ref) => ref.range.start), [{ line: 1, character: 6 }, { line: 2, character: 6 }]);
	const rename = await lsp.request('textDocument/rename', { ...request, newName: 'changed' }); assert.equal(rename.changes[crUri].length, 2);
	report.protocol.push('Raw bare-CR protocol buffers resolve definition/references/rename using editor lines');
	const diagnostics = lsp.notification('textDocument/publishDiagnostics', (params) => params.uri === crUri && params.diagnostics.some((item) => item.code === 'undeclared-name'));
	lsp.notify('textDocument/didChange', { textDocument: { uri: crUri, version: 2 }, contentChanges: [{ text: '-- header\rprint(missing)' }] });
	const published = await diagnostics; assert.deepEqual(published.diagnostics.find((item) => item.code === 'undeclared-name').range.start, { line: 1, character: 6 });
	report.protocol.push('Bare-CR diagnostics retain the actual editor row after a raw stdio change');
	assert.deepEqual(await fs.readFile(bom), bomBytes); assert.equal(await fs.readFile(file, 'utf8'), source);
	report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
	try { await lsp?.close(); } catch (error) { report.shutdownError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
	await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close();
}
if (!report.passed) process.stderr.write(JSON.stringify(report) + '\n');
else process.stdout.write(JSON.stringify({ passed: true, cases: report.results.length, protocol: report.protocol.length, report: output }) + '\n');
