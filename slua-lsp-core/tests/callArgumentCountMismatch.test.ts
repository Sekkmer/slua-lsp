import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);

describe('call argument count mismatch', () => {
	test('checks native aliases without treating shadowed library names as builtins', () => {
		const diagnostics = analyzeText([
			'local json = lljson',
			'json.encode()',
			'local lljson = {}; lljson.encode()',
			'local function custom(vector) vector.abs() end'
		].join('\n'), { registry });
		expect(diagnostics.filter((d) => d.code === 'call-argument-count-mismatch')).toHaveLength(1);
	});

	test('accepts omitted byte bounds and known trailing return packs', () => {
		const diagnostics = analyzeText([
			'local function values() return "abc", 1 end',
			'print(string.byte(values()))'
		].join('\n'), { registry });
		expect(diagnostics.filter((d) => d.code === 'call-argument-count-mismatch')).toEqual([]);
	});

	test('does not invent insufficient arguments for an unresolved final return pack', () => {
		const diagnostics = analyzeText('local function apply(values) print(math.clamp(values())) end', { registry });
		expect(diagnostics.filter((d) => d.code === 'call-argument-count-mismatch')).toEqual([]);
	});

	test('permits omitted native options while still requiring the JSON input', () => {
		const valid = analyzeText('lljson.encode(42)\nlljson.encode(42, {})\nlljson.decode("42")', { registry });
		expect(valid.some((d) => d.code === 'call-argument-count-mismatch')).toBe(false);
		const missing = analyzeText('lljson.encode()\nlljson.decode()', { registry });
		expect(missing.filter((d) => d.code === 'call-argument-count-mismatch')).toHaveLength(2);
	});

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
