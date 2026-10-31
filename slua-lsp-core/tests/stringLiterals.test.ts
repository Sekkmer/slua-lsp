import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { isStringNode, visitAst } from '../src/parser/ast.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { getSourceModuleGraph } from '../src/workspace/sourceModules.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/string-literals.json', import.meta.url), 'utf8')) as { name: string; literal: string; valid: boolean; value?: string }[];
const registry = buildSluaRegistryFromLslDefinitions(null);
describe('native string literal values and escape validation', () => {
	it.each(cases)('$name', ({ literal, valid, value }) => {
		const parsed = parseSlua('local value=' + literal + '\nprint(value)');
		expect(parsed.diagnostics.length === 0, JSON.stringify(parsed.diagnostics)).toBe(valid);
		if (valid) {
			const values: string[] = [];
			visitAst(parsed.ast, (node) => { if (isStringNode(node)) values.push(node.value); });
			expect(values).toEqual([value]);
		}
	});
	it('checks escaped builtin names and type guards using their runtime values', () => {
		const source = 'math["\\x61bs"]("bad")\nlocal function f(value: number?)\n if type(value)=="\\x6eumber" then math.abs(value) end\nend\nprint(f)';
		const found = analyzeTextWithDirectives(source, { registry });
		expect(found.map((d) => [d.code, d.range.start.line])).toEqual([['call-argument-type-mismatch', 0]]);
	});
	it('shares decoded computed keys with table inference and read-only library writes', () => {
		const source = 'local t={["\\x6eame"]=42}\nmath.abs(t.name)\nstring.lower(t.name)\nmath["\\x70i"]=0';
		const found = analyzeTextWithDirectives(source, { registry });
		expect(found.map((d) => [d.code, d.range.start.line])).toEqual([['call-argument-type-mismatch', 2], ['readonly-write', 3]]);
	});
	it('keeps invalid UTF-8 byte keys distinct from literal Unicode and valid escaped UTF-8', () => {
		const source = 'local t={["\\xff"]=42,["ÿ"]="text"}\nmath.abs(t["\\255"])\nstring.lower(t["\\xc3\\xbf"])';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('resolves decoded Unicode/ASCII literal paths and refuses binary paths before host IO', async () => {
		const reads: string[] = [];
		const options = { entryText: 'return require("\\x6dod")', readFile: async (file: string) => { reads.push(file); return file === '/project/mod.luau' ? 'return 42' : undefined; } };
		const result = await getSourceModuleGraph('/project/main.luau', options);
		expect(result.diagnostics).toEqual([]); expect(result.edges[0]!.target).toBe('/project/mod.luau');
		reads.length = 0;
		const invalid = await getSourceModuleGraph('/project/main.luau', { ...options, entryText: 'return require("\\xff")' });
		expect(invalid.diagnostics.some((d) => d.code === 'module-resolution')).toBe(true);
		expect(reads).toEqual([]);
	});
	it('locates malformed escapes after Unicode and CR at the actual backslash', () => {
		const parsed = parseSlua('-- 😀\rlocal value="😀\\xQ0"');
		expect(parsed.diagnostics[0]?.range.start).toEqual({ line: 1, character: 15 });
	});
	it('decodes literal template segments without decoding nested quoted values twice', () => {
		const parsed = parseSlua('print(`\\u{61}{"\\x62"}\\{c\\}`)');
		expect(parsed.diagnostics).toEqual([]);
		const values: string[] = [];
		visitAst(parsed.ast, (node) => { if (isStringNode(node)) values.push(node.value); });
		expect(values).toEqual(['a', 'b', '{c}']);
	});
	it('locates a malformed escape inside a template expression in the original document', () => {
		const source = '-- header\rprint(`value {"\\xGG"}`)';
		const parsed = parseSlua(source);
		expect(parsed.diagnostics[0]?.range.start).toEqual({ line: 1, character: 15 });
	});
});
