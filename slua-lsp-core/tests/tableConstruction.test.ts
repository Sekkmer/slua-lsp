import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, inferLocalVariableTypes, parseSlua, sluaTypeToString } from '../src/index.js';
import { getVisibleLocalTypes } from '../src/typing/completion.js';
import { analyzeFunctionReturns } from '../src/typing/inferLocals.js';
import { slua } from '../src/slua/types.js';
import { tableWrite } from '../src/typing/tableWrites.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function inspect(source: string) {
	const text = source + '\nprint(M)';
	const parsed = parseSlua(text);
	expect(parsed.diagnostics).toEqual([]);
	const locals = getVisibleLocalTypes(parsed.ast, { line: source.split('\n').length, character: 7 }, registry);
	return { locals, diagnostics: analyzeTextWithDirectives(text, { ast: parsed.ast, registry }) };
}
describe('incrementally constructed source tables', () => {
	it('shares direct and nested alias writes without changing an unrelated table', () => {
		const { locals, diagnostics } = inspect('local M = {}\nlocal alias = M\nlocal other = {}\nalias.count = 42\nM.nested = {}\nlocal inner = M.nested\ninner.message = "hi"\nlocal value: string = M.count\nprint(other, value)');
		expect(sluaTypeToString(locals.get('M')!)).toBe('{ count: number, nested: { message: string } }');
		expect(locals.get('M')).toBe(locals.get('alias'));
		expect(sluaTypeToString(locals.get('other')!)).toBe('table');
		expect(diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch']);
	});
	it('evaluates assignment receivers and aliases before rebinding a table local', () => {
		const { locals, diagnostics } = inspect('local M = {}\nlocal alias\nalias, M.count = M, 42\nlocal previous = M\nM, M.message = {}, "old"\nlocal count: string = alias.count\nlocal message: number = previous.message\nprint(count, message)');
		expect(sluaTypeToString(locals.get('M')!)).toBe('table');
		expect(sluaTypeToString(locals.get('alias')!)).toBe('{ count: number, message: string }');
		expect(locals.get('alias')).toBe(locals.get('previous'));
		expect(diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch', 'assignment-type-mismatch']);
	});
	it('handles static string keys, prototype-like names and replacement assignments', () => {
		const { locals, diagnostics } = inspect('local M = {}\nM["__proto__"] = 1\nM["constructor"] = "hi"\nM.value = 1\nM.value = "changed"');
		const type = locals.get('M')!;
		expect(type.kind === 'table' && type.fields?.__proto__).toEqual(slua.number());
		expect(sluaTypeToString(type)).toContain('value: number'); expect(diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch']);
	});
	it('stores dot and colon function contracts and consumes only the colon receiver', () => {
		const { locals, diagnostics } = inspect('local M = {}\nM.count = 42\nfunction M.double(value: number): number return value * 2 end\nfunction M:message(value: string): string return value end\nlocal value: number = M.double(2)\nM.double("bad")\nM:message(1)\nM.message(M, "ok")\nprint(value)');
		expect(sluaTypeToString(locals.get('M')!)).toContain('double: (number) -> number');
		expect(diagnostics.map((item) => item.code)).toEqual(['call-argument-type-mismatch', 'call-argument-type-mismatch']);
	});
	it('infers method returns from self but does not execute deferred member writes', () => {
		const { locals, diagnostics } = inspect('local M = {}\nM.count = 42\nfunction M:get() return self.count end\nfunction M.later() M.hidden = "later" end\nlocal value: string = M:get()\nprint(value)');
		expect(sluaTypeToString(locals.get('M')!)).not.toContain('hidden:');
		expect(diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch']);
	});
	it('uses the same implicit self field types for local inlays inside a method body', () => {
		const parsed = parseSlua('local M = {}\nM.count = 42\nfunction M:get() local current = self.count; return current end');
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		expect(sluaTypeToString(inferred.find((item) => item.name === 'current')!.type)).toBe('number');
	});
	it('keeps branch snapshots separate instead of making a conditional field definite', () => {
		const { locals, diagnostics } = inspect('local M = {}\nif math.random() > 0.5 then M.value = 1 else M.value = "hi" end');
		expect(sluaTypeToString(locals.get('M')!)).toBe('{ value: number } | { value: string }'); expect(diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch']);
	});
	it('invalidates named facts after an unknown key while numeric writes retain them', () => {
		const numeric = inspect('local M = {count = 42}\nM[1] = "hi"');
		expect(sluaTypeToString(numeric.locals.get('M')!)).toContain('count: number');
		const dynamic = inspect('local M = {count = 42}\nlocal key = tostring(math.random())\nM[key] = "hi"');
		expect(sluaTypeToString(dynamic.locals.get('M')!)).toBe('table');
	});
	it('checks alias and nil field writes against the existing source table contract', () => {
		const { locals, diagnostics } = inspect('local M = {count = 42}\nlocal alias = M\nalias.count = "bad"\nM.count = nil\nM.count = 43\nprint(alias)');
		expect(sluaTypeToString(locals.get('M')!)).toBe('{ count: number }');
		expect(diagnostics.map((item) => item.code)).toEqual(['assignment-type-mismatch', 'assignment-type-mismatch']);
	});
	it('bounds growing fields and self references instead of retaining recursive snapshots', () => {
		const { locals } = inspect('local M = {}\nM.self = M\nM.count = 42');
		expect(sluaTypeToString(locals.get('M')!)).toBe('{ self: unknown, count: number }');
		const { locals: bounded } = inspect('local M = {}\n' + Array.from({ length: 130 }, (_, index) => `M.field${index} = ${index}`).join('\n'));
		expect(sluaTypeToString(bounded.get('M')!)).toBe('table');
	});
	it('preserves caller-owned types and generic tables when applying known source writes', () => {
		const original = slua.table({ count: slua.unknown() });
		const target = { type: 'MemberExpression', object: { type: 'Identifier', name: 'M' }, property: { type: 'Identifier', name: 'count' }, indexer: '.' };
		const update = tableWrite(target, slua.string(), registry, () => original);
		expect(sluaTypeToString(update(original))).toBe('{ count: string }'); expect(sluaTypeToString(original)).toBe('{ count: unknown }');
		const generic = slua.table(); expect(tableWrite(target, slua.string(), registry, () => generic)(generic)).toBe(generic);
	});
	it('returns accumulated fields through shared function return inference', () => {
		const parsed = parseSlua('local M = {}\nM.count = 42\nfunction M.double(value: number) return value * 2 end\nreturn M');
		const ast = parsed.ast as { body: unknown[] };
		const result = analyzeFunctionReturns({ type: 'Function', parameters: [], body: ast.body }, registry, new Map());
		expect(sluaTypeToString(result!.type)).toBe('{ count: number, double: (number) -> number }');
	});
});
