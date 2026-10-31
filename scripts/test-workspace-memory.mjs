import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const count = Number(process.env.SLUA_WORKSPACE_FILES ?? 512);
const binding = process.env.SLUA_WORKSPACE_BINDING ?? 'local';
assert.ok(binding === 'local' || binding === 'const', 'SLUA_WORKSPACE_BINDING must be local or const');
assert.ok(Number.isInteger(count) && count >= 16 && count <= 4096);
assert.ok(typeof WebSocket === 'function', 'This local qualification needs Node with built-in WebSocket');
const entry = process.env.SLUA_WORKSPACE_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const folder = path.join(root, '.local/workspace-memory', `v2-${count}${binding === 'const' ? '-const' : ''}`);
await fs.mkdir(folder, { recursive: true });
async function fixture(file, text) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	try { await fs.writeFile(file, text, { flag: 'wx' }); }
	catch (err) { if (err.code !== 'EEXIST') throw err; assert.equal(await fs.readFile(file, 'utf8'), text, `Preserve unexpected existing fixture: ${file}`); }
	return { uri: pathToFileURL(file).href, bytes: Buffer.byteLength(text), sha256: hash(text), text };
}
const documents = [];
for (let i = 0; i < count; i++) documents.push(await fixture(path.join(folder, `folder-${i % 8}`, `${i}.luau`),
	`${binding} count = ${i}\n${binding} function double(value: number): number\n return value * 2\nend\n${binding} values: {number} = {count, double(count)}\nfor index, value in values do print(index, value) end\nprint(count)\n`));
const base = await fs.readFile(path.join(root, 'slua-lsp-core/tests/fixtures/probes/llevents_log_all_once_shapes.luau'), 'utf8');
const large = await fixture(path.join(folder, 'large.luau'), `ll.Say(0, "workspace stress")\n${(`do\n${base}\nend\n`).repeat(48)}`);
const lsp = launchServer(entry, root, { nodeArgs: ['--inspect=127.0.0.1:0'] });
let inspector;
async function connect() {
	const url = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Owned child did not expose its inspector endpoint')), 30000);
		let output = '';
		const listener = (data) => {
			output += data.toString();
			const match = /ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/.exec(output);
			if (match) { clearTimeout(timer); lsp.child.stderr.off('data', listener); resolve(match[0]); }
		};
		lsp.child.stderr.on('data', listener);
	});
	const socket = new WebSocket(url), pending = new Map(); let nextId = 0;
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		const request = pending.get(message.id); if (!request) return;
		clearTimeout(request.timer); pending.delete(message.id);
		if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
	});
	await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
	return {
		call(method) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 30000);
				pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method }));
			});
		},
		close() { return new Promise((resolve) => { socket.addEventListener('close', resolve, { once: true }); socket.close(); }); }
	};
}
async function heap(collect = false) {
	if (collect) await inspector.call('HeapProfiler.collectGarbage');
	const usage = await inspector.call('Runtime.getHeapUsage');
	assert.ok(Number.isFinite(usage.usedSize) && usage.usedSize > 0);
	const status = await fs.readFile(`/proc/${lsp.child.pid}/status`, 'utf8');
	return { ...usage, rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024, forcedGc: collect };
}
async function change(method, params) {
	const response = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === params.textDocument.uri);
	lsp.notify(method, params); return response;
}
async function tokens(uri) { return lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } }); }
const cycles = [], checks = [];
try {
	inspector = await connect();
	await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} });
	lsp.notify('initialized', {});
	// Warm normal parser/token machinery before measuring close retention.
	for (const document of documents.slice(0, 4)) {
		await change('textDocument/didOpen', { textDocument: { uri: document.uri, languageId: 'luau', version: 1, text: document.text } });
		await tokens(document.uri); lsp.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
	}
	await lsp.request('textDocument/documentSymbol', { textDocument: { uri: documents[0].uri } });
	const baseline = await heap(true);
	for (let cycle = 0; cycle < 3; cycle++) {
		const openedAt = performance.now();
		for (const document of documents) {
			const result = await change('textDocument/didOpen', { textDocument: { uri: document.uri, languageId: 'luau', version: 1, text: document.text } });
			assert.deepEqual(result.diagnostics, [], `Unexpected diagnostic in ${document.uri}`);
			assert.ok((await tokens(document.uri)).data.length);
		}
		await change('textDocument/didOpen', { textDocument: { uri: large.uri, languageId: 'luau', version: 1, text: large.text } });
		assert.ok((await tokens(large.uri)).data.length);
		const openMs = performance.now() - openedAt;
		const open = await heap(true);
		const first = documents[0], previous = await tokens(first.uri);
		assert.deepEqual(await tokens(first.uri), previous);
		const references = await lsp.request('textDocument/references', { textDocument: { uri: first.uri }, position: { line: 6, character: 8 }, context: { includeDeclaration: true } });
		assert.equal(references.length, 4); assert.ok(references.every((reference) => reference.uri === first.uri));
		const rename = await lsp.request('textDocument/rename', { textDocument: { uri: first.uri }, position: { line: 6, character: 8 }, newName: 'total' });
		assert.deepEqual(Object.keys(rename.changes), [first.uri]); assert.equal(rename.changes[first.uri].length, 4);
		await change('textDocument/didChange', { textDocument: { uri: first.uri, version: 2 }, contentChanges: [{ text: first.text.replaceAll('count', 'quantity') }] });
		assert.notDeepEqual(await tokens(first.uri), previous);
		for (const document of [...documents, large]) lsp.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
		await lsp.request('textDocument/documentSymbol', { textDocument: { uri: first.uri } });
		assert.deepEqual(await tokens(first.uri), { data: [] });
		const closed = await heap(true);
		cycles.push({ cycle, openMs, open, closed, postCloseGrowthBytes: closed.usedSize - baseline.usedSize, releasedHeapBytes: open.usedSize - closed.usedSize });
		checks.push(`cycle ${cycle}: populated token caches, isolated references/rename, edit invalidation and close`);
	}
	// Concrete local retention budget after warmup; it is not a universal bound.
	const postCloseGrowthLimitBytes = 16 * 1024 * 1024;
	assert.ok(cycles.every((cycle) => cycle.postCloseGrowthBytes <= postCloseGrowthLimitBytes), 'Post-close retained heap exceeds the documented local 16MiB growth budget');
	assert.ok(cycles.every((cycle) => cycle.releasedHeapBytes > 0), 'Closing the cohort did not release measured heap');
	const report = { passed: true, measuredAt: new Date().toISOString(), node: process.version, entry, entrySha256: hash(await fs.readFile(entry)),
		fixtureCount: count, binding, largeSeed: { source: 'slua-lsp-core/tests/fixtures/probes/llevents_log_all_once_shapes.luau', sha256: hash(base) }, totalBytes: documents.reduce((sum, d) => sum + d.bytes, 0) + large.bytes,
		fixtureSetSha256: hash(JSON.stringify(documents.map(({ text, ...document }) => document))), large: { ...large, text: undefined },
		baseline, cycles, postCloseGrowthLimitBytes, checks,
		limits: 'Synthetic typed cohort plus a 48x repeat of a real pinned parser fixture. LSP checks never execute that source. Owned child only, ordinary stdio LSP and a loopback ephemeral V8 inspector; no FS IPC/viewer test. Forced-GC retained V8 heap differs from RSS and uninstrumented latency. Scope remains document-local; closed files are not indexed. The 16MiB growth budget is local to this three-cycle scenario, not a universal memory guarantee.' };
	const destination = process.env.SLUA_WORKSPACE_EVIDENCE ?? path.join(root, '.local/logs/workspace-memory.json');
	await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report));
} finally { if (inspector) await inspector.close(); await lsp.close(); }
