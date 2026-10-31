import assert from 'node:assert/strict';
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
