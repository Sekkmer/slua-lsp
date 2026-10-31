import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { run } from '../src/index.js';
import { getBundledLslDefinitionsYamlPath } from 'slua-lsp-core';

const tempDirs: string[] = [];

class BufferStream {
	text = '';

	write(chunk: string | Uint8Array): boolean {
		this.text += String(chunk);
		return true;
	}
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function invoke(args: string[], source?: string | Uint8Array) {
	const stdout = new BufferStream();
	const stderr = new BufferStream();
	async function* stdin() { if (source !== undefined) yield source; }
	const code = await run(['node', 'slua-lsp', ...args], {
		stdout: stdout as unknown as NodeJS.WritableStream,
		stderr: stderr as unknown as NodeJS.WritableStream,
		stdin: stdin()
	});
	return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('slua-lsp CLI', () => {
	it('uses an explicit macro context for ordinary file/stdin checks and source hover', async () => {
		const source = 'local count: number = __LINE__\nprint(count, __FILE__)';
		const file = await tempFile(source), context = await tempFile('{}');
		const flags = ['--preprocessor-context', context, '--warnings-as-errors', '--json'];
		const disk = await invoke(['check', file, ...flags]);
		expect(disk.code).toBe(0);
		expect(await invoke(['check', '-', '--stdin-filepath', file, ...flags], source)).toEqual(disk);
		expect(JSON.parse(disk.stdout).contextSource.sha256).toBe(createHash('sha256').update('{}').digest('hex'));
		const hover = await invoke(['hover', file, '--position', '1:16', '--preprocessor-context', context, '--json']);
		expect(hover.code).toBe(0); expect(JSON.parse(hover.stdout).result.markdown).toContain(file);
		expect((await invoke(['check', file, '--warnings-as-errors', '--json'])).code).toBe(1);
	});
	it('reports missing macro data and refuses invalid context before checking a file', async () => {
		const file = await tempFile('print(__AGENTID__)'), context = await tempFile('{}');
		const missing = await invoke(['check', file, '--preprocessor-context', context, '--json']);
		expect(missing.code).toBe(1); expect(JSON.parse(missing.stdout).diagnostics.map((d: { code: string }) => d.code)).toEqual(['preprocessor-context']);
		const invalid = await tempFile('{"agentId":"bad"}');
		const rejected = await invoke(['check', '/missing-source-for-context-test.luau', '--preprocessor-context', invalid, '--json']);
		expect(rejected.code).toBe(2); expect(JSON.parse(rejected.stdout).error.code).toBe('preprocessor-context');
	});
	it.each(['\n', '\r', '\r\n'])('resolves source positions and hashes consistently for %j file/stdin newlines', async (eol) => {
		const source = ['-- header', 'local value=42', 'print(value)'].join(eol), file = await tempFile(source);
		for (const command of ['definition', 'references', 'hover', 'rename']) {
			const flags = ['--position', '2:8', ...(command === 'rename' ? ['--new-name', 'other'] : [])];
			const disk = await invoke([command, file, '--json', ...flags]);
			const stdin = await invoke([command, '-', '--stdin-filepath', file, '--json', ...flags], source);
			expect(disk.code).toBe(0); expect(stdin).toEqual(disk);
			expect(JSON.parse(disk.stdout).sourceSha256).toBe(createHash('sha256').update(await fs.readFile(file)).digest('hex'));
		}
	});
	it('maps a hash-bound generated position back to an imported source for agents', async () => {
		const main = await tempFile('print(require("helper"))'), helper = path.join(path.dirname(main), 'helper.luau');
		await fs.writeFile(helper, '-- 😀\r\nreturn 42');
		const first = JSON.parse((await invoke(['preprocess', main])).stdout);
		const before = first.content.slice(0, first.content.indexOf('42')), point = `${before.split('\n').length - 1}:${before.length - before.lastIndexOf('\n') - 1}`;
		const mapped = await invoke(['preprocess', main, '--generated-position', point, '--generated-sha256', first.contentSha256]);
		expect(mapped.code).toBe(0); expect(JSON.parse(mapped.stdout).mappedSource).toEqual({ status: 'mapped', file: helper, position: { line: 1, character: 7 }, sourceSha256: createHash('sha256').update(await fs.readFile(helper)).digest('hex') });
		await fs.writeFile(helper, 'return 43');
		const changed = await invoke(['preprocess', main, '--generated-position', point, '--generated-sha256', first.contentSha256]);
		expect(changed.code).toBe(1); expect(JSON.parse(changed.stdout).mappedSource.status).toBe('generated-changed');
	});
	it('maps fresh stdin snapshots without consulting an unrelated disk entry and refuses unmapped positions', async () => {
		const main = await tempFile('print("disk")'), source = 'print("unsaved")';
		const first = JSON.parse((await invoke(['preprocess', '-', '--stdin-filepath', main], source)).stdout);
		const args = ['preprocess', '-', '--stdin-filepath', main, '--generated-position', '0:7', '--generated-sha256', first.contentSha256];
		const mapped = await invoke(args, source); expect(mapped.code).toBe(0);
		expect(JSON.parse(mapped.stdout).mappedSource).toEqual({ status: 'mapped', file: main, position: { line: 0, character: 7 }, sourceSha256: createHash('sha256').update(source).digest('hex') });
		const outside = await invoke(args.map((arg) => arg === '0:7' ? '99:0' : arg), source);
		expect(outside.code).toBe(1); expect(JSON.parse(outside.stdout).mappedSource.status).toBe('unmapped');
	});
	it.each([
		['preprocess', '-', '--generated-position', '0:0'], ['preprocess', '-', '--generated-sha256', '0'.repeat(64)],
		['preprocess', '-', '--generated-position', 'x:0', '--generated-sha256', '0'.repeat(64)],
		['preprocess', '-', '--generated-position', '0:0', '--generated-sha256', 'not-a-hash'],
		['modules', '-', '--generated-position', '0:0', '--generated-sha256', '0'.repeat(64)]
	])('rejects incomplete or invalid generated mapping requests as JSON usage errors: %j', async (...args) => {
		const result = await invoke(args); expect(result.code).toBe(2); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout).error.code).toBe('usage');
	});
	it.each(['modules', 'preprocess'])('always emits JSON for %s usage and stdin decoding failures without a format flag', async (command) => {
		for (const args of [[command], [command, '--unknown'], [command, '-', '--max-module-depth', '0']]) {
			const result = await invoke(args); expect(result.code).toBe(2); expect(result.stderr).toBe('');
			expect(JSON.parse(result.stdout).error.code).toBe('usage');
		}
		const invalid = await invoke([command, '-'], new Uint8Array([0xff]));
		expect(invalid.code).toBe(2); expect(invalid.stderr).toBe(''); expect(JSON.parse(invalid.stdout).exitCode).toBe(2);
	});
	it.each(['check', 'symbols', 'hover', 'definition', 'references', 'rename'])('rejects malformed on-disk UTF-8 before %s analysis', async (command) => {
		const file = await tempFile(''); await fs.writeFile(file, Buffer.from([112, 114, 105, 110, 116, 40, 34, 255, 34, 41]));
		const args = [command, file, '--json'];
		if (['hover', 'definition', 'references', 'rename'].includes(command)) args.push('--position', '0:1');
		if (command === 'rename') args.push('--new-name', 'other');
		const result = await invoke(args); expect(result.code).toBe(2); expect(result.stderr).toBe('');
		expect(JSON.parse(result.stdout).error.message).toContain('utf-8');
	});
	it.each(['check', 'symbols', 'hover'])('bounds ordinary %s file input before parsing', async (command) => {
		const file = await tempFile(''); await fs.truncate(file, 8 * 1024 * 1024 + 1);
		const result = await invoke([command, file, '--json', ...(command === 'hover' ? ['--position', '0:0'] : [])]);
		expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.message).toContain('8388608');
	});
	it('preserves a leading BOM identically across disk and stdin, including graph hashes and syntax refusal', async () => {
		const text = '\ufeffprint("owned")', file = await tempFile(text);
		for (const command of ['check', 'modules', 'preprocess']) {
			const disk = await invoke([command, file, '--json']);
			const stdin = await invoke([command, '-', '--stdin-filepath', file, '--json'], Buffer.from(text));
			expect(disk.code).toBe(1); expect(stdin).toEqual(disk);
			if (command !== 'check') {
				const out = JSON.parse(disk.stdout), graph = out.graph ?? out;
				expect(graph.modules[0].sourceSha256).toBe(createHash('sha256').update(await fs.readFile(file)).digest('hex'));
			}
		}
	});
	it.each([Buffer.from([0]), '\ud800'])('refuses binary or malformed Unicode stdin before source hashing: %j', async (source) => {
		const result = await invoke(['check', '-', '--json'], source);
		expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error).toBeDefined();
	});
	it('bounds stdin before parsing or retaining oversized agent input', async () => {
		const result = await invoke(['preprocess', '-', '--json'], ' '.repeat(8 * 1024 * 1024 + 1));
		expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe('input');
	});
	it('refuses malformed UTF-8 stdin without hashing replacement characters as source', async () => {
		const result = await invoke(['preprocess', '-', '--json'], new Uint8Array([0xff]));
		expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error).toBeDefined();
	});
	it('generates agent JSON without definitions/network and binds source and context hashes', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-preprocess-cli-')); tempDirs.push(dir);
		const main = path.join(dir, 'main.luau'), module = path.join(dir, 'helper.luau'), context = path.join(dir, 'context.json');
		await fs.writeFile(main, 'print(require("helper"))'); await fs.writeFile(module, 'return __LINE__'); await fs.writeFile(context, '{}');
		vi.stubEnv('SLUA_LSP_DEFS_PATH', path.join(dir, 'does-not-exist.yaml'));
		const result = await invoke(['preprocess', main, '--preprocessor-context', context]);
		expect(result.code).toBe(0); expect(result.stderr).toBe('');
		const data = JSON.parse(result.stdout); expect(data.schema).toBe('slua-lsp.cli.v1'); expect(data.command).toBe('preprocess');
		expect(data.contentSha256).toBe(createHash('sha256').update(data.content).digest('hex'));
		expect(data.contextSource.sha256).toBe(createHash('sha256').update('{}').digest('hex')); expect(data.moduleIds).toEqual([{ file: module, id: 1 }]);
		expect(data.graph.modules[1].sourceSha256).toBe(createHash('sha256').update('return __LINE__').digest('hex'));
		expect(await fs.readFile(module, 'utf8')).toBe('return __LINE__');
	});
	it('generates stdin relative to its filename and refuses dynamic calls without partial source', async () => {
		const result = await invoke(['preprocess', '-', '--stdin-filepath', 'scratch.luau'], 'local function require(x) return x end\nprint(require("value"))');
		expect(result.code).toBe(0); expect(JSON.parse(result.stdout).content).toContain('print(require("value"))');
		const failure = await invoke(['preprocess', '-'], 'return require(variable)');
		expect(failure.code).toBe(1); const data = JSON.parse(failure.stdout);
		expect(data.content).toBeNull(); expect(data.diagnostics[0].code).toBe('module-dynamic-require');
	});
	it('reports invalid context as an operational error and supports recovery on the next invocation', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-preprocess-context-')); tempDirs.push(dir);
		const context = path.join(dir, 'context.json'); await fs.writeFile(context, '{"agentId":"invalid"}');
		const args = ['preprocess', '-', '--preprocessor-context', context, '--json'];
		expect((await invoke(args, 'print(__AGENTID__)')).code).toBe(2);
		await fs.writeFile(context, '{}'); const repaired = await invoke(args, 'print(__LINE__)');
		expect(repaired.code).toBe(0); expect(JSON.parse(repaired.stdout).content).toBe('print(1)');
	});
	it.each([['preprocess'], ['preprocess', 'a', 'b'], ['preprocess', '-', '--auto-update-defs'], ['check', '-', '--preprocessor-context', 'context.json']])('rejects preprocessor usage mistakes: %j', async (...args) => {
		expect((await invoke([...args, '--json'])).code).toBe(2);
	});
	it('checks imported source and module return types through the ordinary agent check command', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-project-check-')); tempDirs.push(dir);
		const main = path.join(dir, 'main.luau'); await fs.writeFile(main, 'local api = require("api")\napi.double("wrong")');
		const api = path.join(dir, 'api.luau'); await fs.writeFile(api, 'local value: number = "wrong"\nreturn {double = function(n: number): number return n * 2 end, count = value}');
		const result = await invoke(['check', main, '--json', '--include-actions', '--warnings-as-errors']); expect(result.code).toBe(1);
		const data = JSON.parse(result.stdout); expect(data.summary.files).toBe(2);
		expect(data.diagnostics.map((item: { code: string }) => item.code).sort()).toEqual(['assignment-type-mismatch', 'call-argument-type-mismatch']);
		expect(data.diagnostics.find((item: { code: string }) => item.code === 'assignment-type-mismatch').file).toBe(api);
		expect(data.actions.find((item: { file: string }) => item.file === api).sourceSha256).toBe(createHash('sha256').update(await fs.readFile(api)).digest('hex'));
	});
	it('reports missing dependencies during ordinary stdin checks instead of an undeclared require warning', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-project-missing-')); tempDirs.push(dir);
		const result = await invoke(['check', '-', '--stdin-filepath', path.join(dir, 'main.luau'), '--json'], 'return require("missing")');
		expect(result.code).toBe(1); expect(JSON.parse(result.stdout).diagnostics.map((item: { code: string }) => item.code)).toEqual(['module-resolution']);
	});
	it('inspects relative source dependencies with hashed agent JSON and never executes their bodies', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-modules-cli-')); tempDirs.push(dir);
		const entry = path.join(dir, 'main.luau'); await fs.writeFile(entry, 'return require("helper")');
		const module = 'error("must never execute")'; await fs.writeFile(path.join(dir, 'helper.luau'), module);
		const result = await invoke(['modules', entry, '--json']); expect(result.code).toBe(0);
		const graph = JSON.parse(result.stdout); expect(graph.schema).toBe('slua-lsp.cli.v1'); expect(graph.command).toBe('modules');
		expect(graph.edges[0].target).toBe(path.join(dir, 'helper.luau')); expect(graph.modules[1].sourceSha256).toBe(createHash('sha256').update(module).digest('hex'));
	});
	it('resolves stdin module paths relative to the supplied filename and returns diagnostic exit 1 for missing modules', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-modules-stdin-')); tempDirs.push(dir);
		await fs.writeFile(path.join(dir, 'helper.lua'), 'return {}');
		const args = ['modules', '-', '--stdin-filepath', path.join(dir, 'main.luau')];
		expect((await invoke(args, 'return require("helper")')).code).toBe(0);
		const missing = await invoke(args, 'return require("missing")'); expect(missing.code).toBe(1); expect(JSON.parse(missing.stdout).diagnostics[0].code).toBe('module-resolution');
	});
	it.each([['modules'], ['modules', 'one', 'two'], ['modules', '-', '--max-module-depth', '0'], ['modules', '-', '--max-module-depth', '51'], ['symbols', '-', '--max-module-depth', '2'], ['modules', '-', '--auto-update-defs']])('rejects module usage mistakes without network activity: %j', async (...args) => {
		const result = await invoke([...args, '--json']); expect(result.code).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe('usage');
	});
	it('checks conditional binding scopes and proposes only the branch-local rename for agents', async () => {
		const source = 'local value="outer"\nif const value=42 then\nmath.abs(value)\nelse\nprint(value)\nend';
		expect((await invoke(['check', '-', '--warnings-as-errors', '--json'], source)).code).toBe(0);
		const hover = JSON.parse((await invoke(['hover', '-', '--position', '2:10', '--json'], source)).stdout);
		expect(hover.result.markdown).toContain('const value: number');
		const renamed = JSON.parse((await invoke(['rename', '-', '--position', '2:10', '--new-name', 'bound', '--json'], source)).stdout);
		expect(renamed.result).toHaveLength(2);
		expect(renamed.result.map((edit: { range: { start: { line: number } } }) => edit.range.start.line)).toEqual([1, 2]);
	});
	it('checks and inspects native const bindings without treating table fields as immutable', async () => {
		const source = 'const count: number = 1\nconst values = {count = count}\nvalues.count += 1\nprint(count, values)';
		expect((await invoke(['check', '-', '--json', '--warnings-as-errors'], source)).code).toBe(0);
		const hover = JSON.parse((await invoke(['hover', '-', '--position', '3:8', '--json'], source)).stdout);
		expect(hover.result.readonly).toBe(true); expect(hover.result.markdown).toContain('const count: number');
		const symbols = JSON.parse((await invoke(['symbols', '-', '--json'], source)).stdout);
		expect(symbols.result[0]).toMatchObject({ name: 'count', detail: 'const number' });
		const renamed = JSON.parse((await invoke(['rename', '-', '--position', '3:8', '--new-name', 'total', '--json'], source)).stdout);
		expect(renamed.result).toHaveLength(3);
	});
	it('returns unsuppressible parse errors for native const reassignments and refuses unsafe rename', async () => {
		const source = 'const count = 1\n-- slua-lsp:disable all\ncount += 1';
		const checked = await invoke(['check', '-', '--json'], source); expect(checked.code).toBe(1);
		expect(JSON.parse(checked.stdout).diagnostics).toContainEqual(expect.objectContaining({ code: 'parse-error', message: expect.stringContaining('constant and may not be reassigned') }));
		const renamed = await invoke(['rename', '-', '--position', '0:8', '--new-name', 'total', '--json'], source);
		expect(renamed.code).toBe(1); expect(JSON.parse(renamed.stdout).status).toBe('parse-error');
	});
	it('returns source local and builtin hover through the shared agent JSON contract', async () => {
		const source = 'local count = 1\nprint(count)';
		const result = await invoke(['hover', '-', '--position', '1:8', '--json'], source);
		expect(result.code).toBe(0);
		const data = JSON.parse(result.stdout);
		expect(data.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
		expect(data.result.kind).toBe('local');
		expect(data.result.markdown).toContain('count: number');
		expect(data.result.range.start).toEqual({ line: 1, character: 6 });
		const builtin = JSON.parse((await invoke(['hover', '-', '--position', '1:2', '--json'], source)).stdout);
		expect(builtin.result.kind).toBe('builtin');
		expect(builtin.result.markdown).toContain('print');
	});
	it('checks interpolation as one string value for agent stdin and rejects native-invalid shorthand', async () => {
		const source = 'local message=`{42}`\nmath.abs(message)';
		const checked = await invoke(['check', '-', '--json', '--warnings-as-errors'], source);
		expect(checked.code).toBe(1);
		expect(JSON.parse(checked.stdout).diagnostics.map((d: { code: string }) => d.code)).toEqual(['call-argument-type-mismatch']);
		const invalid = await invoke(['symbols', '-', '--json'], 'print`text`');
		expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stdout).status).toBe('parse-error');
	});
	it('provides hashed navigation JSON for nested interpolations containing literal closing braces', async () => {
		const source = 'local value=42\nprint(`outer {`inner {value} {"}"}`} end`)';
		const position = `1:${source.split('\n')[1]!.indexOf('value') + 2}`;
		for (const command of ['definition', 'references', 'rename', 'hover']) {
			const args = [command, '-', '--position', position, '--json', ...(command === 'rename' ? ['--new-name', 'changed'] : [])];
			const found = await invoke(args, source); expect(found.code).toBe(0);
			expect(JSON.parse(found.stdout).sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
		}
	});
	it('checks escaped library names and raw malformed escapes for agent stdin without changing source hashes', async () => {
		const source = 'math["\\x61bs"]("bad")';
		const checked = await invoke(['check', '-', '--json', '--warnings-as-errors'], source);
		expect(checked.code).toBe(1);
		expect(JSON.parse(checked.stdout).diagnostics.map((d: { code: string }) => d.code)).toEqual(['call-argument-type-mismatch']);
		const malformed = await invoke(['symbols', '-', '--json'], 'local value="\\xGG"');
		expect(malformed.code).toBe(1);
		expect(JSON.parse(malformed.stdout).status).toBe('parse-error');
	});
	it('resolves escaped literal module paths in JSON and preserves the original source hash', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-escaped-path-')); tempDirs.push(dir);
		await fs.writeFile(path.join(dir, 'mod.luau'), 'return 42');
		const source = 'print(require("\\x6dod"))', file = path.join(dir, 'main.luau');
		const checked = await invoke(['modules', '-', '--stdin-filepath', file, '--json'], source);
		expect(checked.code).toBe(0);
		const result = JSON.parse(checked.stdout);
		expect(result.edges[0]).toMatchObject({ specifier: 'mod', target: path.join(dir, 'mod.luau') });
		expect(result.modules[0].sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
	});
	it('lists hierarchical symbols from stdin, without inventing declarations in text', async () => {
		const source = 'local count = 1\nlocal handler = function(value)\nlocal result = value\nreturn result\nend\n-- local fake = 1';
		const result = await invoke(['symbols', '-', '--stdin-filepath', 'outline.luau', '--json'], source);
		expect(result.code).toBe(0);
		const data = JSON.parse(result.stdout);
		expect(data.file).toBe('outline.luau');
		expect(data.result.map((item: { name: string }) => item.name)).toEqual(['count', 'handler']);
		expect(data.result[1].children[0].name).toBe('result');
		expect(data.position).toBeUndefined();
		expect(data.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
	});
	it('treats empty outlines as success and absent or invalid hover results as exit 1', async () => {
		const empty = await invoke(['symbols', '-', '--json'], '-- empty');
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.stdout).result).toEqual([]);
		const missing = await invoke(['hover', '-', '--position', '0:8', '--json'], 'print("count")');
		expect(missing.code).toBe(1);
		expect(JSON.parse(missing.stdout).status).toBe('not-found');
		const invalid = await invoke(['symbols', '-', '--json'], 'local value = 1\nlocal =');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout)).toMatchObject({ status: 'parse-error', result: null });
	});
	it('validates inspection arguments and advertises machine-discoverable capabilities', async () => {
		for (const args of [['symbols'], ['symbols', '-', '--position', '0:0'], ['hover', '-'], ['symbols', '-', '--exclude-declaration']]) {
			const result = await invoke([...args, '--json'], 'local count = 1');
			expect(result.code).toBe(2);
			expect(JSON.parse(result.stdout).error.code).toBe('usage');
		}
		const data = JSON.parse((await invoke(['capabilities'])).stdout);
		expect(data.commands).toEqual(expect.arrayContaining(['hover', 'symbols']));
		expect(data.inspection).toMatchObject({ commands: ['hover', 'symbols'], automaticApplication: false, sourceHash: 'sha256' });
	});
	it('provides hashed, zero-based definition and reference JSON for stdin', async () => {
		const source = 'local count = 0\r\ncount += 1\r\nprint("😀", count)';
		const args = ['-', '--position', '1:0', '--stdin-filepath', 'scratch.luau', '--json'];
		const definition = await invoke(['definition', ...args], source);
		expect(definition.code).toBe(0);
		const data = JSON.parse(definition.stdout);
		expect(data.schema).toBe('slua-lsp.cli.v1');
		expect(data.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
		expect(data.result).toEqual({ file: 'scratch.luau', name: 'count', kind: 'local', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } });
		const refs = JSON.parse((await invoke(['references', ...args], source)).stdout);
		expect(refs.result).toHaveLength(3);
		expect(refs.result[2].range.start).toEqual({ line: 2, character: 12 });
		expect(JSON.parse((await invoke(['references', ...args, '--exclude-declaration'], source)).stdout).result).toHaveLength(2);
	});
	it('proposes rename edits without altering an actual input file or same-named fields', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cli-navigation-')); tempDirs.push(dir);
		const file = path.join(dir, 'file with spaces.luau');
		const source = 'local value = 1\nlocal obj = {value = value}\nprint(obj.value, value)';
		await fs.writeFile(file, source);
		const output = await invoke(['rename', file, '--position=0:6', '--new-name=total', '--json']);
		expect(output.code).toBe(0);
		const data = JSON.parse(output.stdout);
		expect(data.result).toHaveLength(3);
		expect(data.result.every((edit: { newText: string }) => edit.newText === 'total')).toBe(true);
		expect(await fs.readFile(file, 'utf8')).toBe(source);
	});
	it('rejects binding capture and reports unsupported symbols with diagnostic exit status', async () => {
		const source = 'local source = 1\ndo local target = 2; print(source, target) end';
		const conflict = await invoke(['rename', '-', '--position', '0:6', '--new-name', 'target', '--json'], source);
		expect(conflict.code).toBe(1);
		expect(JSON.parse(conflict.stdout)).toMatchObject({ status: 'binding-conflict', result: [], exitCode: 1 });
		const missing = await invoke(['definition', '-', '--position', '0:0', '--json'], 'print(1)');
		expect(missing.code).toBe(1);
		expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'not-found', result: null, exitCode: 1 });
	});
	it('never proposes navigation edits from a recovered parse-error buffer', async () => {
		const output = await invoke(['rename', '-', '--position', '0:6', '--new-name', 'total', '--json'], 'local value = 1\nlocal =');
		expect(output.code).toBe(1);
		const data = JSON.parse(output.stdout);
		expect(data.status).toBe('parse-error');
		expect(data.result).toBeNull();
		expect(data.diagnostics.length).toBeGreaterThan(0);
	});
	it('validates navigation arguments and cursor bounds with structured operational errors', async () => {
		for (const args of [
			['definition', '-'], ['references', '-', '--position', '-1:0'],
			['definition', '-', '--position', '9007199254740992:0'], ['definition', '-', '--position', '0:99'],
			['rename', '-', '--position', '0:6'], ['rename', '-', '--position', '0:6', '--new-name', 'end'],
			['check', '-', '--position', '0:0'], ['definition', '-', '--position', '0:0', '--exclude-declaration'],
			['check', '-', '--new-name', 'value']
		]) {
			const output = await invoke([...args, '--json'], 'local value = 1');
			expect(output.code).toBe(2);
			expect(JSON.parse(output.stdout).error.code).toMatch(/usage|position/);
		}
	});
	it('advertises the scope and read-only navigation contract to agents', async () => {
		const data = JSON.parse((await invoke(['capabilities'])).stdout);
		expect(data.commands).toEqual(expect.arrayContaining(['definition', 'references', 'rename']));
		expect(data.navigation).toMatchObject({ automaticApplication: false, sourceHash: 'sha256', renameRejectsBindingCapture: true });
		expect(data.navigation.unsupported).toContain('cross-file symbol index/references/rename');
	});
	it('exposes global constants and private metadata while rejecting removed state events and booleans', async () => {
		expect((await invoke(['check', '-', '--json', '--warnings-as-errors'], 'print(ALL_SIDES)\nfunction timer() end\nLLEvents:on("timer", timer)')).code).toBe(0);
		const output = JSON.parse((await invoke(['lookup', 'ALL_SIDES', '--json'])).stdout);
		expect(output.signature).toBe('number');
		expect(JSON.parse((await invoke(['lookup', 'll.ClearExperience', '--json'])).stdout).definition.private).toBe(true);
		const bad = await invoke(['check', '-', '--json'], 'print(ll.TRUE)\nLLEvents:on("state_exit", function() end)');
		expect(bad.code).toBe(1);
		expect(JSON.parse(bad.stdout).diagnostics.map((diagnostic: {code: string}) => diagnostic.code).sort()).toEqual(['removed-ll-constant', 'unknown-event']);
	});

	it('distinguishes compatibility declarations and mutable user tables from removed ordinary APIs', async () => {
		const valid = 'llcompat.SetTimerEvent(1)\nllcompat.ResetTime()\nlocal ll = {}\nll.ResetTime()';
		expect((await invoke(['check', '-', '--json', '--warnings-as-errors'], valid)).code).toBe(0);
		const invalid = await invoke(['check', '-', '--json'], 'local api = ll\napi.ResetTime()\napi["SetTimerEvent"](1)');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout).diagnostics.map((d: { code: string }) => d.code)).toEqual(['removed-ll-api', 'legacy-timer-api']);
		expect(JSON.parse((await invoke(['lookup', 'llcompat.GetAndResetTime', '--json'])).stdout).signature).toBe('() -> number');
	});

	it('reports typed array keys and element writes with agent JSON ranges', async () => {
		const valid = 'local values: {number} = {1}\nlocal index = 1\nvalues[index] = 2\nprint(values[index + 1])';
		expect((await invoke(['check', '-', '--json', '--warnings-as-errors'], valid)).code).toBe(0);
		const bad = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'local values: {number} = {1}\nvalues[false] = 2\nvalues[1] = "bad"\nprint(values)');
		expect(bad.code).toBe(1);
		const diagnostics = JSON.parse(bad.stdout).diagnostics;
		expect(diagnostics.map((d: { code: string }) => d.code)).toEqual(['array-index-type-mismatch', 'assignment-type-mismatch']);
		expect(diagnostics[0].range).toEqual({ start: { line: 1, character: 7 }, end: { line: 1, character: 12 } });
	});

	it('checks SLua profile flags and inferred detected-event callbacks for agents', async () => {
		const valid = 'local active: boolean = ll.GetStatus(1)\nlocal legacy: number = llcompat.GetStatus(1)\nll.SetStatus(1, true)\nprint(active, legacy)\nLLEvents:on("touch_start", function(items)\n local item = items[1]\n local same: boolean = item:getGroup()\n local damage: table = item:getDamage()\n print(same, damage)\nend)';
		expect((await invoke(['check', '-', '--json', '--warnings-as-errors'], valid)).code).toBe(0);
		const bad = await invoke(['check', '-', '--json', '--warnings-as-errors'], valid.replace('same: boolean', 'same: uuid'));
		expect(bad.code).toBe(1);
		expect(JSON.parse(bad.stdout).diagnostics.filter((d: { code: string }) => d.code === 'assignment-type-mismatch')).toHaveLength(1);
		expect(JSON.parse((await invoke(['lookup', 'DetectedEvent.getGroup', '--json'])).stdout).signature).toBe('() -> boolean');
		expect(JSON.parse((await invoke(['lookup', 'DetectedEvent.getDamage', '--json'])).stdout).signature).toBe('() -> table');
	});

	it('exposes current standard-library contracts to offline agents', async () => {
		const valid = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'local b = buffer.create(8)\nbuffer.writeu32(b, 0, 42)\nprint(string.sub("abc", 2), string.char(), math.random(), table.pack(), utf8.len("a"), buffer.readu32(b, 0))');
		expect(valid.code).toBe(0);
		const invalid = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'string.char(65, false)\nlocal n: number = tonumber("invalid")\nprint(n)');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout).diagnostics.map((d: { code: string }) => d.code).sort()).toEqual(['assignment-type-mismatch', 'call-argument-type-mismatch']);
		const signature = JSON.parse((await invoke(['lookup', 'string.char', '--json'])).stdout).signature;
		expect(signature).toBe('(...number) -> string');
	});

	it('checks readonly module aliases and callback writes without confusing mutable shadows', async () => {
		const valid = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'local math = {pi = 1}\nmath.pi = 2\nlocal function change(math) math.pi = 3 end\nchange(math)');
		expect(valid.code).toBe(0);
		const invalid = await invoke(['check', '-', '--json'], 'local native = math\nnative.pi = 0\nlocal callback = function(item: {read x: number}) item.x = 2 end\nprint(callback)');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout).diagnostics.filter((d: { code: string }) => d.code === 'readonly-write')).toHaveLength(2);
	});

	it('returns agent-applicable edits with an exact source hash without changing input', async () => {
		const source = 'local json = lljson\njson:encode(3)';
		const result = await invoke(['check', '-', '--json', '--include-actions'], source);
		const output = JSON.parse(result.stdout);
		expect(result.code).toBe(1);
		const fix = output.actions.find((action: { isPreferred: boolean }) => action.isPreferred);
		expect(fix.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(fix.file).toBe('<stdin>.luau');
		expect(fix.edits).toEqual([{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, newText: '.' }]);
		const fixed = source.replace('json:encode', 'json.encode');
		expect((await invoke(['check', '-', '--json', '--include-actions'], fixed)).code).toBe(0);
		expect(JSON.parse((await invoke(['check', '-', '--json'], source)).stdout).actions).toBeUndefined();
	});

	it.each([['check', '-', '--include-actions'], ['lookup', 'integer', '--include-actions', '--json']])('rejects action options outside check JSON', async (...args) => {
		const result = await invoke(args, 'print(1)');
		expect(result.code).toBe(2);
	});

	it('does not suppress CLI diagnostics because a string contains a directive', async () => {
		const result = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'local text = "-- slua-lsp:disable all"\nprint(text)\nmissingSentinel()');
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).diagnostics.map((d: { code: string }) => d.code)).toContain('undeclared-name');
	});

	it('checks builtin aliases, explicit self and shadowed globals consistently for agents', async () => {
		const valid = await invoke(['check', '-', '--json', '--warnings-as-errors'], [
			'local events, timers = LLEvents, LLTimers',
			'events.on(LLEvents, "listen", function(channel: number) end)',
			'timers.once(LLTimers, 0, function(time: number, interval: nil) end)',
			'local LLTimers, LLEvents, lljson = {}, {}, {}',
			'LLTimers:custom(); LLEvents:on("not-an-event"); lljson.encode()'
		].join('\n'));
		expect(valid.code).toBe(0);
		const invalid = await invoke(['check', '-', '--json'], 'local events, timers = LLEvents, LLTimers\nevents:on("state_exit", function() end)\ntimers:once(0, function(time: string) end)');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout).diagnostics.map((d: { code: string }) => d.code).sort()).toEqual(['callback-param-type-mismatch', 'unknown-event']);
	});

	it('checks a valid file successfully', async () => {
		const file = await tempFile('local n = 1\nprint(n)\n');
		const stdout = new BufferStream();
		const stderr = new BufferStream();

		const code = await run(['node', 'slua-lsp', 'check', file], {
			stdout: stdout as unknown as NodeJS.WritableStream,
			stderr: stderr as unknown as NodeJS.WritableStream
		});

		expect(code).toBe(0);
		expect(stdout.text).toBe('');
		expect(stderr.text).toBe('');
	});

	it('reports parse diagnostics and exits non-zero', async () => {
		const file = await tempFile('local =\n');
		const stdout = new BufferStream();
		const stderr = new BufferStream();

		const code = await run(['node', 'slua-lsp', 'check', file], {
			stdout: stdout as unknown as NodeJS.WritableStream,
			stderr: stderr as unknown as NodeJS.WritableStream
		});

		expect(code).toBe(1);
		expect(stdout.text).toContain(`${file}:1:`);
		expect(stdout.text).toContain('error parse-error');
		expect(stderr.text).toBe('');
	});

	it('can emit JSON diagnostics', async () => {
		const file = await tempFile('local =\n');
		const stdout = new BufferStream();
		const stderr = new BufferStream();

		const code = await run(['node', 'slua-lsp', 'check', '--format', 'json', file], {
			stdout: stdout as unknown as NodeJS.WritableStream,
			stderr: stderr as unknown as NodeJS.WritableStream
		});

		expect(code).toBe(1);
		const parsed = JSON.parse(stdout.text) as { diagnostics: unknown[] };
		expect(parsed.diagnostics).toHaveLength(1);
		expect(stderr.text).toBe('');
	});
});

async function tempFile(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cli-'));
	tempDirs.push(dir);
	const file = path.join(dir, 'script.luau');
	await fs.writeFile(file, source, 'utf8');
	return file;
}

describe('agent-facing CLI contract', () => {

	it('discovers module exports and precise integer signatures without constructor aliases', async () => {
		const module = await invoke(['lookup', 'integer', '--json']);
		expect(module.code).toBe(0);
		const out = JSON.parse(module.stdout);
		expect(out.kind).toBe('module');
		expect(out.signature).toBe('table');
		expect(out.definition.functions.create).toBeDefined();
		expect(out.definition.values.maxsigned).toBeDefined();
		const band = await invoke(['lookup', 'integer.band', '--json']);
		expect(band.code).toBe(0);
		expect(JSON.parse(band.stdout).signature).toBe('(...integer) -> integer');
		const invalid = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'integer(1)\nnumber("1")');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout).diagnostics.map((d: { code: string }) => d.code)).toEqual(['call-non-callable', 'undeclared-name']);
	});
	it('discovers nested builder APIs and checks fluent code without an editor', async () => {
		const namespace = await invoke(['lookup', 'llprim.ParamSetter', '--json']);
		expect(namespace.code).toBe(0);
		expect(Object.keys(JSON.parse(namespace.stdout).definition.functions)).toHaveLength(53);
		const method = await invoke(['lookup', 'llprim.ParamSetter.size', '--json']);
		expect(method.code).toBe(0);
		expect(JSON.parse(method.stdout).signature).toContain('table, vector');
		const valid = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'local P = llprim.ParamSetter\nlocal rules = P.new():size(vector.one):physical(true)\nprint(rules)');
		expect(valid.code).toBe(0);
		const invalid = await invoke(['check', '-', '--json', '--warnings-as-errors'], 'local rules = llprim.ParamSetter.new()\nrules:size("bad")');
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout).diagnostics.some((d: { code: string }) => d.code === 'call-argument-type-mismatch')).toBe(true);
	});

	it('checks stdin noninteractively with a stable JSON schema and supplied filename', async () => {
		const result = await invoke(['check', '-', '--stdin-filepath', 'agent-buffer.luau', '--json'], 'local =\n');
		const out = JSON.parse(result.stdout);
		expect(result.code).toBe(1);
		expect(result.stderr).toBe('');
		expect(out.schema).toBe('slua-lsp.cli.v1');
		expect(out.summary.files).toBe(1);
		expect(out.diagnostics[0].file).toBe('agent-buffer.luau');
		expect(out.exitCode).toBe(1);
	});

	it('reports clean stdin in JSON without progress noise', async () => {
		const result = await invoke(['check', '-', '--json'], 'local value = 1\nprint(value)\n');
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
		expect(result.stderr).toBe('');
	});

	it('checks guarded nullable SLua results for agents and retains unsafe paths', async () => {
		const good = 'local index = ll.SubStringIndex("hello", "e")\nif index then print(math.abs(index)) end';
		const clean = await invoke(['check', '-', '--stdin-filepath', 'guard.luau', '--json', '--warnings-as-errors'], good);
		expect(clean.code).toBe(0);
		expect(JSON.parse(clean.stdout).diagnostics).toEqual([]);
		const bad = await invoke(['check', '-', '--stdin-filepath', 'guard.luau', '--json', '--warnings-as-errors'], good + '\nprint(math.abs(index))');
		expect(bad.code).toBe(1);
		expect(JSON.parse(bad.stdout).diagnostics.map((d: { code: string; range: { start: { line: number } } }) => [d.code, d.range.start.line])).toEqual([['call-argument-type-mismatch', 2]]);
		expect(bad.stderr).toBe('');
	});

	it('reports possible nil from an inferred function return to agent callers', async () => {
		const source = 'local function maybe(flag: boolean)\n if flag then return 1 end\nend\nlocal result = maybe(false)\nmath.abs(result)';
		const response = await invoke(['check', '-', '--json', '--warnings-as-errors'], source);
		expect(response.code).toBe(1);
		expect(response.stderr).toBe('');
		expect(JSON.parse(response.stdout).diagnostics.map((d: { code: string; range: { start: { line: number } } }) => [d.code, d.range.start.line])).toEqual([['missing-return', 0], ['call-argument-type-mismatch', 4]]);
		const guarded = await invoke(['check', '-', '--json', '--warnings-as-errors'], source.replace('maybe(flag: boolean)', 'maybe(flag: boolean): number?').replace('if flag then return 1 end', 'if flag then return 1 else return nil end').replace('math.abs(result)', 'if result then math.abs(result) end'));
		expect(guarded.code).toBe(0);
	});

	it('uses zero-based UTF-16 ranges after supplementary Unicode characters', async () => {
		const source = 'local greeting = "😀"; print(greeting, missing)\n';
		const result = await invoke(['check', '-', '--json'], source);
		const diagnostic = JSON.parse(result.stdout).diagnostics.find((d: { code: string }) => d.code === 'undeclared-name');
		expect(diagnostic.range.start).toEqual({ line: 0, character: source.indexOf('missing') });
		expect(diagnostic.range.end.character).toBe(source.indexOf('missing') + 'missing'.length);
	});

	it('only fails warning-only checks when strict warnings are requested', async () => {
		const source = 'missing()\n';
		const ordinary = await invoke(['check', '-', '--json'], source);
		const strict = await invoke(['check', '-', '--json', '--warnings-as-errors'], source);
		expect(JSON.parse(ordinary.stdout).summary.errors).toBe(0);
		expect(JSON.parse(ordinary.stdout).summary.warnings).toBeGreaterThan(0);
		expect(ordinary.code).toBe(0);
		expect(strict.code).toBe(1);
	});

	it('rejects auto-refresh with an environment definitions override before network access', async () => {
		vi.stubEnv('SLUA_LSP_DEFS_PATH', '/not-a-real-custom-definition-file.yaml');
		const result = await invoke(['check', '-', '--json', '--auto-update-defs', '--update-url', 'http://127.0.0.1:1'], 'print(1)');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('usage');
		expect(JSON.parse(result.stdout).error.message).toContain('SLUA_LSP_DEFS_PATH');
	});

	it('does not silently replace an explicit missing definitions path with the fallback', async () => {
		const file = await tempFile('print(1)');
		const result = await invoke(['check', file, '--defs', path.join(path.dirname(file), 'missing.yaml'), '--json']);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('operation-failed');
	});

	it('checks and dumps definitions offline when optional cache metadata is a directory', async () => {
		const file = await tempFile('ll.Say(0, "offline")');
		const cache = path.join(path.dirname(file), 'cache');
		await fs.mkdir(path.join(cache, 'lsl_definitions.metadata.json'), { recursive: true });
		const result = await invoke(['check', file, '--json', '--cache-dir', cache, '--warnings-as-errors']);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
		expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
		const dump = await invoke(['dump-defs', '--json', '--cache-dir', cache]);
		expect(dump.code).toBe(0);
		expect(JSON.parse(dump.stdout).definitionsPath).toBe(getBundledLslDefinitionsYamlPath());
		expect(JSON.parse(dump.stdout).cache).toBeNull();
		const refresh = await invoke(['update-defs', '--json', '--cache-dir', cache, '--update-url', 'http://127.0.0.1:1']);
		expect(refresh.code).toBe(2);
		expect(JSON.parse(refresh.stdout).error.code).toBe('operation-failed');
	});

	it.skipIf(process.getuid?.() === 0)('uses bundled definitions when the optional cache cannot be read', async () => {
		const file = await tempFile('ll.Say(0, "offline")');
		const cache = path.join(path.dirname(file), 'cache');
		await fs.mkdir(cache);
		const metadata = path.join(cache, 'lsl_definitions.metadata.json');
		await fs.writeFile(metadata, '{}');
		await fs.chmod(metadata, 0);
		try {
			const result = await invoke(['check', file, '--json', '--cache-dir', cache, '--warnings-as-errors']);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
		} finally { await fs.chmod(metadata, 0o600); }
	});

	it('gives an explicit definitions path precedence over an environment override', async () => {
		const file = await tempFile('print(1)');
		vi.stubEnv('SLUA_LSP_DEFS_PATH', path.join(path.dirname(file), 'missing-environment.yaml'));
		const explicit = await invoke(['check', file, '--defs', getBundledLslDefinitionsYamlPath(), '--json']);
		expect(explicit.code).toBe(0);
		const environment = await invoke(['check', file, '--json']);
		expect(environment.code).toBe(2);
		expect(JSON.parse(environment.stdout).error.message).toContain('missing-environment.yaml');
	});

	it.skipIf(process.getuid?.() === 0)('reports permission-denied input without prompting or emitting malformed JSON', async () => {
		const file = await tempFile('print(1)');
		await fs.chmod(file, 0);
		try {
			const result = await invoke(['check', file, '--json']);
			expect(result.code).toBe(2);
			expect(result.stderr).toBe('');
			expect(JSON.parse(result.stdout).error.code).toBe('operation-failed');
			expect(JSON.parse(result.stdout).error.message).toContain('EACCES');
		} finally { await fs.chmod(file, 0o600); }
	});

	it.each([
		['check', '--json'],
		['check', '--unknown', '--json'],
		['check', '--defs', '--json'],
		['check', '-', '-', '--json'],
		['check', '--format=xml', '--json'],
		['capabilities', 'unexpected', '--json'],
		['lookup', 'll..Say', '--json']
	])('returns a JSON usage error and exit 2 for %j', async (...args) => {
		const result = await invoke(args);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.code).toBe('usage');
		expect(result.stderr).toBe('');
	});

	it('reports missing files as structured operational failures', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cli-missing-'));
		tempDirs.push(dir);
		const result = await invoke(['check', path.join(dir, 'missing.luau'), '--json']);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.message).toContain('ENOENT');
	});

	it('recursively checks source files in deterministic order while excluding generated data', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cli-project-'));
		tempDirs.push(dir);
		await fs.mkdir(path.join(dir, 'node_modules'));
		await fs.writeFile(path.join(dir, 'b.luau'), 'local =');
		await fs.writeFile(path.join(dir, 'a.lua'), 'local =');
		await fs.writeFile(path.join(dir, 'node_modules', 'ignored.luau'), 'local =');
		const result = await invoke(['check', dir, '--json']);
		const out = JSON.parse(result.stdout);
		expect(result.code).toBe(1);
		expect(out.summary.files).toBe(2);
		expect(out.diagnostics.map((d: { file: string }) => path.basename(d.file))).toEqual(['a.lua', 'b.luau']);
	});

	it('describes machine capabilities and the supported exit/position contract', async () => {
		const result = await invoke(['capabilities']);
		const out = JSON.parse(result.stdout);
		expect(result.code).toBe(0);
		expect(out.commands).toContain('update-defs');
		expect(out.positionEncoding).toBe('utf-16');
		expect(out.exitCodes.usageOrOperationalError).toBe(2);
	});

	it('dumps resolved builtins and definitions without an editor or network', async () => {
		const result = await invoke(['dump-defs', '--json']);
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout);
		expect(out.modules.ll.functions.Say).toBeDefined();
		expect(out.globals.vector).toBeDefined();
	});
});

describe('builtin lookup for agents', () => {
	it('returns a compact lookup result for a qualified builtin', async () => {
		const stdout = new BufferStream();
		const stderr = new BufferStream();
		const code = await run(['node', 'slua-lsp', 'lookup', 'll.Say', '--json'], {
			stdout: stdout as unknown as NodeJS.WritableStream, stderr: stderr as unknown as NodeJS.WritableStream
		});
		expect(code).toBe(0);
		const out = JSON.parse(stdout.text);
		expect(out.query).toBe('ll.Say');
		expect(out.signature).toContain('string');
		expect(out.definition.meta.lslName).toBe('llSay');
		expect(stdout.text.length).toBeLessThan(5000);
	});
});
