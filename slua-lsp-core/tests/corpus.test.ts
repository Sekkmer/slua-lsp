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

	it('parses Luau optional and tuple type aliases', () => {
		const parsed = parseSlua('type Middleware = { Inbound: ClientMiddleware? }\ntype Fn = (args: { any }) -> (boolean, ...any)\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses Luau type packs, typeof aliases, and dotted generic annotations', () => {
		const parsed = parseSlua([
			'export type QueueEntry<TArgs..., T...> = {',
			'\tpromise: Promise.Promise<T...>,',
			'\ttuple: Tuple.Tuple<TArgs...>,',
			'}',
			'export type Box = typeof(setmetatable({} :: { _value: ValueObject.ValueObject<Instance?> }, {})) & BaseObject.BaseObject',
			'function Box.new<TArgs..., T...>(self: Box, value: Promise.Promise<T...>): () -> ()',
			'\treturn function() end',
			'end'
		].join('\n') + '\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses chained calls split across newlines', () => {
		const parsed = parseSlua('Knit.Start({ ServicePromises = true })\n\t:andThen(function()\n\t\tprint("started")\n\tend)\n\t:catch(warn)\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline table literals and call arguments', () => {
		const parsed = parseSlua('local options = {\n\tServicePromises = true,\n\tMiddleware = nil,\n}\nKnit.Start(\n\toptions,\n)\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses Luau intersections split across lines', () => {
		const parsed = parseSlua('export type Box = typeof(setmetatable({}, {}))\n\t& BaseObject.BaseObject\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses vararg expressions in function bodies', () => {
		const parsed = parseSlua('local f = function(player, ...)\n\tprint(player, ...)\n\treturn ...\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline function parameter lists', () => {
		const parsed = parseSlua('function Box.SetWeightedTracks(\n\tself: Box,\n\tweightedTracks: { Track },\n\ttransitionTime: number?\n)\n\treturn nil\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses binary expressions continued across newlines', () => {
		const parsed = parseSlua('local ok = type(value) == "table"\n\tand value.x ~= nil\n\tand value.y ~= nil\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses elseif chains with a single closing end', () => {
		const parsed = parseSlua('if type(v) == "function" then\n\tcallA()\nelseif v == marker then\n\tcallB()\nelseif type(v) == "table" and v[1] == marker then\n\tcallC()\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multi-target assignments', () => {
		const parsed = parseSlua('local result, err\nresult, err = loadstring(code)\nok, err = pcall(function() end)\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses typed generic for variables', () => {
		const parsed = parseSlua('for _, brio: any in brios do\n\tprint(brio)\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline function type parameters', () => {
		const parsed = parseSlua('export type Callback = (\n\tpercentHighlighted: AccelTween.AccelTween,\n\tpercentChosen: AccelTween.AccelTween\n) -> boolean\nexport type BulkQuery<T> = ({ number }) -> Promise.Promise<T>\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline if expressions', () => {
		const parsed = parseSlua('local value = if state.enabled and state.visible\n\tthen true\n\telse false\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses assignments whose values start on the next line', () => {
		const parsed = parseSlua('self._renderPreview.Value =\n\tself:_showPreviewText("missing")\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline local variable lists', () => {
		const parsed = parseSlua('local _, _, _,\n\t_, _, zx,\n\t_, _, _,\n\t_, _, zz = cframe:GetComponents()\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline if statement conditions before then', () => {
		const parsed = parseSlua('if\n\thasProperties["BorderColor3"]\n\tand Color3Utils.areEqual(instance.BorderColor3, Color3.fromRGB(27, 42, 53))\nthen\n\tmap.BorderColor3 = nil\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses nested generic function return annotations', () => {
		const parsed = parseSlua('function AttributeValue.ObserveBrio<T>(\n\tself: AttributeValue<T>,\n\tcondition: Rx.Predicate<T>?\n): Observable.Observable<Brio.Brio<any>>\n\treturn RxAttributeUtils.observeAttributeBrio(self._object, self._attributeName, condition)\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses unnamed union and optional function type parameters', () => {
		const parsed = parseSlua('export type KeyGenerator = (Player | PlayerUserId) -> string\nexport type RemovingCallback = (Player?) -> Promise.Promise<any>?\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline unary expressions', () => {
		const parsed = parseSlua('if\n\tnot (\n\t\ta\n\t\tor b\n\t)\nthen\n\tc()\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses multiline return value lists', () => {
		const parsed = parseSlua('return cframe * Vector3.new(1, 2, 3),\n\tcframe.Position\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses hexadecimal numeric literals', () => {
		const parsed = parseSlua('if c1 > 0xffffff then\n\tc2 = c2 + 1\nend\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses numeric separators and semicolon statement separators', () => {
		const parsed = parseSlua('local n = 50_000_000; local h = 0xff_ff\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses local assignments with the equals sign on the next line', () => {
		const parsed = parseSlua('local a1, b1, c1, d1\n\t= q0[1], q0[2], q0[3], q0[4]\n');

		expect(parsed.diagnostics).toEqual([]);
	});

	it('parses return statements with inline comments', () => {
		const parsed = parseSlua('if ok then\n\treturn -- handled\nend\n');

		expect(parsed.diagnostics).toEqual([]);
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
