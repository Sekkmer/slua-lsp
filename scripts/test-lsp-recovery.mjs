import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lsp = launchServer(path.join(root, 'slua-lsp-server/out/index.js'), root);
const uri = pathToFileURL(path.join(root, '.local/fixtures/recovery.luau')).href;
const results = [];
async function change(method, params) {
	const event = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri);
	lsp.notify(method, params);
	return event;
}
async function hover() {
	return lsp.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 4 } });
}
try {
	await lsp.request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
	lsp.notify('initialized', {});
	const opened = await change('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'luau', text: 'll.Say(0, "working")' } });
	assert.ok(!opened.diagnostics.some((d) => d.severity === 1));
	assert.ok((await hover())?.contents); results.push('open and hover');
	const firstTokens = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } });
	assert.ok(firstTokens.data.length);
	assert.deepEqual(await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } }), firstTokens);
	results.push('unchanged document semantic tokens remain stable');
	const log = lsp.notification('window/logMessage', (p) => p.message.includes('Failed to load LSL definitions YAML'));
	lsp.notify('workspace/didChangeConfiguration', { settings: { slua: { definitionsPath: path.join(root, '.local/does-not-exist.yaml') } } });
	await log;
	assert.ok((await hover())?.contents); results.push('failed configuration preserves registry');
	const chosen = path.join(root, 'third_party/lsl-definitions/lsl_definitions.yaml');
	assert.equal((await lsp.request('slua/setDefinitions', { definitionsPath: chosen })).accepted, true);
	assert.equal((await lsp.request('slua/setDefinitions', { definitionsPath: path.join(root, '.local/missing-defs.yaml') })).accepted, false);
	assert.deepEqual(await lsp.request('slua/getDefinitions', {}), { loaded: true, definitionsPath: chosen });
	results.push('definition activation acknowledgement matches the actual registry');
	const invalid = await change('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'local =' }] });
	assert.ok(invalid.diagnostics.some((d) => d.code === 'parse-error'));
	assert.equal(await hover(), null); results.push('edit invalidates old parse');
	const editedTokens = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } });
	assert.notDeepEqual(editedTokens, firstTokens); results.push('edit invalidates semantic token data');
	const repaired = await change('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'll.Say(0, "repaired")' }] });
	assert.ok(!repaired.diagnostics.some((d) => d.severity === 1));
	assert.ok((await hover())?.contents); results.push('subsequent edit recovers');
	await change('textDocument/didClose', { textDocument: { uri } });
	assert.equal(await hover(), null);
	assert.deepEqual(await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } }), { data: [] });
	const reopened = await change('textDocument/didOpen', { textDocument: { uri, version: 1, languageId: 'luau', text: 'local =' } });
	assert.ok(reopened.diagnostics.some((d) => d.code === 'parse-error')); results.push('close and reopen forgets prior epoch');
	assert.deepEqual(await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } }), editedTokens);
	results.push('same-version reopening uses its new semantic token snapshot');
	const destination = path.join(root, '.local/logs/lsp-recovery.json');
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await fs.writeFile(destination, JSON.stringify({ passed: true, results }, null, 2) + '\n');
	console.log(JSON.stringify({ passed: true, results }));
} finally { await lsp.close(); }
