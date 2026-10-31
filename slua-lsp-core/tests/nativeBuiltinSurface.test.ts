import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { slua } from '../src/slua/types.js';
import { sluaTypeIsAssignable, sluaTypeFromLslType } from '../src/slua/types.js';

const native = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/native-surface-4116d7f.json'), 'utf8')) as {
	modules: Record<string, Record<string, string>>; objects: Record<string, string[]>;
};
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('October native SLua API surface (recorded --sl runtime)', () => {
	it.each(Object.entries(native.modules))('matches the actual %s exports, including no invented aliases', (name, members) => {
		const module = registry.getModule(name);
		expect(module).toBeDefined();
		expect(Object.keys({ ...module!.functions, ...module!.values }).sort()).toEqual(Object.keys(members).sort());
		for (const [name, kind] of Object.entries(members)) if (kind === 'function') expect(module!.functions[name]).toBeDefined();
	});

	it.each(Object.entries(native.objects))('matches the probed %s methods', (name, methods) => {
		expect(Object.keys(registry.getObjectType(name)!.methods).sort()).toEqual(methods.sort());
	});

	it('accepts current native helper names and ordinary bit32 numeric arguments', () => {
		const text = [
			'local midpoint = vector.lerp(vector(0, 0, 0), vector(2, 4, 6), 0.5)',
			'local normalized = quaternion.normalize(quaternion.identity)',
			'local signed = bit32.s32(4294967295)',
			'local product = bit32.smul(2147483647, 2)',
			'local flags = bit32.bor(1, 2)',
			'local encoded = lljson.encode(42)',
			'local sentinels = {lljson.null, lljson.remove, lljson.empty_object, lljson.object_mt}',
			'local handlers = LLEvents:handlers("listen")',
			'print(midpoint, normalized, signed, product, flags, encoded, sentinels, handlers)'
		].join('\n');
		const parsed = parseSlua(text);
		expect(parsed.diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(text, { registry, ast: parsed.ast })).toEqual([]);
	});

	it('models decoded primitive JSON conservatively rather than asserting a table result', () => {
		expect(registry.getModule('lljson')!.functions.decode!.signature).toEqual(slua.fn([slua.string(), slua.union([slua.table(), slua.anyFunction()])], slua.unknown(), undefined, { min: 1, max: 2 }));
	});

	it('rejects the historical event method and omits an invented JSON sentinel', () => {
		const text = 'LLEvents:listeners("listen")\nprint(lljson.empty_array_mt)';
		const diagnostics = analyzeTextWithDirectives(text, { registry });
		expect(diagnostics.some((d) => d.code === 'unknown-intrinsic-method')).toBe(true);
		expect(registry.getModule('lljson')!.values.empty_array_mt).toBeUndefined();
	});

	it('models the current integer library instead of LSL-only constructor globals', () => {
		expect(registry.getGlobal('integer')).toBeUndefined();
		expect(registry.getGlobal('number')).toBeUndefined();
		const integer = registry.getModule('integer')!;
		expect(integer.functions.create!.signature).toEqual(slua.fn([slua.number()], slua.union([slua.integer(), slua.nil()])));
		expect(integer.functions.fromstring!.signature).toEqual(slua.fn([slua.string(), slua.union([slua.number(), slua.nil()])], slua.union([slua.integer(), slua.nil()])));
		expect(integer.functions.tonumber!.signature).toEqual(slua.fn([slua.integer()], slua.number()));
		expect(integer.values.maxsigned!.type).toEqual(slua.integer());
		expect(sluaTypeFromLslType('integer')).toEqual(slua.number());
		expect(sluaTypeIsAssignable(slua.number(), slua.integer())).toBe(false);
		expect(sluaTypeIsAssignable(slua.integer(), slua.number())).toBe(false);
	});

	it('checks every integer variadic argument and preserves native minimum arity', () => {
		const valid = 'print(integer.band(), integer.btest(), integer.min(integer.maxsigned), integer.max(integer.maxsigned, integer.minsigned, integer.maxsigned))';
		expect(analyzeTextWithDirectives(valid, { registry })).toEqual([]);
		const invalid = analyzeTextWithDirectives('integer.min()\ninteger.band(integer.maxsigned, integer.maxsigned, 1)', { registry });
		expect(invalid.filter((d) => d.code === 'call-argument-count-mismatch')).toHaveLength(1);
		expect(invalid.filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
	});

	it('checks actual integer library inputs and detects historical constructor calls', () => {
		const valid = 'local value = integer.maxsigned\nlocal converted = integer.tonumber(value)\nlocal created = integer.create(42)\nlocal parsed = integer.fromstring("ff", 16)\nprint(value, converted, created, parsed)';
		expect(analyzeTextWithDirectives(valid, { registry })).toEqual([]);
		const invalid = analyzeTextWithDirectives('integer(1)\nnumber("1")\ninteger.add(1, 2)\ninteger.fromstring(42)', { registry });
		expect(invalid.filter((d) => d.code === 'call-non-callable')).toHaveLength(1);
		expect(invalid.filter((d) => d.code === 'undeclared-name')).toHaveLength(1);
		expect(invalid.filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(3);
	});
});
