import { describe, expect, it } from 'vitest';
import { getCodeActions, type CoreCodeAction } from '../src/typing/codeActions.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function actions(text: string) {
	const parsed = parseSlua(text);
	expect(parsed.diagnostics).toEqual([]);
	const diagnostics = analyzeTextWithDirectives(text, { ast: parsed.ast, registry });
	return getCodeActions(text, parsed.ast, diagnostics);
}
function apply(text: string, action: CoreCodeAction): string {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	const edits = action.edits.map((edit) => ({ ...edit, start: starts[edit.range.start.line]! + edit.range.start.character, end: starts[edit.range.end.line]! + edit.range.end.character }));
	for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
	return text;
}

describe('code actions', () => {
	it('changes only the actual separator across comments and newline continuations', () => {
		const source = 'local timers = LLTimers\ntimers -- . :\n . -- . :\n once(0, function() end)';
		const fix = actions(source).find((a) => a.isPreferred)!;
		expect(fix.title).toContain(':');
		expect(fix.edits).toHaveLength(1);
		expect(fix.edits[0]!.newText).toBe(':');
		const changed = apply(source, fix);
		expect(changed).toBe(source.replace(' . -- . :', ' : -- . :'));
		expect(actions(changed).filter((a) => a.isPreferred)).toEqual([]);
	});

	it('provides the inverse fix for a module colon call with UTF-16 ranges', () => {
		const source = 'local s = "😀"; lljson:encode(s)';
		const fix = actions(source).find((a) => a.isPreferred)!;
		expect(fix.edits[0]!.range.start.character).toBe(source.indexOf(':'));
		expect(apply(source, fix)).toBe(source.replace('lljson:', 'lljson.'));
	});

	it('does not alter member values, valid explicit self, shadowed tables or literal text', () => {
		const source = 'local method = LLEvents.on\nLLEvents.on(LLEvents, "listen", function() end)\nlocal LLTimers = {}; LLTimers.once(0)\nprint("LLTimers.once")';
		expect(actions(source)).toEqual([]);
	});

	it('suppresses one semantic code on one line while preserving indentation and CRLF', () => {
		const source = 'do\r\n\tmissing()\r\n\tother()\r\nend';
		const suppression = actions(source).find((a) => a.diagnostics[0]!.range.start.line === 1 && !a.isPreferred)!;
		expect(suppression.edits[0]!.newText).toBe('\t-- slua-lsp:disable-next-line undeclared-name\r\n');
		const remaining = analyzeTextWithDirectives(apply(source, suppression), { registry }).filter((d) => d.code === 'undeclared-name');
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.message).toContain('other');
	});

	it('merges a previous next-line directive so its existing suppression is preserved', () => {
		const source = '-- slua-lsp:disable-next-line use-colon-call\nLLTimers.once(0, missing)';
		const suppression = actions(source).find((a) => !a.isPreferred && a.diagnostics[0]!.code === 'undeclared-name')!;
		const changed = apply(source, suppression);
		expect(changed).toContain('use-colon-call, undeclared-name');
		expect(analyzeTextWithDirectives(changed, { registry }).some((d) => ['use-colon-call', 'undeclared-name'].includes(d.code))).toBe(false);
	});

	it('filters fixes by the requested range and does not return duplicates', () => {
		const source = 'LLTimers.once(0, function() end)\nlljson:encode(3)';
		const parsed = parseSlua(source);
		const diagnostics = analyzeTextWithDirectives(source, { registry, ast: parsed.ast });
		const selected = getCodeActions(source, parsed.ast, [...diagnostics, ...diagnostics], { start: { line: 1, character: 7 }, end: { line: 1, character: 7 } });
		expect(selected.filter((a) => a.isPreferred)).toHaveLength(1);
		expect(selected.every((a) => a.diagnostics[0]!.range.start.line === 1)).toBe(true);
	});

	it('never inserts a suppression comment into a multiline string literal', () => {
		const source = 'print([=[\nmissing\n]=])';
		const parsed = parseSlua(source);
		const fake = { code: 'undeclared-name', message: 'missing', severity: 'warning' as const, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 7 } } };
		expect(getCodeActions(source, parsed.ast, [fake])).toEqual([]);
	});
});
