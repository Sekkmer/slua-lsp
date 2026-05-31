import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

describe('parseSlua', () => {
	it('parses a basic SLua/Lua file with no errors', () => {
		const text = [
			'-- simple Lua/SLua sample',
			'local function add(a, b)',
			'\treturn a + b',
			'end',
			'',
			'local x = add(1, 2)',
			'if x > 0 then',
			'\t-- ok',
			'end'
		].join('\n');

		const result = parseSlua(text);
		expect(result.diagnostics).toEqual([]);
		expect(result.ast).toBeTruthy();
	});
});
