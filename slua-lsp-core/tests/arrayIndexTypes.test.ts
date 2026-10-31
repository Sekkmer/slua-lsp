import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { getCompletions } from '../src/typing/completion.js';
import { getBuiltinMemberHover } from '../src/typing/builtinHover.js';
import { sluaTypeToString } from '../src/slua/types.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const analyze = (source: string) => analyzeTextWithDirectives(source, { registry });

describe('typed array keys and values', () => {
	it.each(['false', 'nil', '"1"', '{}', 'function() end'])('rejects a known nonnumeric key %s without inventing an element type', (key) => {
		const source = `local function inspect(items: {DetectedEvent})\n local item = items[${key}]\n print(item)\nend\nprint(inspect)`;
		const diagnostics = analyze(source);
		expect(diagnostics.map((d) => d.code)).toEqual(['array-index-type-mismatch']);
		expect(diagnostics[0]?.range.start.line).toBe(1);
		const item = inferLocalVariableTypes(parseSlua(source).ast, registry).find((v) => v.name === 'item');
		expect(item).toBeUndefined(); // Unknown locals deliberately have no inferred inlay.
	});

	it('uses the key binding, cast and scalar expression types', () => {
		const valid = 'local function inspect(items: {DetectedEvent}, index: number)\n local one = items[index]\n local next = items[index + 1]\n local last = items[#items]\n local negative = items[-index]\n local cast = items[(index :: number)]\n print(one, next, last, negative, cast)\nend\nprint(inspect)';
		expect(analyze(valid)).toEqual([]);
		const types = inferLocalVariableTypes(parseSlua(valid).ast, registry).filter((v) => ['one', 'next', 'last', 'negative', 'cast'].includes(v.name));
		expect(types).toHaveLength(5);
		expect(types.map((v) => sluaTypeToString(v.type))).toEqual(Array(5).fill('DetectedEvent'));
		const invalid = 'local function inspect(items: {DetectedEvent}, key: string, maybe: number?)\n local a = items[key]\n local b = items[maybe]\n print(a, b)\nend\nprint(inspect)';
		expect(analyze(invalid).map((d) => d.code)).toEqual(['array-index-type-mismatch', 'array-index-type-mismatch']);
	});

	it('checks numeric array writes and visits their index expressions once', () => {
		const source = 'local values: {number} = {1}\nvalues[1] = 2\nvalues[2] = "bad"\nvalues[false] = 3\nvalues[math.abs("bad")] = 4\nprint(values)';
		expect(analyze(source).map((d) => d.code)).toEqual(['assignment-type-mismatch', 'array-index-type-mismatch', 'call-argument-type-mismatch']);
		expect(analyze(source).map((d) => d.range.start.line)).toEqual([2, 3, 4]);
	});

	it('does not invent array contents for an unknown key or flag untyped tables', () => {
		const source = 'local function inspect(items: {DetectedEvent}, key: any)\n local item = items[key]\n local plain = {}\n plain[false] = 1\n plain["name"] = 2\n print(item, plain)\nend\nprint(inspect)';
		expect(analyze(source)).toEqual([]);
		const item = inferLocalVariableTypes(parseSlua(source).ast, registry).find((v) => v.name === 'item');
		expect(item).toBeUndefined();
	});

	it('allows removal and nullable writes to a typed array, matching native Luau', () => {
		const source = 'local function update(values: {number}, maybe: number?)\n values[1] = nil\n values[2] = maybe\n print(values)\nend\nprint(update)';
		expect(analyze(source)).toEqual([]);
	});

	it('respects array parameter shadows and diagnostic suppression', () => {
		const source = 'local values: {number} = {1}\ndo\n local values = {}\n values[false] = "allowed"\nend\n-- slua-lsp:disable-next-line array-index-type-mismatch\nprint(values[false])\nprint(values[true])';
		expect(analyze(source).map((d) => d.code)).toEqual(['array-index-type-mismatch']);
	});

	it('withholds detected hover and completion after invalid or unknown indexing', () => {
		for (const key of ['false', 'key']) {
			const text = `local function inspect(items: {DetectedEvent}, key: any)\n local item = items[${key}]\n item:getGroup()\nend\nprint(inspect)`;
			const ast = parseSlua(text).ast;
			const position = { line: 2, character: 9 };
			expect(getBuiltinMemberHover(ast, position, registry)).toBeNull();
			expect(getCompletions(ast, position, registry, { sourceText: text, triggerCharacter: ':' }).some((item) => item.label === 'getGroup')).toBe(false);
		}
	});
});
