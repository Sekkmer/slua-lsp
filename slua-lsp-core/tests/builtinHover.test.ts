import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { getBuiltinMemberHover } from '../src/typing/builtinHover.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function hover(source: string) {
	const offset = source.indexOf('$');
	const text = source.replace('$', '');
	const before = source.slice(0, offset).split('\n');
	return getBuiltinMemberHover(parseSlua(text).ast, { line: before.length - 1, character: before.at(-1)!.length }, registry);
}

describe('shared registered builtin member hover', () => {
	it('shows current integer variadic arguments and nullable creation', () => {
		expect(hover('integer.ba$nd(integer.maxsigned)')?.markdown).toContain('integer.band(...: integer): integer');
		expect(hover('integer.cr$eate(1)')?.markdown).toContain('integer | nil');
	});
	it('covers standard and callable modules', () => {
		expect(hover('math.a$bs(1)')?.markdown).toContain('math.abs(arg1: number): number');
		expect(hover('vector.nor$malize(vector.zero)')?.markdown).toContain('vector.normalize');
	});
	it('shows intrinsic method docs', () => {
		expect(hover('LLTimers:ev$ery(1, function() end)')?.markdown).toContain('LLTimers:every');
	});
	it('describes runtime values without inventing a literal or parser replacement', () => {
		const text = hover('print(integer.maxsi$gned)')?.markdown;
		expect(text).toContain('integer.maxsigned: integer');
		expect(text).toContain('Read-only');
		expect(text).not.toContain('undefined');
		expect(text).not.toContain('replaced by the parser');
	});
	it.each([
		'local integer = {}\ninteger.ba$nd(1)',
		'local function run(math) return math.a$bs(1) end\nprint(run)',
		'for integer = 1,2 do print(integer.maxsi$gned) end',
		'do local LLTimers = {}\nLLTimers:ev$ery(1) end'
	])('does not apply native docs to a shadowed receiver: %s', (text) => {
		expect(hover(text)).toBeNull();
	});
	it('does not treat a later or finished-block binding as an earlier shadow', () => {
		expect(hover('integer.ba$nd()\nlocal integer = {}\nprint(integer)')).not.toBeNull();
		expect(hover('do local integer = {}\nprint(integer) end\ninteger.ba$nd()')).not.toBeNull();
	});
	it('returns exact UTF-16 member ranges', () => {
		expect(hover('print("😀", integer.ba$nd())')?.range).toEqual({ start: { line: 0, character: 20 }, end: { line: 0, character: 24 } });
	});
});
