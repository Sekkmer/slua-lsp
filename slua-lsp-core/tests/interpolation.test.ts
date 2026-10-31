import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { getVisibleLocalTypes, getCompletions } from '../src/typing/completion.js';
import { getHover } from '../src/typing/hover.js';
import { findDefinitionAtPosition } from '../src/typing/findDefinition.js';
import { findAllReferences } from '../src/typing/findReferences.js';
import { getRenameEdits } from '../src/typing/rename.js';
import { classifySemanticTokens } from '../src/semanticTokens/classify.js';
import { parseDirectives } from '../src/diagnostics/directives.js';
import { SourceTextIndex } from '../src/parser/sourceTextIndex.js';
import { getSourceModuleGraph } from '../src/workspace/sourceModules.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/interpolation.json', import.meta.url), 'utf8')) as { name: string; source: string; valid: boolean }[];
const registry = buildSluaRegistryFromLslDefinitions(null);
describe('native interpolation syntax, type and source locations', () => {
	it.each(cases)('$name', ({ name, source, valid }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics.length === 0, JSON.stringify(parsed.diagnostics)).toBe(valid);
		if (valid) expect(analyzeTextWithDirectives(source, { ast: parsed.ast, registry }).map((d) => d.code)).toEqual(name === 'one-result' ? ['assignment-return-count-mismatch'] : []);
	});
	it.each(['42', 'false', 'nil', '({})'])('infers one string result for %s in locals, arguments and return values', (value) => {
		const source = 'local function message() return `{' + value + '}` end\nlocal first,second=message()\nstring.lower(first)\nprint(second)';
		const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
		const inferred = new Map(inferLocalVariableTypes(parsed.ast, registry).map((v) => [v.name, v.type]));
		expect(inferred.get('first')).toEqual({ kind: 'primitive', name: 'string' });
		expect(inferred.get('second')).toEqual({ kind: 'primitive', name: 'nil' });
		expect(analyzeTextWithDirectives(source, { ast: parsed.ast, registry }).map((d) => d.code)).toEqual(['assignment-return-count-mismatch']);
	});
	it('checks the string result and still visits calls inside the interpolation', () => {
		const source = 'math.abs(`{42}`)\nprint(`{math.abs("bad")}`)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => [d.code, d.range.start.line])).toEqual([['call-argument-type-mismatch', 0], ['call-argument-type-mismatch', 1]]);
	});
	it.each(['\n', '\r', '\r\n'])('retains nested expression bindings and exact Unicode/editor ranges with %j', (eol) => {
		const source = ['-- 😀', 'const value=42', 'print(`outer {`inner {value} {"}"}`} end`)'].join(eol);
		const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
		const at = new SourceTextIndex(source).positionAt(source.indexOf('value}', source.indexOf('print')) + 2);
		expect(findDefinitionAtPosition(parsed.ast, at, registry)?.identifier.location?.start).toEqual({ line: 2, column: 7 });
		const references = findAllReferences(parsed.ast, at, registry);
		expect(references.map((ref) => ref.identifier.location?.start.line)).toEqual([2, 3]);
		expect(getRenameEdits(parsed.ast, at, 'changed', registry)).toHaveLength(2);
		expect(getHover(parsed.ast, at, registry)?.markdown).toContain('value: number');
		expect(getVisibleLocalTypes(parsed.ast, at, registry).get('value')).toEqual({ kind: 'primitive', name: 'number' });
		expect(getCompletions(parsed.ast, at, registry, { sourceText: source }).some((item) => item.label === 'value')).toBe(true);
		const token = classifySemanticTokens(source, { ast: parsed.ast }).find((t) => t.line === at.line && t.character === at.character - 2);
		expect(token?.tokenType).toBe('variable'); expect(token?.length).toBe(5);
		expect(token?.modifiers).toContain('readonly');
	});
	it('preserves interpolation comment directives and excludes literal comment text', () => {
		const source = 'print(`literal -- slua-lsp:disable all {\n-- slua-lsp:disable-next-line undeclared-name\nmissing\n}`)';
		const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
		expect(parseDirectives(source)).toEqual([{ kind: 'disable-next-line', line: 1, codes: ['undeclared-name'] }]);
		expect(analyzeTextWithDirectives(source, { ast: parsed.ast, registry })).toEqual([]);
	});
	it('keeps simple backtick strings constant for static member names, guards and module paths', async () => {
		const source = 'math[`abs`]("bad")\nlocal function f(value: number?) if type(value)==`number` then math.abs(value) end end\nprint(f)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['call-argument-type-mismatch']);
		const graph = await getSourceModuleGraph('/project/main.luau', { entryText: 'return require(`mod`)', readFile: async (file) => file === '/project/mod.luau' ? 'return 42' : undefined });
		expect(graph.diagnostics).toEqual([]); expect(graph.edges[0]!.target).toBe('/project/mod.luau');
	});
});
