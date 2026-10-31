import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import { ruleLiteralTruthiness } from '../slua-lsp-core/out/diagnostics/rules/gotchas.js';

const root = fileURLToPath(new URL('../', import.meta.url)), digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
const output = process.env.SLUA_SCALING_EVIDENCE ?? path.join(root, '.local/logs/gotcha-scaling.json');
await fs.mkdir(path.dirname(output), { recursive: true }); const handle = await fs.open(output, 'wx');
const report = { passed: false, releaseAcceptance: false, node: process.version, executableSha256: digest(await fs.readFile(process.execPath)), harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), ruleSha256: digest(await fs.readFile(path.join(root, 'slua-lsp-core/out/diagnostics/rules/gotchas.js'))), results: [],
	scope: 'Actual parsed source, transparent AST proxy counts logical-edge reads as a deterministic traversal budget. Direct-rule local timings are supplementary, not universal latency or whole-server improvement. Optional preserved baseline is explicit and hash-verified. No user code execution outside the owned native program, FS IPC or host effects.' };
function measure(ast, rule) {
	let edges = 0; const proxies = new WeakMap();
	function wrap(value) {
		if (!value || typeof value !== 'object') return value;
		if (!proxies.has(value)) proxies.set(value, new Proxy(value, { get(target, key, receiver) { if (key === 'left' || key === 'right') edges++; return wrap(Reflect.get(target, key, receiver)); } }));
		return proxies.get(value);
	}
	const diagnostic = rule(wrap(ast)); assert.deepEqual(diagnostic, []);
	const samples = [];
	for (let pass = 0; pass < 5; pass++) { const start = performance.now(); assert.deepEqual(rule(ast), []); samples.push(performance.now() - start); }
	return { edgeReads: edges, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[2] };
}
try {
	let baseline;
	if (process.env.SLUA_GOTCHA_BASELINE_CORE) {
		const manifest = JSON.parse(await fs.readFile(process.env.SLUA_GOTCHA_BASELINE_MANIFEST, 'utf8'));
		for (const item of manifest.files) assert.equal(digest(await fs.readFile(path.join(root, item.path))), item.sha256);
		const entry = path.join(process.env.SLUA_GOTCHA_BASELINE_CORE, 'diagnostics/rules/gotchas.js');
		baseline = (await import(pathToFileURL(entry).href)).ruleLiteralTruthiness; report.baseline = { entry, sha256: digest(await fs.readFile(entry)), manifestSha256: digest(await fs.readFile(process.env.SLUA_GOTCHA_BASELINE_MANIFEST)), packageSha256: digest(await fs.readFile(path.join(process.env.SLUA_GOTCHA_BASELINE_CORE, 'package.json'))) };
	}
	let largest;
	for (const count of [64, 128, 256, 512]) {
		const source = `local function check(flag: boolean) if ${Array(count).fill('flag').join(' and ')} then return 1 else return 0 end end\nassert(check(true)==1 and check(false)==0)\nprint("scaling-ok")`;
		const parsed = parseSlua(source); assert.deepEqual(parsed.diagnostics, []);
		const item = { terms: count, sourceSha256: digest(Buffer.from(source)), current: measure(parsed.ast, ruleLiteralTruthiness) };
		assert.ok(item.current.edgeReads <= 12 * count, JSON.stringify(item));
		if (baseline) item.baseline = measure(parsed.ast, baseline);
		report.results.push(item); largest = source;
	}
	await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true }); const directory = await fs.mkdtemp(path.join(root, '.local/fixtures/gotcha-scaling-'));
	const file = path.join(directory, 'condition.luau'); await fs.writeFile(file, largest, { flag: 'wx' });
	const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), bin = path.join(local, 'build/slua-oracle');
	const build = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
	for (const name of ['slua', 'slua-compile']) assert.equal(digest(await fs.readFile(path.join(bin, name))), build.binaries[name]);
	report.native = { file, sourceSha256: digest(Buffer.from(largest)), binaries: build.binaries, results: [] };
	for (const [name, args] of [['slua-compile', ['--only-parse', '--null', file]], ['slua-compile', ['--null', file]], ['slua', ['--sl', file]]]) {
		const child = spawnSync(path.join(bin, name), args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }); assert.ifError(child.error);
		report.native.results.push({ name, args, exit: child.status, stdout: child.stdout, stderr: child.stderr }); assert.equal(child.status, 0, child.stderr);
		if (name === 'slua') assert.equal(child.stdout, 'scaling-ok\n');
	}
	report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.close(); }
console.log(JSON.stringify({ passed: report.passed, cases: report.results.length, output }));
