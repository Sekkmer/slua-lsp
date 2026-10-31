import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-initialization.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; codes: string[] }>;
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('native constructor field initialization and self escape', () => {
	it.each(cases)('$name', ({ source, codes }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		const diagnostics = analyzeTextWithDirectives(source, { ast: parsed.ast, registry });
		expect(diagnostics.map((item) => item.code).sort(), JSON.stringify(diagnostics)).toEqual([...codes].sort());
	});
	it('anchors a repeated field at its first read and a repeated instance at its last use, as native does', () => {
		const source = 'class Box\npublic x: number\nfunction __init(self)\nprint(self.x)\nprint(self.x)\nprint(self)\nprint(self)\nend\nend';
		const diagnostics = analyzeTextWithDirectives(source, { registry });
		expect(diagnostics.map((item) => ({ code: item.code, line: item.range.start.line })).sort((a, b) => a.line - b.line)).toEqual([
			{ code: 'class-uninitialized-access', line: 3 }, { code: 'class-uninitialized-access', line: 6 }
		]);
	});
});
