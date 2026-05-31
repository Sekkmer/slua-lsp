import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);

describe('type guard conditions', () => {
	test('warns when typeof(x) == "string" is always true', () => {
		const text = `
			local x: string = "hi"
				if typeof(x) == "string" then
				print(x)
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'type-guard-always-true')).toBe(true);
	});

	test('warns when typeof(x) == "number" is always false', () => {
		const text = `
			local x: string = "hi"
				if typeof(x) == "number" then
				print(x)
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'type-guard-always-false')).toBe(true);
	});

	test('warns when typeof(x) is impossible for a nil local', () => {
		const text = `
			local x
				if typeof(x) == "string" then
				print(x)
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'type-guard-always-false')).toBe(true);
	});

	test('supports typeof() custom types', () => {
		const text = `
			local v: vector = vector(1,2,3)
			if typeof(v) == "vector" then end
			if typeof(v) == "rotation" then end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.filter((d) => d.code === 'type-guard-always-true').length).toBeGreaterThanOrEqual(1);
		expect(diags.filter((d) => d.code === 'type-guard-always-false').length).toBeGreaterThanOrEqual(1);
	});

	test('handles not(typeof(x) == "string") by inverting', () => {
		const text = `
			local x: string = "hi"
			if not (typeof(x) == "string") then end
		`;
		const diags = analyzeText(text, { registry });
		// typeof(x) == "string" is always true, so the negated condition is always false.
		expect(diags.some((d) => d.code === 'type-guard-always-false')).toBe(true);
	});

	test('does not use outer locals for shadowed generic for variables', () => {
		const text = `
			local item: string = "outer"
			local list = {}
			for _, item in pairs(list) do
				if typeof(item) == "string" then end
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'type-guard-always-true' || d.code === 'type-guard-always-false')).toBe(false);
	});
});
