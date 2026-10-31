import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, getCompletions, getHover, getDocumentSymbols,
	classifySemanticTokens, findDefinitionAtPosition, findAllReferences, getRenameEdits, analyzeTextWithDirectives,
	inferLocalVariableTypes, sluaTypeToString, visitAst } from '../src/index.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function program(source: string) { const result = parseSlua(source); expect(result.diagnostics).toEqual([]); return result.ast; }

describe('current native contextual const bindings', () => {
	it.each([
		'local function value(): number const result = 3; return result end',
		'local value = function(): number const result = 3; return result end'
	])('retains the declaration rather than absorbing it into a return annotation: %s', (source) => {
		const ast = program(source); const declarations: unknown[] = []; const functions: Array<{ type: string; returnTypeAnnotation?: unknown }> = [];
		visitAst(ast, (node) => {
			if ((node as { isConst?: boolean }).isConst && node.type === 'LocalStatement') declarations.push(node);
			if (node.type === 'Function' || node.type === 'FunctionDeclaration') functions.push(node);
		});
		expect(declarations).toHaveLength(1); expect(functions[0]?.returnTypeAnnotation).toBe('number');
	});
	it('shares const binding identity, rename proposals and readonly source inspection', () => {
		const source = 'const count: number = 1\nprint(count)'; const ast = program(source); const position = { line: 1, character: 8 };
		expect(findDefinitionAtPosition(ast, position, registry, source)?.identifier.name).toBe('count');
		expect(findAllReferences(ast, position, registry, true)).toHaveLength(2);
		expect(getRenameEdits(ast, position, 'const', registry)).toHaveLength(2);
		const hover = getHover(ast, position, registry); expect(hover?.readonly).toBe(true); expect(hover?.markdown).toContain('const count: number');
		expect(getDocumentSymbols(ast)).toMatchObject([{ name: 'count', kind: 'variable', detail: 'const number' }]);
		const completion = getCompletions(ast, position, registry, { invoked: true, sourceText: source }).find((item) => item.label === 'count');
		expect(completion?.kind).toBe('constant'); expect(completion?.detail).toContain('const number');
	});
	it('keeps table fields mutable while rejecting rebinding across closures and assignment forms', () => {
		const source = 'const values = {count = 1}\nvalues.count += 1\nvalues["extra"] = 2\nprint(values)'; program(source);
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
		for (const update of ['value = 2', 'value += 2', 'value, other = 2, 3', 'local function update() value = 2 end']) {
			const parsed = parseSlua('const value = 1\nlocal other\n' + update);
			expect(parsed.diagnostics.filter((d) => d.message.includes('constant and may not be reassigned'))).toHaveLength(1);
		}
	});
	it('does not let semantic directives suppress native const syntax errors', () => {
		const parsed = parseSlua('const value = 1\n-- slua-lsp:disable all\nvalue = 2');
		expect(parsed.diagnostics).toMatchObject([{ code: 'parse-error', range: { start: { line: 2, character: 0 } } }]);
	});
	it('marks only actual contextual keywords and immutable bindings, preserving mutable shadows', () => {
		const source = 'const count = 1\ndo local count = 2; print(count) end\nprint(count)\nlocal const = function(value) return value end\nconst("text")';
		const tokens = classifySemanticTokens(source, { ast: program(source) });
		expect(tokens.find((item) => item.line === 0 && item.character === 0)?.tokenType).toBe('keyword');
		expect(tokens.find((item) => item.line === 0 && item.character === 6)?.modifiers).toEqual(['declaration', 'readonly']);
		expect(tokens.find((item) => item.line === 2 && item.character === 6)?.modifiers).toContain('readonly');
		expect(tokens.filter((item) => item.line === 1).every((item) => !item.modifiers.includes('readonly'))).toBe(true);
		expect(tokens.find((item) => item.line === 4 && item.character === 0)?.tokenType).toBe('function');
		expect(tokens.find((item) => item.line === 4 && item.character === 0)?.modifiers).not.toContain('readonly');
	});
	it('preserves exact UTF-16 locations and namespace isolation around const text', () => {
		const source = 'print("😀 const fake = 1")\r\nconst value = 1\r\nvalue += 2'; const parsed = parseSlua(source);
		expect(parsed.diagnostics).toMatchObject([{ code: 'parse-error', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }]);
		expect(getDocumentSymbols(parsed.ast).map((item) => item.name)).toEqual(['value']);
		expect(classifySemanticTokens(source, { ast: parsed.ast }).filter((item) => item.tokenType === 'keyword' && item.length === 5)).toHaveLength(1);
	});
	it('keeps grouping single-valued when a call otherwise returns a pack', () => {
		const source = 'local function pair(): (number, string) return 1, "two" end\nlocal first, second = (pair())\nprint(first, second)'; const ast = program(source);
		const inferred = inferLocalVariableTypes(ast, registry);
		expect(inferred.find((item) => item.name === 'first')?.type).toMatchObject({ name: 'number' });
		expect(sluaTypeToString(inferred.find((item) => item.name === 'second')!.type)).toBe('nil');
	});
});
