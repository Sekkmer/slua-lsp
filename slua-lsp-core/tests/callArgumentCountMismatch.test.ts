import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);

describe('call argument count mismatch', () => {
	test('warns when last argument expands to zero values', () => {
		const text = `
			local function zero()
				return
			end

			local function one()
				return nil
			end

			local a = {1}
			table.insert(a, one())
			table.insert(a, zero())
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).toContain('call-argument-count-mismatch');
	});

	test('does not warn when last argument expression returns one value (nil)', () => {
		const text = `
			local function one()
				return nil
			end

			local a = {1}
			table.insert(a, one())
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).not.toContain('call-argument-count-mismatch');
	});

	test('uses outer function returns, not nested function returns', () => {
		const text = `
			local function outer()
				local function inner()
					return nil
				end
			end

			local a = {1}
			table.insert(a, outer())
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).toContain('call-argument-count-mismatch');
	});

	test('warns when table field value expands to zero values', () => {
		const text = `
			local function zero()
				return
			end

			local function one()
				return nil
			end

			local t1 = { zero() }
			local t2 = { a = zero() }
			local t3 = { one() }
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).toContain('value-from-zero-return');
	});

	test('warns when assignment or return use zero-returning call', () => {
		const text = `
			local function zero()
				return
			end

			local function demo()
				local x = zero()
				return zero()
			end
		`;
		const diags = analyzeText(text, { registry });
		const codes = diags.map((d) => d.code);
		expect(codes).toContain('value-from-zero-return');
	});
});
