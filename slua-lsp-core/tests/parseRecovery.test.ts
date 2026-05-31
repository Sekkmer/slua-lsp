import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

type Position = { line: number; column: number };

function comparePos(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.column - b.column;
}

describe('parseSlua recovery + locations', () => {
	it('returns a partial AST and a parse diagnostic for a broken type alias', () => {
		const text = ['type Foo = { x: number,', 'local x = 1', ''].join('\n');
		const result = parseSlua(text);

		expect(result.ast).not.toBeNull();
		const parseErrors = result.diagnostics.filter((d) => d.code === 'parse-error');
		expect(parseErrors.length).toBeGreaterThan(0);
	});

	it('keeps parsing after a statement error (contains the error)', () => {
		const text = ['local x =', 'local y = 2', ''].join('\n');
		const result = parseSlua(text);
		expect(result.ast).not.toBeNull();
		const parseErrors = result.diagnostics.filter((d) => d.code === 'parse-error');
		expect(parseErrors.length).toBeGreaterThan(0);

		const prog = result.ast as { body?: unknown[] };
		expect(Array.isArray(prog.body)).toBe(true);
		const body = prog.body ?? [];
		// Expect at least: ErrorStatement + LocalStatement
		expect(body.length).toBeGreaterThanOrEqual(2);
	});

	it('treats git merge markers as comment-like and continues', () => {
		const text = [
			'local a = 1',
			'<<<<<<< ours',
			'local a = 2',
			'=======',
			'local a = 3',
			'>>>>>>> theirs',
			'local b = 4',
			''
		].join('\n');

		const result = parseSlua(text);
		expect(result.ast).not.toBeNull();
		// Markers should not force parse errors on their own.
		const parseErrors = result.diagnostics.filter((d) => d.code === 'parse-error');
		expect(parseErrors).toEqual([]);
	});

	it('normalizes node locations to be stable spans', () => {
		const result = parseSlua('local x = 1\n');
		expect(result.ast).not.toBeNull();

		const prog = result.ast as { location?: { start: Position; end: Position } };
		expect(prog.location).toBeTruthy();
		if (!prog.location) return;

		expect(comparePos(prog.location.start, prog.location.end)).toBeLessThanOrEqual(0);
	});
});
