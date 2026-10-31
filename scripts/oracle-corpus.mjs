import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSlua } from '../slua-lsp-core/out/index.js';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = process.env.SLUA_CORPUS_LOCAL ?? process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const documentationPin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-docs.json'), 'utf8'));
const sourcePin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-source.json'), 'utf8'));
const documentation = { ...documentationPin, root: path.join(local, 'upstream', `create-${documentationPin.commit}`) };
const source = { ...sourcePin, root: path.join(local, 'upstream', `slua-${sourcePin.commit}`) };
const output = process.env.SLUA_CORPUS_OUTPUT ?? path.join(local, 'oracle-corpus');
const bin = process.env.SLUA_NATIVE_BIN ?? path.join(process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local'), 'build/slua-oracle');
const sourceVerification = {};
for (const name of ['source', 'documentation']) {
	const args = [path.join(root, 'scripts/prepare-oracle.py'), '--local-dir', local, '--check', ...(name === 'documentation' ? ['--documentation'] : [])];
	const verification = spawnSync('python3', args, { encoding: 'utf8', timeout: 60000 });
	assert.equal(verification.status, 0, `Prepare a complete verified ${name} snapshot first: ${verification.stderr}`);
	sourceVerification[name] = JSON.parse(verification.stdout);
}
const cases = [];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function immutable(file, text) {
	try { await fs.writeFile(file, text, { flag: 'wx' }); }
	catch (error) {
		if (error.code !== 'EEXIST') throw error;
		if (await fs.readFile(file, 'utf8') !== text) throw new Error(`Existing corpus evidence differs; preserved ${file}`);
	}
}
async function visit(dir) {
	for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) await visit(file);
		else if (/\.mdx?$/.test(entry.name)) {
			const text = await fs.readFile(file, 'utf8');
			let index = 0;
			for (const match of text.matchAll(/```(?:luau|lua)\s*\n([\s\S]*?)```/g)) {
				cases.push({ name: `${path.relative(documentation.root, file)}#example-${++index}`, text: match[1] });
			}
		}
	}
}
await visit(path.join(documentation.root, 'src/content/docs/script'));
for (const name of (await fs.readdir(path.join(root, 'slua-lsp-core/tests/fixtures/probes'))).sort()) {
	if (/\.(lua|luau)$/.test(name)) cases.push({ name: `probes/${name}`, text: await fs.readFile(path.join(root, 'slua-lsp-core/tests/fixtures/probes', name), 'utf8') });
}
const compiler = path.join(bin, 'slua-compile');
const compilerSha256 = hash(await fs.readFile(compiler));
const runtimeSha256 = hash(await fs.readFile(path.join(bin, 'slua')));
const buildRecord = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
assert.equal(buildRecord.status, 'built', 'Require a completed recorded native build');
assert.equal(buildRecord.inputs?.pin?.commit, sourcePin.commit, 'Corpus compiler source commit differs from the pin');
assert.equal(buildRecord.inputs?.pin?.archive_sha256, sourcePin.archive_sha256, 'Corpus compiler archive differs from the pin');
assert.equal(buildRecord.inputs?.sourceContentSha256, sourceVerification.source.contentSha256, 'Corpus compiler source-content binding differs');
assert.equal(buildRecord.binaries?.['slua-compile'], compilerSha256, 'Corpus compiler binary differs from its build record');
assert.equal(buildRecord.binaries?.slua, runtimeSha256, 'Corpus runtime binary differs from its build record');
const portableSource = `local values = {1, 2, 3}\nassert(#values == 3)\nassert(7 // 4 == 1)\nassert(0 and true)\nassert("" and true)\nlocal n = 0\nfor _, value in values do n += value end\nassert(n == 6)\nassert(bit32.band(7, 3) == 3)\nlocal result = if n == 6 then "pass" else "fail"\nassert(result == "pass")\nprint("portable-runtime: pass")\n`;
const fixtureInputs = cases.map((item) => ({ name: item.name, sha256: hash(item.text) }));
const generationSha256 = hash(JSON.stringify({ documentationPin, sourcePin, compilerSha256, runtimeSha256, fixtureInputs, portable: hash(portableSource) }));
const generation = path.join(output, 'generations', generationSha256);
const acceptedRoot = path.join(generation, 'accepted');
await fs.mkdir(path.join(generation, 'fixtures'), { recursive: true });
await fs.mkdir(acceptedRoot, { recursive: true });
const results = [];
for (const [index, item] of cases.entries()) {
	const name = `${String(index).padStart(4, '0')}.luau`;
	const file = path.join(generation, 'fixtures', name);
	await immutable(file, item.text);
	const start = performance.now();
	const native = spawnSync(compiler, ['--only-parse', '--null', file], { encoding: 'utf8', timeout: 10000 });
	if (native.error || native.status === null) throw native.error ?? new Error('C++ compiler did not return a status');
	const parsed = parseSlua(item.text);
	const nativeValid = native.status === 0;
	const lspValid = parsed.diagnostics.length === 0;
	if (nativeValid) await immutable(path.join(acceptedRoot, name), item.text);
	results.push({ name: item.name, file: path.relative(root, file), sha256: crypto.createHash('sha256').update(item.text).digest('hex'),
		nativeExit: native.status, nativeValid, lspValid, mismatch: nativeValid !== lspValid,
		nativeDiagnostics: native.stderr + native.stdout, lspDiagnostics: parsed.diagnostics,
		seconds: (performance.now() - start) / 1000 });
}
const runtimeFile = path.join(generation, 'portable-runtime.luau');
await immutable(runtimeFile, portableSource);
const runtime = spawnSync(path.join(bin, 'slua'), [runtimeFile], { encoding: 'utf8', timeout: 10000 });
const report = { createdAt: new Date().toISOString(), documentation, source, sourceVerification, compilerSha256, runtimeSha256, generationSha256, acceptedRoot,
	count: results.length, mismatches: results.filter((r) => r.mismatch).length, nativeAccepted: results.filter((r) => r.nativeValid).length,
	portableRuntime: { exit: runtime.status, stdout: runtime.stdout, stderr: runtime.stderr, error: runtime.error?.message },
	classification: 'Official examples include fragments and intentionally invalid code. C++ acceptance is observed per case; mismatches require review, not blanket acceptance of every snippet.', results };
const previous = path.join(output, 'results.json');
try {
	await fs.mkdir(path.join(output, 'history'), { recursive: true });
	await fs.copyFile(previous, path.join(output, 'history', `results-${Date.now()}.json`));
} catch (err) { if (err.code !== 'ENOENT') throw err; }
const staged = path.join(output, `results-${crypto.randomUUID()}.tmp`);
await fs.writeFile(staged, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await fs.rename(staged, path.join(output, 'results.json'));
process.stdout.write(JSON.stringify({ count: report.count, mismatches: report.mismatches, nativeAccepted: report.nativeAccepted, acceptedRoot, generationSha256, portableRuntime: report.portableRuntime }) + '\n');
// Investigation may retain mismatches; the default is an actual qualification gate.
process.exitCode = runtime.status === 0 && (report.mismatches === 0 || process.argv.includes('--investigate')) ? 0 : 1;
