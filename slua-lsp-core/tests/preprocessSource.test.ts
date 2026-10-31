import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { preprocessSource, mapPreprocessedPosition, resolvePreprocessedPosition } from '../src/workspace/preprocessSource.js';
import { parseSlua } from '../src/parser/parseSlua.js';

const host = (files: Record<string, string>) => ({ readFile: async (file: string) => files[file] });
const position = (text: string, marker: string) => {
	const offset = text.indexOf(marker); expect(offset).toBeGreaterThanOrEqual(0);
	const before = text.slice(0, offset), line = before.split('\n').length - 1;
	return { line, character: before.length - before.lastIndexOf('\n') - 1 };
};

describe('read-only generated SLua and source mapping', () => {
	it('resolves a copied Unicode/CRLF position only against the exact current source hash', async () => {
		const files = { '/project/main.luau': 'print(require("mod"))', '/project/mod.luau': '-- 😀\r\nreturn "value"' };
		const result = await preprocessSource('/project/main.luau', host(files));
		const location = await resolvePreprocessedPosition(result, position(result.content!, '"value"'), host(files));
		expect(location).toEqual({ status: 'mapped', file: '/project/mod.luau', position: { line: 1, character: 7 }, sourceSha256: createHash('sha256').update(files['/project/mod.luau']).digest('hex') });
		files['/project/mod.luau'] = 'return "changed"';
		expect(await resolvePreprocessedPosition(result, position(result.content!, '"value"'), host(files))).toEqual({ status: 'stale', file: '/project/mod.luau', expectedSourceSha256: location.status === 'mapped' ? location.sourceSha256 : '', actualSourceSha256: createHash('sha256').update(files['/project/mod.luau']).digest('hex') });
	});
	it('maps replacement anchors and leaves helpers, failed output and invalid positions unmapped without IO', async () => {
		const files = { '/project/main.luau': 'print(__LINE__)' };
		const result = await preprocessSource('/project/main.luau', { ...host(files), context: {} });
		expect(await resolvePreprocessedPosition(result, position(result.content!, '1'), host(files))).toMatchObject({ status: 'mapped', position: { line: 0, character: 6 } });
		let reads = 0; const readFile = async () => { reads++; return undefined; };
		expect(await resolvePreprocessedPosition(result, { line: 999, character: 0 }, { readFile })).toEqual({ status: 'unmapped' });
		const failed = await preprocessSource('/project/main.luau', host({}));
		expect(await resolvePreprocessedPosition(failed, { line: 0, character: 0 }, { readFile })).toEqual({ status: 'unmapped' });
		const imported = await preprocessSource('/project/main.luau', host({ '/project/main.luau': 'require("mod")', '/project/mod.luau': 'return 1' }));
		expect(await resolvePreprocessedPosition(imported, { line: 0, character: 0 }, { readFile })).toEqual({ status: 'unmapped' });
		expect(reads).toBe(0);
	});
	it.each([['absent', undefined], ['denied', new Error('read denied')], ['surrogate', '\ud800'], ['binary', '\0'], ['oversized', 'x'.repeat(8388609)]] as const)('reports unavailable %s source instead of emitting a misleading location', async (_name, current) => {
		const result = await preprocessSource('/project/main.luau', { ...host({}), entryText: 'print(1)' });
		const mapped = await resolvePreprocessedPosition(result, { line: 0, character: 0 }, { readFile: async () => { if (current instanceof Error) throw current; return current; } });
		expect(mapped).toMatchObject({ status: 'unavailable', file: '/project/main.luau' });
	});
	it('propagates cancellation before IO and after an asynchronous read', async () => {
		const result = await preprocessSource('/project/main.luau', { ...host({}), entryText: 'print(1)' });
		const controller = new AbortController(); controller.abort();
		let reads = 0;
		await expect(resolvePreprocessedPosition(result, { line: 0, character: 0 }, { signal: controller.signal, readFile: async () => { reads++; return ''; } })).rejects.toThrow();
		expect(reads).toBe(0);
		const during = new AbortController();
		await expect(resolvePreprocessedPosition(result, { line: 0, character: 0 }, { signal: during.signal, readFile: async () => { during.abort(); return 'print(1)'; } })).rejects.toThrow();
	});
	it('parses a valid large statement sequence beyond the former arbitrary safety counter', () => {
		const result = parseSlua('print(1)\n'.repeat(10001));
		expect(result.diagnostics).toEqual([]); expect(result.ast).not.toBeNull();
	});
	it('emits a deterministic dependency snapshot and hashes without reading sources twice', async () => {
		const files = { '/project/main.luau': 'local a=require("mod")\nlocal b=require("mod")\nprint(a==b)', '/project/mod.luau': 'return {}' };
		const reads = new Map<string, number>();
		const options = { readFile: async (file: string) => { reads.set(file, (reads.get(file) ?? 0) + 1); return files[file as keyof typeof files]; } };
		const result = await preprocessSource('/project/main.luau', options);
		expect(result.success).toBe(true); expect(result.diagnostics).toEqual([]);
		expect(result.graph.modules).toHaveLength(2); expect(result.moduleIds).toEqual([{ file: '/project/mod.luau', id: 1 }]);
		expect(result.contentSha256).toBe(createHash('sha256').update(result.content!).digest('hex'));
		expect([...reads.values()].every((count) => count === 1)).toBe(true);
		expect(await preprocessSource('/project/main.luau', host(files))).toEqual(result);
		expect(mapPreprocessedPosition(result, { line: 0, character: 0 })).toBeNull();
	});
	it('accepts an empty module and preserves a module without a trailing newline', async () => {
		const result = await preprocessSource('/project/main.luau', host({ '/project/main.luau': 'require("empty")\nrequire("comment")', '/project/empty.luau': '', '/project/comment.luau': 'return 42 -- trailing comment' }));
		expect(result.success).toBe(true); expect(result.moduleIds).toHaveLength(2);
		expect(mapPreprocessedPosition(result, position(result.content!, 'return 42'))).toEqual({ file: '/project/comment.luau', position: { line: 0, character: 0 } });
	});
	it('preserves local require functions, member calls, strings and comments byte for byte', async () => {
		const text = '-- require("missing")\r\nlocal function require(x) return x end\r\nlocal obj={require=require}\r\nprint(obj.require("value"), require("value"), [=[require("text")]=])';
		const result = await preprocessSource('/project/main.luau', { entryText: text, ...host({}) });
		expect(result.success).toBe(true); expect(result.content).toBe(text); expect(result.moduleIds).toEqual([]);
	});
	it.each(['require(value)', 'require("missing")', 'return require("self")'])('refuses incomplete generation with diagnostics and no source: %s', async (text) => {
		const result = await preprocessSource('/project/main.luau', host({ '/project/main.luau': text, '/project/self.luau': 'return require("main")' }));
		expect(result.success).toBe(false); expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(result.content).toBeNull(); expect(result.contentSha256).toBeNull(); expect(result.mappings).toEqual([]);
	});
	it.each(['local load=require\nreturn load("mod")', 'require=function(x) return x end', 'function require(x) return x end'])('rejects indirect or overwritten global loader values explicitly: %s', async (text) => {
		const result = await preprocessSource('/project/main.luau', { entryText: text, ...host({}) });
		expect(result.success).toBe(false); expect(result.diagnostics.some((item) => item.code === 'preprocessor-require-value')).toBe(true);
	});
	it('maps module and caller independently across Unicode, CRLF and multiline calls', async () => {
		const main = '-- 😀\r\nlocal value = require(\r\n  "mod"\r\n)\r\nprint("caller")';
		const module = '-- 😀\r\nlocal n=1\r\nerror("module")';
		const result = await preprocessSource('/project/main.luau', host({ '/project/main.luau': main, '/project/mod.luau': module }));
		expect(result.success).toBe(true);
		for (const [marker, file, original] of [['error("module")', '/project/mod.luau', module], ['print("caller")', '/project/main.luau', main]]) {
			expect(mapPreprocessedPosition(result, position(result.content!, marker!))).toEqual({ file, position: position(original!, marker!) });
		}
		const emoji = result.mappings.find((mapping) => mapping.file === '/project/main.luau' && mapping.kind === 'copy')!;
		expect(mapPreprocessedPosition(result, { line: emoji.generated.start.line, character: 5 })).toEqual({ file: '/project/main.luau', position: { line: 0, character: 5 } });
		const replacement = result.mappings.find((mapping) => mapping.kind === 'replacement')!;
		expect(mapPreprocessedPosition(result, replacement.generated.start)).toEqual({ file: '/project/main.luau', position: { line: 2, character: 2 } });
	});
	it('keeps macros ordinary unless context is explicitly enabled, respecting lexical shadows', async () => {
		const text = 'local __LINE__=123\nprint(__LINE__, __FILE__)';
		expect((await preprocessSource('/project/main.luau', { entryText: text, ...host({}) })).content).toBe(text);
		const result = await preprocessSource('/project/main.luau', { entryText: text, context: {}, ...host({}) });
		expect(result.success).toBe(true); expect(result.content).toContain('local __LINE__=123\nprint(__LINE__, "/project/main.luau")');
	});
	it.each(['require "mod"', 'require[[mod]]', 'require( -- comment\n "mod"\n)'])('handles literal call forms without corrupting the call: %s', async (call) => {
		const result = await preprocessSource('/project/main.luau', host({ '/project/main.luau': `print(${call})`, '/project/mod.luau': 'return 42' }));
		expect(result.success).toBe(true); expect(result.moduleIds).toHaveLength(1);
	});
	it('does not map impossible positions within an otherwise valid multiline copy', async () => {
		const result = await preprocessSource('/project/main.luau', { entryText: 'print(1)\r\nprint(2)', ...host({}) });
		expect(mapPreprocessedPosition(result, { line: 0, character: 999 })).toBeNull();
		expect(mapPreprocessedPosition(result, { line: 0, character: 9 })).toBeNull();
		expect(mapPreprocessedPosition(result, { line: 20, character: 0 })).toBeNull();
	});
	it('propagates cancellation without returning a partial generation result', async () => {
		const controller = new AbortController(); controller.abort();
		await expect(preprocessSource('/project/main.luau', { signal: controller.signal, ...host({}) })).rejects.toThrow();
	});
	it('expands explicit deterministic context in each source without inventing identity or time', async () => {
		const files = { '/project/main.luau': 'print(__LINE__, __SHORTFILE__, __AGENTID__, __AGENTKEY__, __AGENTNAME__, __DATE__, __TIME__, __TIMESTAMP__, __UNIXTIME__)\nrequire("mod")', '/project/mod.luau': 'print(__FILE__)\nreturn __LINE__' };
		const context = { agentId: '00000000-0000-0000-0000-000000000000', agentName: 'Name "quoted"\nnext', timestamp: '2026-10-30T01:02:03Z' };
		const result = await preprocessSource('/project/main.luau', { ...host(files), context });
		expect(result.success).toBe(true); expect(result.content).toContain('"/project/mod.luau"');
		expect(result.content).toContain('"2026-10-30"'); expect(result.content).toContain('"01:02:03"');
		expect(result.content).toContain('uuid("00000000-0000-0000-0000-000000000000")');
		expect(result.contextSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await preprocessSource('/project/main.luau', { ...host(files), context })).toEqual(result);
	});
	it.each(['__AGENTNAME__', '__AGENTID__', '__DATE__', '__AGENTIDRAW__'])('reports missing or unsupported context rather than replacing it with a guess: %s', async (macro) => {
		const result = await preprocessSource('/project/main.luau', { entryText: `print(${macro})`, context: {}, ...host({}) });
		expect(result.success).toBe(false); expect(result.diagnostics[0]!.code).toBe('preprocessor-context');
	});
	it('refuses writes to enabled source macros', async () => {
		const result = await preprocessSource('/project/main.luau', { entryText: '__LINE__=2', context: {}, ...host({}) });
		expect(result.success).toBe(false); expect(result.diagnostics[0]!.code).toBe('preprocessor-context');
	});
	it.each([null, [], { unknown: true }, { agentId: 'not-a-uuid' }, { agentName: 42 }, { timestamp: '2026-02-31T00:00:00Z' }])('refuses invalid context before source IO: %j', async (context) => {
		let reads = 0;
		await expect(preprocessSource('/project/main.luau', { context: context as never, readFile: async () => { reads++; return undefined; } })).rejects.toThrow();
		expect(reads).toBe(0);
	});
});
