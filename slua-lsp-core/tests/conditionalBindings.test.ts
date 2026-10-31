import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, analyzeTextWithDirectives, getHover, getCompletions,
	getDocumentSymbols, findDefinitionAtPosition, findAllReferences, getRenameEdits, classifySemanticTokens,
	inferLocalVariableTypes, sluaTypeToString, visitAst, withSourceContext, getVisibleLocalTypes } from '../src/index.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function program(text: string) { const result = parseSlua(text); expect(result.diagnostics).toEqual([]); return result.ast; }
function cursor(marked: string) {
	const offset = marked.indexOf('$'), text = marked.replace('$', ''), lines = text.slice(0, offset).split('\n');
	return { text, ast: program(text), pos: { line: lines.length - 1, character: lines.at(-1)!.length } };
}
function hover(marked: string) { const { ast, pos } = cursor(marked); return getHover(ast, pos, registry); }
function diagnostics(text: string) { program(text); return analyzeTextWithDirectives(text, { registry }); }

describe('pinned native conditional bindings', () => {
	it.each([
		'if local value = 1 then print(value) end',
		'if const value: number? = 1 then print(value) end',
		'if false then print(0) elseif local value = 2 then print(value) elseif const other = 3 then print(other) else print(4) end',
		'local result = if local value = 1 then value elseif const other = 2 then other else 0\nprint(result)',
		'if local outer = {value=1} then if local inner = outer.value then print(inner) end end',
		'local result = if local outer = {value=1} then (if local inner = outer.value then inner else 0) else 0\nprint(result)',
		'if local value = if true then 1 else 2 then print(value) end',
		'if\n-- binding\nlocal value\n=\n1\nthen print(value) end'
	])('parses statements, expressions, chaining and trivia: %s', (source) => { program(source); });
	it.each([
		'if local value then end', 'if const value then end', 'if local a,b=1 then end',
		'if local value=1,2 then end', 'if local = 1 then end', 'local result=if local value=1 then value',
		'if local value: = 1 then end', 'while local value=1 do end'
	])('rejects malformed or unsupported native syntax: %s', (source) => { expect(parseSlua(source).diagnostics.length).toBeGreaterThan(0); });
	it('preserves contextual const as an ordinary condition and call', () => {
		expect(diagnostics('local const = function() return true end\nif const() then print(const) end\nlocal result=if const then const() else false\nprint(result)')).toEqual([]);
	});
	it('binds only the true branch and resolves the initializer, else and following text to the outer name', () => {
		const text = 'local value="outer"\nif local value=tonumber(value) then\nprint(value)\nelse\nprint(value)\nend\nprint(value)';
		const ast = program(text);
		for (const [line, character, expectedLine] of [[1, 24, 0], [2, 7, 1], [4, 7, 0], [6, 7, 0]]) {
			expect(findDefinitionAtPosition(ast, { line: line!, character: character! }, registry, text)?.identifier.location?.start.line).toBe(expectedLine! + 1);
		}
		expect(findAllReferences(ast, { line: 2, character: 7 }, registry, true)).toHaveLength(2);
		expect(getRenameEdits(ast, { line: 2, character: 7 }, 'inner', registry)).toHaveLength(2);
	});
	it('reports actual missing outer names without declaring the conditional name early or leaking it', () => {
		const text = 'if local value=value then print(value) elseif value then print(0) else print(value) end\nprint(value)';
		expect(diagnostics(text).filter((d) => d.code === 'undeclared-name')).toHaveLength(4);
		const expr = 'local result=if local value=value then value else value\nprint(result,value)';
		expect(diagnostics(expr).filter((d) => d.code === 'undeclared-name')).toHaveLength(3);
	});
	it('narrows the bound first return value without narrowing the outer optional input', () => {
		const text = 'local function use(input: number?)\nif local value=input then\nmath.abs(value)\nlocal copy=value\nend\nmath.abs(input)\nend\nprint(use)';
		expect(diagnostics(text).map((d) => [d.code, d.range.start.line])).toEqual([['call-argument-type-mismatch', 5]]);
		const inferred = inferLocalVariableTypes(program(text), registry);
		expect(sluaTypeToString(inferred.find((v) => v.name === 'copy')!.type)).toBe('number');
		expect(hover(text.replace('math.abs(value)', 'math.abs(va$lue)'))?.markdown).toContain('value: number');
	});
	it('uses the bound type inside expressions and local return inference', () => {
		const text = 'local function use(input: number?)\nreturn if local value=input then math.abs(value) else 0\nend\nlocal result=use(nil)\nmath.abs(result)';
		expect(diagnostics(text)).toEqual([]);
		expect(hover(text.replace('math.abs(value)', 'math.abs(va$lue)'))?.markdown).toContain('value: number');
		expect(hover(text.replace('math.abs(result)', 'math.abs(re$sult)'))?.markdown).toContain('result: number');
	});
	it('checks initializer annotations before truthy narrowing and permits later nullable writes', () => {
		expect(diagnostics('if local value: number?=1 then value=nil; print(value) end')).toEqual([]);
		expect(diagnostics('if local value: number="bad" then print(value) end').map((d) => d.code)).toEqual(['assignment-type-mismatch']);
		expect(diagnostics('local result=if local value: number="bad" then value else 0\nprint(result)').map((d) => d.code)).toEqual(['assignment-type-mismatch']);
	});
	it('preserves mutable branch shadowing of runtime modules and callable locals', () => {
		expect(diagnostics('if local math={abs=function(value: string) return value end} then math.abs("ok") end\nmath.abs(1)')).toEqual([]);
		expect(diagnostics('local result=if local math={abs=function(value: string) return value end} then math.abs("ok") else "none"\nprint(result)')).toEqual([]);
	});
	it.each(['value=2', 'value+=2', 'function value() end', 'local function change() value=2 end'])('rejects immutable writes with native parse diagnostics: %s', (write) => {
		const result = parseSlua('if const value=1 then\n-- slua-lsp:disable all\n' + write + '\nend');
		expect(result.diagnostics.filter((d) => d.message.includes('constant and may not be reassigned'))).toHaveLength(1);
	});
	it('keeps const table contents mutable and independent local shadows assignable', () => {
		expect(diagnostics('if const value={count=1} then value.count+=1; do local value=2; value+=1; print(value) end end')).toEqual([]);
	});
	it('keeps constructor and context macro shadow analysis on the same lexical binding graph', () => {
		const text = 'if local uuid=function(value) return value end then print(uuid("x")) end\nprint(uuid("00000000-0000-0000-0000-000000000000"))';
		const ast = program(text); expect(findAllReferences(ast, { line: 0, character: 58 }, registry, true)).toHaveLength(2);
	});
	it('offers the binding as readonly only inside its branch and includes its outline', () => {
		const marked='if const value=1 then\nprint(va$lue)\nelse\nprint(0)\nend', { ast, pos, text }=cursor(marked);
		expect(getHover(ast, pos, registry)?.readonly).toBe(true);
		expect(getCompletions(ast, pos, registry, { invoked: true, sourceText: text }).find((item) => item.label === 'value')?.kind).toBe('constant');
		expect(getDocumentSymbols(ast).map((item) => item.name)).toContain('value');
		const tokens=classifySemanticTokens(text,{ast});
		expect(tokens.find((item) => item.line===0 && item.character===3)?.tokenType).toBe('keyword');
		expect(tokens.find((item) => item.line===0 && item.character===9)?.modifiers).toEqual(['declaration','readonly']);
		expect(tokens.find((item) => item.line===1 && item.character===6)?.modifiers).toContain('readonly');
	});
	it('does not leak branch assignments into the shadowed outer value', () => {
		expect(diagnostics('local value=1\nif local value="inner" then value="changed"; print(value) end\nmath.abs(value)')).toEqual([]);
		expect(hover('local value=1\nif local value="inner" then value="changed"; print(value) end\nmath.abs(va$lue)')?.markdown).toContain('value: number');
	});
	it.each(['', 'print(value)\n'])('retains the successful binding at an empty completion line before else: %s', (body) => {
		const { ast, pos } = cursor('local value="outer"\nif const value=42 then\n' + body + ' $ \nelse\nprint(value)\nend');
		expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('value')!)).toBe('number');
	});
	it.each(['\n', '\r\n', '\r'])('keeps ordinary then/else completion scopes at blank lines with %j', (eol) => {
		for (const marked of [
			'local value="outer"\nif true then\nlocal value=42\n $ \nelse\nprint(value)\nend',
			'local value="outer"\nif false then\nprint(value)\nelse\nlocal value=42\n $ \nend'
		]) {
			const { text, pos } = cursor(marked);
			const ast = program(text.replaceAll('\n', eol));
			expect(sluaTypeToString(getVisibleLocalTypes(ast, pos, registry).get('value')!)).toBe('number');
		}
	});
	it('shares conditional shadow identity with enabled macro context and constructor safety', () => {
		const context = { agentId: '12345678-1234-1234-1234-123456789abc' };
		const good = 'if local __LINE__=42 then math.abs(__LINE__) end\nprint(__LINE__)';
		const ast = program(good), scoped = withSourceContext(ast, '/tmp/context.luau', registry, context);
		expect(analyzeTextWithDirectives(good, { ast, registry: scoped })).toEqual([]);
		const bad = 'if local uuid=function(value) return value end then print(__AGENTKEY__) end';
		const parsed = program(bad), unsafe = withSourceContext(parsed, '/tmp/context.luau', registry, context);
		expect(analyzeTextWithDirectives(bad, { ast: parsed, registry: unsafe }).map((d) => d.code)).toEqual(['preprocessor-context']);
	});
	it('keeps declaration, initializer and branch ranges in original UTF-16 CRLF coordinates', () => {
		const text='print("😀")\r\nif const value=1 then print(value) end', ast=program(text), bindings: unknown[]=[];
		visitAst(ast,(node)=>{ if (node.type==='IfStatement') bindings.push((node as { conditionLocal?: unknown }).conditionLocal); });
		expect(bindings).toMatchObject([{name:'value',location:{start:{line:2,column:10},end:{line:2,column:15}}}]);
	});
});
