import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';

describe('call argument type mismatch', () => {
	test('warns when number is passed to integer-only ll function', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			ll.Abs(1.2)
			ll.Abs(1)
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).toContain('call-argument-type-mismatch');
	});

	test('does not warn when integer() is passed to integer-only ll function', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			ll.Abs(integer(1.2))
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).not.toContain('call-argument-type-mismatch');
	});

	test('allows integer where number is expected', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local v = vector(integer(1), 2, 3)
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).not.toContain('call-argument-type-mismatch');
	});

	test('uses the local type visible at each call site', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local x = "bad"
			ll.Abs(x)
			if true then
				local x = integer(1)
				ll.Abs(x)
			end
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags).toHaveLength(1);
		expect(diags[0]?.range.start.line).toBe(2);
	});

	test('does not leak nested shadow types to earlier calls', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local x = integer(1)
			ll.Abs(x)
			if true then
				local x = "bad"
				ll.Abs(x)
			end
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags).toHaveLength(1);
		expect(diags[0]?.range.start.line).toBe(5);
	});

	test('uses annotated local function types for calls', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local f: (integer) -> integer = function(value: integer): integer
				return value
			end
			ll.Abs(f("bad"))
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags.map((d) => d.message)).toContain('Argument #1 to f expects \'integer\' but got \'string\'.');
	});

	test('checks if-expression argument types', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			ll.Abs(if true then "bad" else "also bad")
			local v = if true then "bad" else "also bad"
			ll.Abs(v)
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags).toHaveLength(2);
	});

	test('uses block-local types inside do and repeat blocks', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local x = "bad"
			do
				local x = integer(1)
				ll.Abs(x)
			end
			repeat
				local x = integer(1)
				ll.Abs(x)
			until true
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags).toEqual([]);
	});

	test('does not leak outer locals into generic for variables', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local k = "bad"
			local t = {}
			for k in pairs(t) do
				ll.Abs(k)
			end
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags).toEqual([]);
	});

	test('uses Luau type casts for argument checking', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
			local value = "1"
			ll.Abs(value :: integer)
			ll.Abs(value :: string)
		`;
		const diags = analyzeText(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diags).toHaveLength(1);
		expect(diags[0]?.message).toContain('got \'string\'');
	});
});
