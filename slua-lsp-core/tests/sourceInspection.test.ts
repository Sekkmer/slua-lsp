import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { getHover } from '../src/typing/hover.js';
import { getDocumentSymbols, type SourceSymbol } from '../src/typing/documentSymbols.js';

const registry = buildSluaRegistryFromLslDefinitions(await loadLslDefinitionsFromYamlFile());
function hover(source: string) {
	const offset = source.indexOf('$');
	const text = source.replace('$', '');
	const prefix = source.slice(0, offset).split('\n');
	const parsed = parseSlua(text);
	expect(parsed.diagnostics).toEqual([]);
	return getHover(parsed.ast, { line: prefix.length - 1, character: prefix.at(-1)!.length }, registry);
}
function symbols(source: string) {
	const parsed = parseSlua(source);
	expect(parsed.diagnostics).toEqual([]);
	return getDocumentSymbols(parsed.ast);
}

describe('shared source hover', () => {
	it('shows ordinary local declarations and uses outside template strings', () => {
		expect(hover('local co$unt = 1\nprint(count)')?.markdown).toContain('count: number');
		expect(hover('local count = 1\nprint(co$unt)')?.markdown).toContain('count: number');
	});
	it('respects shadows, initializer visibility and later assignments', () => {
		expect(hover('local value = 1\ndo local value = "inner"\nprint(va$lue) end')?.markdown).toContain('value: string');
		expect(hover('local value = 1\ndo local value = va$lue end')?.markdown).toContain('value: number');
		expect(hover('local value = 1\nvalue = "now string"\nprint(va$lue)')?.markdown).toContain('value: string');
	});
	it('shows parameter annotations and contextual event callback types', () => {
		expect(hover('local function use(value: number) print(va$lue) end')?.markdown).toContain('value: number');
		expect(hover('LLEvents:on("touch_start", function(items) print(it$ems) end)')?.markdown).toContain('DetectedEvent');
	});
	it('uses current nullable refinement at the hovered occurrence', () => {
		expect(hover('local function use(value: number?)\nif value then print(va$lue) end\nend')?.markdown).toContain('value: number\n');
		expect(hover('local function use(value: number?)\nif value then print(value) end\nprint(va$lue)\nend')?.markdown).toContain('value: nil | number');
	});
	it('shows local function signatures on the declaration and call', () => {
		expect(hover('local function dou$ble(value: number) return value * 2 end')?.markdown).toContain('double: (number) -> number');
		expect(hover('local function double(value: number) return value * 2 end\nprint(dou$ble(2))')?.markdown).toContain('double: (number) -> number');
	});
	it('retains interpolation and exact UTF-16/CRLF identifier ranges', () => {
		const result = hover('local value = "hi"\r\nprint("😀", `{va$lue}`)');
		expect(result?.markdown).toContain('value: string');
		expect(result?.range).toEqual({ start: { line: 1, character: 14 }, end: { line: 1, character: 19 } });
	});
	it('shows bare standard functions while honoring a user shadow', () => {
		expect(hover('pri$nt(1)')?.kind).toBe('builtin');
		expect(hover('local print = function(value: number) return value end\npri$nt(1)')?.kind).toBe('local');
	});
	it('shows explicit script function declarations and calls without offering global rename', () => {
		expect(hover('function dou$ble(value: number) return value * 2 end')?.markdown).toContain('double: (number) -> number');
		expect(hover('function double(value: number) return value * 2 end\nprint(dou$ble(2))')?.kind).toBe('function');
	});
	it('shows an inferred table field as a field rather than mistaking it for a same-named local', () => {
		const field = hover('local value = "outer"\nlocal object = {value = 1}\nprint(object.va$lue)');
		expect(field?.kind).toBe('field'); expect(field?.markdown).toContain('object.value: number');
	});
	it.each([
		'local value = 1\nprint("va$lue")',
		'local value = 1\n-- va$lue',
		'local value = 1\nlocal object = {va$lue = value}',
		'local print = 1\ntype pri$nt = number',
		'print(un$knownName)'
	])('does not invent a local or builtin hover in another namespace: %s', (source) => {
		expect(hover(source)).toBeNull();
	});
});

describe('shared hierarchical source symbols', () => {
	it('includes local values and assigned functions with nested declarations', () => {
		const result = symbols('local count = 1\nlocal handler = function(value: number)\nlocal result = value * 2\nreturn result\nend\nprint(count, handler)');
		expect(result.map((item) => [item.name, item.kind])).toEqual([['count', 'variable'], ['handler', 'function']]);
		expect(result[1]?.children?.map((item) => item.name)).toEqual(['result']);
	});
	it('preserves function hierarchy and deeply qualified method names', () => {
		const result = symbols('local function outer()\nlocal value = 1\nlocal function inner() return value end\nreturn inner\nend\nfunction app.handlers:run() end');
		expect(result.map((item) => item.name)).toEqual(['outer', 'app.handlers:run']);
		expect(result[0]?.children?.map((item) => item.name)).toEqual(['value', 'inner']);
	});
	it('represents class fields/methods and aliases with distinct kinds', () => {
		const result = symbols('class Point\npublic x: number\nfunction get() return self.x end\nend\ntype Scalar = number');
		expect(result.map((item) => [item.name, item.kind])).toEqual([['Point', 'class'], ['Scalar', 'type']]);
		expect(result[0]?.children?.map((item) => [item.name, item.kind])).toEqual([['x', 'field'], ['get', 'method']]);
	});
	it('keeps callback declarations inside an explicit anonymous function symbol', () => {
		const result = symbols('LLTimers:once(0, function() local value = 1; print(value) end)');
		expect(result[0]?.name).toBe('<anonymous>');
		expect(result[0]?.children?.map((item) => item.name)).toEqual(['value']);
	});
	it('excludes text, parameters and assignment uses from the declaration outline', () => {
		const result = symbols('local value = "local fake = 1"\n-- local comment = 1\nvalue = "changed"\nlocal function use(parameter) return parameter end');
		expect(result.map((item) => item.name)).toEqual(['value', 'use']);
		expect(result[1]?.children).toBeUndefined();
	});
	it('has precise selections contained by declaration ranges including multi-locals', () => {
		const source = 'local first, second = 1, 2\r\nlocal function use(value)\r\n local text = "😀"\r\n return value, text\r\nend';
		const lines = source.split('\n');
		const position = (pos: { line: number; character: number }) => pos.line * 100000 + pos.character;
		function check(items: SourceSymbol[], parent?: SourceSymbol) {
			for (const item of items) {
				expect(position(item.selectionRange.start)).toBeGreaterThanOrEqual(position(item.range.start));
				expect(position(item.selectionRange.end)).toBeLessThanOrEqual(position(item.range.end));
				if (parent) {
					expect(position(item.range.start)).toBeGreaterThanOrEqual(position(parent.range.start));
					expect(position(item.range.end)).toBeLessThanOrEqual(position(parent.range.end));
				}
				expect(lines[item.selectionRange.start.line]?.slice(item.selectionRange.start.character, item.selectionRange.end.character)).toBe(item.name);
				check(item.children ?? [], item);
			}
		}
		check(symbols(source));
	});
	it('handles empty/absent programs and repeated requests deterministically', () => {
		expect(getDocumentSymbols(null)).toEqual([]);
		expect(symbols('-- empty')).toEqual([]);
		const ast = parseSlua('local value = 1\nvalue += 1').ast;
		expect(getDocumentSymbols(ast)).toEqual(getDocumentSymbols(ast));
		expect(getDocumentSymbols(ast)).toHaveLength(1);
	});
});
