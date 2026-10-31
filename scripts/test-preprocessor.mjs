// Qualifies actual pinned upstream preprocessing against the existing C++ SLua
// VM. The host reads only the fixture map. No simulator, viewer or FS IPC.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
	assert.ifError(result.error); assert.equal(result.signal, null); assert.notEqual(result.status, null);
	return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
};
const local = process.env.SLUA_ORACLE_LOCAL ?? path.join(root, '.local');
const upstreamLocal = process.env.SLUA_PREPROCESSOR_LOCAL ?? local;
const binary = path.join(process.env.SLUA_NATIVE_BIN ?? path.join(local, 'build/slua-oracle'), 'slua');
const cli = process.env.SLUA_PREPROCESSOR_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const output = process.env.SLUA_PREPROCESSOR_EVIDENCE ?? path.join(root, '.local/logs/preprocessor.json');
await fs.mkdir(path.dirname(output), { recursive: true });
// Exclusive evidence: even a failed attempt records its own partial results.
const evidence = await fs.open(output, 'wx');
const report = { passed: false, releaseAcceptance: false, recordedAt: new Date().toISOString(), node: process.version,
	harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), results: [],
	scope: 'Actual pinned upstream package bundled without source changes; a read-only in-memory fixture host and owned generated files run in the pre-existing pinned native CLI with --sl. No ordinary native require loader, simulator, GUI, FS IPC or world effects. Expected upstream defects are observations, not release acceptance.' };
try {
	const verify = (args) => {
		const result = run('python3', ['scripts/prepare-oracle.py', ...args, '--check']);
		assert.equal(result.exit, 0, result.stderr); const source = JSON.parse(result.stdout);
		assert.deepEqual(source.executableModeDifferences, []); return source;
	};
	const source = verify(['--preprocessor', '--local-dir', upstreamLocal]);
	const pin = JSON.parse(await fs.readFile(path.join(root, 'scripts/preprocessor-source.json'), 'utf8'));
	assert.equal(source.commit, pin.commit); assert.equal(source.archiveSha256, pin.archive_sha256);
	const build = JSON.parse(await fs.readFile(path.join(path.dirname(binary), 'oracle-build.json'), 'utf8'));
	const nativePin = JSON.parse(await fs.readFile(path.join(root, 'scripts/oracle-source.json'), 'utf8'));
	const nativeSource = verify(['--local-dir', path.dirname(path.dirname(build.source.root))]);
	assert.equal(build.status, 'built'); assert.equal(build.inputs.pin.commit, nativePin.commit);
	assert.equal(build.inputs.pin.archive_sha256, nativePin.archive_sha256);
	assert.equal(nativeSource.contentSha256, build.inputs.sourceContentSha256);
	assert.equal(digest(await fs.readFile(binary)), build.binaries.slua);
	const fixtureBytes = await fs.readFile(path.join(root, 'scripts/fixtures/preprocessor-cases.json'));
	const cases = JSON.parse(fixtureBytes);
	const fixtureRoot = process.env.SLUA_PREPROCESSOR_FIXTURE_ROOT ?? path.join(root, '.local/fixtures');
	await fs.mkdir(fixtureRoot, { recursive: true });
	const folder = await fs.mkdtemp(path.join(fixtureRoot, 'preprocessor-'));
	const require = createRequire(new URL('../slua-lsp-client/package.json', import.meta.url));
	const esbuild = require('esbuild');
	const bundle = path.join(folder, 'official-preprocessor.mjs');
	const built = await esbuild.build({ entryPoints: [path.join(source.root, 'packages/sl-script-preprocessor/src/index.ts')],
		bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: bundle, metafile: true });
	const inputs = [];
	for (const name of Object.keys(built.metafile.inputs)) {
		const file = path.resolve(root, name);
		assert.ok(file.startsWith(source.root + path.sep), `Unexpected preprocessor bundle input: ${file}`);
		inputs.push({ file, sha256: digest(await fs.readFile(file)) });
	}
	assert.equal(inputs.length, 11);
	const lib = await import(pathToFileURL(bundle));
	Object.assign(report, { upstreamSource: source, nativeSource, binary, binarySha256: digest(await fs.readFile(binary)),
		cli, cliSha256: digest(await fs.readFile(cli)), fixtureSha256: digest(fixtureBytes), folder,
		bundle: { file: bundle, sha256: digest(await fs.readFile(bundle)), inputs, esbuildVersion: esbuild.version } });
	for (const item of cases) {
		assert.match(item.name, /^[a-z0-9-]+$/);
		const directory = path.join(folder, item.name); await fs.mkdir(directory);
		const files = { ...item.files, 'main.luau': item.main };
		const virtual = new Map();
		for (const [name, text] of Object.entries(files)) {
			assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'));
			const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, text, { flag: 'wx' }); virtual.set(`file:///owned/${name}`, text);
		}
		const reads = [];
		const host = {
			readFile: async (uri) => { reads.push(uri); return virtual.get(uri) ?? null; },
			readJSON: async (uri) => { reads.push(uri); return virtual.has(uri) ? JSON.parse(virtual.get(uri)) : null; },
			exists: async (uri) => virtual.has(uri),
			existsInSameWorkspace: async (_from, desired) => desired.startsWith('file:///owned/'),
			listWorkspaceFolders: async () => ['file:///owned/'],
			resolveFile: async (filename, from, extensions, includes) => {
				for (const directory of includes ?? ['.']) {
					const base = path.posix.resolve(path.posix.dirname(fileURLToPath(from)), directory, filename);
					for (const suffix of ['', ...extensions.map((extension) => `.${extension}`)]) {
						const uri = pathToFileURL(base + suffix).href;
						if (virtual.has(uri)) return uri;
					}
				}
				return null;
			}
		};
		const config = { enabled: true, language: 'luau', flags: { generateWarnings: true, generateDecls: false }, include: { maxDepth: item.maxDepth ?? 5 } };
		const macros = item.macros ? new lib.MacroProcessor() : undefined;
		macros?.defineSystemMacro('__LINE__', (context) => context.line.toString());
		macros?.defineSystemMacro('__FILE__', (context) => JSON.stringify(context.sourceFile));
		const processed = await new lib.LexingPreprocessor(host, config, macros).process(item.main, 'file:///owned/main.luau', lib.getLanguageConfig('luau', config));
		const generated = path.join(directory, 'generated.luau');
		await fs.writeFile(generated, processed.content, { flag: 'wx' });
		const result = { name: item.name, finding: item.finding, files: Object.entries(files).map(([file, text]) => ({ file, sha256: digest(text) })),
			generated, generatedSha256: digest(processed.content), preprocessor: processed, reads };
		report.results.push(result);
		assert.equal(processed.success, item.preprocessorValid ?? true, `${item.name}: ${JSON.stringify(processed.issues)}`);
		if (item.issue) assert.ok(processed.issues.some((issue) => !issue.isWarning && issue.message.includes(item.issue)), item.name);
		if (processed.success) {
			result.native = run(binary, ['--sl', generated], { cwd: directory, timeout: 15000 });
			assert.equal(result.native.exit, item.nativeExit ?? 0, `${item.name}: ${result.native.stderr}`);
			assert.equal(result.native.stdout, item.stdout, item.name);
			if (item.stderrContains) assert.ok(result.native.stderr.includes(item.stderrContains), item.name);
			else assert.equal(result.native.stderr, '', item.name);
		}
		if (item.originalStdout) {
			result.originalNative = run(binary, ['--sl', path.join(directory, 'main.luau')], { cwd: directory, timeout: 15000 });
			assert.deepEqual(result.originalNative, { exit: 0, stdout: item.originalStdout, stderr: '' });
		}
		if (item.inspectionValid !== undefined) {
			const inspection = run(process.execPath, [cli, 'modules', path.join(directory, 'main.luau'), '--max-module-depth', String(item.maxDepth ?? 5)]);
			assert.equal(inspection.exit, item.inspectionValid ? 0 : 1, `${item.name}: ${inspection.stdout}`);
			assert.equal(inspection.stderr, ''); const graph = JSON.parse(inspection.stdout);
			assert.equal(graph.schema, 'slua-lsp.cli.v1');
			assert.equal(graph.modules[0].sourceSha256, digest(item.main));
			if (item.inspectionCode) assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.code === item.inspectionCode), item.name);
			result.inspection = { exit: inspection.exit, graph };
		}
		if (item.mapping) {
			const lines = processed.content.split('\n');
			const moduleLine = lines.findIndex((line) => line.includes('error("mapped-owned-error")')) + 1;
			const callerLine = lines.findIndex((line) => line.startsWith('local v=require(')) + 1;
			assert.ok(moduleLine > 0 && callerLine > moduleLine);
			assert.ok(result.native.stderr.includes(`${generated}:${moduleLine}: mapped-owned-error`));
			const module = lib.LineMapper.convertAbsoluteLineToSource(processed.lineMappings, moduleLine);
			const caller = lib.LineMapper.convertAbsoluteLineToSource(processed.lineMappings, callerLine);
			assert.deepEqual(module, { source: 'file:///owned/mod.luau', line: 3 });
			assert.notDeepEqual(caller, { source: 'file:///owned/main.luau', line: 2 });
			result.mapping = { moduleLine, module, callerLine, actualCaller: caller,
				expectedCaller: { source: 'file:///owned/main.luau', line: 2 }, callerMatches: false };
		}
	}
	// Check the complete pristine package again after bundling and execution.
	assert.equal(verify(['--preprocessor', '--local-dir', upstreamLocal]).contentSha256, source.contentSha256);
	report.passed = true;
} catch (error) {
	report.error = error.stack ?? String(error); throw error;
} finally {
	await evidence.writeFile(JSON.stringify(report, null, 2) + '\n'); await evidence.close();
}
console.log(JSON.stringify({ passed: true, releaseAcceptance: false, scenarios: report.results.length,
	findings: report.results.filter((item) => item.finding).map(({ name, finding }) => ({ name, finding })), output }));
