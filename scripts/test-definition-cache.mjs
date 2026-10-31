// Real multi-process cache publication test; requires the built core, no network
// beyond an ephemeral loopback server. Results survive under .local/logs/.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cachedDefinitionPath, definitionUpdatePaths, updateDefinitions } from '../slua-lsp-core/out/lsl/definitionUpdate.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cache-processes-'));
const source = await fs.readFile(path.join(root, 'third_party/lsl-definitions/lsl_definitions.yaml'), 'utf8');
const digest = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const bodies = Array.from({ length: 6 }, (_, i) => `${source}\n# concurrent writer ${i}\n`);
const interruptedBody = `${source}\n# interrupted publication\n`;
const server = http.createServer((req, res) => {
	const index = Number(req.url?.slice(1));
	const body = req.url === '/interrupted' ? interruptedBody : bodies[index];
	if (!body) { res.writeHead(404).end(); return; }
	res.writeHead(200, { 'Content-Type': 'application/yaml', ETag: `"writer-${index}"` });
	res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const moduleUrl = pathToFileURL(path.join(root, 'slua-lsp-core/out/lsl/definitionUpdate.js')).href;
const children = [];
const results = [];
let checks = 0;
const started = performance.now();
try {
	const initial = await updateDefinitions({ cacheDir, sourceUrl: `${url}/0` });
	const childSource = `
		import fs from 'node:fs/promises';
		import { updateDefinitions } from ${JSON.stringify(moduleUrl)};
		const [cacheDir, sourceUrl] = process.argv.slice(1);
		await new Promise(resolve => process.once('message', resolve));
		const paths = [];
		for (let i = 0; i < 3; i++) paths.push((await updateDefinitions({ cacheDir, sourceUrl })).definitionsPath);
		for (const file of paths) await fs.access(file);
		process.send({ paths });
		process.disconnect();
	`;
	for (let i = 0; i < bodies.length; i++) {
		const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, cacheDir, `${url}/${i}`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
		let stderr = '';
		child.stderr.on('data', (data) => { stderr += data; });
		const result = { index: i, paths: [] };
		results.push(result);
		child.on('message', (message) => { result.paths = message.paths; });
		const completion = new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => { result.exit = code; result.signal = signal; result.stderr = stderr; resolve(); });
		});
		children.push({ child, completion });
	}
	let done = false;
	const complete = Promise.all(children.map(({ completion }) => completion)).finally(() => { done = true; });
	for (const { child } of children) child.send('start');
	while (!done) {
		const file = await cachedDefinitionPath(cacheDir);
		assert.ok(file, 'reader lost the last good cache during concurrent publication');
		const raw = await fs.readFile(file, 'utf8');
		assert.equal(path.basename(file), `${digest(raw)}.yaml`, 'returned content path changed under the reader');
		checks++;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	await complete;
	for (const result of results) {
		assert.equal(result.exit, 0, result.stderr);
		assert.equal(result.paths.length, 3);
		for (const file of result.paths) assert.equal(await fs.readFile(file, 'utf8'), bodies[result.index]);
	}
	assert.equal(await fs.readFile(initial.definitionsPath, 'utf8'), bodies[0]);
	assert.ok(checks > 0);
	const beforeCrash = await cachedDefinitionPath(cacheDir);
	const { metadataPath } = definitionUpdatePaths(cacheDir);
	const previousMetadata = await fs.readFile(metadataPath, 'utf8');
	// Fault injection is confined to this disposable child: stop precisely before
	// the metadata rename, after real content and metadata temporary files exist.
	const crashSource = `
		import fs from 'node:fs/promises';
		import { updateDefinitions } from ${JSON.stringify(moduleUrl)};
		const [cacheDir, sourceUrl, metadataPath] = process.argv.slice(1);
		const rename = fs.rename;
		fs.rename = async (...args) => {
			if (args[1] === metadataPath) {
				process.send('staged');
				await new Promise(() => { setInterval(() => {}, 1000); });
			}
			return rename(...args);
		};
		await updateDefinitions({ cacheDir, sourceUrl });
	`;
	const crashed = spawn(process.execPath, ['--input-type=module', '-e', crashSource, cacheDir, `${url}/interrupted`, metadataPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
	const crashCompletion = new Promise((resolve) => crashed.once('exit', (code, signal) => resolve({ code, signal })));
	children.push({ child: crashed, completion: crashCompletion });
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Writer did not reach publication boundary')), 10000);
		crashed.once('error', (error) => { clearTimeout(timer); reject(error); });
		crashed.once('message', (message) => {
			clearTimeout(timer);
			if (message === 'staged') resolve(); else reject(new Error('Unexpected writer fault-injection message'));
		});
		crashed.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Writer exited before publication boundary: ${code}/${signal}`)); });
	});
	crashed.kill('SIGKILL');
	const crash = await crashCompletion;
	assert.equal(crash.signal, 'SIGKILL');
	assert.equal(await fs.readFile(metadataPath, 'utf8'), previousMetadata);
	assert.equal(await cachedDefinitionPath(cacheDir), beforeCrash);
	assert.equal(await fs.readFile(path.join(cacheDir, 'generations', `${digest(interruptedBody)}.yaml`), 'utf8'), interruptedBody);
	const report = { passed: true, writers: results.length, publications: 18, concurrentReaderChecks: checks,
		interruptedPublication: { childTerminal: crash, oldMetadataUnchanged: true, oldCacheReadable: true, unactivatedGenerationIgnored: true },
		seconds: (performance.now() - started) / 1000, results };
	await fs.mkdir(path.join(root, '.local/logs'), { recursive: true });
	await fs.writeFile(path.join(root, '.local/logs/definition-cache-processes.json'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report));
} finally {
	for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
	await Promise.allSettled(children.map(({ completion }) => completion));
	await new Promise((resolve) => server.close(resolve));
	await fs.rm(cacheDir, { recursive: true, force: true });
}
