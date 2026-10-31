import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { slua, sluaPackValue, sluaTypeEquals, sluaTypeToString } from '../src/slua/types.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
describe('native variable return packs', () => {
	it('preserves pack shape and minimum in type identity and presentation', () => {
		const pack = slua.tuple([slua.number()], slua.unknown(), 1);
		expect(sluaTypeEquals(pack, slua.tuple([slua.number()]))).toBe(false);
		expect(sluaTypeEquals(pack, slua.tuple([slua.number()], slua.unknown(), 0))).toBe(false);
		expect(sluaTypeToString(pack)).toBe('(number, ...unknown)');
	});
	it('retains known nullable bounds before an unknown capture tail', () => {
		const source = 'local first: string, last: number?, capture: string = string.find("a12", "(%d+)"); print(first, last, capture)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['assignment-type-mismatch']);
	});
	it.each([
		'local first, last, capture = string.find("a12", "(%d+)"); print(first, last, capture)',
		'local first: number?, last: number?, capture: string = string.find("a12", "(%d+)"); print(first, last, capture)',
		'local value, nextByte = string.unpack("<I2", string.pack("<I2", 42)); print(value, nextByte)',
		'local a, b, c, nextByte = string.unpack("BBB", "abc"); print(a, b, c, nextByte)',
		'local find = string.find; local a, b, c = find("a12", "(%d+)"); print(a, b, c)',
		'local function find() return string.find("a12", "(%d+)") end; local a, b, c = find(); print(a, b, c)'
	])('does not invent an exact result count for %s', (source) => {
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('retains an exact single result after parentheses', () => {
		const source = 'local first, last = (string.find("abc", "a")); print(first, last)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['assignment-return-count-mismatch']);
	});
	it('keeps guaranteed excessive argument prefixes visible before an open tail', () => {
		const source = 'lljson.encode(42, {}, string.unpack("", ""))';
		expect(analyzeTextWithDirectives(source, { registry }).filter((d) => d.code === 'call-argument-count-mismatch')).toHaveLength(1);
	});
	it.each([
		'local a,b,c=string.byte("abc",1,3); print(a,b,c)',
		'local a,b,c=utf8.codepoint("A😀é",1,7); print(a,b,c)',
		'local a:number,b:string=string.match("abc","()(%a+)"); print(a,b)',
		'local a,b,c=unpack({1,2,3}); print(a,b,c)',
		'local a,b,c=table.unpack({1,2,3}); print(a,b,c)',
		'local a,b=select(2,1,2,3); print(a,b)',
		'local ok,a,b=pcall(function() return 1,2 end); print(ok,a,b)',
		'local ok=pcall(function() end); print(ok)',
		'local ok,a,b=xpcall(function() return 1,2 end,function(err) return err end); print(ok,a,b)',
		'local co=coroutine.create(function() return 1,2 end); local ok,a,b=coroutine.resume(co); print(ok,a,b)',
		'local function read() return string.byte("abc",1,3) end; local a,b,c=read(); print(a,b,c)'
	])('preserves stdlib result packs for %s', (source) => {
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it.each([
		'local value:string=string.byte("a"); print(value)',
		'local value:string=utf8.codepoint("a"); print(value)',
		'local status:string,a,b=pcall(function() return 1,2 end); print(status,a,b)'
	])('retains known result types for %s', (source) => {
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['assignment-type-mismatch']);
	});
	it('retains numeric optional values after empty-capable pack adjustment and guards', () => {
		const source = 'local a,b=string.byte("ab",1,2); if a ~= nil then local value:number=a; print(value) end; if b ~= nil then local value:number=b; print(value) end';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('does not infer nil for a grouped open pack with an empty known prefix', () => {
		const source = 'local value:number=(string.unpack("B","a")); print(value)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('distinguishes absent numeric results from supplied numeric call arguments', () => {
		expect(sluaPackValue([], 0, slua.number(), 0)).toEqual(slua.union([slua.number(), slua.nil()]));
		expect(sluaPackValue([], 0, slua.number(), 1)).toEqual(slua.number());
		expect(sluaPackValue([slua.boolean()], 0, slua.unknown(), 1)).toEqual(slua.boolean());
		expect(sluaPackValue([], 0, slua.unknown(), 0)).toEqual(slua.unknown());
	});
});
