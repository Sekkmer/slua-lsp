import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = process.cwd();
const folder = process.env.SLUA_DIAGNOSTIC_PERF_CORE ?? path.join(root, 'slua-lsp-core/out');
const { parseSlua } = require(path.join(folder, 'parser/parseSlua.js'));
const { buildSluaRegistryFromLslDefinitions } = require(path.join(folder, 'slua/registry.js'));
const { ruleExpressionTypes } = require(path.join(folder, 'diagnostics/rules/callArgumentTypes.js'));
const { analyzeText } = require(path.join(folder, 'diagnostics/engine.js'));
const { inferLocalVariableTypes } = require(path.join(folder, 'typing/inferLocals.js'));
const { getVisibleLocalTypes } = require(path.join(folder, 'typing/completion.js'));
const { sluaTypeToString } = require(path.join(folder, 'slua/types.js'));
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const label = process.argv[2] ?? 'diagnostics'; assert.match(label, /^[a-zA-Z0-9-]{1,128}$/);
const fixture = process.env.SLUA_DIAGNOSTIC_PERF_FIXTURE ?? path.join(root, 'slua-lsp-core/tests/fixtures/native/table-construction-profile.luau');
const base = await fs.readFile(fixture, 'utf8');
const fixtures = [{ name: 'repeated-real', source: `ll.Say(0, "benchmark")\n${(`do\n${base}\nend\n`).repeat(12)}` },
	...[64, 128, 256, 512, 1024].map(count => ({ name: 'scalar-' + count,
		source: Array.from({ length: count }, (_, i) => `local v${i} = ${i}`).join('\n') + '\n' + Array.from({ length: count }, (_, i) => `v${i} = v${i}+1`).join('\n') }))];
async function inventory() {
	const files = [];
	async function scan(directory) { for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) await scan(absolute);
		else if (entry.isFile()) { const raw = await fs.readFile(absolute); files.push({ path: path.relative(folder, absolute), bytes: raw.length, sha256: hash(raw) }); }
	} }
	await scan(folder); return files;
}
const inputs = await inventory(), registry = buildSluaRegistryFromLslDefinitions(null), rows = [];
for (const { name, source } of fixtures) {
	const parsed = parseSlua(source); assert.deepEqual(parsed.diagnostics, []);
	const position = { line: source.split('\n').length - 1, character: source.split('\n').at(-1).length };
	for (const [route, operation] of [
		['expression-types', () => ruleExpressionTypes(parsed.ast, registry)],
		['all-diagnostics', () => analyzeText(source, { ast: parsed.ast, registry })],
		['inference', () => inferLocalVariableTypes(parsed.ast, registry).map(({ identifier, type }) => [identifier.name, sluaTypeToString(type)])],
		['cursor-locals', () => [...getVisibleLocalTypes(parsed.ast, position, registry)].map(([name,type]) => [name,sluaTypeToString(type)])]
	]) {
		const expected = operation(), resultSha256 = hash(JSON.stringify(expected)), observations = [];
		for (let i = 0; i < 5; i++) {
			const usage = process.cpuUsage(), start = performance.now(), result = operation(), wallMs = performance.now() - start, delta = process.cpuUsage(usage);
			observations.push({ wallMs, processCpuMs: (delta.user + delta.system) / 1000 });
			assert.equal(hash(JSON.stringify(result)), resultSha256, 'Analysis must be deterministic across observations');
		}
		const median = key => observations.map(x => x[key]).sort((a,b) => a-b)[2];
		rows.push({ fixture: name, bytes: Buffer.byteLength(source), sourceSha256: hash(source), route, resultCount: expected.length, resultSha256, observations,
			medianWallMs: median('wallMs'), medianProcessCpuMs: median('processCpuMs') });
	}
}
assert.deepEqual(await inventory(), inputs, 'Compiled analysis inputs changed during measurement');
const destination = process.env.SLUA_DIAGNOSTIC_PERF_EVIDENCE ?? path.join(root, '.local/performance', label + '.json');
await fs.mkdir(path.dirname(destination), { recursive: true });
const report = { passed: true, at: new Date().toISOString(), label, node: process.version, executable: process.execPath,
	executableSha256: hash(await fs.readFile(process.execPath)), harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
	coreFolder: folder, coreInputs: inputs, fixture, fixtureSha256: hash(base), rows,
	scope: 'Preparsed ASTs separate diagnosis/inference/cursor lookup from parsing, transport and editor overhead. Five observed operations after one warmup per route and fixture. Process CPU includes GC/workers and wider accounting; not main-thread CPU or latency guarantees. Large scalar counts exceed native registers and are static scaling stress only. The repeated source is analyzed, never executed. No FS IPC, host or world effects.' };
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ label, evidence: destination, rows: rows.map(({fixture,route,medianWallMs}) => ({fixture,route,medianWallMs})) }));
