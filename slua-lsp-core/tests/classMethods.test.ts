import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSluaRegistryFromLslDefinitions } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-methods.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; codes: string[] }>;

describe('class method diagnostic scopes', () => {
	it.each(cases)('$name', ({ source, codes }) => {
		const diagnostics = analyzeTextWithDirectives(source, { registry: buildSluaRegistryFromLslDefinitions(null) });
		expect(diagnostics.map((item) => item.code).sort(), JSON.stringify(diagnostics)).toEqual([...codes].sort());
	});
});
