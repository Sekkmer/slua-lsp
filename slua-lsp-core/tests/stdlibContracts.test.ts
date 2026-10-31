import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { slua, sluaTypeEquals, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable } from '../src/slua/types.js';
import { getSignatureHelp } from '../src/typing/signatureHelp.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const native = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/native/stdlib-surface.json'), 'utf8')) as {
	modules: Record<string, Record<string, string>>;
};

describe('qualified October SLua standard libraries', () => {
	it.each(Object.entries(native.modules))('matches the actual %s exports and function/value categories', (name, exports) => {
		const module = registry.getModule(name)!;
		expect(module).toBeDefined();
		expect(Object.keys({ ...module.functions, ...module.values }).sort()).toEqual(Object.keys(exports).sort());
		for (const [key, kind] of Object.entries(exports)) {
			if (kind === 'function') expect(module.functions[key], key).toBeDefined();
			else expect(module.values[key]?.type, key).toEqual(kind === 'string' ? slua.string() : slua.number());
		}
	});

	it('models genuine nullable results instead of promising successful conversions and searches', () => {
		const optionalNumber = slua.union([slua.number(), slua.nil()]);
		expect(registry.getGlobal('tonumber')!.signature).toEqual(slua.fn([slua.unknown(), optionalNumber], optionalNumber));
		expect(registry.getModule('table')!.functions.find!.signature).toEqual(slua.fn([slua.table(), slua.unknown(), optionalNumber], optionalNumber));
		expect(registry.getModule('utf8')!.functions.len!.signature).toEqual(slua.fn([slua.string(), optionalNumber, optionalNumber], slua.tuple([optionalNumber, optionalNumber], undefined, 1)));
	});

	it('preserves fixed tuple return types through YAML flow syntax and typed assignments', () => {
		for (const name of ['modf', 'frexp']) expect(registry.getModule('math')!.functions[name]!.signature).toEqual(slua.fn([slua.number()], slua.tuple([slua.number(), slua.number()])));
		const source = 'local whole: number, fraction: string = math.modf(2.5)\nprint(whole, fraction)';
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['assignment-type-mismatch']);
	});

	it('distinguishes ordinary buffer numbers from 64-bit integer operations', () => {
		const source = 'local b = buffer.create(8)\nbuffer.writeinteger(b, 0, integer.maxsigned)\nlocal wide: integer = buffer.readinteger(b, 0)\nlocal narrow: number = buffer.readu32(b, 0)\nprint(wide, narrow)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
		expect(analyzeTextWithDirectives('buffer.writeinteger(buffer.create(8), 0, 42)', { registry }).map((d) => d.code)).toEqual(['call-argument-type-mismatch']);
	});

	it('accepts safe SLua table additions and checks required destination/source inputs', () => {
		expect(analyzeTextWithDirectives('local t = {}\ntable.append(t)\ntable.append(t, 1, "two")\nlocal result = table.extend(t, {3})\nprint(result)', { registry })).toEqual([]);
		expect(analyzeTextWithDirectives('table.extend({})\ntable.append("bad", 1)', { registry }).map((d) => d.code).sort()).toEqual(['call-argument-count-mismatch', 'call-argument-type-mismatch']);
	});

	it('accepts known callback functions without confusing bare function with a zero-argument contract', () => {
		const typed = slua.fn([slua.number()], slua.number());
		const bare = sluaTypeFromLuauAnnotationText('function');
		expect(sluaTypeIsAssignable(bare, typed)).toBe(true);
		expect(sluaTypeIsAssignable(bare, slua.number())).toBe(false);
		expect(sluaTypeEquals(bare, slua.fn([], slua.unknown()))).toBe(false);
		const source = 'local function compare(a: number, b: number): boolean return a < b end\nlocal function identity(a: number): number return a end\ntable.sort({2, 1}, compare)\nprint(pcall(identity, 42))\nlocal co = coroutine.create(identity)\nlocal function finish(status: string) print(status) end\ncoroutine.finally(co, finish)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
		expect(analyzeTextWithDirectives('coroutine.create(42)\ncoroutine.finally(coroutine.create(function() end), false)', { registry }).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(2);
	});

	it('retains corrected contracts through module and function aliases', () => {
		const source = 'local strings, numbers = string, math\nlocal chars, maximum = strings.char, numbers.max\nprint(chars(), maximum(1))\nchars(65, false)\nmaximum(1, 2, "bad")';
		const diagnostics = analyzeTextWithDirectives(source, { registry });
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics.every((d) => d.code === 'call-argument-type-mismatch')).toBe(true);
	});

	it('exposes optional bounds and typed variadics in signature help', () => {
		const text = 'string.sub("abc", 1)';
		const sub = getSignatureHelp(parseSlua(text).ast, { line: 0, character: 17 }, registry, text);
		expect(sub?.signatures[0]?.parameters[2]?.label).toBe('arg3: nil | number');
		const chars = 'string.char(65, 66)';
		expect(JSON.stringify(getSignatureHelp(parseSlua(chars).ast, { line: 0, character: 15 }, registry, chars))).toContain('...: number');
	});
});
