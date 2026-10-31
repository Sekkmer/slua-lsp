// Actual agent CLI refresh/cache precedence using only an owned loopback server.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = process.env.SLUA_CLI_REFRESH_ENTRY ?? path.join(root, 'slua-lsp-cli/out/index.js');
const destination = process.env.SLUA_CLI_REFRESH_EVIDENCE ?? path.join(root, '.local/logs/cli-refresh.json');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cli-refresh-'));
const cache = path.join(temporary, 'cache');
const bundled = path.join(root, 'third_party/lsl-definitions/lsl_definitions.yaml');
const canonical = await fs.readFile(bundled, 'utf8');
const original = canonical + `\n# unique CLI refresh ${crypto.randomUUID()}\n`;
// Change one type only in the disposable HTTP fixture, proving that checks load
// the active download rather than silently reading the bundle or an older cache.
const match = /\n  llSay:\n[\s\S]*?(?=\n  [A-Za-z0-9_]+:\n)/.exec(original);
assert.ok(match?.[0].includes('type: string'));
const custom = original.replace(match[0], match[0].replace('type: string', 'type: integer')) + '# test-only numeric ll.Say contract\n';
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
let body = original; let etag = '"initial"'; let mode = 'valid';
const requests = []; const results = [];
const server = http.createServer((request, response) => {
	requests.push({ ifNoneMatch: request.headers['if-none-match'] ?? null, mode, bodySha256: digest(body) });
	if (mode === 'invalid') { response.writeHead(200).end('functions: {}\nconstants: {}\nevents: {}\n'); return; }
	if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag }).end(); return; }
	response.writeHead(200, { ETag: etag, 'Content-Type': 'application/yaml' }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/definitions.yaml`;
async function cli(args, source) {
	const env = { ...process.env, XDG_CACHE_HOME: path.join(temporary, 'empty-xdg') }; delete env.SLUA_LSP_DEFS_PATH;
	const child = spawn(process.execPath, [entry, ...args, ...(args[0] === 'check' ? ['--warnings-as-errors'] : []), '--cache-dir', cache, '--json'], { cwd: temporary, env, stdio: ['pipe', 'pipe', 'pipe'] });
	let stdout = ''; let stderr = '';
	child.stdout.on('data', (bytes) => { stdout += bytes; }); child.stderr.on('data', (bytes) => { stderr += bytes; });
	const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
	try {
		const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)); });
		child.stdin.end(source);
		const code = await completion;
		assert.equal(stderr, ''); assert.ok(code === 0 || code === 1 || code === 2, `CLI status ${code}: ${stdout}`);
		const output = JSON.parse(stdout); assert.equal(output.schema, 'slua-lsp.cli.v1'); return { code, output };
	} finally { clearTimeout(timer); }
}
try {
	const first = await cli(['update-defs', '--update-url', url]);
	assert.equal(first.code, 0); assert.equal(first.output.metadata.sha256, digest(original));
	assert.equal(await fs.readFile(first.output.definitionsPath, 'utf8'), original);
	results.push('explicit refresh accepts and activates the exact current official YAML download');
	const count = requests.length;
	const before = await cli(['check', '-'], 'll.Say(0, 42)'); assert.equal(before.code, 1);
	assert.ok(before.output.diagnostics.some((d) => d.code === 'call-argument-type-mismatch')); assert.equal(requests.length, count);
	results.push('ordinary check uses the cache offline without any HTTP request');
	const unchanged = await cli(['update-defs', '--update-url', url]);
	assert.equal(unchanged.code, 0); assert.equal(unchanged.output.notModified, true); assert.equal(requests.at(-1).ifNoneMatch, etag);
	assert.equal(unchanged.output.definitionsPath, first.output.definitionsPath);
	results.push('ETag refresh and 304 retain the verified immutable generation');
	body = custom; etag = '"custom-type"';
	const automatic = await cli(['check', '-', '--auto-update-defs', '--update-url', url], 'll.Say(0, 42)'); assert.equal(automatic.code, 0);
	const metadataPath = path.join(cache, 'lsl_definitions.metadata.json'); const metadata = await fs.readFile(metadataPath, 'utf8');
	assert.equal(JSON.parse(metadata).sha256, digest(custom));
	assert.equal(await fs.readFile(first.output.definitionsPath, 'utf8'), original);
	results.push('opt-in refresh activates a new registry contract and preserves the previously returned generation');
	mode = 'invalid';
	const rejected = await cli(['update-defs', '--update-url', url]); assert.equal(rejected.code, 2);
	assert.equal(rejected.output.error.code, 'operation-failed'); assert.equal(await fs.readFile(metadataPath, 'utf8'), metadata);
	results.push('invalid HTTP response reports an operational error without replacing the active cache');
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	const offline = await cli(['update-defs', '--update-url', url]); assert.equal(offline.code, 2);
	assert.equal(await fs.readFile(metadataPath, 'utf8'), metadata);
	assert.equal((await cli(['check', '-'], 'll.Say(0, 42)')).code, 0);
	results.push('offline explicit refresh fails truthfully while ordinary checks retain the last good definitions');
	assert.equal((await cli(['check', '-', '--defs', bundled], 'll.Say(0, 42)')).code, 1);
	const conflict = await cli(['check', '-', '--defs', bundled, '--auto-update-defs', '--update-url', url], 'print(1)');
	assert.equal(conflict.code, 2); assert.equal(conflict.output.error.code, 'usage');
	results.push('explicit YAML takes precedence over cached contracts and rejects an incompatible automatic refresh request');
	const report = { passed: true, measuredAt: new Date().toISOString(), node: process.version, nodeExecutable: process.execPath, entry, entrySha256: digest(await fs.readFile(entry)),
		canonicalSha256: digest(canonical), downloadedSha256: digest(original), testOnlyCustomSha256: digest(custom), requests, results,
		scope: 'Owned loopback HTTP, cache files and actual CLI processes. Numeric ll.Say is an isolated precedence fixture, never an official API claim or live host call. No viewer/FS IPC or world operations.' };
	await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally {
	if (server.listening) await new Promise((resolve) => server.close(resolve));
	await fs.rm(temporary, { recursive: true, force: true });
}
