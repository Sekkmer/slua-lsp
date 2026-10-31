import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { inferValueExports } from '../src/typing/inferLocals.js';
import { sluaTypeToString } from '../src/slua/types.js';
import { analyzeSourceProject } from '../src/workspace/analyzeSourceProject.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
describe('inference snapshot isolation', () => {
	it.each([
		['captured scalar', 'export local count=1\nlocal function change() count="changed" end\nprint(change)', 'count: number'],
		['captured table', 'export local api={count=1}\nlocal function change() api.count="changed" end\nprint(change)', 'count: number'],
		['captured table alias', 'export local api={count=1}\nlocal alias=api\nlocal function change() alias.extra="changed" end\nprint(change)', 'api: { count: number }'],
		['nested local shadow', 'export local count=1\nlocal function outer() local count="shadow"\nlocal function inner() count=false end\nreturn inner end\nprint(outer)', 'count: number'],
		['branch assignment', 'export local count=1\nif math.random()>0.5 then count="changed" else count=false end', 'boolean | string'],
		['branch alias', 'export local api={count=1}\nif math.random()>0.5 then local alias=api alias.extra="changed" end', 'api: { count: number }'],
		['loop capture', 'export local count=1\nfor i=1,2 do local function change() count="changed" end print(i,change) end', 'count: number'],
		['repeat capture', 'export local count=1\nrepeat local function change() count="changed" end print(change) until true', 'count: number'],
		['shadow after exported function', 'export local count=1\nexport function get() return count end\nlocal count="shadow"\ncount=false', 'get: () -> number'],
		['annotated function', 'export local count=1\nexport function get(): number return count end\nlocal count="shadow"', 'get: () -> number'],
		['anonymous return inference', 'export local count=1\nexport local get=function() return count end\nlocal count="shadow"', 'get: () -> number'],
		['function-local writes', 'export local api={}\nexport function get() api.extra=1 return api.extra end', 'get: () -> number'],
	])('keeps %s facts scoped to their snapshot', (_name, source, expected) => {
		const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
		expect(sluaTypeToString(inferValueExports(parsed.ast, registry)!)).toContain(expected);
	});
	it('still checks bodies with declared returns and retains nested local inference', () => {
		const source = 'export function get(): number\nlocal value: string=3\nreturn "wrong"\nend';
		expect(analyzeTextWithDirectives(source, { registry }).map((x) => x.code).sort()).toEqual(['assignment-type-mismatch', 'declared-return-type-mismatch']);
	});
	it('preserves source origin and frozen identity after branch table writes in a function snapshot', async () => {
		const project = await analyzeSourceProject('/owned/main.luau', registry, { entryText: 'local api=require("api")\napi.table.count=2\napi.table={}', readFile: async (file) => file === '/owned/api.luau' ? 'export local table={count=1}\nlocal function change() if math.random()>0.5 then table.extra=1 end end\nprint(change)' : undefined });
		expect(project.diagnostics.map((x) => x.code)).toEqual(['readonly-write']);
		expect(sluaTypeToString(project.exports.get('/owned/api.luau')!)).toBe('{ table: { count: number } }');
	});
});
