import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const cli = process.env.SLUA_GENERATION_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const server = process.env.SLUA_GENERATION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = process.env.SLUA_NATIVE_BIN ?? path.join(local, 'build/slua-oracle');
const output = process.env.SLUA_GENERATION_EVIDENCE ?? path.join(root, '.local/logs/generation.json');
await fs.mkdir(path.dirname(output), { recursive: true }); const evidence = await fs.open(output, 'wx');
const report = { passed: false, releaseAcceptance: false, recordedAt: new Date().toISOString(), node: process.version,
	harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), results: [], protocol: [],
	scope: 'Standalone core/CLI/LSP source generation, exact copied-range mapping and owned pure local generated code compiled/executed with the unchanged pinned C++ SLua CLI. No viewer, FS IPC, simulator, account discovery, world effects or native rebuild.' };
const run = (command, args, options = {}) => {
	const done = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
	assert.ifError(done.error); assert.equal(done.signal, null); assert.notEqual(done.status, null);
	return { exit: done.status, stdout: done.stdout, stderr: done.stderr };
};
const compare = (a, b) => a.line - b.line || a.character - b.character;
const contains = (range, point) => compare(range.start, point) <= 0 && compare(point, range.end) < 0;
function offset(text, point) {
	let start = 0;
	const breaks = text.matchAll(/\r\n|\r|\n/g);
	for (let line = 0; line < point.line; line++) { const next = breaks.next(); assert.ok(!next.done); start = next.value.index + next.value[0].length; }
	return start + point.character;
}
function position(text, marker) {
	const index = text.indexOf(marker); assert.ok(index >= 0, marker);
	const lines = text.slice(0, index).split(/\r\n|\r|\n/); return { line: lines.length - 1, character: lines.at(-1).length };
}
let lsp;
try {
	const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
	const pin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-source.json'), 'utf8'));
	assert.equal(build.status, 'built'); assert.equal(build.inputs.pin.commit, pin.commit); assert.equal(build.inputs.pin.archive_sha256, pin.archive_sha256);
	const check = run('python3', ['scripts/prepare-oracle.py', '--local-dir', path.dirname(path.dirname(build.source.root)), '--check']);
	assert.equal(check.exit, 0, check.stderr); const source = JSON.parse(check.stdout);
	assert.equal(source.contentSha256, build.inputs.sourceContentSha256); assert.deepEqual(source.executableModeDifferences, []);
	for (const name of ['slua', 'slua-compile']) assert.equal(digest(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	const bytes = await fs.readFile(path.join(root, 'scripts/fixtures/generated-source-cases.json'));
	const cases = JSON.parse(bytes);
	const parent = process.env.SLUA_GENERATION_FIXTURE_ROOT ?? path.join(root, '.local/fixtures');
	await fs.mkdir(parent, { recursive: true }); const folder = await fs.mkdtemp(path.join(parent, 'generation-'));
	Object.assign(report, { cli, cliSha256: digest(await fs.readFile(cli)), server, serverSha256: digest(await fs.readFile(server)),
		fixtureSha256: digest(bytes), source, binaries: { slua: build.binaries.slua, compile: build.binaries['slua-compile'] }, folder });
	lsp = launchServer(server, root);
	await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
	for (const item of cases) {
		const directory = path.join(folder, item.name); await fs.mkdir(directory);
		const files = { ...item.files, 'main.luau': item.main };
		for (const [name, raw] of Object.entries(files)) {
			const text = raw.replaceAll('__EXPECTED_MAIN__', JSON.stringify(path.join(directory, 'main.luau'))).replaceAll('__EXPECTED_MODULE__', JSON.stringify(path.join(directory, 'mod.luau')));
			files[name] = text; assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'));
			await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), text, { flag: 'wx' });
		}
		const main = path.join(directory, 'main.luau');
		const args = [cli, 'preprocess', main, '--max-module-depth', String(item.maxDepth ?? 5)];
		if (item.context !== undefined) {
			const context = path.join(directory, 'context.json'); await fs.writeFile(context, JSON.stringify(item.context), { flag: 'wx' });
			args.push('--preprocessor-context', context);
		}
		const agent = run(process.execPath, args); assert.equal(agent.stderr, ''); assert.equal(agent.exit, item.valid ? 0 : 1, `${item.name}: ${agent.stdout}`);
		const { schema, command, exitCode, contextSource, ...result } = JSON.parse(agent.stdout);
		assert.equal(schema, 'slua-lsp.cli.v1'); assert.equal(command, 'preprocess'); assert.equal(exitCode, agent.exit);
		const editor = await lsp.request('slua/preprocess', { uri: pathToFileURL(main).href, maxDepth: item.maxDepth ?? 5, context: item.context });
		assert.deepEqual(result, editor, item.name);
		const record = { name: item.name, valid: item.valid, result, files: Object.entries(files).map(([file, text]) => ({ file, sha256: digest(text) })) };
		if (item.nativeOriginalSyntaxExit !== undefined) {
			record.originalSyntax = run(path.join(bin, 'slua-compile'), ['--null', main]); assert.equal(record.originalSyntax.exit, item.nativeOriginalSyntaxExit);
		}
		report.results.push(record);
		if (!item.valid) { assert.equal(result.content, null); assert.equal(result.contentSha256, null); assert.deepEqual(result.mappings, []); assert.ok(result.diagnostics.length); continue; }
		assert.equal(result.contentSha256, digest(result.content)); assert.equal(result.diagnostics.length, 0);
		for (const mapping of result.mappings) {
			if (mapping.kind !== 'copy') continue;
			const original = await fs.readFile(mapping.file, 'utf8');
			assert.equal(result.content.slice(offset(result.content, mapping.generated.start), offset(result.content, mapping.generated.end)),
				original.slice(offset(original, mapping.original.start), offset(original, mapping.original.end)), item.name);
		}
		if (result.moduleIds.length) {
			const helper = position(result.content, 'function require(mod)');
			assert.equal(result.mappings.some((mapping) => contains(mapping.generated, helper)), false);
			if (item === cases[0]) {
				const helperResult = run(process.execPath, [...args, '--generated-position', `${helper.line}:${helper.character}`, '--generated-sha256', result.contentSha256]);
				assert.equal(helperResult.exit, 1); assert.equal(helperResult.stderr, ''); assert.deepEqual(JSON.parse(helperResult.stdout).mappedSource, { status: 'unmapped' });
				record.helperMapping = 'CLI refuses a synthetic helper location with a matching output hash';
			}
		}
		const generated = path.join(directory, 'generated.luau'); await fs.writeFile(generated, result.content, { flag: 'wx' }); record.generated = generated;
		record.syntax = run(path.join(bin, 'slua-compile'), [generated]); assert.equal(record.syntax.exit, 0, `${item.name}: ${record.syntax.stderr}`);
		record.native = run(path.join(bin, 'slua'), ['--sl', generated]);
		assert.equal(record.native.exit, item.nativeExit ?? 0, `${item.name}: ${record.native.stderr}`); assert.equal(record.native.stdout, item.stdout, item.name);
		if (item.stderrContains) assert.ok(record.native.stderr.includes(item.stderrContains)); else assert.equal(record.native.stderr, '');
		if (item.mapping || item.mainMapping) {
			const requests = item.mapping ? [['error("mapped-owned-error")', 'mod.luau'], ['local v=require(', 'main.luau']]
				: [['error("owned-main-error")', 'main.luau']];
			record.nativeMappings = [];
			for (const [marker, filename] of requests) {
				const point = position(result.content, marker);
				const nativeLine = result.content.slice(0, offset(result.content, point)).split('\n').length;
				assert.ok(record.native.stderr.includes(`${generated}:${nativeLine}`));
				const mapping = result.mappings.find((mapping) => contains(mapping.generated, point)); assert.ok(mapping);
				const delta = point.line - mapping.generated.start.line;
				const mapped = { line: mapping.original.start.line + delta, character: delta ? point.character : mapping.original.start.character + point.character - mapping.generated.start.character };
				assert.equal(mapping.file, path.join(directory, filename)); assert.deepEqual(mapped, position(files[filename], marker));
				const mappedAgent = run(process.execPath, [...args, '--generated-position', `${point.line}:${point.character}`, '--generated-sha256', result.contentSha256]);
				assert.equal(mappedAgent.exit, 0); assert.equal(mappedAgent.stderr, '');
				const sourceLocation = JSON.parse(mappedAgent.stdout).mappedSource;
				assert.deepEqual(sourceLocation, { status: 'mapped', file: mapping.file, position: mapped, sourceSha256: digest(files[filename]) });
				record.nativeMappings.push({ point, nativeLine, mapped, file: mapping.file, agent: sourceLocation });
			}
		}
		for (const [name, text] of Object.entries(files)) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), text);
	}
	const main = path.join(folder, 'protocol-main.luau'), imported = path.join(folder, 'protocol-module.luau');
	await fs.writeFile(main, 'print(require("protocol-module"))', { flag: 'wx' }); await fs.writeFile(imported, 'return 1', { flag: 'wx' });
	const uri = pathToFileURL(imported).href, request = () => lsp.request('slua/preprocess', { uri: pathToFileURL(main).href });
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text: 'return "unsaved"' } });
	const unsaved = await request(); assert.ok(unsaved.success); assert.ok(unsaved.content.includes('return "unsaved"'));
	assert.equal(unsaved.graph.modules[1].sourceSha256, digest('return "unsaved"')); report.protocol.push('open imported buffer overrides disk and binds its exact hash');
	lsp.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'return require(variable)' }] });
	const invalid = await request(); assert.equal(invalid.success, false); assert.equal(invalid.content, null); report.protocol.push('dynamic unsaved import refuses generation without stale content');
	lsp.notify('textDocument/didClose', { textDocument: { uri } });
	assert.ok((await request()).content.includes('return 1')); report.protocol.push('closing imported buffer restores disk generation');
	for (const params of [{ uri: 'untitled:test' }, { uri: pathToFileURL(main).href, maxDepth: 51 }, { uri: pathToFileURL(main).href, context: { unknown: true } }]) await assert.rejects(lsp.request('slua/preprocess', params));
	assert.ok((await request()).success); report.protocol.push('invalid URI/depth/context requests leave later requests working');
	report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); throw error; }
finally {
	try { await lsp?.close(); }
	catch (error) { report.passed = false; report.shutdownError = error.stack ?? String(error); throw error; }
	finally { await evidence.writeFile(JSON.stringify(report, null, 2) + '\n'); await evidence.close(); }
}
console.log(JSON.stringify({ passed: true, scenarios: report.results.length, protocol: report.protocol.length, output }));
