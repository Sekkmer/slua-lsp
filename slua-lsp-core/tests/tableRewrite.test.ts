import { describe, expect, it } from 'vitest';
import { buildSluaRegistryFromLslDefinitions, parseSlua } from '../src/index.js';
import { slua, type SluaType } from '../src/slua/types.js';
import { freezeSourceTable } from '../src/slua/sourceOrigins.js';
import { tableAssignments, tableWrite } from '../src/typing/tableWrites.js';
const registry = buildSluaRegistryFromLslDefinitions(null);
const referenceIdentity = tableWrite(undefined, slua.number(), registry, () => undefined);
function target(source: string): unknown {
	const parsed = parseSlua(source + ' = 1'); expect(parsed.diagnostics).toEqual([]);
	return (parsed.ast as {body: Array<{variables: unknown[]}>}).body[0]!.variables[0];
}
describe('table rewrite work selection', () => {
	it.each(['value', 'unknown.field', 'll.extra', 'api[1]', 'opaque.field', 'frozen.field'])('shares the identity operation for a target that cannot change table facts: %s', (source) => {
		const frozen = slua.table({field: slua.number()}); freezeSourceTable(frozen);
		const local = (name: string) => ({api: slua.table({field: slua.number()}), opaque: slua.table(), frozen} as Record<string, SluaType>)[name];
		const value = [slua.number()];
		const result = tableAssignments([target(source)], value, registry, local);
		expect(result.update).toBe(referenceIdentity);
		expect(result.values).toBe(value);
		const untouched = slua.table({field: slua.string()}); expect(result.update(untouched)).toBe(untouched);
	});
	it('does not inspect local types for scalar-only assignment targets', () => {
		const result = tableAssignments([target('left'), target('right')], [slua.number(), slua.string()], registry, () => { throw new Error('scalar assignment needs no receiver lookup'); });
		expect(result.update).toBe(referenceIdentity);
	});
	it('keeps real field writes and pre-evaluated aliases in a mixed assignment', () => {
		const original = slua.table({});
		const result = tableAssignments([target('copy'), target('api.field'), target('missing.field')], [original, slua.number(), slua.boolean()], registry, (name) => name === 'api' ? original : undefined);
		expect(result.update).not.toBe(referenceIdentity);
		const updated = result.update(original);
		expect(updated).toEqual(slua.table({field: slua.number()}));
		expect(result.values[0]).toBe(updated);
		expect(original).toEqual(slua.table({}));
	});
	it('keeps unknown-key invalidation active while numeric-index writes preserve named facts', () => {
		const original = slua.table({field: slua.number()});
		const local = (name: string) => name === 'api' ? original : undefined;
		expect(tableWrite(target('api[key]'), slua.string(), registry, local)(original)).toEqual(slua.table());
		expect(tableWrite(target('api[1]'), slua.string(), registry, local)).toBe(referenceIdentity);
	});
});
