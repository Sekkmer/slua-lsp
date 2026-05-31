import { describe, expect, test } from 'vitest';

import { analyzeText } from '../src/diagnostics/engine.js';

describe('LLTimers calls', () => {
	test('rejects LLTimers:on(...) (legacy method not present)', () => {
		const text = 'LLTimers:on(1, function() end)';
		const diags = analyzeText(text);
		expect(diags.some((d) => d.code === 'unknown-intrinsic-method')).toBe(true);
	});

	test('rejects LLTimers.on(...) as well', () => {
		const text = 'LLTimers.on(1, function() end)';
		const diags = analyzeText(text);
		expect(diags.some((d) => d.code === 'unknown-intrinsic-method')).toBe(true);
	});
});
