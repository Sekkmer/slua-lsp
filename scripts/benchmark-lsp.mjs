import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchServer } from './lsp-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = process.argv[2] || 'current';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
let corpus = process.env.SLUA_BENCH_CORPUS;
if (!corpus) {
	try {
		const prepared = JSON.parse(await fs.readFile(path.join(process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), 'oracle-corpus/results.json'), 'utf8'));
		assert.equal(prepared.mismatches, 0, 'Resolve corpus mismatches before benchmarking');
		assert.equal(prepared.portableRuntime?.exit, 0, 'Qualify the corpus runtime first');
		corpus = prepared.acceptedRoot;
	} catch (error) { if (error.code !== 'ENOENT') throw error; }
}
corpus ??= path.join(root, '.local/oracle-corpus/accepted'); // Legacy prepared corpus remains usable.
const serverEntry = process.env.SLUA_BENCH_SERVER ?? path.join(root, 'slua-lsp-server/out/index.js');
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
async function compiledIdentity() {
	const files = [];
	async function scan(relative) {
		for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.posix.join(relative, entry.name);
			if (entry.isDirectory()) await scan(file);
			else if (entry.isFile()) {
				const raw = await fs.readFile(path.join(root, file));
				files.push({ file, bytes: raw.length, sha256: hash(raw) });
			}
		}
	}
	for (const directory of ['slua-lsp-core/out', 'slua-lsp-server/out']) await scan(directory);
	return { sha256: hash(JSON.stringify(files)), files,
		lockSha256: hash(await fs.readFile(path.join(root, 'pnpm-lock.yaml'))),
		nodeSha256: hash(await fs.readFile(process.execPath)) };
}
const inputs = await compiledIdentity();
const fixtures = await Promise.all((await fs.readdir(corpus)).filter((f) => f.endsWith('.luau')).sort().map(async (file) => {
	const text = await fs.readFile(path.join(corpus, file), 'utf8');
	return { file, text, bytes: Buffer.byteLength(text), sha256: hash(text) };
}));
assert.ok(fixtures.length >= 125, 'Prepare the pinned oracle corpus first');
const largest = [...fixtures].sort((a, b) => b.bytes - a.bytes)[0];
const largeText = `ll.Say(0, "benchmark")\n${(`do\n${largest.text}\nend\n`).repeat(12)}`;
const profile = process.env.SLUA_BENCH_PROFILE === '1';
const profileDir = path.join(root, '.local/performance/profiles');
if (profile) await fs.mkdir(profileDir, { recursive: true });
const clock = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
const ticksPerSecond = Number(clock.stdout?.trim());
assert.ok(clock.status === 0 && ticksPerSecond > 0, 'Linux CPU clock units must be observed');
const schedstatsEnabled = await fs.readFile('/proc/sys/kernel/sched_schedstats', 'utf8').then((x) => x.trim() === '1', () => false);
const processStart = performance.now();
const lsp = launchServer(serverEntry, root,
	{ nodeArgs: profile ? ['--cpu-prof', `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${label}.cpuprofile`] : [] });
const samples = {}, memory = {}, opened = [], accounting = {};
async function counters() {
	const stat = await fs.readFile(`/proc/${lsp.child.pid}/stat`, 'utf8');
	const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
	const sched = (await fs.readFile(`/proc/${lsp.child.pid}/schedstat`, 'utf8')).trim().split(/\s+/).map(Number);
	return { atMs: performance.now(), processCpuTicks: Number(fields[11]) + Number(fields[12]), mainThreadCpuNs: sched[0], runQueueWaitNs: schedstatsEnabled ? sched[1] : null };
}
async function measure(group, operation) {
	const before = await counters(), start = performance.now();
	const result = await operation();
	const end = performance.now(), after = await counters();
	(accounting[group] ??= []).push({ wallMs: end - start, processCpuMs: (after.processCpuTicks - before.processCpuTicks) * 1000 / ticksPerSecond,
		mainThreadCpuMs: (after.mainThreadCpuNs - before.mainThreadCpuNs) / 1e6,
		runQueueWaitMs: schedstatsEnabled ? (after.runQueueWaitNs - before.runQueueWaitNs) / 1e6 : null,
		counterWindowMs: after.atMs - before.atMs });
	return result;
}
function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return { n: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
}
async function rss() {
	const status = await fs.readFile(`/proc/${lsp.child.pid}/status`, 'utf8');
	return Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024;
}
async function open(uri, text) {
	const result = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri);
	lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'luau', version: 1, text } });
	await result; opened.push(uri);
	// Barrier drains any second validation notification generated during open.
	await lsp.request('textDocument/documentSymbol', { textDocument: { uri } });
}
try {
	const start = performance.now();
	const initialized = await measure('initialize', () => lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(corpus).href, capabilities: {} }));
	assert.ok(initialized.capabilities.completionProvider);
	samples.initializeMs = accounting.initialize[0].wallMs;
	samples.processStartToInitializeMs = performance.now() - processStart;
	lsp.notify('initialized', {});
	memory.initialRssBytes = await rss();
	const workspaceStart = performance.now();
	for (const fixture of fixtures) await open(pathToFileURL(path.join(corpus, fixture.file)).href, fixture.text);
	samples.openCorpusMs = performance.now() - workspaceStart;
	memory.corpusRssBytes = await rss();
	const uri = pathToFileURL(path.join(root, '.local/fixtures/benchmark-large.luau')).href;
	const largeStart = performance.now(); await open(uri, largeText); samples.largeOpenMs = performance.now() - largeStart;
	memory.largeRssBytes = await rss();
	for (const method of ['completion', 'hover', 'semanticTokens/full', 'documentSymbol']) {
		const times = [];
		for (let i = 0; i < 16; i++) {
			const start = performance.now();
			const result = await measure(method, () => lsp.request(`textDocument/${method}`, { textDocument: { uri }, position: { line: 0, character: 4 }, context: { triggerKind: 1 } }));
			if (method === 'completion') assert.ok((result.items || result).some((item) => item.label === 'Say'));
			if (method === 'hover') assert.ok(result?.contents);
			if (method === 'semanticTokens/full') assert.ok(result?.data?.length);
			times.push(accounting[method].at(-1).wallMs);
		}
		samples[method] = stats(times);
	}
	const edits = [];
	for (let i = 0; i < 16; i++) {
		const start = performance.now();
		await measure('incrementalEditToDiagnostics', async () => {
		const changed = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === uri);
		lsp.notify('textDocument/didChange', { textDocument: { uri, version: i + 2 }, contentChanges: [{
			range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } }, text: String(i % 2)
		}] });
		await changed;
		});
		edits.push(accounting.incrementalEditToDiagnostics.at(-1).wallMs);
	}
	samples.incrementalEditToDiagnostics = stats(edits);
	for (const uri of opened) lsp.notify('textDocument/didClose', { textDocument: { uri } });
	await lsp.request('textDocument/documentSymbol', { textDocument: { uri } });
	memory.afterCloseRssBytes = await rss();
	assert.deepEqual(await compiledIdentity(), inputs, 'Compiled server/core inputs changed during measurement');
	const report = { label, measuredAt: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
		serverEntry, serverSha256: hash(await fs.readFile(serverEntry)),
		inputScope: serverEntry === path.join(root, 'slua-lsp-server/out/index.js') ? 'compiledInputs binds the active development server/core' : 'serverSha256 binds the active bundled server; compiledInputs records the development build for context, not the active bundle. Match packaged definitions/assets with candidate verification.',
		compiledInputs: inputs,
		fixtureCount: fixtures.length, fixtureBytes: fixtures.reduce((n, f) => n + f.bytes, 0),
		largeFixture: { bytes: Buffer.byteLength(largeText), lines: largeText.split('\n').length, sha256: hash(largeText), base: largest.file, repetitions: 12 },
		fixtures: fixtures.map(({ text: _, ...fixture }) => fixture), samples, memory, accounting,
		instrumentation: { profile, profilePath: profile ? path.relative(root, path.join(profileDir, `${label}.cpuprofile`)) : null,
			ticksPerSecond, schedstatsEnabled, runQueueWaitAvailable: schedstatsEnabled,
			benchmarkSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
			harnessSha256: hash(await fs.readFile(path.join(root, 'scripts/lsp-harness.mjs'))),
			note: 'CPU counters bracket a slightly wider window than the request wall time. Process CPU ticks include all threads and are quantized; main-thread CPU excludes worker/GC threads. Runqueue wait is null when kernel schedstats is disabled. Profiling adds overhead. CPU and elapsed time are reported separately; wall minus CPU is not asserted to equal scheduler wait.' },
		limits: `Local stdio transport, ${fixtures.length} real accepted snippets plus a repeated largest snippet stress case. Closed files are not workspace-indexed. RSS includes the runtime heap and is not live-object retention. compiledInputs binds the server/core output bytes and Node binary; the lock hash records dependency declarations, not every installed dependency byte. serverSha256 alone binds only the thin entry point.` };
	const destination = path.join(root, '.local/performance'); await fs.mkdir(destination, { recursive: true });
	await fs.writeFile(path.join(destination, `${label}.json`), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify({ samples, memory, accounting: Object.fromEntries(Object.entries(accounting).map(([name, rows]) => [name, { cpu: stats(rows.map((r) => r.processCpuMs)), mainThreadCpu: stats(rows.map((r) => r.mainThreadCpuMs)), wall: stats(rows.map((r) => r.wallMs)) }])), profile }));
} finally { await lsp.close(); }
