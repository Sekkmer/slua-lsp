import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

describe('Luau type annotations (best-effort capture)', () => {
	it('captures parameter and return type annotation text', () => {
		const text = [
			'local f = function(detected: {DetectedEvent}): number',
			'\treturn 1',
			'end'
		].join('\n');

		const result = parseSlua(text);
		expect(result.diagnostics).toEqual([]);
		expect(result.ast).toBeTruthy();

		const program = result.ast as { body: Array<{ type: string; init?: unknown[] }> };
		const localStmt = program.body[0] as { type: string; init: unknown[] };
		expect(localStmt.type).toBe('LocalStatement');

		const fnExpr = localStmt.init[0] as {
			type: string;
			parameters: Array<{ name: string; typeAnnotation?: string }>;
			returnTypeAnnotation?: string;
		};
		expect(fnExpr.type).toBe('Function');

		expect(fnExpr.parameters[0].name).toBe('detected');
		expect(fnExpr.parameters[0].typeAnnotation).toBe('{DetectedEvent}');
		expect(fnExpr.returnTypeAnnotation).toBe('number');
	});
});
