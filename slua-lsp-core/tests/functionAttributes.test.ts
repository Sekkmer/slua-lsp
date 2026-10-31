import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { Lexer, TokenType } from '../src/luau/vendor/clients/lexer.js';
import type { Program, FunctionDeclaration } from '../src/luau/vendor/types.js';

const native = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/function-attributes.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; expectedNative: { syntax: number } }>;

describe('ordinary source function attributes', () => {
	it.each(native.filter((row) => row.name !== 'debugnoinline-enabled'))('$name matches the pinned native syntax', ({ source, expectedNative }) => {
		const result = parseSlua(source);
		expect(result.diagnostics, source).toEqual(expectedNative.syntax === 0 ? [] : expect.arrayContaining([expect.objectContaining({ code: 'parse-error' })]));
	});
	const literals = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/function-attribute-literals.json', import.meta.url), 'utf8')) as typeof native;
	it.each(literals)('$name preserves native literal distinctions', ({ source, expectedNative }) => { expect(parseSlua(source).diagnostics.length === 0).toBe(expectedNative.syntax === 0); });
	it('tokenizes @ as punctuation without changing comments or strings', () => {
		const source = '-- @unknown\nlocal text="@checked"\n@native function answer() return 42 end';
		const tokens = new Lexer(source).tokenize(source);
		expect(tokens.filter((token) => token.value === '@')).toEqual([expect.objectContaining({ type: TokenType.AT, start: source.indexOf('@native'), end: source.indexOf('@native') + 1 })]);
		expect(tokens.filter((token) => token.type === TokenType.COMMENT).map((token) => token.value)).toEqual(['-- @unknown']);
	});
	it('preserves the complete same-line declaration, body and ordered metadata', () => {
		const source = '@native @[checked,deprecated{use="new",reason="old"}] local function answer(): number return 42 end\nanswer()';
		const result = parseSlua(source);
		expect(result.diagnostics).toEqual([]);
		const ast = result.ast as Program;
		const fn = ast.body[0] as FunctionDeclaration;
		expect(ast.body).toHaveLength(2);
		expect(fn.identifier).toMatchObject({ type: 'Identifier', name: 'answer' });
		expect(fn.body).toMatchObject([{ type: 'ReturnStatement', arguments: [{ type: 'Number', value: 42 }] }]);
		expect(fn.attributes?.map((attribute) => attribute.name)).toEqual(['native', 'checked', 'deprecated']);
		expect(fn.location?.start).toEqual({ line: 1, column: 1 });
	});
	it('keeps attribute, identifier and body locations in UTF16 across CRLF', () => {
		const source = 'local text="😀"\r\n@[deprecated{reason="😀"}] local function answer() return text end';
		const result = parseSlua(source);
		expect(result.diagnostics).toEqual([]);
		const fn = (result.ast as Program).body[1] as FunctionDeclaration;
		expect(fn.location?.start).toEqual({ line: 2, column: 1 });
		expect(fn.identifier?.location?.start).toEqual({ line: 2, column: source.split('\r\n')[1]!.indexOf('answer') + 1 });
		expect(fn.attributes?.[0]?.location?.start).toEqual({ line: 2, column: 3 });
	});
	it.each(['@unknown', '@[native,]', '@[deprecated{bad="x"}]', '@[native(value)]'])('recovers a later function after %s', (prefix) => {
		const result = parseSlua(prefix+'\nlocal function kept() return 42 end\nkept()');
		expect(result.diagnostics.some((item) => item.code === 'parse-error')).toBe(true);
		expect((result.ast as Program).body).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'FunctionDeclaration', identifier: expect.objectContaining({ name: 'kept' }) })]));
	});
	it.each([
		'local f: typeof(@unknown function() end)',
		'type F=typeof(@unknown function() end)',
		'local f: typeof(@[native(value)] function() end)',
		'local f: typeof(@checked ()->number)',
		'local f: typeof(function(value: @checked ()->number) end)',
	])('validates attributes inside typeof values: %s', (source) => {
		expect(parseSlua(source).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'parse-error' })]));
	});
});

import { analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, getCompletions, getHover, getSignatureHelp, findDefinitionAtPosition, findAllReferences, getRenameEdits, classifySemanticTokens } from '../src/index.js';
const registry = buildSluaRegistryFromLslDefinitions(null);
const attributed = '@[native,checked]\nlocal function double(value: number): number return value*2 end\nlocal alias=double\nassert(alias(21)==42)\n';
describe('attributed function bindings', () => {
	it('keeps local bindings, parameters, aliases and body analysis', () => {
		const parsed = parseSlua(attributed);
		expect(parsed.diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(attributed, { ast: parsed.ast, registry })).toEqual([]);
		const wrong = attributed.replace('alias(21)', 'alias("bad")');
		expect(analyzeTextWithDirectives(wrong, { ast: parseSlua(wrong).ast, registry }).map((item) => item.code)).toEqual(['call-argument-type-mismatch']);
	});
	it('preserves navigation references rename and function signature through aliases', () => {
		const ast = parseSlua(attributed).ast;
		expect(findDefinitionAtPosition(ast, { line: 2, character: 14 }, registry)?.identifier.location?.start).toEqual({ line: 2, column: 16 });
		expect(findAllReferences(ast, { line: 2, character: 14 }, registry)).toHaveLength(2);
		expect(getRenameEdits(ast, { line: 2, character: 14 }, 'twice', registry)).toHaveLength(2);
		expect(getHover(ast, { line: 3, character: 9 }, registry)?.markdown).toContain('number');
		expect(getSignatureHelp(ast, { line: 3, character: 13 }, registry, attributed)?.signatures[0]?.parameters).toHaveLength(1);
		expect(getCompletions(ast, { line: 4, character: 0 }, registry, { sourceText: attributed }).map((item) => item.label)).toEqual(expect.arrayContaining(['double', 'alias']));
	});
	it('does not invent bindings or semantic variable references for metadata record keys', () => {
		const source='@[deprecated{use="next",reason="old"}] local function old() end\nold()';
		const ast=parseSlua(source).ast;
		expect(findDefinitionAtPosition(ast,{line:0,character:14},registry)).toBeNull();
		expect(getRenameEdits(ast,{line:0,character:14},'other',registry)).toEqual([]);
		expect(analyzeTextWithDirectives(source,{ast,registry}).map((item)=>item.code)).toEqual(['deprecated-function']);
		expect(classifySemanticTokens(source,{ast}).filter((item)=>item.line===0&&[13,24].includes(item.character)&&item.tokenType==='variable')).toEqual([]);
	});
});
