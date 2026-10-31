// Owned local source graph, stdio LSP and loopback V8 inspector only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const server = process.env.SLUA_GENERATION_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const cli = process.env.SLUA_GENERATION_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const output = process.env.SLUA_GENERATION_BUDGET_EVIDENCE ?? path.join(root, '.local/logs/generation-budget.json');
await fs.mkdir(path.dirname(output), { recursive: true }); const evidence = await fs.open(output, 'wx');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const parent = process.env.SLUA_GENERATION_FIXTURE_ROOT ?? path.join(root, '.local/fixtures'); await fs.mkdir(parent, { recursive: true });
const folder = await fs.mkdtemp(path.join(parent, 'generation-budget-'));
const report = { passed: false, releaseAcceptance: false, recordedAt: new Date().toISOString(), node: process.version,
	harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), server, serverSha256: digest(await fs.readFile(server)),
	cli, cliSha256: digest(await fs.readFile(cli)), folder, cycles: [], limits: [],
	scope: 'One owned 129-file / roughly 2 MiB source project; three repeated generation/forced-GC cycles, inotify lifetime observation, local C++ generated-program syntax/runtime, and explicit CLI replacement/output refusals. Named local measurements, not universal latency/RSS or simulator upload limits. No viewer/FS IPC or world effects.' };
const sourceParts = ['local total=0'];
for (let index = 0; index < 128; index++) {
	await fs.writeFile(path.join(folder, `m${index}.luau`), `return {value=${index},payload="${'x'.repeat(16384)}"}`, { flag: 'wx' });
	sourceParts.push(`local m${index}=require("m${index}")\ntotal+=m${index}.value`);
}
sourceParts.push('assert(total==8128)\nprint("large-ok")');
const main = path.join(folder, 'main.luau'); await fs.writeFile(main, sourceParts.join('\n'), { flag: 'wx' });
const lsp = launchServer(server, root, { nodeArgs: ['--inspect=127.0.0.1:0'] });
let inspector;
async function connect() {
	const endpoint = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Owned child inspector missing')), 30000); let text = '';
		const listener = (data) => { text += data.toString(); const found = /ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/.exec(text);
			if (found) { clearTimeout(timer); lsp.child.stderr.off('data', listener); resolve(found[0]); } };
		lsp.child.stderr.on('data', listener);
	});
	const socket = new WebSocket(endpoint), pending = new Map(); let id = 0;
	socket.addEventListener('message', (event) => { const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return;
		clearTimeout(request.timer); pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); });
	await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
	return { call(method) { const current = ++id; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Inspector timeout: ${method}`)); }, 30000);
		pending.set(current, { resolve, reject, timer }); socket.send(JSON.stringify({ id: current, method })); }); },
		close() { return new Promise((resolve) => { socket.addEventListener('close', resolve, { once: true }); socket.close(); }); } };
}
async function sample() {
	await inspector.call('HeapProfiler.collectGarbage'); const usage = await inspector.call('Runtime.getHeapUsage');
	assert.ok(Number.isFinite(usage.usedSize) && usage.usedSize > 0); let watches = 0;
	for (const name of await fs.readdir(`/proc/${lsp.child.pid}/fdinfo`)) { try { const text = await fs.readFile(`/proc/${lsp.child.pid}/fdinfo/${name}`, 'utf8'); watches += (text.match(/^inotify wd:/gm) ?? []).length; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
	const status = await fs.readFile(`/proc/${lsp.child.pid}/status`, 'utf8');
	return { ...usage, rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024, watches, forcedGc: true };
}
const run = (command, args, options = {}) => { const start = performance.now(); const done = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
	if (done.error || done.signal) report.processFailure = { command, args, error: done.error?.message, signal: done.signal, status: done.status, stderr: done.stderr };
	assert.ifError(done.error); assert.equal(done.signal, null); return { exit: done.status, stdout: done.stdout, stderr: done.stderr, ms: performance.now() - start }; };
try {
	inspector = await connect(); await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {} }); lsp.notify('initialized', {});
	const generate = async () => { const start = performance.now(); const result = await lsp.request('slua/preprocess', { uri: pathToFileURL(main).href });
		assert.ok(result.success); assert.equal(result.graph.modules.length, 129); assert.equal(result.moduleIds.length, 128); assert.equal(result.contentSha256, digest(result.content));
		return { result, ms: performance.now() - start }; };
	const first = await generate(); report.warmupMs = first.ms; report.sourceBytes = first.result.graph.modules.reduce((n, item) => n + item.bytes, 0);
	report.generatedBytes = Buffer.byteLength(first.result.content); report.sourceFiles = first.result.graph.modules;
	const generated = path.join(folder, 'generated.luau'); await fs.writeFile(generated, first.result.content, { flag: 'wx' }); report.generatedSha256 = first.result.contentSha256;
	const baseline = await sample(); report.baseline = baseline;
	for (let cycle = 0; cycle < 3; cycle++) {
		const requests = [];
		for (let index = 0; index < 3; index++) requests.push((await generate()).ms);
		const after = await sample(), growth = after.usedSize - baseline.usedSize;
		report.cycles.push({ cycle, requestsMs: requests, after, growthBytes: growth });
		assert.ok(growth < 16 * 1024 * 1024, `Retained generation heap grew ${growth} bytes`); assert.equal(after.watches, baseline.watches);
	}
	const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
	const bin = process.env.SLUA_NATIVE_BIN ?? path.join(local, 'build/slua-oracle');
	const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
	const pin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-source.json'), 'utf8'));
	assert.equal(build.status, 'built'); assert.equal(build.inputs.pin.commit, pin.commit); assert.equal(build.inputs.pin.archive_sha256, pin.archive_sha256);
	const source = run('python3', ['scripts/prepare-oracle.py', '--local-dir', path.dirname(path.dirname(build.source.root)), '--check']); assert.equal(source.exit, 0, source.stderr);
	assert.equal(JSON.parse(source.stdout).contentSha256, build.inputs.sourceContentSha256);
	for (const name of ['slua', 'slua-compile']) assert.equal(digest(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	report.nativeBinaries = { slua: build.binaries.slua, compile: build.binaries['slua-compile'] };
	const syntax = run(path.join(bin, 'slua-compile'), ['--null', generated]); assert.equal(syntax.exit, 0, syntax.stderr); report.nativeSyntax = syntax;
	const native = run(path.join(bin, 'slua'), ['--sl', generated]); assert.equal(native.exit, 0, native.stderr); assert.equal(native.stdout, 'large-ok\n'); assert.equal(native.stderr, ''); report.native = native;
	const context = path.join(folder, 'context.json'); await fs.writeFile(context, JSON.stringify({ agentName: 'n'.repeat(1024) }), { flag: 'wx' });
	for (const [name, text, contextFile] of [['replacement-count', 'print(__LINE__)\n'.repeat(65537), true], ['output-bytes', 'print(__AGENTNAME__)\n'.repeat(50000), true]]) {
		const file = path.join(folder, name + '.luau'); await fs.writeFile(file, text, { flag: 'wx' });
		const rawSyntax = run(path.join(bin, 'slua-compile'), ['--null', file]); assert.equal(rawSyntax.exit, 0, rawSyntax.stderr);
		const args = ['--max-old-space-size=384', cli, 'preprocess', file]; if (contextFile) args.push('--preprocessor-context', context);
		const done = run(process.execPath, args); assert.equal(done.exit, 1, done.stderr); assert.equal(done.stderr, ''); const result = JSON.parse(done.stdout);
		report.limits.push({ name, sourceSha256: digest(text), sourceBytes: Buffer.byteLength(text), rawNativeSyntax: rawSyntax, heapMiB: 384, ms: done.ms, diagnostics: result.diagnostics });
		assert.equal(result.content, null); assert.equal(result.contentSha256, null); assert.deepEqual(result.mappings, []);
		assert.ok(result.diagnostics.some((item) => item.code === 'preprocessor-limit' && item.message.includes(name === 'replacement-count' ? '65536 replacements' : '50331648 bytes')));
	}
	report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); throw error; }
finally { try { if (inspector) await inspector.close(); await lsp.close(); } catch (error) { report.passed = false; report.shutdownError = String(error); throw error; }
	finally { await evidence.writeFile(JSON.stringify(report, null, 2) + '\n'); await evidence.close(); } }
console.log(JSON.stringify({ passed: true, sourceBytes: report.sourceBytes, generatedBytes: report.generatedBytes, cycles: report.cycles.map((item) => ({ growthBytes: item.growthBytes, requestsMs: item.requestsMs })), output }));
