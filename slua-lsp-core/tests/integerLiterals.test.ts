import { describe, expect, it } from 'vitest';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { parseSlua, visitAst, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions,
	inferLocalVariableTypes, sluaTypeToString, getHover, getCompletions } from '../src/index.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
describe('native integer literal identity', () => {
	it.each([
		['42i', '42'], ['9_007_199_254_740_993i', '9007199254740993'],
		['9223372036854775807i', '9223372036854775807'],
		['0xffffffffffffffffi', '-1'], ['0x8000000000000000i', '-9223372036854775808'],
		['0b101010i', '42']
	])('preserves exact signed integer bytes for %s', (literal, value) => {
		const parsed = parseSlua(`local value=${literal}`);
		expect(parsed.diagnostics).toEqual([]);
		const integers: unknown[] = [];
		visitAst(parsed.ast, (node) => { if (node.type === 'Integer') integers.push(node); });
		expect(integers).toEqual([expect.objectContaining({ type: 'Integer', value })]);
	});
	it.each(['9223372036854775808i', '-9223372036854775808i', '0x10000000000000000i', '.5i', '1.0i', '1e3i'])('rejects malformed or overflowing integer %s', (literal) => {
		expect(parseSlua(`return ${literal}`).diagnostics.length).toBeGreaterThan(0);
	});
	it('shares literal and direct negative-literal types across assignments, calls and returns', () => {
		const source = 'local value=42i\nlocal neg=-42i\nlocal function identity() return 9007199254740993i end\nlocal result=identity()\nbuffer.writeinteger(buffer.create(8), 0, result)\ninteger.add(value, neg)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
		const inferred = inferLocalVariableTypes(parseSlua(source).ast, registry);
		for (const name of ['value', 'neg', 'result']) expect(sluaTypeToString(inferred.find((v) => v.name === name)!.type)).toBe('integer');
		expect(getHover(parseSlua(source).ast, { line: 5, character: 13 }, registry)?.markdown).toContain('value: integer');
	});
	it('keeps integer and number argument and annotation contracts distinct', () => {
		const source = 'local narrow: number=42i\nlocal wide: integer=42\nmath.abs(42i)\ninteger.add(42i, 42)\nprint(narrow,wide)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => [d.code, d.range.start.line])).toEqual([
			['assignment-type-mismatch', 0], ['assignment-type-mismatch', 1],
			['call-argument-type-mismatch', 2], ['call-argument-type-mismatch', 3]
		]);
	});
	it('does not treat tagged integer indexes as numeric array indexes', () => {
		const source = 'local values: {string}={"a"}\nlocal value=values[1i]\nprint(value)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toContain('array-index-type-mismatch');
	});
	it('exposes the literal type to completion at the current scope', () => {
		const source = 'local value=42i\nprint(value)\n';
		expect(getCompletions(parseSlua(source).ast, { line: 2, character: 0 }, registry, source).find((v) => v.label === 'value')?.detail).toContain('integer');
	});
	it('preserves host numeric conversion through aliases without allowing number annotations or user calls', async () => {
		const registry = buildSluaRegistryFromLslDefinitions(await loadLslDefinitionsFromYamlFile());
		const source = 'local abs=ll.Abs\nlocal host=ll\nlocal value=42i\nabs(value)\nhost.Abs(value)\nll.Abs(value)\nlocal function use(n: number) print(n) end\nuse(value)\nlocal narrow: number=value\nprint(narrow)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => [d.code, d.range.start.line])).toEqual([
			['call-argument-type-mismatch', 7], ['assignment-type-mismatch', 8]
		]);
	});
	it.each(['-(42i)', '-value', 'value+1i', 'value<1i', '#value', 'value.."x"'])('reports unsupported tagged integer operator %s', (expression) => {
		const source = `local value=42i\nprint(${expression})`;
		expect(analyzeTextWithDirectives(source, { registry }).filter((d) => d.code === 'integer-operator')).toHaveLength(1);
		expect(analyzeTextWithDirectives('-- slua-lsp:disable integer-operator\n' + source, { registry })).toEqual([]);
	});
	it('accepts equality, truthiness, explicit integer operations and direct negative literals', () => {
		expect(analyzeTextWithDirectives('local value=42i\nprint(value==1i, value~=1i, not value, value and 1i, value or 1i, -42i, integer.neg(value))', { registry })).toEqual([]);
		expect(analyzeTextWithDirectives('if 0i then print("truthy") end', { registry }).map((d) => d.code)).toEqual(['truthy-literal']);
	});
	it('handles large significant digit counts without constructing an unbounded BigInt', () => {
		expect(parseSlua('return ' + '9'.repeat(65536) + 'i').diagnostics.length).toBeGreaterThan(0);
		expect(parseSlua('return ' + '0'.repeat(65536) + '42i').diagnostics).toEqual([]);
	});
	it('does not reject a table supplied integer operator implementation', () => {
		const source = 'local object=setmetatable({}, {__add=function(self, other: integer) return other end})\nprint(object+42i)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('accepts every valid scalar branch of a native host conversion union', async () => {
		const registry = buildSluaRegistryFromLslDefinitions(await loadLslDefinitionsFromYamlFile());
		const source = 'local value=if math.random()>0 then 42i else 42\nll.Abs(value)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
		expect(analyzeTextWithDirectives(source.replace('ll.Abs(value)', 'local function use(n: number) print(n) end\nuse(value)'), { registry }).map((d) => d.code)).toEqual(['call-argument-type-mismatch']);
	});
});
