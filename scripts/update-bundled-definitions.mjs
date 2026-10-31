import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLslDefinitionsFromSource } from '../slua-lsp-core/out/lsl/lslDefinitions.js';
import { validateDefinitionUpdate } from '../slua-lsp-core/out/lsl/definitionUpdate.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const submodule = path.join(root, 'third_party/lsl-definitions');
const official = 'https://github.com/secondlife/lsl-definitions.git';
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const revisionIndex = args.indexOf('--revision');
const revision = revisionIndex >= 0 ? args[revisionIndex + 1] : undefined;
assert.ok(args.every((arg, i) => arg === '--check' || arg === '--revision' || (revisionIndex >= 0 && i === revisionIndex + 1)), 'Use --check and/or --revision <40-hex commit>');
if (revisionIndex >= 0) assert.match(revision || '', /^[a-f0-9]{40}$/);
function gitRaw(...argv) {
	const result = spawnSync('git', ['-C', submodule, ...argv], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${argv[0]} failed: ${result.stderr}`);
	return result.stdout;
}
function git(...argv) { return gitRaw(...argv).trimEnd(); }
assert.equal(git('status', '--porcelain'), '', 'Preserve definitions submodule edits before updating');
const before = git('rev-parse', 'HEAD');
const oldRaw = await fs.readFile(path.join(submodule, 'lsl_definitions.yaml'), 'utf8');
const fallback = path.join(root, 'slua-lsp-client/third_party/lsl-definitions/lsl_definitions.yaml');
assert.equal(await fs.readFile(fallback, 'utf8'), oldRaw, 'Client definitions contain independent edits; review them before updating');
if (!revision) git('fetch', '--no-tags', official, 'main');
const after = git('rev-parse', `${revision || 'FETCH_HEAD'}^{commit}`);
const raw = gitRaw('show', `${after}:lsl_definitions.yaml`);
const definitions = loadLslDefinitionsFromSource(raw, after);
validateDefinitionUpdate(definitions);
const oldDefinitions = loadLslDefinitionsFromSource(oldRaw, before);
const sections = {};
for (const section of ['functions', 'constants', 'events']) {
	const oldEntries = oldDefinitions[section] || {}, next = definitions[section] || {};
	sections[section] = {
		before: Object.keys(oldEntries).length, after: Object.keys(next).length,
		added: Object.keys(next).filter((name) => !(name in oldEntries)).sort(),
		removed: Object.keys(oldEntries).filter((name) => !(name in next)).sort(),
		changed: Object.keys(next).filter((name) => name in oldEntries && JSON.stringify(next[name]) !== JSON.stringify(oldEntries[name])).sort()
	};
}
const report = { checkedAt: new Date().toISOString(), official, before, after, checkOnly,
	sha256: crypto.createHash('sha256').update(raw).digest('hex'), sections };
if (!checkOnly) {
	git('checkout', '--detach', after);
	// Preserve exact upstream bytes; git's textual command output was only used
	// for validation. Build scripts refresh the other ignored asset copies.
	await fs.copyFile(path.join(submodule, 'lsl_definitions.yaml'), fallback);
}
await fs.mkdir(path.join(root, '.local/logs'), { recursive: true });
await fs.writeFile(path.join(root, '.local/logs/definition-bundle-update.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
