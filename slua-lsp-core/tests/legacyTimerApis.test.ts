import { describe, expect, it } from 'vitest';

import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';

describe('legacy timer APIs', () => {
	it('flags ll.SetTimerEvent(...) as legacy and suggests LLTimers', () => {
		const text = 'll.SetTimerEvent(1.0)';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeTruthy();
		expect(d!.message).toContain('LLTimers:every');
	});

	it('flags llcompat.SetTimerEvent(...) as legacy and suggests LLTimers', () => {
		const text = 'llcompat.SetTimerEvent(1.0)';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeTruthy();
		expect(d!.message).toContain('LLTimers:once');
	});

	it('flags function timer() as legacy and suggests LLTimers', () => {
		const text = 'function timer() end';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeTruthy();
		expect(d!.message).toContain('LLTimers:once');
	});

	it('flags referencing ll.SetTimerEvent as legacy (no call)', () => {
		const text = 'local f = ll.SetTimerEvent';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeTruthy();
		expect(d!.message).toContain('LLTimers:every');
	});

	it('flags referencing ll["SetTimerEvent"] as legacy (no call)', () => {
		const text = 'local f = ll["SetTimerEvent"]';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeTruthy();
		expect(d!.message).toContain('LLTimers:every');
	});
});
