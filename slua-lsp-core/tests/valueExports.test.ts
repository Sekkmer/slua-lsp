import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, getRenameEdits, findAllReferences, classifySemanticTokens, getCompletions, getHover } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { analyzeSourceProject } from '../src/workspace/analyzeSourceProject.js';
import { sluaTypeToString } from '../src/slua/types.js';
import { findDefinitionAtPosition } from '../src/typing/findDefinition.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/value-exports.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; parseValid: boolean }>;
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('native value exports', () => {
	it.each(cases)('$name', ({ source, parseValid }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics.length === 0, JSON.stringify(parsed.diagnostics)).toBe(parseValid);
		if (parseValid) expect(analyzeTextWithDirectives(source, { ast: parsed.ast, registry })).toEqual([]);
	});
	it('retains local identity and excludes a later mutable shadow from readonly references', () => {
		const source = 'export function get(): number return 1 end\nprint(get())\ndo local get=2 print(get) end';
		const ast = parseSlua(source).ast;
		expect(findAllReferences(ast, { line: 1, character: 8 }, registry, true)).toHaveLength(2);
		expect(getRenameEdits(ast, { line: 1, character: 8 }, 'read', registry)).toHaveLength(2);
		const tokens = classifySemanticTokens(source, { ast });
		expect(tokens.find((x) => x.line === 1 && x.character === 6)?.modifiers).toContain('readonly');
		expect(tokens.filter((x) => x.line === 2).every((x) => !x.modifiers.includes('readonly'))).toBe(true);
	});
	it('refuses rename into another exported key even when an unused shadow would preserve value uses', () => {
		const source = 'export local first=1\nexport local second=2';
		expect(getRenameEdits(parseSlua(source).ast, { line: 0, character: 14 }, 'second', registry)).toEqual([]);
	});
	it('infers the export binding at module completion through mutation and subsequent shadowing', async () => {
		const files: Record<string, string> = {
			'/project/main.luau': 'local api=require("api")\nlocal count: string=api.count\napi.double("wrong")\nprint(count)',
			'/project/api.luau': 'export local count=1\ncount=2\nexport function double(value: number): number return value*2 end\nlocal count="shadow"\nprint(count)',
		};
		const project = await analyzeSourceProject('/project/main.luau', registry, { readFile: async (file) => files[file] });
		expect(project.diagnostics.map((x) => x.code)).toEqual(['assignment-type-mismatch', 'call-argument-type-mismatch']);
		expect(sluaTypeToString(project.exports.get('/project/api.luau')!)).toContain('count: number');
		const ast = project.documents.get('/project/main.luau')!.parsed.ast;
		expect(findDefinitionAtPosition(ast, { line: 1, character: 25 }, project.registry)?.identifier).toMatchObject({ name: 'count', location: { start: { line: 1, column: 14 } } });
	});
	it.each([
		['uninitialized', 'export local count', 'count: nil'],
		['updated scalar', 'export local count=1\ncount="changed"', 'count: string'],
		['block write', 'export local count=1\ndo count=2 end', 'count: number'],
		['branch write', 'export local count=1\nif math.random()>0.5 then count="changed" end', 'number | string'],
		['shadow initializer', 'local count=1\nexport local count=count+1', 'count: number'],
		['shadow assignment', 'export local count=1\nlocal count="other"\ncount=false', 'count: number'],
		['table alias', 'export local api={}\nlocal alias=api\nalias.count=1', 'count: number'],
		['table shadow', 'export local api={}\nlocal alias=api\nlocal api={}\nalias.count=1', 'count: number'],
		['forward function', 'export local get\nfunction get(): number return 3 end', 'get: () -> number'],
		['class', 'export class Box end', 'Box: (table) -> Box'],
	])('retains %s exports independently of final name lookup', async (_name, source, expected) => {
		const project = await analyzeSourceProject('/project/api.luau', registry, { entryText: source });
		expect(project.graph.diagnostics).toEqual([]);
		expect(sluaTypeToString(project.exports.get('/project/api.luau')!)).toContain(expected);
	});
	it.each(['api.count=2', 'alias["count"]=2', 'api[math.random()]=2', 'function api.get() end'])('rejects frozen module surface writes: %s', async (write) => {
		const project = await analyzeSourceProject('/project/main.luau', registry, { entryText: 'local api=require("api")\nlocal alias=api\n' + write, readFile: async (file) => file === '/project/api.luau' ? 'export local count=1\nexport function get(): number return 3 end' : undefined });
		expect(project.diagnostics.map((x) => x.code)).toEqual(['readonly-write']);
	});
	it('freezes only the export surface, leaving a nested ordinary table mutable and navigable', async () => {
		const project = await analyzeSourceProject('/project/main.luau', registry, { entryText: 'local api=require("api")\napi.nested.count=2\nprint(api.nested.count)', readFile: async (file) => file === '/project/api.luau' ? 'export local nested={count=1}' : undefined });
		expect(project.diagnostics).toEqual([]);
		const ast = project.documents.get('/project/main.luau')!.parsed.ast;
		expect(getHover(ast, { line: 0, character: 7 }, project.registry)?.markdown).toContain('nested');
		expect(getCompletions(ast, { line: 1, character: 4 }, project.registry, { invoked: true, sourceText: project.documents.get('/project/main.luau')!.text }).some((x) => x.label === 'nested')).toBe(true);
	});
	it('re-reads changed exports without retaining the previous project identity or mutating the base', async () => {
		let source = 'export local count=1';
		const options = { entryText: 'local api=require("api")\nlocal count: number=api.count\nprint(count)', readFile: async (file: string) => file === '/project/api.luau' ? source : undefined };
		expect((await analyzeSourceProject('/project/main.luau', registry, options)).diagnostics).toEqual([]);
		source = 'export local count="changed"';
		expect((await analyzeSourceProject('/project/main.luau', registry, options)).diagnostics.map((x) => x.code)).toEqual(['assignment-type-mismatch']);
		expect(registry.getGlobal('require')).toBeUndefined();
	});
	it('keeps parse failures unsuppressible while honoring semantic directives inside exported functions', () => {
		const source = '-- slua-lsp:disable all\nexport local count=1\nexport local count=2';
		expect(parseSlua(source).diagnostics.map((x) => x.code)).toEqual(['parse-error']);
		const suppressed = '-- slua-lsp:disable-next-line undeclared-name\nexport function get() return missing end';
		expect(analyzeTextWithDirectives(suppressed, { registry })).toEqual([]);
	});
	it('tracks function statements assigning mutable exported forward declarations in diagnostics and hover', () => {
		const source = 'export local double\nfunction double(value: number): number return value*2 end\nprint(double("wrong"))';
		const ast = parseSlua(source).ast;
		expect(analyzeTextWithDirectives(source, { ast, registry }).map((x) => x.code)).toEqual(['call-argument-type-mismatch']);
		expect(getHover(ast, { line: 2, character: 9 }, registry)?.markdown).toContain('(number) -> number');
	});
});
