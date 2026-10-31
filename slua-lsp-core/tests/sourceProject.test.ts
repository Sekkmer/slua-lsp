import { describe, expect, it } from 'vitest';
import { analyzeSourceProject } from '../src/workspace/analyzeSourceProject.js';
import { preprocessSource } from '../src/workspace/preprocessSource.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { getHover } from '../src/typing/hover.js';
import { getCompletions } from '../src/typing/completion.js';
import { slua, sluaTypeEquals, sluaTypeToString, type SluaType } from '../src/slua/types.js';

const base = buildSluaRegistryFromLslDefinitions(null);
const host = (files: Record<string, string>) => ({ readFile: async (file: string) => files[file] });
describe('source project diagnostics and inferred exports', () => {
	it('checks generated runtime require calls without treating numeric IDs as source imports', async () => {
		const options = host({
			'/project/main.luau': 'local tools = require("./math")\nassert(tools.double(21) == 42)',
			'/project/math.luau': 'return {double = function(value: number): number return value * 2 end}'
		});
		const generated = await preprocessSource('/project/main.luau', options);
		expect(generated.success).toBe(true);
		const reads: string[] = [];
		const project = await analyzeSourceProject('/project/generated.luau', base, {
			entryText: generated.content!, readFile: async (file) => { reads.push(file); return undefined; }
		});
		expect(project.graph.edges).toEqual([]);
		expect(project.diagnostics.filter((item) => item.code.startsWith('module-') || item.code === 'call-argument-type-mismatch')).toEqual([]);
		expect(reads).toEqual([]);
	});
	it('bounds formatting and comparison of shared table export graphs', () => {
		function graph(leaf: SluaType): SluaType {
			let value = leaf;
			for (let index = 0; index < 80; index++) value = slua.table({ left: value, right: value });
			return value;
		}
		const first = graph(slua.number()); const second = graph(slua.number()); const third = graph(slua.string());
		expect(sluaTypeEquals(first, second)).toBe(true); expect(sluaTypeEquals(first, third)).toBe(false);
		expect(sluaTypeToString(first).length).toBeLessThan(15000);
		expect(sluaTypeEquals(slua.union([first, third]), slua.union([first]))).toBe(false);
	});
	it('aborts stale project analysis before applying source expression facts', async () => {
		const controller = new AbortController();
		const project = analyzeSourceProject('/project/main.luau', base, { signal: controller.signal, readFile: async () => {
			controller.abort(); return 'return 1';
		} });
		await expect(project).rejects.toThrow();
	});
	it('checks imported code and carries scalar exports into caller assignments without inventing a runtime require global', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'local value: number = require("message")\nprint(value)', '/project/message.luau': 'return "hello"'
		}));
		expect(project.diagnostics.map((item) => [item.file, item.code])).toEqual([['/project/main.luau', 'assignment-type-mismatch']]);
		expect(sluaTypeToString(project.exports.get('/project/message.luau')!)).toBe('string');
		expect(base.getGlobal('require')).toBeUndefined(); expect(project.registry.getGlobal('require')).toBeUndefined();
	});
	it('carries nested table fields and annotated function contracts across multiple source modules', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'local api = require("api")\nlocal value: string = api.count\napi.double("wrong")\nprint(value)',
			'/project/api.luau': 'local count = require("count")\nreturn {count = count, double = function(value: number): number return value * 2 end, nested = {message = "hi"}}',
			'/project/count.luau': 'return 42'
		}));
		expect(project.diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch', 'call-argument-type-mismatch']);
		const ast = project.documents.get('/project/main.luau')!.parsed.ast;
		expect(getHover(ast, { line: 0, character: 7 }, project.registry)?.markdown).toContain('count: number');
		const members = getCompletions(ast, { line: 1, character: 26 }, project.registry, { sourceText: project.documents.get('/project/main.luau')!.text, invoked: true });
		expect(members.some((item) => item.label === 'double')).toBe(true);
		expect(sluaTypeToString(project.exports.get('/project/api.luau')!)).toContain('message: string');
	});
	it('infers incrementally built exports through aliases, nested fields and function statements', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'local api = require("api")\nlocal value: string = api.count\napi.double("wrong")\nprint(value)',
			'/project/api.luau': 'local M = {}\nlocal alias = M\nalias.count = 42\nM.nested = {}\nM.nested.message = "hi"\nfunction M.double(value: number): number return value * 2 end\nreturn M'
		}));
		expect(project.diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch', 'call-argument-type-mismatch']);
		expect(sluaTypeToString(project.exports.get('/project/api.luau')!)).toContain('message: string');
	});
	it('checks imported semantic diagnostics once per source and preserves source-local suppression directives', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'print(require("a"), require("a"), require("b"))',
			'/project/a.luau': 'local value: number = "wrong"\nreturn value',
			'/project/b.luau': '-- slua-lsp:disable assignment-type-mismatch\nlocal value: number = "wrong"\nreturn value'
		}));
		expect(project.diagnostics.map((item) => [item.file, item.code])).toEqual([['/project/a.luau', 'assignment-type-mismatch']]);
	});
	it('leaves local require functions and bare unknown require references in their own lexical contracts', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'local callback = require\ndo local function require(value: number): number return value end\nprint(require("wrong")) end\nprint(callback)'
		}));
		expect(project.graph.edges).toEqual([]);
		expect(project.diagnostics.map((item) => item.code)).toEqual(['undeclared-name', 'call-argument-type-mismatch']);
	});
	it('does not conceal missing/dynamic/cyclic imports or parse errors as successfully typed dependencies', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'print(require("bad"), require("missing"), require(name))',
			'/project/bad.luau': 'const value = 1\nvalue = 2'
		}));
		expect(project.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['parse-error', 'module-resolution', 'module-dynamic-require', 'undeclared-name']));
		expect(project.diagnostics.filter((item) => item.message.includes('Undeclared name \'require\''))).toEqual([]);
	});
	it('does not retain stale types across separate project requests or mutate the base registry', async () => {
		const main = 'local value: number = require("a")\nprint(value)'; let module = 'return 1';
		const options = { entryText: main, readFile: async (file: string) => file === '/project/a.luau' ? module : undefined };
		const first = await analyzeSourceProject('/project/main.luau', base, options); expect(first.diagnostics).toEqual([]);
		module = 'return "changed"'; const second = await analyzeSourceProject('/project/main.luau', base, options);
		expect(second.diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch']);
		expect(first.registry).not.toBe(second.registry); expect(base.modules.size).toBe(first.registry.modules.size);
	});
	it('uses conservative unions for conditional module return values', async () => {
		const project = await analyzeSourceProject('/project/main.luau', base, host({
			'/project/main.luau': 'local value: number = require("choice")\nprint(value)',
			'/project/choice.luau': 'if math.random() > 0.5 then return 1 else return "message" end'
		}));
		expect(sluaTypeToString(project.exports.get('/project/choice.luau')!)).toBe('number | string');
		expect(project.diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch']);
	});
});
