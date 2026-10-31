import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { getVisibleLocalTypes, getCompletions } from '../src/typing/completion.js';
import { sluaTypeToString } from '../src/slua/types.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const diagnostics = (text: string) => analyzeTextWithDirectives(text, { registry });
const inspect = (text: string) => inferLocalVariableTypes(parseSlua(text).ast, registry);
function atCursor(marked: string) {
	const offset = marked.indexOf('$');
	const text = marked.replace('$', '');
	const prefix = text.slice(0, offset).split('\n');
	const pos = { line: prefix.length - 1, character: prefix.at(-1)!.length };
	return { text, pos, ast: parseSlua(text).ast };
}

describe('shared local guard refinements', () => {
	it.each(['key', 'key ~= nil', 'nil ~= key', 'not (key == nil)', 'type(key) == "number"', 'typeof(key) ~= "nil"'])('accepts a guarded nullable index: %s', (guard) => {
		const source = `local function inspect(values: {number}, key: number?)\n if ${guard} then\n  print(values[key], math.abs(key))\n end\nend\nprint(inspect)`;
		expect(diagnostics(source)).toEqual([]);
	});

	it('narrows the real nullable ll.SubStringIndex result', async () => {
		const full = buildSluaRegistryFromLslDefinitions(await loadLslDefinitionsFromYamlFile());
		const text = 'local index = ll.SubStringIndex("hello", "e")\nif index then\n print(math.abs(index))\nend\nprint(math.abs(index))';
		const found = analyzeTextWithDirectives(text, { registry: full });
		expect(found.map((d) => [d.code, d.range.start.line])).toEqual([['call-argument-type-mismatch', 4]]);
	});

	it('keeps the nil branch and the outer binding independent', () => {
		const text = 'local function check(key: number?)\n if key then\n  math.abs(key)\n else\n  math.abs(key)\n end\n math.abs(key)\nend\nprint(check)';
		expect(diagnostics(text).map((d) => d.range.start.line)).toEqual([4, 6]);
	});

	it('refines elseif and negative guards independently', () => {
		const text = 'local function check(value: number | string | nil)\n if value == nil then\n  print(value)\n elseif type(value) == "number" then\n  math.abs(value)\n else\n  string.lower(value)\n end\nend\nprint(check)';
		expect(diagnostics(text)).toEqual([]);
	});

	it('uses guarded short circuit RHS and if expression branches', () => {
		const text = 'local function check(key: number?)\n local a = key and math.abs(key)\n local b = not key or math.abs(key)\n local c = if key then math.abs(key) else 0\n print(a, b, c)\nend\nprint(check)';
		expect(diagnostics(text)).toEqual([]);
	});

	it('does not assume either disjunct alone or equate ~= false with truthiness', () => {
		const text = 'local function check(key: number?, flag: boolean)\n if key or flag then math.abs(key) end\n if key ~= false then math.abs(key) end\nend\nprint(check)';
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(2);
	});

	it('bounds nested disjunction paths without inventing a nonnil guarantee', () => {
		const condition = Array(40).fill('key or flag').join(' or ');
		const text = `local function check(key: number?, flag: boolean)\n if ${condition} then math.abs(key) end\nend\nprint(check)`;
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
	});

	it('accepts unshadowed assert and rejects local lookalikes', () => {
		const good = 'local function check(key: number?)\n assert(key)\n math.abs(key)\nend\nprint(check)';
		expect(diagnostics(good)).toEqual([]);
		const shadowed = 'local function check(key: number?)\n local assert = function(value) print(value) end\n assert(key)\n math.abs(key)\n local type = function(value) print(value) return "number" end\n if type(key) == "number" then math.abs(key) end\nend\nprint(check)';
		expect(diagnostics(shadowed).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(2);
	});

	it('forgets a guard after assignment and checks declared writes', () => {
		const text = 'local function check(key: number?)\n if key then\n  key = nil\n  math.abs(key)\n  key = "bad"\n end\nend\nprint(check)';
		expect(diagnostics(text).map((d) => d.code)).toEqual(['call-argument-type-mismatch', 'assignment-type-mismatch']);
	});

	it('does not let an uncalled function body change the current outer value', () => {
		const text = 'local value = 1\nlocal function later() value = "bad" end\nmath.abs(value)\nprint(later)';
		expect(diagnostics(text)).toEqual([]);
	});

	it('starts alternatives from the same incoming bindings and merges possible writes', () => {
		const text = 'local value = 1\nif math.random() > 0.5 then\n value = "bad"\nelse\n math.abs(value)\nend\nmath.abs(value)';
		expect(diagnostics(text).map((d) => d.range.start.line)).toEqual([6]);
		const inferred = inspect(text + '\nlocal after = value').find((v) => v.name === 'after');
		expect(sluaTypeToString(inferred!.type)).toBe('number | string');
		const { ast, pos } = atCursor(text + '\nprint($value)');
		expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('value')!)).toBe('number | string');
	});

	it('shares guards with inlay types without leaking into outer scope', () => {
		const text = 'local function check(key: number?)\n if key then\n  local inside = key\n  key = nil\n  local changed = key\n end\n local outside = key\nend\nprint(check)';
		const types = new Map(inspect(text).map((v) => [v.name, sluaTypeToString(v.type)]));
		expect(types.get('inside')).toBe('number');
		expect(types.get('changed')).toBe('nil');
		expect(types.get('outside')).toBe('nil');
	});

	it.each(['if item then', 'if not item then\n print(item)\nelse'])('shares guarded custom types with cursor completion: %s', (guard) => {
		const { text, ast, pos } = atCursor(`local function check(item: DetectedEvent?)\n ${guard}\n item:$getGroup()\nend\nend\nprint(check)`);
		expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('item')!)).toBe('DetectedEvent');
		expect(getCompletions(ast, pos, registry, { sourceText: text, triggerCharacter: ':' }).some((c) => c.label === 'getGroup')).toBe(true);
	});

	it('shares assertions and assignment invalidation with cursor types', () => {
		for (const [statement, expected] of [['assert(key)', 'number'], ['assert(key)\n key = nil', 'nil']]) {
			const { ast, pos } = atCursor(`local function check(key: number?)\n ${statement}\n print($key)\nend\nprint(check)`);
			expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('key')!)).toBe(expected);
		}
	});

	it('does not leak a conditional assert into following inlays or diagnostics', () => {
		const text = 'local function check(key: number?, flag: boolean)\n local checked = flag and assert(key)\n local after = key\n print(checked, math.abs(key))\nend\nprint(check)';
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
		expect(sluaTypeToString(inspect(text).find((v) => v.name === 'after')!.type)).toBe('nil | number');
	});

	it.each(['if not key then return end', 'if key then print(key) else return end'])('uses the surviving path after an early return: %s', (guard) => {
		const text = `local function check(key: number?)\n ${guard}\n math.abs(key)\n local after = key\nend\nprint(check)`;
		expect(diagnostics(text)).toEqual([]);
		expect(sluaTypeToString(inspect(text).find((v) => v.name === 'after')!.type)).toBe('number');
		const { ast, pos } = atCursor(text.replace('math.abs(key)', 'math.abs($key)'));
		expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('key')!)).toBe('number');
	});

	it('preserves array identity for type(table) checks and honors directives', () => {
		const text = 'local function check(values: {number}, key: number?)\n if type(values) == "table" and key then print(values[key]) end\n -- slua-lsp:disable-next-line call-argument-type-mismatch\n math.abs(key)\nend\nprint(check)';
		expect(diagnostics(text)).toEqual([]);
	});

	it('narrows inside a while body and includes the zero-iteration path after loops', () => {
		const text = 'local function check(key: number?)\n while key do\n  math.abs(key)\n  key = nil\n end\nend\nlocal value = 1\nfor _ = 1, math.random() do value = "changed" end\nmath.abs(value)\nlocal after = value\nprint(after, check)';
		expect(diagnostics(text).map((d) => d.code)).toEqual(['call-argument-type-mismatch']);
		expect(sluaTypeToString(inspect(text).find((v) => v.name === 'after')!.type)).toBe('number | string');
		const { ast, pos } = atCursor('local function check(key: number?)\n while key do\n math.abs($key)\n key = nil\n end\nend\nprint(check)');
		expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('key')!)).toBe('number');
	});
});
