import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, getCompletions, inferLocalVariableTypes, sluaTypeToString, findDefinitionAtPosition } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { slua, sluaTypeEquals, sluaTypeIsAssignable } from '../src/slua/types.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const prefix = 'class Box\npublic x: number\nfunction answer(): number return 42 end\nend\nlocal item=Box{x=1}\n';
function codes(tail: string): string[] {
	const source = prefix + tail, parsed = parseSlua(source);
	expect(parsed.diagnostics).toEqual([]);
	return analyzeTextWithDirectives(source, { ast: parsed.ast, registry }).map((item) => item.code).sort();
}

describe('experimental native class library', () => {
	const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-library.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; codes: string[] }>;
	it.each(cases)('$name shared native contract', ({ source, codes }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(source, { ast: parsed.ast, registry }).map((item) => item.code).sort()).toEqual([...codes].sort());
	});
	it('exposes both members and explicit argument presence in the shared registry', () => {
		const module = registry.getModule('class');
		expect(Object.keys(module?.functions ?? {}).sort()).toEqual(['classof', 'isinstance']);
		expect(module?.functions.classof?.signature).toMatchObject({ params: [{ kind: 'primitive', name: 'unknown' }], arity: { min: 1, max: 1 } });
		expect(module?.functions.isinstance?.signature).toMatchObject({ arity: { min: 2, max: 2 } });
	});
	it.each(['class.isinstance(item,Box)', 'class.isinstance(nil,Box)', 'class.isinstance({},Box)', 'class.isinstance(Box,Box)', 'class.classof(item)', 'class.classof(nil)'])('accepts %s', (tail) => { expect(codes(tail)).toEqual([]); });
	it.each(['class.isinstance(item,{})', 'class.isinstance(item,item)', 'class.isinstance(item,nil)', 'class.isinstance(item,function() end)'])('rejects a nonclass second argument in %s', (tail) => { expect(codes(tail)).toEqual(['call-argument-type-mismatch']); });
	it.each(['class.classof()', 'class.isinstance(item)', 'class.classof(item,1)', 'class.isinstance(item,Box,1)'])('checks supplied argument counts for %s', (tail) => { expect(codes(tail)).toEqual(['call-argument-count-mismatch']); });
	it.each(['local Make=class.classof(item)', 'local lib=class\nlocal Make=lib.classof(item)', 'local lib={inspect=class.classof}\nlocal Make=lib.inspect(item)'])('preserves builtin function identity through %s', (tail) => {
		const source = prefix + tail + '\nMake.';
		const labels = getCompletions(parseSlua(source).ast, { line: source.split('\n').length - 1, character: 5 }, registry, { sourceText: source }).map((item) => item.label);
		expect(labels).toContain('answer');
	});
	it('retains constructor and member source identity through a saved classof function', () => {
		const source = prefix + 'local inspect=class.classof\nlocal Make=inspect(item)\nprint(Make.answer())';
		expect(codes('local inspect=class.classof\nlocal Make=inspect(item)\nlocal clone=Make{x=2}\nassert(clone.x==2)')).toEqual([]);
		const position = { line: source.split('\n').length - 1, character: 'print(Make.'.length + 1 };
		expect(findDefinitionAtPosition(parseSlua(source).ast, position, registry)?.identifier.location?.start.line).toBe(3);
	});
	it.each(['nil', '{}', 'Box', '42', 'function() end'])('knows classof(%s) is nil without inventing a class', (value) => {
		const source = prefix + `local result=class.classof(${value})\nprint(result)`;
		const type = inferLocalVariableTypes(parseSlua(source).ast, registry).find((item) => item.name === 'result')?.type;
		expect(type && sluaTypeToString(type)).toBe('nil');
	});
	it('keeps an unproven result nullable', () => {
		const source = 'local function inspect(value)\nreturn class.classof(value)\nend\nlocal result=inspect(42)\nprint(result)';
		const type = inferLocalVariableTypes(parseSlua(source).ast, registry).find((item) => item.name === 'result')?.type;
		expect(type && sluaTypeToString(type)).toContain('class');
		expect(type && sluaTypeToString(type)).toContain('nil');
	});
	it('does not specialize a shadowed local module or function', () => {
		expect(codes('local class={classof=function(value: number): number return value end}\nlocal result: number=class.classof(42)\nprint(result)')).toEqual([]);
		expect(codes('local inspect=class.classof\ninspect=function(value: number): number return value end\nlocal result: number=inspect(42)\nprint(result)')).toEqual([]);
	});
	it('retains ordinary profile aliases called class and object', () => {
		const source = 'type class=number\ntype object=string\nlocal x: class=42\nlocal y: object="value"\nprint(x,y)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('does not equate the native constructor top with a custom value of the same spelling', () => {
		const signature = registry.getModule('class')?.functions.isinstance?.signature;
		expect(signature?.kind).toBe('function');
		if (signature?.kind !== 'function') return;
		const expected = signature.params[1]!;
		expect(sluaTypeEquals(expected, slua.custom('class'))).toBe(false);
		expect(sluaTypeIsAssignable(expected, slua.custom('class'))).toBe(false);
		expect(sluaTypeIsAssignable(expected, slua.fn([], slua.unknown()))).toBe(false);
	});
	it('honors diagnostic directives for invalid class-library arguments', () => {
		expect(codes('-- slua-lsp:disable-next-line call-argument-type-mismatch\nclass.isinstance(item,{})')).toEqual([]);
	});
});
