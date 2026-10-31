import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { LuauParser } from '../src/luau/vendor.js';
import { buildSluaRegistryFromLslDefinitions, inferLocalVariableTypes, sluaTypeToString, getCompletions } from '../src/index.js';
import { analyzeText } from '../src/diagnostics/engine.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/classes.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; valid: boolean; message?: string }>;

describe('experimental class grammar', () => {
	it.each(cases)('$name', ({ source, valid, message }) => {
		const result = parseSlua(source);
		expect(result.diagnostics.length === 0, JSON.stringify(result.diagnostics)).toBe(valid);
		if (message) expect(result.diagnostics.some((item) => item.code === 'parse-error' && item.message.includes(message))).toBe(true);
	});
	it('retains class and following declarations after an invalid class member', () => {
		const source = 'class Point\npublic x\npublic x\nend\nlocal after = 42';
		const result = parseSlua(source);
		expect(result.diagnostics).toHaveLength(1);
		expect((result.ast as { body: Array<{ type: string }> }).body.map((node) => node.type)).toEqual(['ClassDeclaration', 'LocalStatement']);
		expect(result.diagnostics[0]!.range.start).toEqual({ line: 2, character: 7 });
	});
	it('does not carry class names or errors into a reused parser', () => {
		const parser = new LuauParser();
		parser.parse('class Point end\nclass Point end');
		expect(parser.getErrors()).toHaveLength(1);
		parser.parse('class Point end');
		expect(parser.getErrors()).toEqual([]);
	});
	it.each([['42', 'number', ''], ['"value"', 'string', ''], ['42', 'number', ': number'], ['"value"', 'string', ': string']])('infers an ordinary new method from its %s return %s %s in locals and completion', (value, expected, annotation) => {
		const source = `class Box\nfunction new()${annotation} return ${value} end\nend\nlocal result=Box.new()\nBox.`;
		const parsed = parseSlua(source), registry = buildSluaRegistryFromLslDefinitions(null);
		const local = inferLocalVariableTypes(parsed.ast, registry).find((item) => item.name === 'result');
		expect(local && sluaTypeToString(local.type)).toBe(expected);
		const completion = getCompletions(parsed.ast, { line: 4, character: 4 }, registry, { sourceText: source, triggerCharacter: '.' }).find((item) => item.label === 'new');
		expect(completion?.type?.kind).toBe('function');
		if (completion?.type?.kind === 'function') expect(sluaTypeToString(completion.type.returns)).toBe(expected);
	});
	it.each([false, true])('checks class method result arguments with local variable = %s', (local) => {
		const prefix = 'class Box\nfunction new(): string return "value" end\nend\n';
		const source = prefix + (local ? 'local result=Box.new()\nmath.abs(result)' : 'math.abs(Box.new())');
		const diagnostics = analyzeText(source, { registry: buildSluaRegistryFromLslDefinitions(null) });
		expect(diagnostics.filter((item) => item.code === 'call-argument-type-mismatch')).toHaveLength(1);
		expect(diagnostics.find((item) => item.code === 'call-argument-type-mismatch')!.message).toContain('got \'string\'');
	});
});
