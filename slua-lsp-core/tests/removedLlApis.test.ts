import { describe, expect, it } from 'vitest';

import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

describe('removed ll APIs', () => {
	it('flags ll.SetMemoryLimit() with a removed-ll-api error (with registry)', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = 'll.SetMemoryLimit()';
		const diags = analyzeTextWithDirectives(text, { registry });

		expect(diags.some((d) => d.code === 'removed-ll-api')).toBe(true);
		expect(diags.some((d) => d.code === 'unknown-member')).toBe(false);
		const d = diags.find((x) => x.code === 'removed-ll-api');
		expect(d?.message).toContain('SetMemoryLimit');
	});

	it('flags ll.ResetTime as a value reference (no call)', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = 'local f = ll.ResetTime';
		const diags = analyzeTextWithDirectives(text, { registry });

		expect(diags.some((d) => d.code === 'removed-ll-api')).toBe(true);
	});

	it('flags ll["SetMemoryLimit"]() with the same removed-ll-api error (with registry)', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = 'll["SetMemoryLimit"]()';
		const diags = analyzeTextWithDirectives(text, { registry });

		expect(diags.some((d) => d.code === 'removed-ll-api')).toBe(true);
		expect(diags.some((d) => d.code === 'unknown-member')).toBe(false);
	});

	it('flags ll["ResetTime"] as a value reference (no call)', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = 'local f = ll["ResetTime"]';
		const diags = analyzeTextWithDirectives(text, { registry });

		expect(diags.some((d) => d.code === 'removed-ll-api')).toBe(true);
	});
});
