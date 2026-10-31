import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { slua, sluaTypeIsAssignable, sluaTypeToString } from '../src/slua/types.js';
import { getSignatureHelp } from '../src/typing/signatureHelp.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const codes = (source: string) => analyzeTextWithDirectives(source, { registry }).map((d) => d.code);

describe('bounded native result counts and debug overloads', () => {
	it.each([
		'local n=utf8.len("abc"); print(n)',
		'local n,pos=utf8.len("abc"); print(n,pos)',
		'local key=next({}); print(key)',
		'local key,value=next({}); print(key,value)',
		'local co=coroutine.create(function() end); local ok=coroutine.close(co); print(ok)',
		'local function read() return utf8.len("abc") end; local n=read(); print(n)',
		'local co=coroutine.create(function() end); local source=debug.info(co,0,"s"); print(source)',
		'local function fn(a:number) return a end; local n,vararg=debug.info(fn,"a"); print(n,vararg)',
		'local info=debug.info; local co=coroutine.create(function() end); local source=info(co,0,"s"); print(source)',
		'local trace=debug.traceback; local text=trace(); print(text)',
		'local text=debug.traceback("owned",0); print(text)',
		'local co=coroutine.create(function() end); local text=debug.traceback(co,"owned",0); print(text)'
	])('accepts supported result counts and overloads: %s', (source) => {
		expect(codes(source)).toEqual([]);
	});
	it.each([
		'local a,b,c=utf8.len("a"); print(a,b,c)',
		'local a,b,c=next({}); print(a,b,c)',
		'local co=coroutine.create(function() end); local a,b,c=coroutine.close(co); print(a,b,c)',
		'local function read() return utf8.len("a") end; local a,b,c=read(); print(a,b,c)'
	])('retains a known upper bound: %s', (source) => {
		expect(codes(source)).toEqual(['assignment-return-count-mismatch']);
	});
	it.each([
		'debug.info(true,"s")',
		'local co=coroutine.create(function() end); debug.info(co,"bad","s")',
		'debug.traceback(false)'
	])('checks the selected overload parameter types: %s', (source) => {
		expect(codes(source)).toEqual(['call-argument-type-mismatch']);
	});
	it('does not erase optional finite-pack counts from type identity', () => {
		const fixed = slua.tuple([slua.boolean(), slua.unknown()]);
		const optional = slua.tuple([slua.boolean(), slua.unknown()], undefined, 1);
		expect(sluaTypeIsAssignable(fixed, optional)).toBe(false);
		expect(sluaTypeToString(optional)).toContain('[');
	});
	it('exposes the selected thread overload in signature help', () => {
		const source = 'local co=coroutine.create(function() end); debug.info(co,0,"s")';
		const help = getSignatureHelp(parseSlua(source).ast, { line: 0, character: source.length - 2 }, registry, source);
		expect(help?.signatures[0]?.parameters).toHaveLength(3);
		expect(help?.signatures[0]?.label).toContain('...unknown');
	});
	it('retains coroutine.wrap as a callable with an open result contract', () => {
		const signature = registry.getModule('coroutine')!.functions.wrap!.signature;
		expect(signature.kind).toBe('function');
		if (signature.kind !== 'function') throw new Error('missing wrap signature');
		expect(signature.returns.kind).toBe('function');
		if (signature.returns.kind !== 'function') throw new Error('missing wrapped call signature');
		expect(signature.returns.returns).toEqual(slua.tuple([], slua.unknown(), 0));
	});
});
