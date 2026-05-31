import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';

describe('readonly write diagnostics', () => {
	test('flags writes to readonly properties in table type annotations', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
				local t: { readonly x: number, y: number, read ["z"]: number } = { x = 1, y = 2, z = 3 }
				t.x = 5
				t["z"] = 9
				t.y = 7
			`;
		const diags = analyzeText(text, { registry });
		const messages = diags.map((d) => d.message);
		expect(messages).toContain('Cannot assign to read-only property \'x\'.');
		expect(messages).toContain('Cannot assign to read-only property \'z\'.');
		expect(messages.some((m) => m.includes('property \'y\''))).toBe(false);
	});

	test('flags writes to readonly builtin module values', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const text = `
				math.pi = 0
				utf8.charpattern = "x"
			`;
		const diags = analyzeText(text, { registry });
		const messages = diags.map((d) => d.message);
		expect(messages).toContain('Cannot assign to read-only builtin value \'math.pi\'.');
		expect(messages).toContain('Cannot assign to read-only builtin value \'utf8.charpattern\'.');
	});
});
