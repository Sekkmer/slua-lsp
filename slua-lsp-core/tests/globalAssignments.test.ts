import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, parseSlua } from '../src/index.js';
const registry = buildSluaRegistryFromLslDefinitions(null);
function codes(source: string): string[] {
	const parsed = parseSlua(source); expect(parsed.diagnostics).toEqual([]);
	return analyzeTextWithDirectives(source, {ast: parsed.ast, registry}).map(item => item.code);
}
describe('global assignment declarations', () => {
	it.each([
		'counter=0\nprint(counter)',
		'counter=0\nlocal function increment() counter+=1 return counter end\nprint(increment())',
		'counter=nil\nlocal function assign() counter=1 end\nprint(assign)',
		'do counter=0 end\nprint(counter)',
		'if true then counter=0 end\nprint(counter)',
		'local counter=0\ncounter=1\nprint(counter)'
	])('records executed-scope assignments before subsequent reads: %s', source => {
		expect(codes(source)).toEqual([]);
	});
	it('keeps all right-hand sides before declarations in multi-target assignments', () => {
		expect(codes('first,second=1,first\nprint(first,second)')).toEqual(['undeclared-name']);
		expect(codes('counter=counter+1\nprint(counter)')).toEqual(['undeclared-name']);
	});
	it('does not turn local block assignments into globals', () => {
		expect(codes('do local counter=0 counter=1 print(counter) end\nprint(counter)')).toEqual(['undeclared-name']);
	});
	it.each([
		'local function create() counter=1 end\nprint(create)',
		'do local function create() counter=1 end print(create) end',
		'local function create() do counter=1 end end\nprint(create)'
	])('preserves accidental-global advice inside actual functions: %s', source => {
		expect(codes(source)).toEqual(['accidental-global-write']);
		expect(codes('-- slua-lsp:disable accidental-global-write\n'+source)).toEqual([]);
	});
});
