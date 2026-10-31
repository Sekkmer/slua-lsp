import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/conversion-contracts.json', import.meta.url), 'utf8')) as { name: string; source: string; codes: string[] }[];

describe('native SLua conversions', () => {
	it.each(cases)('$name', ({ source, codes }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(source, { registry, ast: parsed.ast }).map((d) => d.code)).toEqual(codes);
	});
});
