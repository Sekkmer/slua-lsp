import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-bundle-update-'));
const repo = path.join(fixture, 'third_party/lsl-definitions');
const fallback = path.join(fixture, 'slua-lsp-client/third_party/lsl-definitions/lsl_definitions.yaml');
function command(executable, args, cwd = fixture) {
	const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	if (result.error) throw result.error;
	return result;
}
function git(...args) {
	const result = command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', repo, ...args]);
	assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function update(revision) { return command(process.execPath, ['scripts/update-bundled-definitions.mjs', '--revision', revision]); }
try {
	await fs.mkdir(path.dirname(repo), { recursive: true });
	assert.equal(command('git', ['clone', '--quiet', '--no-hardlinks', path.join(root, 'third_party/lsl-definitions'), repo]).status, 0);
	const previous = git('rev-parse', 'HEAD');
	// Submodules may be shallow. Create a valid candidate exclusively inside the
	// disposable clone instead of assuming upstream's parent object is available.
	await fs.appendFile(path.join(repo, 'lsl_definitions.yaml'), '\n# isolated qualification candidate\n');
	git('-c', 'user.name=SLua LSP fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-am', 'Valid test-only definitions');
	const current = git('rev-parse', 'HEAD');
	await fs.mkdir(path.join(fixture, 'scripts'));
	await fs.copyFile(path.join(root, 'scripts/update-bundled-definitions.mjs'), path.join(fixture, 'scripts/update-bundled-definitions.mjs'));
	await fs.writeFile(path.join(fixture, 'package.json'), '{"type":"module"}\n');
	await fs.symlink(path.join(root, 'slua-lsp-core'), path.join(fixture, 'slua-lsp-core'), 'dir');
	await fs.mkdir(path.dirname(fallback), { recursive: true });
	git('checkout', '--quiet', '--detach', previous);
	await fs.copyFile(path.join(repo, 'lsl_definitions.yaml'), fallback);
	const advance = update(current);
	assert.equal(advance.status, 0, advance.stderr);
	assert.equal(git('rev-parse', 'HEAD'), current);
	assert.deepEqual(await fs.readFile(fallback), await fs.readFile(path.join(repo, 'lsl_definitions.yaml')));
	const delta = JSON.parse(advance.stdout);
	assert.equal(delta.before, previous); assert.equal(delta.after, current);
	const good = await fs.readFile(fallback);
	await fs.writeFile(path.join(repo, 'lsl_definitions.yaml'), 'functions: {}\nconstants: {}\nevents: {}\n');
	git('-c', 'user.name=SLua LSP fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-am', 'Invalid test-only definitions');
	const invalid = git('rev-parse', 'HEAD');
	git('checkout', '--quiet', '--detach', current);
	assert.notEqual(update(invalid).status, 0, 'Malformed candidate must be rejected');
	assert.equal(git('rev-parse', 'HEAD'), current);
	assert.deepEqual(await fs.readFile(fallback), good);
	await fs.appendFile(path.join(repo, 'lsl_definitions.yaml'), '# local edits\n');
	assert.notEqual(update(previous).status, 0, 'Submodule edits must be preserved');
	assert.ok((await fs.readFile(path.join(repo, 'lsl_definitions.yaml'), 'utf8')).endsWith('# local edits\n'));
	const report = { passed: true, fixtureCandidate: current, upstreamBaseline: previous, cases: ['advance validated submodule and fallback together', 'reject invalid YAML without changing checkout or fallback', 'refuse to overwrite local submodule edits'], delta };
	await fs.mkdir(path.join(root, '.local/logs'), { recursive: true });
	await fs.writeFile(path.join(root, '.local/logs/bundled-definitions-tests.json'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report));
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
