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
});