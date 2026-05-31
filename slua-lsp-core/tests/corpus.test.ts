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
		expectParseErrors: false
	},
	{
		name: 'if expression',
		source: 'local x = if true then 1 else 2\n',
		expectParseErrors: false
	},
	{
		name: 'generic function declaration',
		source: 'local function id<T>(x: T): T\n\treturn x\nend\n',
		expectParseErrors: false
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

	it('parses type aliases as TypeAlias nodes', () => {
		const parsed = parseSlua('type Person = { name: string }\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body).toHaveLength(1);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('TypeAlias');
	});

	it('parses export type aliases as exported TypeAlias nodes', () => {
		const parsed = parseSlua('export type Person = { name: string }\n');

		expect(parsed.diagnostics).toEqual([]);
		const [statement] = (parsed.ast as { body: Array<{ type: string; exported?: boolean }> }).body;
		expect(statement?.type).toBe('TypeAlias');
		expect(statement?.exported).toBe(true);
	});

	it('keeps runtime type calls as ordinary expressions', () => {
		const parsed = parseSlua('local kind = type(value)\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('LocalStatement');
	});

	it('keeps top-level type calls as ordinary expressions', () => {
		const parsed = parseSlua('type(value)\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('ExpressionStatement');
	});

	it('keeps top-level type assignments as ordinary assignments', () => {
		const parsed = parseSlua('type = function(value)\n\treturn value\nend\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('AssignmentStatement');
	});

	it('parses nested continue statements', () => {
		const parsed = parseSlua('for i = 1, 3 do\n\tif i == 2 then continue end\nend\n');

		expect(parsed.diagnostics).toEqual([]);
		const [statement] = (parsed.ast as { body: Array<{ type: string; body?: Array<{ type: string; consequent?: Array<{ type: string }> }> }> }).body;
		expect(statement?.type).toBe('ForStatement');
		expect(statement?.body?.[0]?.type).toBe('IfStatement');
		expect(statement?.body?.[0]?.consequent?.[0]?.type).toBe('ContinueStatement');
	});

	it('parses Lua do blocks', () => {
		const parsed = parseSlua('do\n\tlocal x = 1\nend\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('DoStatement');
	});

	it('parses repeat until loops', () => {
		const parsed = parseSlua('repeat\n\tlocal x = 1\nuntil true\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('RepeatStatement');
	});

	it('parses generic for loops', () => {
		const parsed = parseSlua('for k, v in pairs(t) do\n\tll.Abs(integer(1))\nend\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string; variables?: unknown[] }> }).body[0]?.type).toBe('GenericForStatement');
		expect((parsed.ast as { body: Array<{ type: string; variables?: unknown[] }> }).body[0]?.variables).toHaveLength(2);
	});

	it('keeps continue calls as ordinary expressions', () => {
		const parsed = parseSlua('continue()\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('ExpressionStatement');
	});

	it('keeps continue usable as a local identifier', () => {
		const parsed = parseSlua('local continue = 1\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body[0]?.type).toBe('LocalStatement');
	});

	it('parses Lua string and table call sugar as calls', () => {
		const parsed = parseSlua('print "hi"\nf { x = 1 }\nobj:send "hi"\n');

		expect(parsed.diagnostics).toEqual([]);
		const body = (parsed.ast as { body: Array<{ type: string; expression?: { type: string } }> }).body;
		expect(body).toHaveLength(3);
		expect(body.every((statement) => statement.type === 'ExpressionStatement' && statement.expression?.type === 'CallExpression')).toBe(true);
	});

	it('keeps export usable as a contextual identifier outside export type', () => {
		const parsed = parseSlua('local export = 1\nexport = export + 1\nexport()\n');

		expect(parsed.diagnostics).toEqual([]);
		expect((parsed.ast as { body: Array<{ type: string }> }).body.map((statement) => statement.type)).toEqual([
			'LocalStatement',
			'AssignmentStatement',
			'ExpressionStatement'
		]);
	});

	it('parses if expressions as local initializers', () => {
		const parsed = parseSlua('local x = if true then 1 else 2\n');

		expect(parsed.diagnostics).toEqual([]);
		const [statement] = (parsed.ast as { body: Array<{ type: string; init?: Array<{ type: string }> }> }).body;
		expect(statement?.type).toBe('LocalStatement');
		expect(statement?.init?.[0]?.type).toBe('IfExpression');
	});

	it('parses Luau type casts as expressions', () => {
		const parsed = parseSlua('local x = y :: integer\n');

		expect(parsed.diagnostics).toEqual([]);
		const [statement] = (parsed.ast as { body: Array<{ type: string; init?: Array<{ type: string; typeAnnotation?: string }> }> }).body;
		expect(statement?.type).toBe('LocalStatement');
		expect(statement?.init?.[0]?.type).toBe('TypeCastExpression');
		expect(statement?.init?.[0]?.typeAnnotation).toBe('integer');
	});

	it('parses Luau compound assignments', () => {
		const parsed = parseSlua('local x = 1\nx += 2\nobj.count -= 1\n');

		expect(parsed.diagnostics).toEqual([]);
		const body = (parsed.ast as { body: Array<{ type: string; init?: Array<{ type: string; operator?: string }> }> }).body;
		expect(body.map((statement) => statement.type)).toEqual(['LocalStatement', 'AssignmentStatement', 'AssignmentStatement']);
		expect(body[1]?.init?.[0]?.type).toBe('BinaryExpression');
		expect(body[1]?.init?.[0]?.operator).toBe('+');
		expect(body[2]?.init?.[0]?.operator).toBe('-');
	});

	it('parses generic local function declarations', () => {
		const parsed = parseSlua('local function id<T>(x: T): T\n\treturn x\nend\n');

		expect(parsed.diagnostics).toEqual([]);
		const [statement] = (parsed.ast as { body: Array<{ type: string; typeParameters?: string[] }> }).body;
		expect(statement?.type).toBe('FunctionDeclaration');
		expect(statement?.typeParameters).toEqual(['T']);
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
