import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, parseSlua } from '../slua-lsp-core/out/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local/native-qualification');
await fs.mkdir(output, { recursive: true });
const fixtures = path.join(root, 'slua-lsp-core/tests/fixtures/native');
const cases = JSON.parse(await fs.readFile(path.join(fixtures, 'qualification.json'), 'utf8'));
const registry = buildSluaRegistryFromLslDefinitions(null);
const sourcePin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-source.json'), 'utf8'));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const bin = process.env.SLUA_NATIVE_BIN ?? path.join(local, 'build/slua-oracle');
const identities = {};
for (const name of ['slua', 'slua-compile', 'slua-analyze']) identities[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(bin, name))).digest('hex');
const buildRecord = JSON.parse(await fs.readFile(path.join(bin, 'oracle-build.json'), 'utf8'));
assert.equal(buildRecord.status, 'built', 'Require a completed recorded native build');
assert.equal(buildRecord.inputs?.pin?.commit, sourcePin.commit, 'Native build source commit differs from the pin');
assert.equal(buildRecord.inputs?.pin?.archive_sha256, sourcePin.archive_sha256, 'Native build archive differs from the pin');
assert.equal(buildRecord.source?.contentSha256, buildRecord.inputs?.sourceContentSha256, 'Native build source-content binding differs');
for (const [name, sha256] of Object.entries(identities)) assert.equal(buildRecord.binaries?.[name], sha256, `Native build binary differs: ${name}`);
const verification = spawnSync('python3', [path.join(root, 'scripts/prepare-oracle.py'), '--local-dir', path.dirname(path.dirname(buildRecord.source.root)), '--check'], { encoding: 'utf8', timeout: 60000 });
assert.equal(verification.status, 0, `Native build source no longer verifies: ${verification.stderr}`);
const sourceVerification = JSON.parse(verification.stdout);
assert.equal(sourceVerification.contentSha256, buildRecord.inputs.sourceContentSha256, 'Native build current source differs from the recorded input');
function execute(name, args) {
	const result = spawnSync(path.join(bin, name), args, { cwd: output, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
	if (result.error || result.status === null) throw result.error ?? new Error(`Native ${name} returned no exit status`);
	return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}
const results = [];
for (const item of cases) {
	const file = path.join(output, `${item.name}.luau`);
	await fs.writeFile(file, item.source);
	const syntax = execute('slua-compile', ['--only-parse', '--null', file]);
	const analysis = item.kind === 'type' ? execute('slua-analyze', ['--mode=strict', '--formatter=gnu', '-j1', file]) : null;
	const parsed = parseSlua(item.source);
	const diagnostics = [...parsed.diagnostics, ...analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry })];
	const nativeValid = (analysis ?? syntax).exit === 0;
	const lspValid = (item.kind === 'syntax' ? parsed.diagnostics : diagnostics).length === 0;
	results.push({ ...item, sha256: crypto.createHash('sha256').update(item.source).digest('hex'), syntax, analysis, diagnostics, nativeValid, lspValid,
		nativeExpectationMet: nativeValid === item.valid, lspExpectationMet: lspValid === item.valid });
}
const stdlibProfile = execute('slua', ['--sl', path.join(fixtures, 'stdlib-profile.luau')]);
const stdlibSurface = JSON.parse(await fs.readFile(path.join(fixtures, 'stdlib-surface.json'), 'utf8'));
const stdlibExports = stdlibProfile.exit === 0 ? JSON.parse(stdlibProfile.stdout.trim().split('\n').at(-1)) : null;
const stableObject = (value) => value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])])) : value;
const stdlibSurfaceMatches = JSON.stringify(stableObject(stdlibExports)) === JSON.stringify(stableObject(stdlibSurface.modules));
const readonlyProfile = execute('slua', ['--sl', path.join(fixtures, 'readonly-profile.luau')]);
const moduleAvailabilityProfile = execute('slua', ['--sl', path.join(fixtures, 'module-availability-profile.luau')]);
const publicSurfaceProfile = execute('slua', ['--sl', path.join(fixtures, 'public-surface-profile.luau')]);
const assertProfile = execute('slua', ['--sl', path.join(fixtures, 'assert-profile.luau')]);
const tableConstructionProfile = execute('slua', ['--sl', path.join(fixtures, 'table-construction-profile.luau')]);
const creatorGuidesProfile = execute('slua', ['--sl', path.join(fixtures, 'creator-guides-profile.luau')]);
const constBindingsProfile = execute('slua', ['--sl', path.join(fixtures, 'const-bindings-profile.luau')]);
const callbacks = execute('slua', ['--sl', path.join(fixtures, 'callbacks.luau')]);
const llprimProfile = execute('slua', ['--sl', path.join(fixtures, 'llprim-builder.luau')]);
const llprimSurface = JSON.parse(await fs.readFile(path.join(fixtures, 'llprim-surface.json'), 'utf8'));
const llprimExports = llprimProfile.stdout.trim().split('\n').at(-1)?.split(',').sort() ?? [];
const llprimSurfaceMatches = JSON.stringify(llprimExports) === JSON.stringify([...llprimSurface.rules.map((r) => r.name), ...llprimSurface.extraMethods].sort());
const integerProfile = execute('slua', ['--sl', path.join(fixtures, 'integer-profile.luau')]);
const expectedSurface = JSON.parse(await fs.readFile(path.join(root, 'slua-lsp-core/tests/fixtures/native-surface-4116d7f.json'), 'utf8'));
const expectedIntegerExports = Object.keys(expectedSurface.modules.integer).sort();
const integerExports = integerProfile.stdout.trim().split('\n').at(-1)?.split(',').sort() ?? [];
const integerSurfaceMatches = JSON.stringify(integerExports) === JSON.stringify(expectedIntegerExports);
const runtimeFixtureSha256 = {};
for (const file of ['callbacks.luau', 'integer-profile.luau', 'llprim-builder.luau', 'readonly-profile.luau', 'stdlib-profile.luau', 'assert-profile.luau', 'module-availability-profile.luau', 'public-surface-profile.luau', 'const-bindings-profile.luau', 'table-construction-profile.luau', 'creator-guides-profile.luau']) runtimeFixtureSha256[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(fixtures, file))).digest('hex');
const report = { measuredAt: new Date().toISOString(), sourceCommit: sourcePin.commit, sourcePin, binaryDirectory: bin, identities, buildRecord, sourceVerification,
	analyzerScope: 'Standard Luau strict builtin environment; this CLI has no SLua custom-global/type injection. Runtime fixtures use --sl for local standard-library contracts and export inventory, library freeze, internal local-only callback dispatch, integer arithmetic and parameter-list construction; no host ll function or builder apply is invoked.',
	passed: creatorGuidesProfile.exit === 0 && tableConstructionProfile.exit === 0 && constBindingsProfile.exit === 0 && stdlibProfile.exit === 0 && stdlibSurfaceMatches && readonlyProfile.exit === 0 && assertProfile.exit === 0 && moduleAvailabilityProfile.exit === 0 && publicSurfaceProfile.exit === 0 && results.every((r) => r.nativeExpectationMet && r.lspExpectationMet) && callbacks.exit === 0 && integerProfile.exit === 0 && integerSurfaceMatches && llprimProfile.exit === 0 && llprimSurfaceMatches,
	results, stdlibProfile, stdlibExports, stdlibSurfaceMatches, readonlyProfile, assertProfile, moduleAvailabilityProfile, publicSurfaceProfile, constBindingsProfile, tableConstructionProfile, creatorGuidesProfile, callbacks, llprimProfile, llprimExports, llprimSurfaceMatches, integerProfile, integerExports, integerSurfaceMatches, runtimeFixtureSha256 };
try { await fs.copyFile(path.join(output, 'results.json'), path.join(output, `results-${Date.now()}.json`)); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, cases: results.length, mismatches: results.filter((r) => !r.nativeExpectationMet || !r.lspExpectationMet).map((r) => r.name), callbacks, integerProfile }));
process.exitCode = report.passed || process.argv.includes('--investigate') ? 0 : 1;
