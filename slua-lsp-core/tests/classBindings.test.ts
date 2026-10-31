import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, classifySemanticTokens, getHover, getCompletions } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-bindings.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; codes: string[]; parseValid: boolean }>;
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('native class bindings and type namespace', () => {
	it.each(cases)('$name', ({ source, codes, parseValid }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics.length === 0).toBe(parseValid);
		const diagnostics = [...parsed.diagnostics, ...analyzeTextWithDirectives(source, { ast: parsed.ast, registry })];
		expect(diagnostics.map((item) => item.code).sort(), JSON.stringify(diagnostics)).toEqual([...codes].sort());
	});
	it('marks the original class binding readonly without marking an alias or mutable shadow', () => {
		const source = 'class Box end\nlocal Alias=Box\ndo local Box=1\nprint(Box) end\nprint(Box,Alias)';
		const tokens = classifySemanticTokens(source, { ast: parseSlua(source).ast });
		expect(tokens.find((item) => item.line === 0 && item.character === 6)?.modifiers).toEqual(['declaration', 'readonly']);
		expect(tokens.find((item) => item.line === 4 && item.character === 6)?.modifiers).toContain('readonly');
		expect(tokens.find((item) => item.line === 4 && item.character === 10)?.modifiers ?? []).not.toContain('readonly');
		expect(tokens.filter((item) => item.line === 2 || item.line === 3).every((item) => !item.modifiers.includes('readonly'))).toBe(true);
	});
	it('shows the class binding as readonly in hover and completion', () => {
		const source = 'class Box end\nprint(Box)'; const ast = parseSlua(source).ast;
		expect(getHover(ast, { line: 1, character: 8 }, registry)).toMatchObject({ kind: 'class', readonly: true });
		const completion = getCompletions(ast, { line: 1, character: 8 }, registry, { invoked: true, sourceText: source }).find((item) => item.label === 'Box');
		expect(completion?.detail).toMatch(/^const /);
	});
	it('anchors semantic type collisions at the new declaration', () => {
		const source = 'class Box end\ntype Box=number';
		expect(analyzeTextWithDirectives(source, { registry })).toMatchObject([{ code: 'duplicate-type-definition', range: { start: { line: 1, character: 5 } } }]);
	});
});
