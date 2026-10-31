import { describe, test, expect } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { prepareRename, getRenameEdits } from '../src/typing/rename.js';

describe('rename', () => {
	describe('prepareRename', () => {
		test('returns range and placeholder for valid symbol', () => {
			const code = `
				local myVar = 42
				local result = myVar + 1
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			// Prepare rename for 'myVar'
			const result = prepareRename(parsed.ast, { line: 1, character: 10 }, registry);
			
			expect(result).not.toBeNull();
			expect(result?.placeholder).toBe('myVar');
			expect(result?.range).toBeDefined();
		});

		test('returns null for undefined symbol', () => {
			const code = `
				local x = y + 1
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			// Try to rename undefined 'y'
			const result = prepareRename(parsed.ast, { line: 1, character: 14 }, registry);
			
			expect(result).toBeNull();
		});

		test('uses the symbol under cursor for prepare range', () => {
			const code = ['local x = 1', 'local y = x + 1'].join('\n') + '\n';
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const usageLine = code.split(/\r?\n/)[1]!;
			const usageChar = usageLine.indexOf('x +');
			expect(usageChar).toBeGreaterThanOrEqual(0);

			const result = prepareRename(parsed.ast, { line: 1, character: usageChar }, registry);
			expect(result).not.toBeNull();
			expect(result?.placeholder).toBe('x');
			expect(result?.range.start.line).toBe(1);
		});
	});

	describe('getRenameEdits', () => {
		test('generates edits for all references to a variable', () => {
			const code = `
				local oldName = 5
				local y = oldName + 1
				local z = oldName * 2
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);

			const edits = getRenameEdits(parsed.ast, { line: 1, character: 10 }, 'newName', registry);

			expect(edits.length).toBe(3); // definition + 2 usages
			expect(edits.every((edit) => edit.newName === 'newName')).toBe(true);
			expect(edits.every((edit) => edit.identifier.name === 'oldName')).toBe(true);
		});

		test('respects scope when renaming', () => {
			const code = `
				local x = 1
				if true then
					local x = 2
					local y = x
				end
				local z = x
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);

			const outerEdits = getRenameEdits(parsed.ast, { line: 1, character: 10 }, 'outerX', registry);
			expect(outerEdits.length).toBe(2);
			expect(outerEdits[0]?.identifier.location?.start.line).toBe(2);
			expect(outerEdits[1]?.identifier.location?.start.line).toBe(7);

			const innerEdits = getRenameEdits(parsed.ast, { line: 3, character: 11 }, 'innerX', registry);
			expect(innerEdits.length).toBe(2);
			expect(innerEdits[0]?.identifier.location?.start.line).toBe(4);
			expect(innerEdits[1]?.identifier.location?.start.line).toBe(5);
		});

		test('renames function parameters', () => {
			const code = `
				local function add(a, b)
					local temp = a + b
					return temp + a
				end
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			const lines = code.split(/\r?\n/);
			const sigLine = lines.findIndex((l) => l.includes('add(a, b)'));
			expect(sigLine).toBeGreaterThanOrEqual(0);
			const char = lines[sigLine]!.indexOf('a, b');
			expect(char).toBeGreaterThanOrEqual(0);
			const edits = getRenameEdits(parsed.ast, { line: sigLine, character: char }, 'first', registry);

			expect(edits.length).toBe(3); // definition + 2 usages
			expect(edits.every((edit) => edit.newName === 'first')).toBe(true);
			expect(edits.every((edit) => edit.identifier.name === 'a')).toBe(true);
		});

		test('renames local functions', () => {
			const code = `
				local function oldFunc()
					return 42
				end
				
				local x = oldFunc()
				local y = oldFunc() + 1
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			const edits = getRenameEdits(parsed.ast, { line: 1, character: 20 }, 'newFunc', registry);

			expect(edits.length).toBe(3); // definition + 2 usages
			expect(edits.every((edit) => edit.newName === 'newFunc')).toBe(true);
			expect(edits.every((edit) => edit.identifier.name === 'oldFunc')).toBe(true);
		});

		test('handles nested function scopes', () => {
			const code = `
				local function outer()
					local value = 10
					local function inner()
						return value + 1
					end
					return inner() + value
				end
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			const edits = getRenameEdits(parsed.ast, { line: 2, character: 11 }, 'data', registry);

			expect(edits.length).toBe(3); // definition + 2 usages
			expect(edits.every((edit) => edit.newName === 'data')).toBe(true);
		});

		test('returns empty array for undefined symbol', () => {
			const code = `
				local x = 5
				local y = z + 1
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			const edits = getRenameEdits(parsed.ast, { line: 2, character: 13 }, 'newName', registry);
			expect(edits.length).toBe(0);
		});

		test('returns empty edits for invalid rename identifiers', () => {
			const code = ['local x = 5', 'print(x)'].join('\n') + '\n';
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const edits = getRenameEdits(parsed.ast, { line: 0, character: 6 }, '1bad-name', registry);
			expect(edits).toEqual([]);
		});

		test('generates correct locations for all edits', () => {
			const code = `
				local x = 1
				local y = x + x
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			const edits = getRenameEdits(parsed.ast, { line: 1, character: 10 }, 'variable', registry);
			expect(edits.length).toBe(3);
			expect(edits.every((edit) => edit.identifier.location !== undefined)).toBe(true);

			const locations = edits.map((edit) => {
				const loc = edit.identifier.location!;
				return `${loc.start.line}:${loc.start.column}`;
			});
			expect(new Set(locations).size).toBe(3);
		});

		test('handles assignment statements', () => {
			const code = `
				local counter = 0
				counter = counter + 1
				counter = counter + 2
			`;
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			const edits = getRenameEdits(parsed.ast, { line: 1, character: 10 }, 'index', registry);

			// 1 definition + 4 usages (2 LHS + 2 RHS in assignments)
			expect(edits.length).toBe(5);
			expect(edits.every((edit) => edit.newName === 'index')).toBe(true);
		});

		test('renames usages inside `{...}` of backtick template strings', () => {
			const code = ['local message = "hi"', 'll.Say(0, `You selected {message}`)'].join('\n') + '\n';
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();

			const registry = buildSluaRegistryFromLslDefinitions(null);
			// Rename `message` (definition is on line 1, after `local `)
			const edits = getRenameEdits(parsed.ast, { line: 0, character: 7 }, 'msg', registry);
			expect(edits.length).toBe(2); // definition + usage inside interpolation
			expect(edits.every((edit) => edit.newName === 'msg')).toBe(true);
		});

		test('renames numeric for-loop variables', () => {
			const code = ['for i = 1, 3 do', '\tprint(i)', 'end'].join('\n') + '\n';
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const edits = getRenameEdits(parsed.ast, { line: 1, character: 7 }, 'idx', registry);
			expect(edits.length).toBe(2);
			expect(edits.every((edit) => edit.identifier.name === 'i')).toBe(true);
		});

		test('renames generic for-loop variables', () => {
			const code = ['local t = {}', 'for k, v in pairs(t) do', '\tprint(k, v)', 'end'].join('\n') + '\n';
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const edits = getRenameEdits(parsed.ast, { line: 1, character: code.split(/\r?\n/)[1]!.indexOf('k,') }, 'key', registry);
			expect(edits.length).toBe(2);
			expect(edits.every((edit) => edit.identifier.name === 'k')).toBe(true);
		});

		test('renames Luau class names', () => {
			const code = [
				'class Point',
				'\tfunction new(x: number)',
				'\t\treturn Point { x = x }',
				'\tend',
				'end',
				'local p = Point.new(1)'
			].join('\n') + '\n';
			const parsed = parseSlua(code);
			expect(parsed.ast).toBeTruthy();
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const edits = getRenameEdits(parsed.ast, { line: 0, character: code.split(/\r?\n/)[0]!.indexOf('Point') }, 'Vector2', registry);
			expect(edits.length).toBe(3);
			expect(edits.every((edit) => edit.identifier.name === 'Point')).toBe(true);
			expect(edits.every((edit) => edit.newName === 'Vector2')).toBe(true);
		});
	});
});
