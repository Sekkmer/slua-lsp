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

	it('accepts the upstream llcompat.SetTimerEvent compatibility declaration', () => {
		const text = 'llcompat.SetTimerEvent(1.0)';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeUndefined();
	});

	it('accepts an ordinary global function named timer without inferring automatic dispatch', () => {
		const text = 'function timer() end\ntimer()';
		const diags = analyzeTextWithDirectives(text);
		const d = diags.find((x) => x.code === 'legacy-timer-api');
		expect(d).toBeUndefined();
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
