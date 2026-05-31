import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);

describe('assignment-return-count-mismatch', () => {
	test('warns on non-call RHS when targets exceed values', () => {
		const code = `
				local a, b = 1
			`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(true);
	});

	test('does not warn on local with no RHS', () => {
		const code = `
				local a, b
			`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(false);
	});

	test('warns when extra return values are discarded', () => {
		const code = `
			local function f()
				return 1, 2
			end
			local a = f()
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(true);
	});

	test('warns when targets exceed produced values (nil fill)', () => {
		const code = `
			local function f()
				return 1
			end
			local a, b = f()
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(true);
	});

	test('warns for member method declarations when targets exceed produced values', () => {
		const code = `
			local obj = {}
			function obj:foo()
				return 1
			end
			local a, b = obj:foo()
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(true);
	});

	test('does not warn when counts match', () => {
		const code = `
			local function f()
				return 1, 2
			end
			local a, b = f()
		`;
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(false);
	});

	test('only last RHS expands (Lua semantics)', () => {
		const code = `
			local function f()
				return 1, 2
			end
			local function g()
				return 3, 4
			end
			local a, b, c = f(), g()
		`;
		// Produced: f() contributes 1, g() contributes 2 => 3 total, matches.
		const diags = analyzeText(code, { registry });
		expect(diags.some((d) => d.code === 'assignment-return-count-mismatch')).toBe(false);
	});
});
