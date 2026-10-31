import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);

describe('undeclared-names + unknown-type', () => {
	test('does not warn on common SLua globals even without a registry', () => {
		const code = `
			vector(1, 2, 3)
			rotation(0, 0, 0, 1)
		`;
		const diags = analyzeText(code);
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(false);
	});

	test('warns on undeclared identifier reads', () => {
		const code = `
			local a = 1
			local c = b
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(true);
	});

	test('warns on undeclared function calls', () => {
		const code = `
			foo(1, 2)
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(true);
	});

	test('warns on accidental global writes inside a function', () => {
		const code = `
			local function f()
				x = 1
			end
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'accidental-global-write')).toBe(true);
	});

	test('does not warn on known builtins (e.g. math)', () => {
		const code = `
			local x = math.abs(-1)
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(false);
	});

	test('flags unknown module member calls for known modules (e.g. lljson)', () => {
		const code = `
			lljson.decod("x")
		`;
		const diags = analyzeText(code);
		expect(diags.some((d) => d.code === 'unknown-member')).toBe(true);
	});

	test('does not flag unknown members for stubbed modules like os', () => {
		const code = `
			os.time()
		`;
		const diags = analyzeText(code);
		expect(diags.some((d) => d.code === 'unknown-member')).toBe(false);
	});

	test('does not warn for table literal field keys', () => {
		const code = `
			local t = { x = 1, y = 2, z = 3 }
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(false);
	});

	test('warns on unknown type annotations like : Something', () => {
		const code = `
			local x: Something = 1
			local function f(a: Something): Something
				return a
			end
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'unknown-type')).toBe(true);
	});

	test('warns on unknown type cast annotations like :: Something', () => {
		const code = `
			local x = value :: Something
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'unknown-type')).toBe(true);
	});

	test('does not warn on known SLua wiki type names (e.g. DetectedEvent)', () => {
		const code = `
			local ev: DetectedEvent = nil
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'unknown-type')).toBe(false);
	});

	test('does not treat inline table annotation field names as unknown types', () => {
		const code = `
			local t: { readonly x: number, y: number, read ["z"]: number } = { x = 1, y = 2, z = 3 }
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'unknown-type')).toBe(false);
	});

	test('declares generic for loop variables', () => {
		const code = `
			local t = {}
			for k, v in pairs(t) do
				print(k, v)
			end
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(false);
	});

	test('declares Luau class names and public field annotation types', () => {
		const code = `
			class Point
				public x: number
				function new(x: number)
					return Point { x = x }
				end
			end
			local p: Point = Point.new(1)
			print(p)
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'undeclared-name')).toBe(false);
		expect(diags.some((d) => d.code === 'unknown-type')).toBe(false);
	});
	test('classifies typeof function annotations without treating value names or end as types', () => {
		const source = 'class Box end\nlocal identity: typeof(function(value: Box): Box return value end) = function(value: Box): Box return value end\nassert(identity(Box{})~=nil)';
		expect(analyzeText(source, { registry }).filter((d) => d.code === 'unknown-type')).toEqual([]);
	});

	test('retains unknown names inside typeof nested function annotations', () => {
		const source = 'local identity: typeof(function(value: Missing): Missing return value end) = nil';
		const warnings = analyzeText(source, { registry }).filter((d) => d.code === 'unknown-type');
		expect(warnings).toHaveLength(1); expect(warnings[0]!.message).toBe('Unknown type \'Missing\'.');
	});

	test('keeps function type labels and generic binders out of unknown-type names', () => {
		const source = 'local identity: <T>(label: T)->T = function<T>(value: T): T return value end';
		expect(analyzeText(source, { registry }).filter((d) => d.code === 'unknown-type')).toEqual([]);
	});

	test('recognizes native buffer and never annotation names', () => {
		const source = 'local function stop(value: buffer): never error(value) end';
		expect(analyzeText(source, { registry }).filter((d) => d.code === 'unknown-type')).toEqual([]);
	});

});
