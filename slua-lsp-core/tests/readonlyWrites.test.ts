import { describe, expect, test } from 'vitest';

import { ruleReadonlyWrites } from '../src/diagnostics/rules/readonlyWrites.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { analyzeText } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';

describe('readonly write diagnostics', () => {
	const registry = buildSluaRegistryFromLslDefinitions(null);
	function readonly(source: string) {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		return ruleReadonlyWrites(parsed.ast, registry, source);
	}

	test('respects local, parameter and loop shadows and restores the outer readonly binding', () => {
		const source = [
			'local item: {read x: number} = {x = 1}',
			'do local item = {}; item.x = 2 end',
			'local function custom(item, math) item.x = 3; math.pi = 0 end',
			'for _, math in {{pi = 1}} do math.pi = 2 end',
			'item.x = 4',
			'math.pi = 0'
		].join('\n');
		expect(readonly(source).map((d) => d.range.start.line)).toEqual([4, 5]);
	});

	test('finds writes inside anonymous initializer and call-argument callbacks', () => {
		const source = [
			'local callback = function(item: {read x: number}) item.x = 2 end',
			'pcall(function(item: {read x: number}) item.x = 3 end)'
		].join('\n');
		expect(readonly(source).map((d) => d.range.start.line)).toEqual([0, 1]);
	});

	test('tracks simple module aliases and simultaneous RHS bindings without confusing mutable shadows', () => {
		const source = [
			'local native = math',
			'local math, alias = {}, native',
			'math.pi = 1',
			'alias.pi = 2',
			'local shadow = {}; local copied = shadow; copied.pi = 3',
			'native = {}; native.pi = 4'
		].join('\n');
		expect(readonly(source).map((d) => d.range.start.line)).toEqual([3]);
	});

	test('does not leak readonly annotations out of block and branch scopes', () => {
		const source = [
			'do local item: {read x: number} = {x = 1}; item.x = 2 end',
			'local item = {}; item.x = 3',
			'if true then local item: {read x: number} = {x = 1}; item.x = 4 else item.x = 5 end',
			'item.x = 6'
		].join('\n');
		expect(readonly(source).map((d) => d.range.start.line)).toEqual([0, 2]);
	});

	test('does not treat a dynamic index identifier as the literal readonly field name', () => {
		expect(readonly('local item: {read key: number, other: number} = {key = 1, other = 2}\nlocal key = "other"\nitem[key] = 3')).toEqual([]);
	});

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
