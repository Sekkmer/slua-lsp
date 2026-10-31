import { describe, expect, it } from 'vitest';
import { analyzeSourceProject } from '../src/workspace/analyzeSourceProject.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { getHover } from '../src/typing/hover.js';
import { sluaTypeToString } from '../src/slua/types.js';

const base = buildSluaRegistryFromLslDefinitions(null);
const file = '/project/main.luau';
async function check(text: string, context?: unknown, extra: Record<string, string> = {}) {
	const options = { context, entryText: text, readFile: async (name: string) => extra[name] };
	return analyzeSourceProject(file, base, options);
}

describe('opt-in source macro context', () => {
	it('keeps ordinary macro spellings undeclared by default', async () => {
		expect((await check('print(__LINE__, __FILE__)')).diagnostics.map((d) => d.code)).toEqual(['undeclared-name', 'undeclared-name']);
	});
	it('recognizes location macros only with explicit context', async () => {
		const result = await check('print(__LINE__, __FILE__, __SHORTFILE__)', {});
		expect(result.diagnostics).toEqual([]);
		expect(base.getGlobalValue('__LINE__')).toBeUndefined();
	});
	it('types enabled macros in ordinary assignments', async () => {
		const result = await check('local n: string = __LINE__\nlocal f: number = __FILE__\nprint(n, f)', {});
		expect(result.diagnostics.map((d) => d.code)).toEqual(['assignment-type-mismatch', 'assignment-type-mismatch']);
	});
	it('requires explicit identity and time without duplicate undeclared warnings', async () => {
		const result = await check('print(__AGENTID__, __AGENTNAME__, __UNIXTIME__)', {});
		expect(result.diagnostics.map((d) => d.code)).toEqual(['preprocessor-context', 'preprocessor-context', 'preprocessor-context']);
	});
	it('retains UUID rather than string for AGENTKEY', async () => {
		const result = await check('local n: number = __AGENTKEY__\nprint(n, __AGENTID__, __AGENTNAME__, __DATE__, __TIME__, __TIMESTAMP__, __UNIXTIME__)', {
			agentId: '12345678-1234-1234-1234-123456789abc', agentName: 'Owned fixture', timestamp: '2026-10-30T00:00:00Z'
		});
		expect(result.diagnostics.map((d) => d.code)).toEqual(['assignment-type-mismatch']);
	});
	it('refuses AGENTKEY expansion through a shadowed UUID constructor', async () => {
		const result = await check('local function uuid(_: string): number return 42 end\nlocal n: number = __AGENTKEY__\nprint(n)', { agentId: '12345678-1234-1234-1234-123456789abc' });
		expect(result.diagnostics.map((d) => d.code)).toEqual(['preprocessor-context']);
	});
	it.each([
		'print(__AGENTKEY__)\nlocal function uuid() return 42 end\nprint(uuid())',
		'do local uuid = 42 print(uuid) end\nprint(__AGENTKEY__)',
		'local __AGENTKEY__ = 42\nlocal uuid = 3\nprint(__AGENTKEY__, uuid)'
	])('preserves constructor scope and local macro shadows: %s', async (text) => {
		expect((await check(text, { agentId: '12345678-1234-1234-1234-123456789abc' })).diagnostics).toEqual([]);
	});
	it('does not assume a globally reassigned uuid still constructs a UUID', async () => {
		const result = await check('uuid = function() return 42 end\nlocal n: number = __AGENTKEY__\nprint(n)', { agentId: '12345678-1234-1234-1234-123456789abc' });
		expect(result.diagnostics.map((d) => d.code)).toEqual(['preprocessor-context']);
	});
	it.each(['__LINE__ = 3', '__LINE__ += 1', 'function __LINE__() end'])('refuses an unbound enabled macro write: %s', async (text) => {
		const result = await check(text, {});
		expect(result.diagnostics.map((d) => d.code)).toEqual(['preprocessor-context']);
	});
	it('preserves lexical shadows, member names, literal text and local writes', async () => {
		const result = await check('local __LINE__ = 3\n__LINE__ += 1\nlocal value = {__AGENTID__ = "__TIME__"}\nlocal function f(__DATE__: number) return __DATE__ end\nprint(__LINE__, value.__AGENTID__, f(3))', {});
		expect(result.diagnostics).toEqual([]);
	});
	it('does not allow the LSL-only raw agent macro', async () => {
		expect((await check('print(__AGENTIDRAW__)', {})).diagnostics.map((d) => d.code)).toEqual(['preprocessor-context']);
	});
	it('keeps source positions and directives on the original CRLF text', async () => {
		const result = await check('-- 😀\r\nprint(__AGENTID__)\r\n-- slua-lsp:disable-next-line preprocessor-context\r\nprint(__AGENTNAME__)', {});
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ code: 'preprocessor-context', range: { start: { line: 1, character: 6 }, end: { line: 1, character: 17 } } });
	});
	it('propagates macro export types across imports with file-local hover', async () => {
		const result = await check('local n: string = require("helper")\nprint(n, __FILE__)', {}, { '/project/helper.luau': 'return __LINE__' });
		expect(result.diagnostics.map((d) => d.code)).toEqual(['assignment-type-mismatch']);
		expect(sluaTypeToString(result.exports.get('/project/helper.luau')!)).toBe('number');
		const ast = result.documents.get(file)!.parsed.ast;
		expect(getHover(ast, { line: 1, character: 12 }, result.registry)?.markdown).toContain('/project/main.luau');
	});
	it.each([null, { agentId: 'bad' }, { timestamp: 'today' }, { unknown: true }])('rejects invalid context before any source IO: %j', async (context) => {
		let reads = 0;
		const options = { context, readFile: async () => { reads++; return ''; } };
		await expect(analyzeSourceProject(file, base, options)).rejects.toThrow();
		expect(reads).toBe(0);
	});
	it('does not leak enabled macros into a following disabled project', async () => {
		await check('print(__LINE__)', {});
		expect((await check('print(__LINE__)')).diagnostics.map((d) => d.code)).toEqual(['undeclared-name']);
	});
	it('unwraps a previous file-context overlay when used as another project base', async () => {
		const first = await check('print(__LINE__)', {});
		const next = await analyzeSourceProject(file, first.registry, { entryText: 'print(__LINE__)', readFile: async () => undefined });
		expect(next.diagnostics.map((d) => d.code)).toEqual(['undeclared-name']);
	});
});
