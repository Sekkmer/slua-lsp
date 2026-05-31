import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);

describe('declared return mismatch', () => {
	test('warns on count mismatch for annotated tuple return', () => {
		const text = `
			local function f(): (number, number)
				return 1
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-count-mismatch')).toBe(true);
	});

	test('warns on type mismatch for annotated single return', () => {
		const text = `
			local function f(): number
				return "hi"
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-type-mismatch')).toBe(true);
	});

	test('does not warn when return matches annotation', () => {
		const text = `
			local function f(): number
				return 123
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-type-mismatch' || d.code === 'declared-return-count-mismatch')).toBe(false);
	});

	test('warns when annotated function has no explicit return (implicit nil)', () => {
		const text = `
			local function f(): number
				local x = 1
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-type-mismatch')).toBe(true);
	});

	test('warns when returning multi-values from a callee but declaring single return', () => {
		const text = `
			local function g(): (number, number)
				return 1, 2
			end
			local function f(): number
				return g()
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-count-mismatch')).toBe(true);
	});

	test('warns when an if-expression return branch mismatches the declaration', () => {
		const text = `
			local function f(): integer
				return if true then integer(1) else "bad"
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-type-mismatch')).toBe(true);
	});

	test('does not use outer locals for shadowed generic for variables', () => {
		const text = `
			local item: string = "outer"
			local list = {}
			local function f(): number
				for _, item in pairs(list) do
					return item
				end
				return 1
			end
		`;
		const diags = analyzeText(text, { registry });
		expect(diags.some((d) => d.code === 'declared-return-type-mismatch')).toBe(false);
	});
});
