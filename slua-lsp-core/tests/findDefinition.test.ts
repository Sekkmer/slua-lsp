import { describe, test, expect } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { findDefinitionAtPosition } from '../src/typing/findDefinition.js';

describe('findDefinitionAtPosition', () => {
	test('finds local variable definition', () => {
		const code = `
			local x = 5
			local y = x + 1
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find definition of 'x' in 'x + 1' (line 3, approximately column 13)
		// The parser uses 1-based line/column, LSP uses 0-based
		const definition = findDefinitionAtPosition(parsed.ast, { line: 2, character: 13 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('x');
		expect(definition?.kind).toBe('local');
		
		// The definition should point to line 2 (1-based), which is line 1 (0-based)
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(2); // 1-based
	});

	test('finds function parameter definition', () => {
		const code = `
			local function add(a, b)
				return a + b
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find definition of 'a' in 'return a + b' (line 3, approximately column 11)
		const definition = findDefinitionAtPosition(parsed.ast, { line: 2, character: 11 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('a');
		expect(definition?.kind).toBe('parameter');
		
		// The definition should point to the parameter 'a' on line 2
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(2);
	});

	test('finds local function definition', () => {
		const code = `
			local function foo()
				return 42
			end
			
			local x = foo()
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find definition of 'foo' in 'foo()' (line 6, approximately column 14)
		const definition = findDefinitionAtPosition(parsed.ast, { line: 5, character: 14 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('foo');
		expect(definition?.kind).toBe('function');
		
		// The definition should point to the function declaration on line 2
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(2);
	});

	test('handles nested scopes correctly', () => {
		const code = `
			local x = 1
			local function outer()
				local x = 2
				local function inner()
					local y = x + 1
				end
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find definition of 'x' in 'x + 1' inside inner function (line 6)
		// Should resolve to the 'x' in outer function (line 4), not the global 'x' (line 2)
		const definition = findDefinitionAtPosition(parsed.ast, { line: 5, character: 16 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('x');
		expect(definition?.kind).toBe('local');
		
		// Should point to line 4 (the inner 'x'), not line 2
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(4);
	});

	test('handles variable shadowing in if blocks', () => {
		const code = `
			local x = 1
			if true then
				local x = 2
				local y = x
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find definition of 'x' in 'local y = x' (line 5)
		// Should resolve to the 'x' in the if block (line 4), not the outer 'x' (line 2)
		const definition = findDefinitionAtPosition(parsed.ast, { line: 4, character: 14 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('x');
		
		// Should point to line 4 (the if-block 'x')
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(4);
	});

	test('finds parameter in anonymous function', () => {
		const code = `
			local fn = function(x)
				return x * 2
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find definition of 'x' in 'x * 2' (line 3)
		const definition = findDefinitionAtPosition(parsed.ast, { line: 2, character: 11 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('x');
		expect(definition?.kind).toBe('parameter');
		
		// Should point to the parameter on line 2
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(2);
	});

	test('returns null for undefined identifier', () => {
		const code = `
			local x = 5
			local y = z + 1
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Try to find definition of 'z' which is not defined
		const definition = findDefinitionAtPosition(parsed.ast, { line: 2, character: 13 }, registry);
		
		// Should return null for undefined variables
		expect(definition).toBeNull();
	});

	test('handles multiple parameters correctly', () => {
		const code = `
			local function calc(a, b, c)
				return a + b + c
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find 'b' in the return statement
		const defB = findDefinitionAtPosition(parsed.ast, { line: 2, character: 15 }, registry);
		expect(defB).not.toBeNull();
		expect(defB?.name).toBe('b');
		expect(defB?.kind).toBe('parameter');
		
		// Find 'c' in the return statement
		const defC = findDefinitionAtPosition(parsed.ast, { line: 2, character: 19 }, registry);
		expect(defC).not.toBeNull();
		expect(defC?.name).toBe('c');
		expect(defC?.kind).toBe('parameter');
	});

	test('resolves to outer scope when inner scope ends', () => {
		const code = `
			local x = 1
			if true then
				local x = 2
			end
			local y = x
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find 'x' in 'local y = x' (line 6) - should resolve to line 2, not line 4
		const definition = findDefinitionAtPosition(parsed.ast, { line: 5, character: 14 }, registry);
		
		expect(definition).not.toBeNull();
		expect(definition?.name).toBe('x');
		
		// Should point to line 2 (outer x) since we're outside the if block
		const loc = definition?.identifier.location;
		expect(loc).toBeDefined();
		expect(loc?.start.line).toBe(2);
	});

	test('finds definition for numeric for-loop variable', () => {
		const code = ['for i = 1, 3 do', '\tprint(i)', 'end'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);

		const def = findDefinitionAtPosition(parsed.ast, { line: 1, character: 7 }, registry);
		expect(def).not.toBeNull();
		expect(def?.name).toBe('i');
		expect(def?.kind).toBe('local');
		expect(def?.identifier.location?.start.line).toBe(1);
	});

	test('finds definition for generic for-loop variables', () => {
		const code = ['local t = {}', 'for k, v in pairs(t) do', '\tprint(k, v)', 'end'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const usageLine = code.split(/\r?\n/)[2]!;
		const def = findDefinitionAtPosition(parsed.ast, { line: 2, character: usageLine.indexOf('k,') }, registry);
		expect(def).not.toBeNull();
		expect(def?.name).toBe('k');
		expect(def?.kind).toBe('local');
		expect(def?.identifier.location?.start.line).toBe(2);
	});

	test('finds definition inside template string interpolation (local)', () => {
		const code = ['local message = "hi"', 'll.Say(0, `You selected {message}`)'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		// Cursor on `mess` inside `{...}` (line 1, character after {)
		const pos = { line: 1, character: code.split(/\r?\n/)[1]!.indexOf('{') + 2 };
		const def = findDefinitionAtPosition(parsed.ast, pos, registry, code);
		expect(def).not.toBeNull();
		expect(def?.name).toBe('message');
		expect(def?.kind).toBe('local');
		expect(def?.identifier.location?.start.line).toBe(1);
	});

	test('finds definition inside template string interpolation (parameter)', () => {
		const code = ['local function f(message)', '  ll.Say(0, `{message}`)', 'end'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const lineText = code.split(/\r?\n/)[1]!;
		const pos = { line: 1, character: lineText.indexOf('{') + 2 };
		const def = findDefinitionAtPosition(parsed.ast, pos, registry, code);
		expect(def).not.toBeNull();
		expect(def?.name).toBe('message');
		expect(def?.kind).toBe('parameter');
		expect(def?.identifier.location?.start.line).toBe(1);
	});

	test('respects do-block shadowing before resolving definitions', () => {
		const code = ['local value = 1', 'do', '\tlocal value = 2', '\tlocal result = value', 'end', 'local outside = value'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();

		const registry = buildSluaRegistryFromLslDefinitions(null);
		const lines = code.split(/\r?\n/);

		const innerLine = 3;
		const innerDefinition = findDefinitionAtPosition(parsed.ast, { line: innerLine, character: lines[innerLine]!.lastIndexOf('value') }, registry);
		expect(innerDefinition).not.toBeNull();
		expect(innerDefinition?.identifier.location?.start.line).toBe(3);

		const outerLine = 5;
		const outerDefinition = findDefinitionAtPosition(parsed.ast, { line: outerLine, character: lines[outerLine]!.lastIndexOf('value') }, registry);
		expect(outerDefinition).not.toBeNull();
		expect(outerDefinition?.identifier.location?.start.line).toBe(1);
	});

	test('finds Luau class definitions from constructor calls and methods', () => {
		const code = [
			'class Point',
			'\tpublic x: number',
			'\tpublic function new(x: number)',
			'\t\treturn Point { x = x }',
			'\tend',
			'end',
			'local p = Point.new(1)'
		].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const lines = code.split(/\r?\n/);

		const ctorDefinition = findDefinitionAtPosition(parsed.ast, { line: 6, character: lines[6]!.indexOf('Point') }, registry);
		expect(ctorDefinition).not.toBeNull();
		expect(ctorDefinition?.kind).toBe('class');
		expect(ctorDefinition?.identifier.location?.start.line).toBe(1);

		const methodDefinition = findDefinitionAtPosition(parsed.ast, { line: 3, character: lines[3]!.indexOf('Point') }, registry);
		expect(methodDefinition).not.toBeNull();
		expect(methodDefinition?.kind).toBe('class');
		expect(methodDefinition?.identifier.location?.start.line).toBe(1);
	});
});
