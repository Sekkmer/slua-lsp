import { describe, test, expect } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { findAllReferences } from '../src/typing/findReferences.js';

describe('findAllReferences', () => {
	test('finds all references to a local variable', () => {
		const code = `
			local x = 5
			local y = x + 1
			local z = x * 2
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to 'x' from the definition on line 2
		const references = findAllReferences(parsed.ast, { line: 1, character: 10 }, registry, true);
		
		expect(references.length).toBe(3); // 1 definition + 2 usages
		
		// Check the definition is included
		const definition = references.find(ref => ref.kind === 'definition');
		expect(definition).toBeDefined();
		expect(definition?.identifier.name).toBe('x');
		
		// Check usages
		const usages = references.filter(ref => ref.kind === 'usage');
		expect(usages.length).toBe(2);
		expect(usages.every(ref => ref.identifier.name === 'x')).toBe(true);
	});

	test('finds references without including declaration', () => {
		const code = `
			local x = 5
			local y = x + 1
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references without declaration
		const references = findAllReferences(parsed.ast, { line: 1, character: 10 }, registry, false);
		
		// Should only find the usage, not the definition
		expect(references.length).toBe(1);
		expect(references[0]?.kind).toBe('usage');
	});

	test('finds all references to function parameters', () => {
		const code = `
			local function add(a, b)
				local temp = a + b
				return temp + a
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to 'a'
		const references = findAllReferences(parsed.ast, { line: 1, character: 22 }, registry, true);
		
		expect(references.length).toBe(3); // 1 definition + 2 usages
		expect(references.every(ref => ref.identifier.name === 'a')).toBe(true);
	});

	test('respects scope boundaries', () => {
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
		
		// Find references to the outer 'x' (line 2)
		const outerRefs = findAllReferences(parsed.ast, { line: 1, character: 10 }, registry, true);
		
		// Should find the definition and usage on line 7, but NOT the inner x
		expect(outerRefs.length).toBe(2);
		expect(outerRefs[0]?.identifier.location?.start.line).toBe(2); // definition
		expect(outerRefs[1]?.identifier.location?.start.line).toBe(7); // usage
		
		// Find references to the inner 'x' (line 4)
		const innerRefs = findAllReferences(parsed.ast, { line: 3, character: 10 }, registry, true);
		
		// Should find the definition and usage on line 5, but NOT the outer x
		expect(innerRefs.length).toBe(2);
		expect(innerRefs[0]?.identifier.location?.start.line).toBe(4); // definition
		expect(innerRefs[1]?.identifier.location?.start.line).toBe(5); // usage
	});

	test('finds references in nested functions', () => {
		const code = `
			local function outer()
				local x = 10
				local function inner()
					return x + 1
				end
				return inner() + x
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to 'x'
		const references = findAllReferences(parsed.ast, { line: 2, character: 10 }, registry, true);
		
		expect(references.length).toBe(3); // 1 definition + 2 usages (line 5 and 7)
		expect(references.every(ref => ref.identifier.name === 'x')).toBe(true);
	});

	test('finds references to local functions', () => {
		const code = `
			local function foo()
				return 42
			end
			
			local x = foo()
			local y = foo() + 1
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to 'foo'
		const references = findAllReferences(parsed.ast, { line: 1, character: 20 }, registry, true);
		
		expect(references.length).toBe(3); // 1 definition + 2 usages
		
		const definition = references.find(ref => ref.kind === 'definition');
		expect(definition?.identifier.location?.start.line).toBe(2);
		
		const usages = references.filter(ref => ref.kind === 'usage');
		expect(usages.length).toBe(2);
	});

	test('handles anonymous function parameters', () => {
		const code = `
			local fn = function(x)
				return x * 2
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to parameter 'x'
		const references = findAllReferences(parsed.ast, { line: 1, character: 23 }, registry, true);
		
		expect(references.length).toBe(2); // 1 definition + 1 usage
		expect(references.every(ref => ref.identifier.name === 'x')).toBe(true);
	});

	test('returns empty array for undefined variable', () => {
		const code = `
			local x = 5
			local y = z + 1
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Try to find references to undefined 'z'
		const references = findAllReferences(parsed.ast, { line: 2, character: 13 }, registry, true);
		
		expect(references.length).toBe(0);
	});

	test('handles multiple parameters with same usage pattern', () => {
		const code = `
			local function calc(a, b, c)
				local x = a + b
				local y = b + c
				return x + y + a
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to 'a'
		const aRefs = findAllReferences(parsed.ast, { line: 1, character: 23 }, registry, true);
		expect(aRefs.length).toBe(3); // 1 definition + 2 usages
		expect(aRefs.every(ref => ref.identifier.name === 'a')).toBe(true);
		
		// Find references to 'b'
		const bRefs = findAllReferences(parsed.ast, { line: 1, character: 26 }, registry, true);
		expect(bRefs.length).toBe(3); // 1 definition + 2 usages
		expect(bRefs.every(ref => ref.identifier.name === 'b')).toBe(true);
	});

	test('finds references across multiple statements', () => {
		const code = `
			local count = 0
			count = count + 1
			count = count + 2
			local result = count
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		
		const registry = buildSluaRegistryFromLslDefinitions(null);
		
		// Find references to 'count'
		const references = findAllReferences(parsed.ast, { line: 1, character: 10 }, registry, true);
		
		// 1 definition + 5 usages (2 in line 3, 2 in line 4, 1 in line 5)
		expect(references.length).toBe(6);
		expect(references.every(ref => ref.identifier.name === 'count')).toBe(true);
	});

	test('finds references for numeric for-loop variables', () => {
		const code = ['for i = 1, 3 do', '\tprint(i)', 'end'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();

		const registry = buildSluaRegistryFromLslDefinitions(null);
		const refs = findAllReferences(parsed.ast, { line: 1, character: 7 }, registry, true);
		expect(refs.length).toBe(2);
		expect(refs[0]?.kind).toBe('definition');
		expect(refs[1]?.kind).toBe('usage');
		expect(refs.every((r) => r.identifier.name === 'i')).toBe(true);
	});

	test('finds references for generic for-loop variables', () => {
		const code = ['local t = {}', 'for k, v in pairs(t) do', '\tprint(k, v)', 'end'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();

		const registry = buildSluaRegistryFromLslDefinitions(null);
		const refs = findAllReferences(parsed.ast, { line: 1, character: code.split(/\r?\n/)[1]!.indexOf('k,') }, registry, true);
		expect(refs.length).toBe(2);
		expect(refs[0]?.kind).toBe('definition');
		expect(refs[1]?.kind).toBe('usage');
		expect(refs.every((r) => r.identifier.name === 'k')).toBe(true);
	});

	test('finds references inside `{...}` of backtick template strings', () => {
		const code = ['local message = "hi"', 'll.Say(0, `You selected {message}`)'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();

		const registry = buildSluaRegistryFromLslDefinitions(null);
		// Cursor on `message` inside `{message}`
		const refs = findAllReferences(parsed.ast, { line: 1, character: 25 }, registry, true);
		expect(refs.map((r) => r.kind)).toEqual(['definition', 'usage']);
	});

	test('respects do-block shadowing when collecting references', () => {
		const code = ['local value = 1', 'do', '\tlocal value = 2', '\tlocal result = value', 'end', 'local outside = value'].join('\n') + '\n';
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();

		const registry = buildSluaRegistryFromLslDefinitions(null);
		const outerRefs = findAllReferences(parsed.ast, { line: 0, character: code.split(/\r?\n/)[0]!.indexOf('value') }, registry, true);
		expect(outerRefs.map((r) => r.identifier.location?.start.line)).toEqual([1, 6]);

		const innerRefs = findAllReferences(parsed.ast, { line: 2, character: code.split(/\r?\n/)[2]!.indexOf('value') }, registry, true);
		expect(innerRefs.map((r) => r.identifier.location?.start.line)).toEqual([3, 4]);
	});
});
