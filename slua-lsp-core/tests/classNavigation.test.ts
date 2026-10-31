import { classifySemanticTokens } from '../src/semanticTokens/classify.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { SourceTextIndex } from '../src/parser/sourceTextIndex.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { findDefinitionAtPosition } from '../src/typing/findDefinition.js';
import { findAllReferences } from '../src/typing/findReferences.js';
import { getRenameEdits, prepareRename } from '../src/typing/rename.js';

type Case = { name: string; source: string; newName: string; expectSafeRename: boolean; expectedRenameOffsets: number[]; expectedRenamedSource: string | null };
const cases = JSON.parse(readFileSync(new URL('../../scripts/fixtures/class-navigation.json', import.meta.url), 'utf8')) as Case[];
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('class type and value navigation', () => {
	it.each(cases)('$name preserves identities and exact type/value ranges', (item) => {
		const parsed = parseSlua(item.source), index = new SourceTextIndex(item.source);
		expect(parsed.diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(item.source, { ast: parsed.ast, registry })).toEqual([]);
		const declaration = item.source.indexOf('class Box') + 6, position = index.positionAt(declaration);
		const edits = getRenameEdits(parsed.ast, position, item.newName, registry);
		const offsets = edits.map((edit) => index.offsetAt({ line: edit.identifier.location!.start.line - 1, character: edit.identifier.location!.start.column - 1 })!).sort((a, b) => a - b);
		expect(offsets).toEqual(item.expectedRenameOffsets);
		if (!item.expectSafeRename) return;
		let renamed = item.source;
		for (const offset of [...offsets].reverse()) renamed = renamed.slice(0, offset) + item.newName + renamed.slice(offset + 3);
		expect(renamed).toBe(item.expectedRenamedSource);
		const reparsed = parseSlua(renamed);
		expect(reparsed.diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(renamed, { ast: reparsed.ast, registry })).toEqual([]);
		for (const offset of offsets) {
			const selected = index.positionAt(offset);
			const definition = findDefinitionAtPosition(parsed.ast, selected, registry, item.source);
			expect(definition?.kind).toBe('class');
			expect(definition?.identifier.location?.start).toEqual({ line: position.line + 1, column: position.character + 1 });
			const refs = findAllReferences(parsed.ast, selected, registry);
			expect(refs.map((ref) => index.offsetAt({ line: ref.identifier.location!.start.line - 1, character: ref.identifier.location!.start.column - 1 })).sort((a, b) => a! - b!)).toEqual(offsets);
			expect(findAllReferences(parsed.ast, selected, registry, false)).toHaveLength(offsets.length - 1);
			expect(prepareRename(parsed.ast, selected, registry)).toEqual({ placeholder: 'Box', range: { start: selected, end: { ...selected, character: selected.character + 3 } } });
			expect(getRenameEdits(parsed.ast, selected, item.newName, registry)).toHaveLength(offsets.length);
		}
	});

	it('renames a value parameter inside body typeof without changing the class type', () => {
		const source = 'class Box end\nlocal function f(Box: number) local value: typeof(Box)=Box\nreturn value end\nlocal item: Box=Box{}';
		const parsed = parseSlua(source), index = new SourceTextIndex(source);
		const offsets = getRenameEdits(parsed.ast, { line: 1, character: 17 }, 'valueArg', registry).map((edit) => index.offsetAt({ line: edit.identifier.location!.start.line - 1, character: edit.identifier.location!.start.column - 1 }));
		expect(offsets).toEqual([source.indexOf('Box: number'), source.indexOf('typeof(Box)') + 7, source.indexOf('=Box\n') + 1]);
	});
	it('refuses a partial rename through an unclassified annotation', () => {
		const source = 'class Box end\nlocal row: {first: Box\nsecond: Box}={first=Box{},second=Box{}}';
		const parsed = parseSlua(source);
		expect(getRenameEdits(parsed.ast, { line: 0, character: 6 }, 'Cell', registry)).toEqual([]);
	});

	it('retains typeof value references in a program without a class declaration', () => {
		const source = 'local value=1\ntype Value=typeof(value)\nlocal result: typeof(value)=value\nprint(result)';
		const parsed = parseSlua(source);
		expect(getRenameEdits(parsed.ast, { line: 0, character: 6 }, 'other', registry)).toHaveLength(4);
	});

	it('renames a qualified type prefix value while preserving its member name', () => {
		const source = 'local M={}\nlocal item: M.Item=nil\nprint(M,item)';
		const parsed = parseSlua(source);
		const refs = findAllReferences(parsed.ast, { line: 0, character: 6 }, registry);
		expect(refs).toHaveLength(3); expect(refs.every((entry) => entry.identifier.name === 'M')).toBe(true);
	});

	it.each(['continue', 'export', 'as', 'goto'])('retains %s class references through a type alias after rename', (newName) => {
		const source = 'class Box end\ntype Alias=Box\nlocal item: Alias=Box{}\nprint(item)', parsed = parseSlua(source);
		expect(getRenameEdits(parsed.ast, { line: 0, character: 6 }, newName, registry)).toHaveLength(3);
		const renamed = source.replace(/Box/g, newName), fresh = parseSlua(renamed);
		expect(fresh.diagnostics).toEqual([]);
		expect(findAllReferences(fresh.ast, { line: 1, character: 11 }, registry)).toHaveLength(3);
		const semantic = classifySemanticTokens(renamed, { ast: fresh.ast });
		for (const [line, character] of [[0, 6], [1, 11], [2, 'local item: Alias='.length]]) {
			const token = semantic.find((entry) => entry.line === line && entry.character === character);
			expect(token?.tokenType).not.toBe('keyword'); expect(token?.modifiers).toContain('readonly');
		}
	});

	it('does not invent a self parameter for static class methods', () => {
		const invalid = parseSlua('class self\nfunction change() self=nil end\nend');
		expect(invalid.diagnostics.map((item) => item.code)).toEqual(['parse-error']);
		const shadow = parseSlua('class self\nfunction keep(self) self=self return self end\nend');
		expect(shadow.diagnostics).toEqual([]);
	});

});
