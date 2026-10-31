const path = require('node:path');
const fs = require('node:fs/promises');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const syncFs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

async function main() {
	const root = path.resolve(__dirname, '../..');
	const local = path.join(root, '.local/vscode-tests');
	// Preserve the previous host/version result before a new run replaces it.
	try {
		const previous = await fs.readFile(path.join(local, 'results.json'));
		const history = path.join(local, 'history');
		await fs.mkdir(history, { recursive: true });
		await fs.writeFile(path.join(history, `results-${new Date().toISOString().replaceAll(':', '-')}.json`), previous);
		await fs.unlink(path.join(local, 'results.json'));
	} catch (err) { if (err.code !== 'ENOENT') throw err; }
	const workspace = path.join(local, 'workspace');
	await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
	const fault = process.env.SLUA_TEST_CACHE_FAULT;
	if (fault && !['metadata-directory', 'unreadable-metadata', 'unreadable-generation'].includes(fault)) throw new Error(`Unknown cache fault: ${fault}`);
	if (fault?.startsWith('unreadable-') && process.getuid?.() === 0) throw new Error('Permission fault tests must run as an ordinary user');
	await fs.mkdir(path.join(local, 'profiles'), { recursive: true });
	const userData = fault ? await fs.mkdtemp(path.join(local, 'profiles', `${fault}-`)) : path.join(local, 'user-data');
	const candidate = process.env.SLUA_EXTENSION_CANDIDATE || path.resolve(__dirname, '..');
	const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
	const definitionsCache = path.join(userData, 'User/globalStorage', `${manifest.publisher}.${manifest.name}`.toLowerCase(), 'definitions');
	let faultPath;
	if (fault) {
		await fs.mkdir(definitionsCache, { recursive: true });
		const metadataPath = path.join(definitionsCache, 'lsl_definitions.metadata.json');
		if (fault === 'metadata-directory') {
			faultPath = metadataPath;
			await fs.mkdir(faultPath);
		} else {
			const raw = await fs.readFile(path.join(candidate, 'third_party/lsl-definitions/lsl_definitions.yaml'));
			const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
			const generation = path.join(definitionsCache, 'generations', `${sha256}.yaml`);
			await fs.mkdir(path.dirname(generation), { recursive: true });
			await fs.writeFile(generation, raw);
			await fs.writeFile(metadataPath, JSON.stringify({ cacheFormat: 2, sha256, sizeBytes: raw.length,
				sourceUrl: 'http://127.0.0.1:1/not-used', checkedAt: new Date().toISOString(), activatedAt: new Date().toISOString(), version: 'fault-fixture' }));
			faultPath = fault === 'unreadable-metadata' ? metadataPath : generation;
			await fs.chmod(faultPath, 0);
		}
	}
	await fs.mkdir(path.join(userData, 'User'), { recursive: true });
	await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'slua.definitions.autoUpdate': false }, null, 2));
	await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
		'security.workspace.trust.enabled': false,
		'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
		'extensions.autoUpdate': false, 'update.mode': 'none'
	}, null, 2));
	const executable = process.env.SLUA_VSCODE_EXECUTABLE || (!process.env.SLUA_VSCODE_VERSION && syncFs.existsSync('/usr/share/code/code') ? '/usr/share/code/code' : await downloadAndUnzipVSCode({ version: process.env.SLUA_VSCODE_VERSION || '1.143.0', cachePath: path.join(local, 'cache') }));
	await runTests({
		vscodeExecutablePath: executable,
		extensionDevelopmentPath: candidate,
		extensionTestsPath: path.join(root, 'slua-lsp-client/out/test/suite.js'),
		extensionTestsEnv: { SLUA_LSP_TEST_EVIDENCE: path.join(local, 'results.json'),
			...(fault ? { SLUA_TEST_CACHE_FAULT: fault, SLUA_TEST_CACHE_FAULT_PATH: faultPath } : {}) },
		launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', path.join(local, 'extensions'),
			// This owned test profile is never signed in and contains no account credentials.
			// Its private bus has no interactive wallet; avoid two 25-second wallet
			// timeouts. This is never an argv.json change to the operator's editor.
			'--password-store=basic', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', '--ozone-platform=x11']
	});
}
// Headless editor tests must not advertise a test accessibility broker on the
// operator's live bus/runtime. A separate editor profile alone does not isolate
// D-Bus, AT-SPI or the Unix sockets under XDG_RUNTIME_DIR.
async function isolatedMain() {
	if (process.env.SLUA_HOST_SESSION_ISOLATED === '1') {
		if (!process.env.DBUS_SESSION_BUS_ADDRESS || !process.env.XDG_RUNTIME_DIR) throw new Error('Missing private host session');
		return main();
	}
	const local = path.resolve(__dirname, '../../.local/vscode-tests/runtime');
	await fs.mkdir(local, { recursive: true });
	const runtime = await fs.mkdtemp(path.join(local, 'host-'));
	await fs.chmod(runtime, 0o700);
	const env = { ...process.env, XDG_RUNTIME_DIR: runtime, SLUA_HOST_SESSION_ISOLATED: '1',
		SLUA_HOST_PRIVATE_RUNTIME: runtime,
		SLUA_HOST_PARENT_BUS_SHA256: crypto.createHash('sha256').update(process.env.DBUS_SESSION_BUS_ADDRESS || '').digest('hex') };
	for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'AT_SPI_BUS_ADDRESS', 'WAYLAND_DISPLAY', 'SESSION_MANAGER']) delete env[key];
	const child = spawn('dbus-run-session', ['--', process.execPath, __filename], { env, stdio: 'inherit' });
	process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 2)); });
	// Preserve the private runtime path and all host evidence. dbus-run-session
	// owns bus shutdown after its child exits; never stop the user's bus.
}
isolatedMain().catch((err) => { console.error(err); process.exitCode = 1; });
