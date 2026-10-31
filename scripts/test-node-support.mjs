// Qualify an explicit Node executable; never install or switch the system runtime.
// Build/package prerequisites and positive resource accounting belong to the caller.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = await fs.realpath(process.env.SLUA_SUPPORT_NODE ?? process.execPath);
const versionResult = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000 });
assert.equal(versionResult.status, 0, versionResult.stderr);
const version = versionResult.stdout.trim();
assert.ok(/^v(?:22|24)\./.test(version), `Qualification matrix covers Node 22 and 24; received ${version}`);
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const logs = path.join(root, '.local/logs'); await fs.mkdir(logs, { recursive: true });
const destination = await fs.mkdtemp(path.join(logs, `node-support-${version}-`));
const results = [];
const report = { passed: false, startedAt: new Date().toISOString(), version, executable, executableSha256: digest(await fs.readFile(executable)),
	harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), results,
	scope: 'Actual selected runtime executes source builds, unit tests, staged CLI packaging, relocation and source/packaged stdio protocols. Loopback-only cache fixtures; no viewer/FS IPC, simulator/world operations or public publication. VS Code uses its own Electron runtime and requires its separate host/GUI gates.' };
async function save() { await fs.writeFile(path.join(destination, 'results.json'), JSON.stringify(report, null, 2) + '\n'); }
async function step(name, args, { cwd = root, env = {}, evidence } = {}) {
	const logfile = path.join(destination, `${name}.log`); const log = await fs.open(logfile, 'wx'); const start = performance.now();
	try {
		const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
		const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 2)); });
		const result = { name, command: [executable, ...args], cwd, exit, seconds: (performance.now() - start) / 1000, log: path.relative(root, logfile) };
		if (exit === 0 && evidence) {
			const bytes = await fs.readFile(path.join(root, evidence)); const saved = path.join(destination, `${name}.json`);
			await fs.writeFile(saved, bytes, { flag: 'wx' }); result.evidence = path.relative(root, saved); result.evidenceSha256 = digest(bytes);
		}
		results.push(result); await save(); console.log(JSON.stringify(result));
		assert.equal(exit, 0, `${name} failed; preserved evidence: ${logfile}`);
	} finally { await log.close(); }
}
const bundledServer = path.join(root, '.local/artifacts/vsix-unpacked/extension/server/out/index.js');
const bundledCli = path.join(root, '.local/artifacts/cli/slua-lsp.mjs');
try {
	await save();
	await step('source-build', ['slua-lsp-core/node_modules/typescript/bin/tsc', '-b', 'slua-lsp-core', 'slua-lsp-server', 'slua-lsp-cli', '--force']);
	for (const workspace of ['core', 'cli', 'server']) {
		const directory = path.join(root, `slua-lsp-${workspace}`);
		await step(`unit-${workspace}`, [path.join(directory, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1'], { cwd: directory });
	}
	await step('artifact-publication', ['--test', 'scripts/tests/artifact-publication.test.mjs']);
	await step('cli-package', ['scripts/package-cli.mjs']);
	await step('relocation', ['scripts/verify-candidate.mjs'], { evidence: '.local/logs/candidate-verification.json' });
	await step('source-cli-refresh', ['scripts/test-cli-refresh.mjs'], { evidence: '.local/logs/cli-refresh.json' });
	await step('packaged-cli-refresh', ['scripts/test-cli-refresh.mjs'], { env: { SLUA_CLI_REFRESH_ENTRY: bundledCli }, evidence: '.local/logs/cli-refresh.json' });
	await step('definition-cache', ['scripts/test-definition-cache.mjs'], { evidence: '.local/logs/definition-cache-processes.json' });
	await step('bundled-definitions', ['scripts/test-bundled-definitions.mjs'], { evidence: '.local/logs/bundled-definitions-tests.json' });
	await step('server-recovery', ['scripts/test-lsp-recovery.mjs'], { evidence: '.local/logs/lsp-recovery.json' });
	for (const backend of ['source', 'packaged']) {
		const packaged = backend === 'packaged';
		await step(`${backend}-inspection`, ['scripts/test-source-inspection.mjs'], { env: packaged ? { SLUA_INSPECTION_SERVER: bundledServer, SLUA_INSPECTION_CLI: bundledCli } : {}, evidence: '.local/logs/source-inspection.json' });
		await step(`${backend}-modules`, ['scripts/test-source-modules.mjs'], { env: packaged ? { SLUA_MODULES_SERVER: bundledServer, SLUA_MODULES_CLI: bundledCli } : {}, evidence: '.local/logs/source-modules.json' });
		await step(`${backend}-actions`, ['scripts/test-code-actions.mjs'], { env: packaged ? { SLUA_CODE_ACTION_SERVER: bundledServer } : {}, evidence: '.local/logs/code-actions-protocol.json' });
		await step(`${backend}-memory`, ['scripts/test-workspace-memory.mjs'], { env: packaged ? { SLUA_WORKSPACE_SERVER: bundledServer } : {}, evidence: '.local/logs/workspace-memory.json' });
	}
	report.artifacts = {};
	for (const [label, filename] of Object.entries({ cli: bundledCli, server: bundledServer, definitions: path.join(root, 'third_party/lsl-definitions/lsl_definitions.yaml') })) {
		report.artifacts[label] = { path: path.relative(root, filename), sha256: digest(await fs.readFile(filename)) };
	}
	report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { report.endedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ passed: report.passed, version, report: path.relative(root, path.join(destination, 'results.json')) })); }
