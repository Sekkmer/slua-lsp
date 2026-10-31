import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function git(args) {
	return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function forbidden(name) {
	const parts = name.split('/');
	return parts.some((part) => ['.local', 'node_modules', 'out', 'dist', 'coverage', '__pycache__', 'AGENT.md', 'AGENTS.md'].includes(part))
		|| ['.agents', '.claude', '.codex', 'target'].includes(parts[0])
		|| name.startsWith('.github/prompts/')
		|| /(?:^|\/)\.env(?:\.|$)|\.(?:log|vsix|tsbuildinfo|pyc)$/.test(name);
}
const paths = git(['ls-files', '-z']).split('\0').filter(Boolean);
const unexpected = paths.filter(forbidden);
assert.deepEqual(unexpected, [], 'Local instructions, private data or generated files are tracked');
const missing = [];
for (const name of paths.filter(name => (name.startsWith('scripts/') && !name.startsWith('scripts/tests/')) || name.startsWith('.github/workflows/'))) {
	if (!/\.(?:mjs|cjs|py|ya?ml)$/.test(name)) continue;
	const text = await fs.readFile(new URL(name, new URL('../', import.meta.url)), 'utf8');
	const references = [
		...text.matchAll(/['"](scripts\/[a-z][a-z0-9-]*\.(?:mjs|cjs|py))['"]/g),
		...text.matchAll(/\b(?:node|python3)\s+(scripts\/[a-z][a-z0-9-]*\.(?:mjs|cjs|py))/g)
	];
	for (const match of references) {
		try { await fs.access(new URL(match[1], new URL('../', import.meta.url))); }
		catch { missing.push({ caller: name, missing: match[1] }); }
	}
}
assert.deepEqual(missing, [], 'A test driver or workflow depends on a missing script');
let commits = 0;
if (process.argv.includes('--history')) {
	const history = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
	for (const commit of history) {
		const files = git(['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter(Boolean);
		assert.deepEqual(files.filter(forbidden), [], `Excluded files remain in commit ${commit}`);
	}
	commits = history.length;
}
console.log(JSON.stringify({ trackedPaths: paths.length, historyCommitsChecked: commits, passed: true }));
