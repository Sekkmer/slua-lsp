import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, parseSlua, inferLocalVariableTypes, sluaTypeToString, getHover, slua } from '../src/index.js';
const registry = buildSluaRegistryFromLslDefinitions(null);
const cases = JSON.parse(readFileSync(new URL('../../scripts/fixtures/vector-rotation-operators.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; expected: string }>;
describe('pinned SLua vector and rotation arithmetic', () => {
	it.each(cases)('$name has native result $expected', ({ source, expected }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		expect(sluaTypeToString(inferLocalVariableTypes(parsed.ast, registry).find((v) => v.name === 'result')?.type ?? slua.unknown())).toBe(expected);
		expect(getHover(parsed.ast, { line: 3, character: 7 }, registry)?.markdown).toContain(`result: ${expected}`);
		const diagnostics = analyzeTextWithDirectives(source, { registry });
		expect(diagnostics.map((d) => d.code)).toEqual(expected === 'unknown' ? ['native-operator'] : []);
	});
	it('propagates component multiplication into argument and variable checks', () => {
		const source='local product=vector(1,2,3)*vector(3,2,1)\nlocal good: vector=product\nlocal bad: number=product\nmath.abs(product)\nprint(good,bad)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => [d.code,d.range.start.line])).toEqual([['assignment-type-mismatch',2],['call-argument-type-mismatch',3]]);
	});
	it('supports number floor division and suppressible native operator warnings', () => {
		const source='local result=6//2\nmath.abs(result)\nlocal bad=rotation(0,0,0,1)//rotation(0,0,0,1)\nprint(bad)';
		expect(sluaTypeToString(inferLocalVariableTypes(parseSlua(source).ast, registry).find((v) => v.name === 'result')?.type ?? slua.unknown())).toBe('number');
		expect(analyzeTextWithDirectives('-- slua-lsp:disable native-operator\n'+source,{registry})).toEqual([]);
	});
	it('defers unknown and table metamethod operands', () => {
		const source='local object=setmetatable({}, {__add=function(self,other) return other end})\nlocal result=object+vector(1,2,3)\nlocal function unknown(value) return value+vector(1,2,3) end\nprint(result,unknown)';
		expect(analyzeTextWithDirectives(source,{registry})).toEqual([]);
	});
});
