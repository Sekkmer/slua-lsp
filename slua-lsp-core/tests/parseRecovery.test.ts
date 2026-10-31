import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

type Position = { line: number; column: number };

function comparePos(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.column - b.column;
}

describe('parseSlua recovery + locations', () => {
	it('retains constructor call receivers at incomplete member separators while reporting syntax errors', () => {
		const result = parseSlua('llprim.ParamSetter.new():');
		expect(result.diagnostics.some((d) => d.code === 'parse-error')).toBe(true);
		const ast = result.ast as { body: { expression: { type: string; object: { type: string }; property: { name: string } } }[] };
		expect(ast.body[0]?.expression.type).toBe('MemberExpression');
		expect(ast.body[0]?.expression.object.type).toBe('CallExpression');
		expect(ast.body[0]?.expression.property.name).toBe('');
	});

	it('accepts whitespace and comments after member separators', () => {
		expect(parseSlua('print(math. -- comment\nabs(1))').diagnostics).toEqual([]);
		expect(parseSlua('local object = {run = function(self) print(self) end}\nobject:\nrun()').diagnostics).toEqual([]);
	});

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
