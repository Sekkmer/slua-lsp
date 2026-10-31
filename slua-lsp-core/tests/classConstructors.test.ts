import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, getCompletions, getSignatureHelp, inferLocalVariableTypes, sluaTypeToString } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-constructors.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; codes: string[] }>;
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('native class constructor contracts', () => {
	it.each(cases)('$name', ({ source, codes }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		const diagnostics = analyzeTextWithDirectives(source, { ast: parsed.ast, registry });
		expect(diagnostics.map((item) => item.code).sort(), JSON.stringify(diagnostics)).toEqual([...codes].sort());
	});
	it.each(['Box', 'Make', 'tools.make'])('exposes the explicit constructor arguments and nominal result through %s', (callee) => {
		const prefix = 'class Box\npublic x: number\nfunction __init(self, x: number, label: string?)\nself.x=x\nend\nend\nlocal Make=Box\nlocal tools={make=Box}\n';
		const source = prefix + `local item=${callee}(42,"ok")`;
		const parsed = parseSlua(source);
		const item = inferLocalVariableTypes(parsed.ast, registry).find((item) => item.name === 'item');
		expect(item && sluaTypeToString(item.type)).toBe('Box');
		const signature = getSignatureHelp(parsed.ast, { line: 8, character: source.split('\n')[8]!.indexOf('42') + 1 }, registry, source);
		expect(signature?.signatures[0]?.parameters.map((item) => item.label)).toEqual(['arg1: number', 'arg2: nil | string']);
	});
	it('shows the same constructor type in completion', () => {
		const source = 'class Box\npublic x: number\nfunction __init(self, x: number)\nself.x=x\nend\nend\nBo';
		const parsed = parseSlua(source);
		const item = getCompletions(parsed.ast, { line: 6, character: 2 }, registry, { sourceText: source }).find((item) => item.label === 'Box');
		expect(item?.type && sluaTypeToString(item.type)).toBe('(number) -> Box');
	});
});
