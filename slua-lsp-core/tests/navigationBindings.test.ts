import { describe, expect, test } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { findDefinitionAtPosition } from '../src/typing/findDefinition.js';
import { findAllReferences } from '../src/typing/findReferences.js';
import { getRenameEdits, prepareRename } from '../src/typing/rename.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function fixture(source: string) {
	const parsed = parseSlua(source);
	expect(parsed.diagnostics).toEqual([]);
	return {
		ast: parsed.ast,
		position(needle: string, last = false) {
			const offset = last ? source.lastIndexOf(needle) : source.indexOf(needle);
			expect(offset).toBeGreaterThanOrEqual(0);
			const prefix = source.slice(0, offset).split('\n');
			return { line: prefix.length - 1, character: prefix.at(-1)!.length };
		}
	};
}

describe('lexical navigation safety', () => {
	test('definition works on declarations and ordinary/compound assignment targets', () => {
		const { ast, position } = fixture('local count = 0\ncount = 1\ncount += 2\nprint(count)');
		for (const needle of ['count = 0', 'count = 1', 'count +=', 'count)']) {
			expect(findDefinitionAtPosition(ast, position(needle), registry)?.identifier.location?.start.line).toBe(1);
			expect(findAllReferences(ast, position(needle), registry)).toHaveLength(4);
		}
	});
	test('member definitions stay separate from same-named lexical references and rename', () => {
		const { ast, position } = fixture('local value = 1\nlocal object = {value = value}\nprint(object.value, value)');
		const refs = findAllReferences(ast, position('value = 1'), registry);
		expect(refs).toHaveLength(3);
		for (const needle of ['value = value', 'value, value']) {
			expect(findDefinitionAtPosition(ast, position(needle), registry)?.kind).toBe('field');
			expect(prepareRename(ast, position(needle), registry)).toBeNull();
		}
	});
	test('computed table keys, index expressions and assignment bases remain local references', () => {
		const { ast, position } = fixture('local key = "x"\nlocal object = {[key] = 1, key = 2}\nobject[key] = object[key] + 1');
		expect(findAllReferences(ast, position('key = "x"'), registry)).toHaveLength(4);
		expect(findAllReferences(ast, position('object ='), registry)).toHaveLength(3);
		expect(findDefinitionAtPosition(ast, position('object[key]'), registry)?.identifier.location?.start.line).toBe(2);
	});
	test('while body locals do not leak and are not traversed twice', () => {
		const { ast, position } = fixture('local value = 1\nwhile value > 0 do\n local value = 2\n print(value)\n break\nend\nprint(value)');
		expect(findAllReferences(ast, position('value = 1'), registry)).toHaveLength(3);
		expect(findAllReferences(ast, position('value = 2'), registry)).toHaveLength(2);
		expect(findDefinitionAtPosition(ast, position('value)', true), registry)?.identifier.location?.start.line).toBe(1);
	});
	test('repeat condition sees body locals, while condition sees the outer binding', () => {
		const { ast, position } = fixture('local value = 1\nrepeat\n local value = 2\nuntil value > 0\nprint(value)');
		expect(findDefinitionAtPosition(ast, position('value >'), registry)?.identifier.location?.start.line).toBe(3);
		expect(findAllReferences(ast, position('value = 2'), registry)).toHaveLength(2);
		expect(findAllReferences(ast, position('value = 1'), registry)).toHaveLength(2);
	});
	test('local initializer uses the previous binding and recursive local functions use their own', () => {
		const { ast, position } = fixture('local value = 1\ndo\n local value = value + 1\n print(value)\nend\nlocal function recur(n)\n if n > 0 then return recur(n - 1) end\nend\nrecur(value)');
		expect(findDefinitionAtPosition(ast, position('value +'), registry)?.identifier.location?.start.line).toBe(1);
		expect(findAllReferences(ast, position('value = 1'), registry)).toHaveLength(3);
		expect(findAllReferences(ast, position('recur(n)'), registry)).toHaveLength(3);
	});
	test('function statements assigning an existing local are usages, not a new binding', () => {
		const { ast, position } = fixture('local handler\nfunction handler(n)\n return n\nend\nhandler(1)');
		expect(findAllReferences(ast, position('handler\n'), registry)).toHaveLength(3);
		expect(findDefinitionAtPosition(ast, position('handler(n)'), registry)?.identifier.location?.start.line).toBe(1);
	});
	test('method receivers use their binding, method names and implicit self do not capture outer locals', () => {
		const { ast, position } = fixture('local self = 1\nlocal method = 2\nlocal object = {}\nfunction object:method()\n return self\nend\nprint(self, method)');
		expect(findAllReferences(ast, position('self ='), registry)).toHaveLength(2);
		expect(findAllReferences(ast, position('method ='), registry)).toHaveLength(2);
		expect(findAllReferences(ast, position('object ='), registry)).toHaveLength(2);
		expect(prepareRename(ast, position('self\n'), registry)).toBeNull();
	});
	test('rename refuses capture of selected uses by an inner binding', () => {
		const { ast, position } = fixture('local source = 1\ndo\n local target = 2\n print(source, target)\nend');
		expect(getRenameEdits(ast, position('source ='), 'target', registry)).toEqual([]);
	});
	test('rename refuses to capture previously unbound names or another local', () => {
		for (const source of ['local source = 1\nprint(source, target)', 'local target = 2\nlocal source = 1\nprint(source, target)']) {
			const { ast, position } = fixture(source);
			expect(getRenameEdits(ast, position('source ='), 'target', registry)).toEqual([]);
		}
	});
	test('rename permits harmless names in disjoint scopes and excludes strings/comments', () => {
		const { ast, position } = fixture('do local target = 2; print(target) end\nlocal source = 1\nprint(source, "source") -- source');
		expect(getRenameEdits(ast, position('source ='), 'target', registry)).toHaveLength(2);
	});
	test('UTF-16 and CRLF references preserve exact identifier ranges', () => {
		const { ast, position } = fixture('local value = 1\r\nprint("😀", value)\r\n');
		const refs = findAllReferences(ast, position('value ='), registry);
		expect(refs).toHaveLength(2);
		expect(refs[1]!.identifier.location).toEqual({ start: { line: 2, column: 13 }, end: { line: 2, column: 18 } });
	});
	test('type declarations do not count as references to a same-named value', () => {
		const { ast, position } = fixture('local Value = 1\ntype Value = number\nprint(Value)');
		expect(findAllReferences(ast, position('Value = 1'), registry)).toHaveLength(2);
		expect(prepareRename(ast, position('Value = number'), registry)).toBeNull();
	});
	test('safe renames in class methods retain implicit self identity across binding checks', () => {
		const { ast, position } = fixture('class Point\n function identity()\n  return self\n end\nend\nlocal p = Point.new()\nprint(p)');
		expect(getRenameEdits(ast, position('Point\n'), 'Vertex', registry)).toHaveLength(2);
		expect(getRenameEdits(ast, position('p ='), 'point', registry)).toHaveLength(2);
		expect(prepareRename(ast, position('self\n'), registry)).toBeNull();
	});
});
