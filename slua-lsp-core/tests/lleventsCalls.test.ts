import { describe, expect, it } from 'vitest';

import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaEventSignaturesFromLslDefinitions, defaultSluaEventOverrides } from '../src/slua/events.js';

async function loadEventSigs() {
	const defs = await loadLslDefinitionsFromYamlFile();
	return buildSluaEventSignaturesFromLslDefinitions(defs, defaultSluaEventOverrides);
}

describe('LLEvents event name + callback checks', () => {
	it('accepts a valid event name', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("listen", function(channel, name, id, text) end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.filter((d) => d.code === 'unknown-event')).toHaveLength(0);
		expect(diags.filter((d) => d.code === 'callback-arity-mismatch')).toHaveLength(0);
	});

	it('rejects state_entry (not a SLua event)', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("state_entry", function() end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'unknown-event')).toBe(true);
	});

	it('rejects timer (legacy event not exposed via LLEvents)', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("timer", function() end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'unknown-event')).toBe(true);
	});

	it('rejects unknown event names', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("definitely_not_real", function() end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'unknown-event')).toBe(true);
	});

	it('errors when callback arity is wrong (too many)', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("listen", function(a, b, c, d, e) end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'callback-arity-mismatch')).toBe(true);
	});

	it('errors when callback arity is wrong (not enough)', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("listen", function(a, b, c) end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'callback-arity-mismatch')).toBe(true);
	});

	it('validates callback param type annotations for listen (stable signature)', async () => {
		const eventSigs = await loadEventSigs();
		const ok = 'LLEvents:on("listen", function(channel: number, name: string, id: uuid, text: string) end)';
		const okDiags = analyzeTextWithDirectives(ok, { eventSignatures: eventSigs });
		expect(okDiags.filter((d) => d.code === 'callback-param-type-mismatch')).toHaveLength(0);

		const bad = 'LLEvents:on("listen", function(channel: string, name: string, id: uuid, text: string) end)';
		const badDiags = analyzeTextWithDirectives(bad, { eventSignatures: eventSigs });
		expect(badDiags.some((d) => d.code === 'callback-param-type-mismatch')).toBe(true);
	});

	it('validates off(eventName) eventName is known', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:off("definitely_not_real")';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'unknown-event')).toBe(true);
	});
});
