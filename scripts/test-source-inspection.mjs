import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHover, getDocumentSymbols, parseSlua, buildSluaRegistryFromLslDefinitions, loadLslDefinitionsFromYamlFile } from '../slua-lsp-core/out/index.js';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = process.env.SLUA_INSPECTION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const cli = process.env.SLUA_INSPECTION_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const destination = process.env.SLUA_INSPECTION_EVIDENCE ?? path.join(root, '.local/logs/source-inspection.json');
const registry = buildSluaRegistryFromLslDefinitions(await loadLslDefinitionsFromYamlFile());
const lsp = launchServer(entry, root);
const uri = pathToFileURL(path.join(root, '.local/fixtures/source-inspection.luau')).href;
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const results = [];
function invoke(command, source, position) {
	const args = [cli, command, '-', '--stdin-filepath', 'inspection.luau', '--json'];
	if (position) args.push('--position', `${position.line}:${position.character}`);
	const result = spawnSync(process.execPath, args, { cwd: root, input: source, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
	assert.equal(result.stderr, '');
	assert.ok(result.status === 0 || result.status === 1, result.stdout);
	const json = JSON.parse(result.stdout);
	assert.equal(json.schema, 'slua-lsp.cli.v1'); assert.equal(json.sourceSha256, digest(source));
	return { code: result.status, data: json };
}
const kinds = { 13: 'variable', 12: 'function', 6: 'method', 5: 'class', 8: 'field', 11: 'type' };
function normalizeSymbols(items) {
	return items.map((item) => ({ ...item, kind: kinds[item.kind], ...(item.children ? { children: normalizeSymbols(item.children) } : {}) }));
}
let version = 0;
async function change(text) {
	const event = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri);
	if (!version) lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: ++version, text } });
	else lsp.notify('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] });
	await event;
}
try {
	await lsp.request('initialize', { processId: process.pid, rootUri: null, capabilities: {} }); lsp.notify('initialized', {});
	const scenarios = [
		{ name: 'contextual const values and functions', source: 'const count: number = 1\nconst function double(value: number): number return value * 2 end\nprint(count, double(count))', positions: [{ line: 2, character: 8 }, { line: 2, character: 15 }] },
		{ name: 'ordinary local and bare builtin', source: 'local count = 1\nprint(count)', positions: [{ line: 1, character: 8 }, { line: 1, character: 2 }] },
		{ name: 'local function signature and shadow initializer', source: 'local function double(value: number) return value * 2 end\nlocal count = 1\ndo local count = count + 1; print(double(count)) end', positions: [{ line: 0, character: 17 }, { line: 0, character: 43 }, { line: 2, character: 18 }] },
		{ name: 'contextual event callback and UTF-16 interpolation', source: 'LLEvents:on("touch_start", function(items) print(items) end)\r\nlocal value = "hi"\r\nprint("😀", `{value}`)', positions: [{ line: 0, character: 49 }, { line: 2, character: 16 }] },
		{ name: 'string/field/type namespace isolation', source: 'local value = 1\nlocal object = {value = value}\nprint("value", object.value)\ntype value = number', positions: [{ line: 1, character: 17 }, { line: 2, character: 8 }, { line: 2, character: 23 }, { line: 3, character: 7 }] },
		{ name: 'class outline with fields, methods and local callback hierarchy', source: 'class Point\npublic x: number\nfunction get() return self.x end\nend\ntype Scalar = number\nlocal handler = function(value) local result = value; return result end', positions: [{ line: 0, character: 7 }, { line: 5, character: 61 }] }
	];
	for (const scenario of scenarios) {
		await change(scenario.source);
		const parsed = parseSlua(scenario.source); assert.deepEqual(parsed.diagnostics, []);
		const coreSymbols = getDocumentSymbols(parsed.ast);
		const wireSymbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri } });
		assert.deepEqual(normalizeSymbols(wireSymbols), coreSymbols, scenario.name);
		const cliSymbols = invoke('symbols', scenario.source); assert.equal(cliSymbols.code, 0); assert.deepEqual(cliSymbols.data.result, coreSymbols);
		for (const position of scenario.positions) {
			const core = getHover(parsed.ast, position, registry);
			const wire = await lsp.request('textDocument/hover', { textDocument: { uri }, position });
			const command = invoke('hover', scenario.source, position);
			if (core) {
				assert.deepEqual(wire, { range: core.range, contents: { kind: 'markdown', value: core.markdown } });
				assert.equal(command.code, 0); assert.deepEqual(command.data.result, core);
			} else { assert.equal(wire, null); assert.equal(command.code, 1); assert.equal(command.data.result, null); }
		}
		results.push({ name: scenario.name, sourceSha256: digest(scenario.source), hoverPositions: scenario.positions.length, topLevelSymbols: coreSymbols.length, parity: ['core', 'stdio server', 'CLI'] });
	}
	await change('local broken = 1\nlocal =');
	assert.equal(invoke('symbols', 'local broken = 1\nlocal =').data.status, 'parse-error');
	results.push({ name: 'CLI parse-error refusal preserves editor recovery behavior' });
	const closed = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri);
	lsp.notify('textDocument/didClose', { textDocument: { uri } }); await closed;
	assert.equal(await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 7 } }), null);
	assert.deepEqual(await lsp.request('textDocument/documentSymbol', { textDocument: { uri } }), []);
	version = 0; await change('local fresh = "new epoch"\nprint(fresh)');
	const fresh = await lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 1, character: 8 } }); assert.ok(fresh.contents.value.includes('fresh: string'));
	results.push({ name: 'close/reopen at the same version forgets stale source inspection' });
} finally { await lsp.close(); }
const report = { passed: true, measuredAt: new Date().toISOString(), entry, entrySha256: digest(await fs.readFile(entry)), cli, cliSha256: digest(await fs.readFile(cli)), results,
	scope: 'Source inspection parity over ordinary stdio and read-only CLI input. No simulator/world, viewer or FS IPC operations.' };
await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
