import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';

describe('C++ Luau expression-statement expectations', () => {
	it.each(['ll.Sa', '42', 'tonumber("2") or 0', '{"hello"}'])('rejects a standalone value while retaining editor recovery for %s', (source) => {
		const parsed = parseSlua(source);
		expect(parsed.ast).toBeTruthy();
		expect(parsed.diagnostics.some((d) => d.code === 'parse-error')).toBe(true);
	});

	it.each(['print("hello")', 'local n = tonumber("2") or 0\nprint(n)', 'local t = {"hello"}', 'LLEvents:on("touch_start", function() print("touch") end)'])('accepts valid statements: %s', (source) => {
		expect(parseSlua(source).diagnostics).toEqual([]);
	});
});
