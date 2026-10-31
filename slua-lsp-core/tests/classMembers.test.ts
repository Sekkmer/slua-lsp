import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, getCompletions, getSignatureHelp, getHover, findDefinitionAtPosition } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-members.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; codes: string[] }>;
const registry = buildSluaRegistryFromLslDefinitions(null);
const base = cases[0]!.source.slice(0, cases[0]!.source.lastIndexOf('\n') + 1);

describe('native class constructor/instance members', () => {
	it.each(cases)('$name', ({ source, codes }) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		const diagnostics = analyzeTextWithDirectives(source, { ast: parsed.ast, registry });
		expect(diagnostics.map((item) => item.code).sort(), JSON.stringify(diagnostics)).toEqual([...codes].sort());
	});
	it.each(['Box', 'Make', 'tools.make'])('offers only static constructor members through %s', (receiver) => {
		const source = base + `local Make=Box\nlocal tools={make=Box}\n${receiver}.`;
		const line = source.split('\n').length - 1;
		const labels = getCompletions(parseSlua(source).ast, { line, character: receiver.length + 1 }, registry, { sourceText: source }).map((item) => item.label).sort();
		expect(labels).toEqual(['twice', 'zero']);
	});
	it.each(['.', ':'])('offers available instance members through %s', (indexer) => {
		const source = base + `item${indexer}`;
		const labels = getCompletions(parseSlua(source).ast, { line: source.split('\n').length - 1, character: 5 }, registry, { sourceText: source }).map((item) => item.label).sort();
		expect(labels).toEqual(indexer === '.' ? ['__tostring', 'increment', 'twice', 'x', 'zero'] : ['__tostring', 'increment', 'twice', 'zero']);
	});
	it('shows bound and unbound method signatures', () => {
		for (const [call, expected] of [['item:increment(2)', ['arg1: number']], ['item.increment(item,2)', ['arg1: Box', 'arg2: number']], ['Box.twice(2)', ['arg1: number']]] as const) {
			const source = base + call;
			const signature = getSignatureHelp(parseSlua(source).ast, { line: source.split('\n').length - 1, character: call.indexOf('(') + 1 }, registry, source);
			expect(signature?.signatures[0]?.parameters.map((item) => item.label)).toEqual(expected);
		}
	});
	it('navigates known class fields and methods through stable aliases', () => {
		for (const [tail, word, line] of [['local alias=item\nprint(alias.x)', 'x', 1], ['local alias=item\nalias:increment(2)', 'increment', 2], ['local Make=Box\nMake.twice(2)', 'twice', 6]] as const) {
			const source = base + tail, lines = source.split('\n'), last = lines.at(-1)!;
			const position = { line: lines.length - 1, character: last.indexOf(word) + 1 };
			const ast = parseSlua(source).ast, definition = findDefinitionAtPosition(ast, position, registry);
			expect(definition?.kind).toBe('field'); expect(definition?.identifier.location?.start.line).toBe(line + 1);
			expect(getHover(ast, position, registry)?.markdown).not.toContain('unknown');
		}
	});
	it('supplies typed self and local parameters inside the class method cursor scope', () => {
		const source = base;
		const labels = getCompletions(parseSlua(source).ast, { line: 3, character: 5 }, registry, { sourceText: source }).map((item) => item.label);
		expect(labels).toContain('x'); expect(labels).toContain('increment');
	});
});
