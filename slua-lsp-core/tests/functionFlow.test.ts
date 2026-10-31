import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { getVisibleLocalTypes } from '../src/typing/completion.js';
import { getCompletions } from '../src/typing/completion.js';
import { getBuiltinMemberHover } from '../src/typing/builtinHover.js';
import { sluaTypeToString } from '../src/slua/types.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const diagnostics = (text: string) => analyzeTextWithDirectives(text, { registry });
function types(text: string) {
	return new Map(inferLocalVariableTypes(parseSlua(text).ast, registry).map((v) => [v.name, sluaTypeToString(v.type)]));
}

describe('function returns and continuing branch contracts', () => {
	it('retains the pinned analyzer contract after branch-only assertions', () => {
		const text = 'local function check(value: number?, flag: boolean)\n if flag then assert(value) else assert(value) end\n local after = value\n math.abs(value)\nend\nprint(check)';
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
		expect(types(text).get('after')).toBe('nil | number');
		const ast = parseSlua(text).ast;
		expect(sluaTypeToString(getVisibleLocalTypes(ast, { line: 3, character: 12 }, registry).get('value')!)).toBe('nil | number');
	});

	it('does not assume an assertion executed in only one alternative', () => {
		const text = 'local function check(value: number?, flag: boolean)\n if flag then assert(value) end\n math.abs(value)\nend\nprint(check)';
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
	});

	it('preserves an incoming contract when a contradictory branch has no writes', () => {
		const text = 'local value = 1\nif typeof(value) == "string" then print(value) end\nlocal after = value\nmath.abs(value)';
		expect(types(text).get('after')).toBe('number');
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toEqual([]);
	});

	it('scopes typed function parameters over captured names', () => {
		const text = 'local value = "outer"\nlocal function identity(value: number) return value end\nlocal result = identity(3)\nprint(result, value)';
		expect(types(text).get('identity')).toBe('(number) -> number');
		expect(types(text).get('result')).toBe('number');
	});

	it.each(['local function requireNumber(value: number?)', 'local requireNumber = function(value: number?)'])('infers asserted returns in %s', (declaration) => {
		const text = `${declaration}\n assert(value)\n return value\nend\nlocal result = requireNumber(3)\nmath.abs(result)`;
		expect(types(text).get('result')).toBe('number');
		expect(diagnostics(text)).toEqual([]);
	});

	it('retains nil on an ordinary function fallthrough path', () => {
		const text = 'local function maybe(flag: boolean)\n if flag then return 1 end\nend\nlocal result = maybe(false)\nmath.abs(result)';
		expect(types(text).get('result')).toBe('nil | number');
		expect(diagnostics(text).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
	});

	it('unions the results of complete alternatives', () => {
		const text = 'local function choose(flag: boolean)\n if flag then return 1 else return "text" end\nend\nlocal result = choose(true)\nprint(result)';
		expect(types(text).get('result')).toBe('number | string');
		expect(diagnostics(text).map((d) => d.code)).toEqual(['inferred-return-type-mismatch']);
	});

	it('keeps tuple positions and missing return values across alternatives', () => {
		const text = 'local function choose(flag: boolean)\n if flag then return 1, "text" else return 2 end\nend\nlocal first, second = choose(true)\nprint(first, second)';
		expect(types(text).get('first')).toBe('number');
		expect(types(text).get('second')).toBe('nil | string');
		expect(diagnostics(text).map((d) => d.code)).toEqual(['inferred-return-count-mismatch']);
	});

	it('does not infer a recursive function from a captured same-named value', () => {
		const text = 'local check = function() return "outer" end\ndo\n local function check(value: number)\n  if value > 0 then return check(value - 1) end\n  return value\n end\n local result = check(2)\n print(result)\nend\nprint(check)';
		expect(types(text).get('result')).not.toBe('string');
	});

	it('shares returned native object types with completion and hover', () => {
		const text = 'local function requireItem(item: DetectedEvent?)\n assert(item)\n return item\nend\nlocal function inspect(item: DetectedEvent)\n local result = requireItem(item)\n print(result:getGroup())\nend\nprint(inspect)';
		expect(types(text).get('result')).toBe('DetectedEvent');
		const ast = parseSlua(text).ast;
		const pos = { line: 6, character: 17 };
		expect(getCompletions(ast, pos, registry, { sourceText: text }).some((item) => item.label === 'getGroup')).toBe(true);
		expect(getBuiltinMemberHover(ast, pos, registry)?.markdown).toContain('): boolean');
	});

	it('retains explicit unknown return annotations and honors diagnostic directives', () => {
		const text = 'local function opaque(): unknown return 1 end\nlocal result = opaque()\nlocal function maybe(flag: boolean): number? if flag then return 1 else return nil end end\n-- slua-lsp:disable-next-line call-argument-type-mismatch\nmath.abs(maybe(false))\nprint(result)';
		expect(types(text).get('result')).toBeUndefined();
		expect(diagnostics(text)).toEqual([]);
	});

	it('infers direct assert returns using the pinned single-result static contract', () => {
		const text = 'local function requireNumber(value: number?) return assert(value) end\nlocal result = requireNumber(1)\nlocal first = assert(result, "message")\nmath.abs(first)';
		expect(types(text).get('result')).toBe('number');
		expect(types(text).get('first')).toBe('number');
		expect(diagnostics(text)).toEqual([]);
	});

	it('checks declared parameter returns and guarded annotations using shared lexical types', () => {
		const bad = 'local function check(value: string): number return value end\nprint(check)';
		expect(diagnostics(bad).map((d) => d.code)).toEqual(['declared-return-type-mismatch']);
		const good = 'local function check(value: number?): number\n assert(value)\n return value\nend\nprint(check)';
		expect(diagnostics(good)).toEqual([]);
	});
});
