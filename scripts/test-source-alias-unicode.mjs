// Real filesystem and CLI regression: JSON escapes must never redirect path IO.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.SLUA_ALIAS_CLI ?? path.join(root, 'slua-lsp-cli/out/index.js');
const output = process.env.SLUA_ALIAS_EVIDENCE ?? path.join(root, '.local/logs/source-alias-unicode.json');
await fs.mkdir(path.dirname(output), { recursive: true });
const handle = await fs.open(output, 'wx');
await fs.mkdir(path.join(root, '.local/fixtures'), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, '.local/fixtures/alias-unicode-'));
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const results = [];
try {
	for (const [name, target, valid] of [['high', '\ud800', false], ['low', '\udc80', false], ['trailing-high', 'x\ud800', false], ['split-pair', '\ud800x\udc80', false], ['pair-and-high', '😀\ud800', false], ['non-ascii', 'könyvtár', true], ['supplementary', '😀', true], ['replacement-scalar', '�', true], ['mixed', 'x😀y', true]]) {
		const directory = path.join(folder, name); await fs.mkdir(directory);
		const actual = Buffer.from(target).toString('utf8');
		await fs.mkdir(path.join(directory, actual));
		await fs.writeFile(path.join(directory, actual, 'value.luau'), 'return 42');
		const config = JSON.stringify({ aliases: { lib: target } }).replaceAll('😀', '\\ud83d\\ude00');
		await fs.writeFile(path.join(directory, '.luaurc'), config);
		const source = 'return require("@lib/value")'; const entry = path.join(directory, 'main.luau'); await fs.writeFile(entry, source);
		const invocations = [];
		for (const command of ['modules', 'preprocess', 'check']) for (const stdin of [false, true]) {
			const args = [cli, command, ...(stdin ? ['-', '--stdin-filepath', entry] : [entry]), '--json'];
			const result = spawnSync(process.execPath, args, { cwd: directory, input: stdin ? source : undefined, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
			assert.ifError(result.error); assert.equal(result.stderr, ''); assert.equal(result.status, valid ? 0 : 1, `${name}/${command}/${stdin}: ${result.stdout}`);
			const data = JSON.parse(result.stdout); assert.equal(data.schema, 'slua-lsp.cli.v1');
			const diagnostics = data.diagnostics;
			if (valid) assert.equal(diagnostics.length, 0);
			else assert.ok(diagnostics.some((item) => item.code === 'module-resolution' && item.message.includes('Unicode')));
			const graph = command === 'modules' ? data : command === 'preprocess' ? data.graph : undefined;
			if (graph) {
				assert.equal(graph.modules.length, valid ? 2 : 1);
				assert.equal(graph.modules[0].sourceSha256, digest(source));
				if (valid) assert.equal(graph.edges[0].target, path.join(directory, target, 'value.luau'));
				else assert.equal(graph.edges[0].target, undefined);
			}
			if (command === 'preprocess') { assert.equal(data.success, valid); if (!valid) assert.equal(data.content, null); }
			invocations.push({ command, stdin, exit: result.status, diagnostics });
		}
		results.push({ name, target, valid, configSha256: digest(config), invocations });
	}
	await handle.writeFile(JSON.stringify({ passed: true, recordedAt: new Date().toISOString(), node: process.version, nodeSha256: digest(await fs.readFile(process.execPath)), cli, cliSha256: digest(await fs.readFile(cli)), harnessSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))), folder, results,
		scope: 'Nine actual UTF-8 filesystem alias cases, 54 file/stdin CLI processes through modules/preprocess/check; malformed decoded targets refused before path IO, valid supplementary/Unicode/replacement scalar targets remain distinct. No native runtime equivalence, source execution, GUI or viewer/FS IPC claim.' }, null, 2) + '\n');
	console.log(JSON.stringify({ passed: true, cases: results.length, cliInvocations: 54, output }));
} finally { await handle.close(); }
