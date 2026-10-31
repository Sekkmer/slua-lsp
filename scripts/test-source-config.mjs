// Ordinary native/source-module configuration qualification. Requires an already
// verified pinned oracle; never downloads, compiles or changes the native tree.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const binary = path.join(process.env.SLUA_NATIVE_BIN ?? path.join(local, 'build/slua-oracle'), 'slua');
const pin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-source.json'), 'utf8'));
const build = JSON.parse(await fs.readFile(path.join(path.dirname(binary), 'oracle-build.json'), 'utf8'));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
assert.equal(build.status, 'built'); assert.equal(build.inputs.pin.commit, pin.commit); assert.equal(build.inputs.pin.archive_sha256, pin.archive_sha256);
assert.equal(digest(await fs.readFile(binary)), build.binaries.slua);
const verified = spawnSync('python3', ['scripts/prepare-oracle.py', '--local-dir', path.dirname(path.dirname(build.source.root)), '--check'], { cwd: root, encoding: 'utf8', timeout: 60000 });
assert.equal(verified.status, 0, verified.stderr);
const source = JSON.parse(verified.stdout); assert.equal(source.contentSha256, build.inputs.sourceContentSha256);
const cli = process.env.SLUA_CONFIG_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const fixtureBytes = await fs.readFile(path.join(root, 'scripts/fixtures/source-config-cases.json'));
const cases = JSON.parse(fixtureBytes);
const fixtureRoot = process.env.SLUA_CONFIG_FIXTURE_ROOT ?? path.join(root, '.local/fixtures');
await fs.mkdir(fixtureRoot, { recursive: true });
const folder = await fs.mkdtemp(path.join(fixtureRoot, 'source-config-'));
const results = [];
for (const item of cases) {
	const directory = path.join(folder, item.name); await fs.mkdir(directory);
	for (const [name, text] of Object.entries(item.files)) {
		const filename = path.resolve(directory, name); assert.ok(filename.startsWith(directory + path.sep));
		await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, text, { flag: 'wx' });
	}
	const entry = path.join(directory, item.entry);
	const entryText = `print(require(${JSON.stringify(item.specifier)}))`;
	await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.writeFile(entry, entryText, { flag: 'wx' });
	const native = spawnSync(binary, [entry], { cwd: directory, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
	assert.ifError(native.error); assert.notEqual(native.status, null); assert.equal(native.status === 0, item.nativeValid, `${item.name}: ${native.stderr}`);
	assert.equal(native.stdout, item.nativeStdout);
	const inspection = spawnSync(process.execPath, [cli, 'modules', entry], { cwd: directory, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
	assert.ifError(inspection.error); assert.equal(inspection.stderr, ''); assert.equal(inspection.status, item.inspectionValid ? 0 : 1, `${item.name}: ${inspection.stdout}`);
	const graph = JSON.parse(inspection.stdout); assert.equal(graph.schema, 'slua-lsp.cli.v1');
	assert.equal(graph.modules[0].sourceSha256, digest(entryText));
	for (const config of graph.configs) assert.equal(config.sourceSha256, digest(await fs.readFile(config.file)));
	if (item.inspectionValid) {
		assert.equal(graph.diagnostics.length, 0); assert.equal(graph.edges.length, 1); assert.ok(graph.edges[0].target);
		const target = path.relative(directory, graph.edges[0].target); assert.ok(Object.hasOwn(item.files, target));
		assert.equal(await fs.readFile(graph.edges[0].target, 'utf8'), item.files[target]);
		if (item.nativeValid) assert.equal(item.files[target], `return ${item.nativeStdout.trim()}`);
	}
	results.push({ ...item, entry, native: { exit: native.status, stdout: native.stdout, stderr: native.stderr },
		inspection: { exit: inspection.status, target: graph.edges[0]?.target, diagnostics: graph.diagnostics, configs: graph.configs } });
}
const report = { passed: true, recordedAt: new Date().toISOString(), node: process.version,
	harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), fixtureSha256: digest(fixtureBytes), cli, cliSha256: digest(await fs.readFile(cli)),
	binary, binarySha256: digest(await fs.readFile(binary)), sourceCommit: pin.commit, sourceContentSha256: source.contentSha256, folder, results,
	differences: results.filter((item) => item.difference).map(({ name, difference }) => ({ name, difference })),
	scope: 'Owned pure local return-value modules in the ordinary native Luau CLI loader, separately compared with read-only CLI source inspection. Explicit expected differences are retained; no SLua generated preprocessor, live-world or viewer/FS IPC behavior is established. No rebuild or downloads.' };
const output = process.env.SLUA_CONFIG_EVIDENCE ?? path.join(root, '.local/logs/source-config.json');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, scenarios: results.length, differences: report.differences, output }));
