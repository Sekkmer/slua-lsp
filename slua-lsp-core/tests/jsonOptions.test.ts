import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSignatureHelp } from '../src/typing/signatureHelp.js';
import { slua, sluaTypeEquals, sluaTypeToString } from '../src/slua/types.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/json-options.json', import.meta.url), 'utf8')) as { name: string; source: string; codes: string[] }[];

describe('native JSON optional arguments', () => {
	for (const item of cases) it(item.name, () => {
		const parsed = parseSlua(item.source);
		expect(parsed.diagnostics).toEqual([]);
		const codes = analyzeTextWithDirectives(item.source, { registry, ast: parsed.ast }).filter((d) => d.code === 'call-argument-type-mismatch' || d.code === 'call-argument-count-mismatch').map((d) => d.code);
		expect(codes).toEqual(item.codes);
	});
});

describe('native argument presence contracts', () => {
	it('records argument bounds separately from provided-value types', () => {
		for (const name of ['encode', 'slencode', 'decode', 'sldecode']) {
			const signature = registry.getModule('lljson')!.functions[name]!.signature;
			expect(signature).toMatchObject({ kind: 'function', arity: { min: 1, max: 2 } });
			if (signature.kind !== 'function') throw new Error('Expected function');
			expect(JSON.stringify(signature.params[1])).not.toContain('"nil"');
		}
	});
	it('keeps unresolved final argument packs conservative', () => {
		const source = 'local function apply(values) return lljson.encode(42,values()) end\nprint(apply)';
		expect(analyzeTextWithDirectives(source, { registry }).filter((d) => d.code.startsWith('call-argument-'))).toEqual([]);
	});
	it('rejects a proven excessive prefix even with an unresolved final pack', () => {
		const source = 'local function apply(values) return lljson.encode(42,{},3,values()) end\nprint(apply)';
		expect(analyzeTextWithDirectives(source, { registry }).filter((d) => d.code === 'call-argument-count-mismatch')).toHaveLength(1);
	});
	it('does not hide an explicit nil warning through directives accidentally', () => {
		const source = '-- slua-lsp:disable-next-line call-argument-type-mismatch\nlljson.encode(42,nil)\nlljson.decode("42",nil)';
		const diagnostics = analyzeTextWithDirectives(source, { registry }).filter((d) => d.code === 'call-argument-type-mismatch');
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.range.start.line).toBe(2);
	});
});

describe('native option presentation and type identity', () => {
	it('shows optional presence without advertising a nil value', () => {
		const source = 'lljson.encode(42, {})';
		const help = getSignatureHelp(parseSlua(source).ast, { line: 0, character: 18 }, registry, source);
		expect(help?.signatures[0]?.label).toContain('arg2?: table');
		expect(sluaTypeToString(registry.getModule('lljson')!.functions.encode!.signature)).toBe('(unknown, [table]) -> string');
	});
	it('keeps different native arity contracts distinct when function shapes coincide', () => {
		const optional = slua.fn([slua.unknown(), slua.table()], slua.string(), undefined, { min: 1, max: 2 });
		const required = slua.fn([slua.unknown(), slua.table()], slua.string(), undefined, { min: 2, max: 2 });
		expect(sluaTypeEquals(optional, required)).toBe(false);
		expect(sluaTypeEquals(optional, { ...optional })).toBe(true);
	});
});
