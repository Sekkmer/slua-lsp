import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = process.env.SLUA_CODE_ACTION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const results = [];
function apply(text, edits) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	for (const edit of [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
		const start = starts[edit.range.start.line] + edit.range.start.character;
		const end = starts[edit.range.end.line] + edit.range.end.character;
		text = text.slice(0, start) + edit.newText + text.slice(end);
	}
	return text;
}
for (const versioned of [true, false]) {
	const lsp = launchServer(entry, root);
	const uri = pathToFileURL(path.join(root, `.local/fixtures/code-action-${versioned}.luau`)).href;
	let version = 1;
	async function change(method, params) {
		const response = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri);
		lsp.notify(method, params); return response;
	}
	function request(range, diagnostics = [], only) {
		return lsp.request('textDocument/codeAction', { textDocument: { uri }, range, context: { diagnostics, ...(only ? { only } : {}) } });
	}
	function edits(action) {
		if (!versioned) { assert.ok(action.edit.changes); assert.equal(action.edit.documentChanges, undefined); return action.edit.changes[uri]; }
		assert.equal(action.edit.changes, undefined);
		assert.deepEqual(action.edit.documentChanges[0].textDocument, { uri, version });
		return action.edit.documentChanges[0].edits;
	}
	try {
		const initialized = await lsp.request('initialize', { processId: process.pid, rootUri: null,
			capabilities: { workspace: { workspaceEdit: { documentChanges: versioned } } } });
		assert.deepEqual(initialized.capabilities.codeActionProvider.codeActionKinds, ['quickfix']);
		lsp.notify('initialized', {});
		const source = 'local json = lljson\nlocal greeting = "😀"; json -- : .\n : -- : .\n encode(greeting)';
		const opened = await change('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version, text: source } });
		const diagnostic = opened.diagnostics.find((d) => d.code === 'use-dot-call'); assert.ok(diagnostic);
		const actions = await request(diagnostic.range, [diagnostic]);
		const fix = actions.find((a) => a.isPreferred); assert.ok(fix);
		assert.deepEqual(edits(fix), [{ range: { start: { line: 2, character: 1 }, end: { line: 2, character: 2 } }, newText: '.' }]);
		const changed = apply(source, edits(fix)); version++;
		const repaired = await change('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: changed }] });
		assert.ok(!repaired.diagnostics.some((d) => d.code === 'use-dot-call'));
		assert.deepEqual(await request(diagnostic.range, [diagnostic]), []);
		results.push(`${versioned ? 'versioned' : 'legacy'} call edit, comment/UTF-16 ranges, revalidation and stale-context rejection`);

		const suppressionSource = '-- slua-lsp:disable-next-line use-colon-call\r\nLLTimers.once(0, missingSentinel)'; version++;
		const missing = await change('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: suppressionSource }] });
		const undeclared = missing.diagnostics.find((d) => d.code === 'undeclared-name'); assert.ok(undeclared);
		assert.deepEqual(await request(undeclared.range, [undeclared], ['source']), []);
		const suppression = (await request(undeclared.range, [undeclared], ['quickfix'])).find((a) => a.title === "Suppress 'undeclared-name' on this line");
		assert.ok(suppression && !suppression.isPreferred);
		const suppressedText = apply(suppressionSource, edits(suppression)); version++;
		assert.ok(suppressedText.startsWith('-- slua-lsp:disable-next-line use-colon-call, undeclared-name\r\n'));
		const suppressed = await change('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: suppressedText }] });
		assert.ok(!suppressed.diagnostics.some((d) => ['use-colon-call', 'undeclared-name'].includes(d.code)));
		results.push(`${versioned ? 'versioned' : 'legacy'} semantic suppression preserves existing directive and CRLF, honors kind filtering`);

		await change('textDocument/didClose', { textDocument: { uri } });
		assert.deepEqual(await request(diagnostic.range, [diagnostic]), []);
		results.push(`${versioned ? 'versioned' : 'legacy'} closed documents provide no stale edit`);
	} finally { await lsp.close(); }
}
const destination = process.env.SLUA_CODE_ACTION_EVIDENCE ?? path.join(root, '.local/logs/code-actions-protocol.json');
const report = { passed: true, measuredAt: new Date().toISOString(), entry, entrySha256: crypto.createHash('sha256').update(await fs.readFile(entry)).digest('hex'), results };
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
