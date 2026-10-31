import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSourceRequires, getSourceModuleGraph, readSourceModuleFile } from '../src/workspace/sourceModules.js';
import { parseSlua } from '../src/parser/parseSlua.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
function host(files: Record<string, string>) {
	return { readFile: async (file: string) => files[file] };
}
describe('source module dependency inspection', () => {
	it.each([
		'function require(value) return value end\nprint(require(1))',
		'(function() function require(value) return value end end)()\nprint(require("not-a-file"))',
		'require = function(value) return value end\nprint(require(1))'
	])('does not inspect source paths after an explicit global require replacement: %s', (source) => {
		const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
		expect(collectSourceRequires(parsed.ast)).toEqual([]);
	});
	it('keeps source imports when function assignment only replaces a lexically bound require', () => {
		const parsed = parseSlua('do local require\nfunction require(value) return value end\nrequire(1) end\nrequire("actual-source")');
		expect(parsed.diagnostics).toEqual([]);
		expect(collectSourceRequires(parsed.ast).map((item) => item.specifier)).toEqual(['actual-source']);
	});
	it('retains the UTF-8 BOM in source bytes and hashes rather than silently changing the program', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-module-bom-')); temporary.push(dir);
		const file = path.join(dir, 'main.luau'), text = '\ufeffprint("owned")';
		await fs.writeFile(file, text);
		expect(await readSourceModuleFile(file)).toBe(text);
		const graph = await getSourceModuleGraph(file);
		expect(graph.modules[0]).toEqual({ file, bytes: Buffer.byteLength(text), sourceSha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
		expect(graph.diagnostics.some((item) => item.code === 'parse-error')).toBe(true);
	});
	it('refuses malformed UTF-16 host buffers before hashing their lossy UTF-8 replacement', async () => {
		const graph = await getSourceModuleGraph('/project/main.luau', { entryText: 'print("\ud800")' });
		expect(graph.modules).toEqual([]);
		expect(graph.diagnostics[0]!.code).toBe('module-input');
		expect(graph.diagnostics[0]!.message).toContain('Unicode');
	});
	it('uses lexical calls rather than matching comments, strings, fields or shadowed functions', () => {
		const source = '-- require("fake")\nlocal text = [[require("text")]]\nlocal real = require("real")\nobject.require("field")\ndo local require = function(value) return value end\nrequire("shadow") end\nlocal function use(require) return require("parameter") end\nprint(text, real, use)';
		const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
		expect(collectSourceRequires(parsed.ast)).toEqual([{ specifier: 'real', range: expect.objectContaining({ start: { line: 2, character: 21 } }) }]);
	});
	it('resolves relative extensions, folder init and duplicate includes without executing or duplicating modules', async () => {
		const files = { '/project/main.luau': 'local a = require("helper")\nlocal b = require("folder")\nlocal c = require("helper")',
			'/project/helper.luau': 'return require("nested.lua")', '/project/nested.lua': 'return 3', '/project/folder/init.luau': 'return {}' };
		const graph = await getSourceModuleGraph('/project/main.luau', host(files));
		expect(graph.diagnostics).toEqual([]); expect(graph.modules).toHaveLength(4); expect(graph.edges).toHaveLength(4);
		expect(graph.edges.map((edge) => edge.target)).toEqual(['/project/helper.luau', '/project/nested.lua', '/project/folder/init.luau', '/project/helper.luau']);
		expect(graph.modules[0]!.sourceSha256).toBe(createHash('sha256').update(files['/project/main.luau']).digest('hex'));
	});
	it('inherits case-insensitive aliases, lets nearest configs override parents and resolves values relative to their declaring config', async () => {
		const graph = await getSourceModuleGraph('/project/src/main.luau', host({
			'/project/.luaurc': '{"aliases":{"lib":"old", "shared":"shared"}}',
			'/project/src/.luaurc': '{"aliases":{"LIB":"../new"}}',
			'/project/src/main.luau': 'print(require("@lib/tool"), require("@shared"))',
			'/project/new/tool.luau': 'return 1', '/project/shared/init.lua': 'return 2'
		}));
		expect(graph.diagnostics).toEqual([]);
		expect(graph.edges.map((edge) => edge.target)).toEqual(['/project/new/tool.luau', '/project/shared/init.lua']);
	});
	it('reads JSONC comments and trailing commas without changing string contents or config hashes', async () => {
		const config = '{/* aliases */ "note":"https://example/a,}",\n"aliases":{"lib":"library",}, // trailing comment\n}';
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/.luaurc': config,
			'/project/main.luau': 'return require("@lib/tool")', '/project/library/tool.luau': 'return 1' }));
		expect(graph.diagnostics).toEqual([]); expect(graph.edges[0]!.target).toBe('/project/library/tool.luau');
		expect(graph.configs[0]!.sourceSha256).toBe(createHash('sha256').update(config).digest('hex'));
	});
	it('resolves a chained alias from its declaring config without rebinding it to a child override', async () => {
		const graph = await getSourceModuleGraph('/project/child/main.luau', host({
			'/project/child/main.luau': 'return require("@pkg/tool")',
			'/project/.luaurc': '{"aliases":{"root":"library","pkg":"@root/sub"}}',
			'/project/child/.luaurc': '{"aliases":{"root":"wrong"}}',
			'/project/library/sub/tool.luau': 'return 1', '/project/child/wrong/sub/tool.luau': 'return 999'
		}));
		expect(graph.diagnostics).toEqual([]); expect(graph.edges[0]!.target).toBe('/project/library/sub/tool.luau');
	});
	it.each(['\ud800', '\udc80', 'dir/\ud800', '\ud800x\udc80', '\ud83d\ude00\ud800'])('refuses malformed Unicode alias targets before any target path IO: %j', async (target) => {
		const files: Record<string, string> = { '/project/main.luau': 'return require("@lib/tool")', '/project/.luaurc': JSON.stringify({ aliases: { lib: target } }) };
		files['/project/' + target + '/tool.luau'] = 'return 42';
		const reads: string[] = [];
		const graph = await getSourceModuleGraph('/project/main.luau', { readFile: async (file) => { reads.push(file); return files[file]; } });
		expect(graph.diagnostics).toHaveLength(1); expect(graph.diagnostics[0]!.code).toBe('module-resolution');
		expect(graph.diagnostics[0]!.message).toContain('Unicode');
		expect(graph.modules).toHaveLength(1); expect(graph.edges[0]!.target).toBeUndefined();
		expect(reads.some((file) => file.endsWith('/tool.luau'))).toBe(false);
	});
	it.each(['könyvtár', '😀', '�', 'x😀y'])('preserves valid Unicode alias target identity: %s', async (target) => {
		const config = JSON.stringify({ aliases: { lib: target } }).replaceAll('😀', '\\ud83d\\ude00');
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau': 'return require("@lib/tool")', '/project/.luaurc': config,
			['/project/' + target + '/tool.luau']: 'return 42' }));
		expect(graph.diagnostics).toEqual([]); expect(graph.edges[0]!.target).toBe('/project/' + target + '/tool.luau');
		expect(graph.configs[0]!.sourceSha256).toBe(createHash('sha256').update(config).digest('hex'));
	});
	it('inherits chained aliases from parents while folding every alias reference by case', async () => {
		const graph = await getSourceModuleGraph('/project/src/main.luau', host({
			'/project/src/main.luau': 'return require("@Pkg/tool")',
			'/project/src/.luaurc': '{"aliases":{"pkg":"@ROOT/sub"}}',
			'/project/.luaurc': '{"aliases":{"root":"library"}}', '/project/library/sub/tool.luau': 'return 1'
		}));
		expect(graph.diagnostics).toEqual([]); expect(graph.edges[0]!.target).toBe('/project/library/sub/tool.luau');
	});
	it.each(['{"aliases":{"lib":"@other","other":"@LIB"}}', '{"aliases":{"lib":"@lib/sub"}}'])('diagnoses alias cycles without treating them as executed module cycles: %s', async (config) => {
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau': 'return require("@lib")', '/project/.luaurc': config }));
		expect(graph.diagnostics).toHaveLength(1); expect(graph.diagnostics[0]!.message).toContain('Circular source alias');
	});
	it.each(['{"aliases":{"lib":"a","lib":"b"}}', '{"aliases":{"lib":"a","LIB":"b"}}', '{"aliases":{"lib":"a"},"aliases":{"other":"b"}}', '{"aliases":{".":"a"}}', '{"aliases":{"..":"a"}}', '{"aliases":{"lib":"a",,}}', '{/* unfinished'])('rejects ambiguous or malformed JSONC data without recovering an alias map: %s', async (config) => {
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau': 'return require("@lib")', '/project/.luaurc': config }));
		expect(graph.diagnostics).toHaveLength(1); expect(graph.diagnostics[0]!.code).toBe('module-resolution');
	});
	it('reports executable config support and conflicting formats without executing or ignoring the config', async () => {
		const files: Record<string, string> = { '/project/main.luau': 'return require("@lib")', '/project/.config.luau': 'error("must never execute")' };
		const unsupported = await getSourceModuleGraph('/project/main.luau', host(files));
		expect(unsupported.diagnostics[0]!.message).toContain('Executable .config.luau is unsupported'); expect(unsupported.configs[0]!.file).toBe('/project/.config.luau');
		files['/project/.luaurc'] = '{"aliases":{"lib":"a"}}';
		const conflicting = await getSourceModuleGraph('/project/main.luau', host(files));
		expect(conflicting.diagnostics[0]!.message).toContain('Ambiguous source configuration'); expect(conflicting.configs).toHaveLength(2);
	});
	it('bounds alias-chain depth independently of source dependency depth', async () => {
		const aliases: Record<string, string> = {};
		for (let index = 0; index < 65; index++) aliases['a' + index] = index === 64 ? 'library' : '@a' + (index + 1);
		const files = { '/project/main.luau': 'return require("@a0/tool")', '/project/.luaurc': JSON.stringify({ aliases }), '/project/library/tool.luau': 'return 1' };
		const bounded = await getSourceModuleGraph('/project/main.luau', host(files)); expect(bounded.diagnostics[0]!.message).toContain('64 declarations');
		files['/project/main.luau'] = 'return require("@a1/tool")'; const within = await getSourceModuleGraph('/project/main.luau', host(files)); expect(within.diagnostics).toEqual([]);
	});
	it.each([
		['depth 64', '{"extra":' + '['.repeat(65) + '1' + ']'.repeat(65) + '}'],
		['depth 64', '}'.repeat(80) + '['.repeat(65) + '1' + ']'.repeat(65)],
		['1048576 bytes', '{"extra":"' + 'x'.repeat(1024 * 1024) + '"}'],
		['65536 tokens', '{"extra":[' + Array.from({ length: 33000 }, () => '1').join(',') + ']}'],
		['4096 aliases', JSON.stringify({ aliases: Object.fromEntries(Array.from({ length: 4097 }, (_, index) => ['a' + index, './lib'])) })]
	])('bounds config parsing before constructing an unbounded tree: %s', async (limit, config) => {
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau': 'return require("@lib")', '/project/.luaurc': config }));
		expect(graph.diagnostics).toHaveLength(1); expect(graph.diagnostics[0]!.message).toContain(limit);
	});
	it('reports missing files, dynamic calls, invalid arguments, absolute paths and reserved/traversing aliases at source locations', async () => {
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau':
			'-- 😀\nrequire("missing")\nrequire(variable)\nrequire("two", 2)\nrequire("/absolute")\nrequire("@sl-system/x")\nrequire("@lib/../outside")' }));
		expect(graph.diagnostics.map((item) => [item.code, item.range.start.line])).toEqual([
			['module-resolution', 1], ['module-dynamic-require', 2], ['module-dynamic-require', 3], ['module-resolution', 4], ['module-resolution', 5], ['module-resolution', 6]
		]);
	});
	it('preserves parse errors and refuses to inspect a recovery AST as a valid dependency graph', async () => {
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau': 'local = require("missing")' }));
		expect(graph.diagnostics.some((item) => item.code === 'parse-error')).toBe(true); expect(graph.edges).toEqual([]);
	});
	it('diagnoses cycles and a configurable source depth without executing recursive modules', async () => {
		const files = { '/project/main.luau': 'return require("a")', '/project/a.luau': 'return require("b")', '/project/b.luau': 'return require("a")' };
		expect((await getSourceModuleGraph('/project/main.luau', host(files))).diagnostics.some((item) => item.code === 'module-cycle')).toBe(true);
		expect((await getSourceModuleGraph('/project/main.luau', { ...host(files), maxDepth: 1 })).diagnostics.map((item) => item.code)).toEqual(['module-depth']);
		await expect(getSourceModuleGraph('/project/main.luau', { maxDepth: 0 })).rejects.toThrow('1 to 50');
	});
	it('does not overlook excessive depth through a dependency already reached by a shorter path', async () => {
		const graph = await getSourceModuleGraph('/project/main.luau', { maxDepth: 3, ...host({
			'/project/main.luau': 'require("shared")\nrequire("a")', '/project/shared.luau': 'require("leaf")', '/project/leaf.luau': 'return {}',
			'/project/a.luau': 'require("b")', '/project/b.luau': 'require("shared")'
		}) });
		expect(graph.diagnostics.filter((item) => item.code === 'module-depth').map((item) => item.file)).toEqual(['/project/shared.luau']);
	});
	it('takes one consistent source/config snapshot per request and re-reads changes on the next request', async () => {
		let source = 'return 1'; const counts = new Map<string, number>();
		const options = { entryText: 'return require("a"), require("a")', readFile: async (file: string) => {
			counts.set(file, (counts.get(file) ?? 0) + 1); return file === '/project/a.luau' ? source : undefined;
		} };
		const first = await getSourceModuleGraph('/project/main.luau', options); expect(counts.get('/project/a.luau')).toBe(1);
		source = 'return 2'; const second = await getSourceModuleGraph('/project/main.luau', options);
		expect(second.modules[1]!.sourceSha256).not.toBe(first.modules[1]!.sourceSha256); expect(counts.get('/project/main.luau')).toBeUndefined();
	});
	it.each(['[]', '{"aliases":[]}', '{"aliases":{"lib":3}}', '{"aliases":{"lib":"@other"}}', '{"aliases":{"lib":"a","LIB":"b"}}', '{ broken'])('reports malformed or unsupported config without guessing: %s', async (config) => {
		const graph = await getSourceModuleGraph('/project/main.luau', host({ '/project/main.luau': 'return require("@lib")', '/project/.luaurc': config }));
		expect(graph.diagnostics).toHaveLength(1); expect(graph.diagnostics[0]!.code).toBe('module-resolution');
	});
	it('bounds source size for custom hosts and represents missing entries as diagnostics', async () => {
		const oversized = await getSourceModuleGraph('/project/main.luau', { entryText: ' '.repeat(8 * 1024 * 1024 + 1) });
		expect(oversized.diagnostics[0]!.code).toBe('module-input');
		expect((await getSourceModuleGraph('/project/main.luau', host({}))).diagnostics[0]!.message).toContain('not found');
	});
	it('reads ordinary UTF-8 sources, ignores absent/directories, rejects binary and malformed UTF-8', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-module-')); temporary.push(dir);
		await fs.writeFile(path.join(dir, 'valid'), 'return "😀"'); expect(await readSourceModuleFile(path.join(dir, 'valid'))).toBe('return "😀"');
		expect(await readSourceModuleFile(path.join(dir, 'missing'))).toBeUndefined(); expect(await readSourceModuleFile(dir)).toBeUndefined();
		await fs.writeFile(path.join(dir, 'binary'), Buffer.from([0, 1, 2])); await expect(readSourceModuleFile(path.join(dir, 'binary'))).rejects.toThrow('Binary');
		await fs.writeFile(path.join(dir, 'invalid'), Buffer.from([0xff])); await expect(readSourceModuleFile(path.join(dir, 'invalid'))).rejects.toThrow();
	});
});
