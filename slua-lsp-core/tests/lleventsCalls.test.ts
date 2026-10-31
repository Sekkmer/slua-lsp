import { describe, expect, it } from 'vitest';

import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaEventSignaturesFromLslDefinitions, defaultSluaEventOverrides } from '../src/slua/events.js';

async function loadEventSigs() {
	const defs = await loadLslDefinitionsFromYamlFile();
	return buildSluaEventSignaturesFromLslDefinitions(defs, defaultSluaEventOverrides);
}

describe('LLEvents event name + callback checks', () => {
	it('resolves aliased and explicit-self event calls while ignoring shadowed receivers', async () => {
		const eventSignatures = await loadEventSigs();
		const diagnostics = analyzeTextWithDirectives([
			'local events = LLEvents',
			'events:on("state_exit", function() end)',
			'events.on(LLEvents, "state_entry", function() end)',
			'events.on(LLEvents, "listen", function(channel: string) end)',
			'local LLEvents = {}; LLEvents:on("not-an-event", function(channel: string) end)'
		].join('\n'), { eventSignatures });
		expect(diagnostics.filter((d) => d.code === 'unknown-event')).toHaveLength(2);
		expect(diagnostics.filter((d) => d.code === 'callback-param-type-mismatch')).toHaveLength(1);
	});

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

	it('accepts timer as a documented compatibility event', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("timer", function() end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'unknown-event')).toBe(false);
	});

	it('rejects unknown event names', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("definitely_not_real", function() end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'unknown-event')).toBe(true);
	});

	it('allows extra unannotated callback parameters, supplied as nil', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("listen", function(a, b, c, d, e) end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'callback-arity-mismatch')).toBe(false);
	});

	it('allows callbacks to ignore supplied event parameters', async () => {
		const eventSigs = await loadEventSigs();
		const text = 'LLEvents:on("listen", function(a, b, c) end)';
		const diags = analyzeTextWithDirectives(text, { eventSignatures: eventSigs });
		expect(diags.some((d) => d.code === 'callback-arity-mismatch')).toBe(false);
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
