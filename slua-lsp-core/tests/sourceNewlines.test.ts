import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { parseDirectives } from '../src/diagnostics/directives.js';
import { classifySemanticTokens } from '../src/semanticTokens/classify.js';
import { getCodeActions } from '../src/typing/codeActions.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { getDocumentSymbols } from '../src/typing/documentSymbols.js';
import { preprocessSource, mapPreprocessedPosition } from '../src/workspace/preprocessSource.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
describe('source newline syntax and editor positions', () => {
	it('uses structured offsets for lexical errors after a bare CR without a conflicting raw LF line number', () => {
		const result = parseSlua('-- header\r!bad');
		expect(result.diagnostics[0]!.range.start).toEqual({ line: 1, character: 0 });
		expect(result.diagnostics[0]!.message).toBe('Unexpected character: !');
	});
	it.each(['\n', '\r', '\r\n'])('ends a line comment before %j and rejects the following invalid statement', (eol) => {
		expect(parseSlua('-- comment' + eol + 'local =').diagnostics.some((d) => d.code === 'parse-error')).toBe(true);
	});
	it.each(['\n', '\r', '\r\n'])('rejects an unescaped %j in a short quoted string', (eol) => {
		expect(parseSlua('print("first' + eol + 'second")').diagnostics.some((d) => d.code === 'parse-error')).toBe(true);
		expect(parseSlua('print("first\\' + eol + 'second")').diagnostics).toEqual([]);
	});
	it.each(['\n', '\r', '\r\n'])('uses editor lines for declarations, diagnostics, semantic tokens and directives: %j', (eol) => {
		const text = ['-- 😀', 'local value=42', 'print(missing)', '-- slua-lsp:disable-next-line undeclared-name', 'print(also_missing)'].join(eol);
		const parsed = parseSlua(text); expect(parsed.diagnostics).toEqual([]);
		expect(getDocumentSymbols(parsed.ast)[0]!.selectionRange.start).toEqual({ line: 1, character: 6 });
		const diagnostics = analyzeTextWithDirectives(text, { ast: parsed.ast, registry });
		expect(diagnostics.some((d) => d.range.start.line === 2 && d.message.includes('missing'))).toBe(true);
		expect(diagnostics.some((d) => d.range.start.line === 4)).toBe(false);
		expect(parseDirectives(text)).toEqual([{ kind: 'disable-next-line', line: 3, codes: ['undeclared-name'] }]);
		for (const token of classifySemanticTokens(text, { ast: parsed.ast })) expect(token.character + token.length).toBeLessThanOrEqual(text.split(/\r\n|\r|\n/)[token.line]!.length);
	});
	it('keeps native LF grammar positions internal while mapping mixed newline long-string source ranges', () => {
		const text = '-- start\rlocal value=[[a\rb\nc]]\rprint(value)';
		const parsed = parseSlua(text); expect(parsed.diagnostics).toEqual([]);
		const symbol = getDocumentSymbols(parsed.ast)[0]!;
		expect(symbol.selectionRange.start).toEqual({ line: 1, character: 6 });
		expect(symbol.range.end).toEqual({ line: 3, character: 3 });
	});
	it('builds a suppression edit with a bare-CR delimiter at the actual diagnostic line', () => {
		const text = '-- header\rprint(missing)'; const parsed = parseSlua(text);
		const diagnostics = analyzeTextWithDirectives(text, { ast: parsed.ast, registry });
		const action = getCodeActions(text, parsed.ast, diagnostics).find((item) => item.title.startsWith('Suppress'))!;
		expect(action.edits[0]).toEqual({ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '-- slua-lsp:disable-next-line undeclared-name\r' });
	});
	it('preserves raw CR bytes in generation while mapping copied source and explicit line macros as editor positions', async () => {
		const text = '-- header\rprint(__LINE__)\rprint("owned")';
		const result = await preprocessSource('/project/main.luau', { entryText: text, context: {}, readFile: async () => undefined });
		expect(result.success).toBe(true); expect(result.content).toBe('-- header\rprint(2)\rprint("owned")');
		expect(mapPreprocessedPosition(result, { line: 2, character: 7 })).toEqual({ file: '/project/main.luau', position: { line: 2, character: 7 } });
		expect(mapPreprocessedPosition(result, { line: 1, character: 6 })).toEqual({ file: '/project/main.luau', position: { line: 1, character: 6 } });
	});
	it('keeps a trailing CR module copy separate from the synthetic wrapper newline', async () => {
		const result = await preprocessSource('/project/main.luau', { entryText: 'print(require("mod"))', readFile: async (file) => file === '/project/mod.luau' ? 'return 42\r' : undefined });
		expect(result.success).toBe(true);
		expect(result.content).toContain('return 42\rend,');
		expect(mapPreprocessedPosition(result, { line: 4, character: 7 })).toEqual({ file: '/project/mod.luau', position: { line: 0, character: 7 } });
	});
});
