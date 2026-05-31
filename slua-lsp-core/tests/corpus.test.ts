import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = path.resolve(packageRoot, '..');

const strictLocalScripts = [
	'tests/fixtures/default_script.lua',
	'tests/fixtures/dialog.lua',
	'tests/fixtures/multi_user_input_coroutine.lua',
	'tests/fixtures/user_input_coroutine.lua',
	'../tools/slua_test_timers.lua',
	'../tools/test_metatables.lua',
	'../test_definition.lua'
];

const luauSyntaxSnippets = [
	{
		name: 'inline table type annotation',
		source: 'local x: { readonly name: string, count: number } = { name = "a", count = 1 }\n',
		expectParseErrors: false
	},
	{
		name: 'type alias with generic parameter',
		source: 'type Pair<T> = { first: T, second: T }\nlocal p: Pair<number> = { first = 1, second = 2 }\n',
		expectParseErrors: true
	},
	{
		name: 'if expression',
		source: 'local x = if true then 1 else 2\n',
		expectParseErrors: true
	},
	{
		name: 'generic function declaration',
		source: 'local function id<T>(x: T): T\n\treturn x\nend\n',
		expectParseErrors: true
	}
];

describe('local and Luau corpus parsing', () => {
	it.each(strictLocalScripts)('parses %s without diagnostics', async (relativePath) => {
		const file = path.resolve(packageRoot, relativePath);
		const text = await fs.readFile(file, 'utf8');
		const parsed = parseSlua(text);

		expect(parsed.ast, relativePath).toBeTruthy();
		expect(parsed.diagnostics, relativePath).toEqual([]);
	});

	it('returns an AST for every checked-in local Lua/Luau script', async () => {
		const files = await collectLocalScripts();
		expect(files.length).toBeGreaterThan(10);

		for (const file of files) {
			const text = await fs.readFile(file, 'utf8');
			const parsed = parseSlua(text);
			expect(parsed.ast, path.relative(repoRoot, file)).toBeTruthy();
		}
	});

	it.each(luauSyntaxSnippets)('handles Luau syntax sample: $name', ({ source, expectParseErrors }) => {
		const parsed = parseSlua(source);

		expect(parsed.ast).toBeTruthy();
		if (expectParseErrors) expect(parsed.diagnostics.length).toBeGreaterThan(0);
		else expect(parsed.diagnostics).toEqual([]);
	});
});

async function collectLocalScripts(): Promise<string[]> {
	const out: string[] = [];
	await collectScripts(path.join(repoRoot, 'tools'), out);
	await collectScripts(path.join(packageRoot, 'tests', 'fixtures'), out);
	out.push(path.join(repoRoot, 'test_definition.lua'));
	return [...new Set(out)].sort();
}

async function collectScripts(dir: string, out: string[]): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectScripts(file, out);
			continue;
		}
		if (/\.(lua|luau)$/.test(entry.name)) out.push(file);
	}
}
