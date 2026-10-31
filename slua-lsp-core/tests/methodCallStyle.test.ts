import { describe, expect, it } from 'vitest';

import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { ruleIntrinsicMethodCalls } from '../src/diagnostics/rules/intrinsicMethodCalls.js';
import { parseSlua } from '../src/parser/parseSlua.js';

describe('method call style', () => {
	function styles(text: string) {
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const parsed = parseSlua(text);
		expect(parsed.diagnostics).toEqual([]);
		return ruleIntrinsicMethodCalls(parsed.ast, registry);
	}

	it('ignores comments, string literals, method values and locally shadowed globals', () => {
		expect(styles([
			'-- LLEvents.on("listen", fn)',
			'local example = [[LLTimers.once(1, fn)]]',
			'local method = LLEvents.on',
			'do local LLTimers = {}; LLTimers:custom(); LLTimers.once(1) end',
			'local function test(LLEvents, lljson) LLEvents:on(); lljson:encode({}) end',
			'for vector in {} do vector:custom() end',
			'local lljson = {}; lljson:encode({})'
		].join('\n'))).toEqual([]);
	});

	it('follows builtin aliases and keeps aliases when the original name is shadowed', () => {
		const diags = styles([
			'local timers, events, json = LLTimers, LLEvents, lljson',
			'local LLTimers, LLEvents, lljson = {}, {}, {}',
			'timers.once(1, function() end)',
			'events.on("listen", function() end)',
			'json:encode({})'
		].join('\n'));
		expect(diags.map((d) => d.code)).toEqual(['use-colon-call', 'use-colon-call', 'use-dot-call']);
	});

	it('accepts explicit self, including an equivalent alias, and rejects absent self', () => {
		expect(styles([
			'local events = LLEvents',
			'LLEvents.on(events, "listen", function() end)',
			'events.eventNames(LLEvents)',
			'LLTimers.once(LLTimers, 0, function() end)',
			'local builder = llprim.ParamSetter.new()',
			'builder.size(builder, vector.one)',
			'builder.size({}, vector.one)'
		].join('\n'))).toEqual([]);
		expect(styles('LLTimers.once(0, function() end)').map((d) => d.code)).toEqual(['use-colon-call']);
	});

	it('does not guess call styles for missing module exports or user tables', () => {
		expect(styles('lljson:futureMethod(); local value = {}; value:encode()')).toEqual([]);
		expect(styles('local timers = LLTimers; timers:on()').map((d) => d.code)).toEqual(['unknown-intrinsic-method']);
	});

	it('uses original UTF-16 property ranges and suppression for aliased methods', () => {
		const text = 'local label = "😀"; local timers = LLTimers; timers.once(1, function() end)';
		const diagnostic = styles(text)[0]!;
		expect(diagnostic.range.start).toEqual({ line: 0, character: text.indexOf('once') });
		expect(diagnostic.range.end.character).toBe(text.indexOf('once') + 4);
		const registry = buildSluaRegistryFromLslDefinitions(null);
		expect(analyzeTextWithDirectives('local timers = LLTimers\n-- slua-lsp:disable-next-line use-colon-call\ntimers.once(1, function() end)', { registry }).filter((d) => d.code === 'use-colon-call')).toEqual([]);
	});

	it('keeps explicit-self arguments aligned in full type and arity analysis', () => {
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const text = [
			'local events, timers = LLEvents, LLTimers',
			'local callback = setmetatable({}, {__call = function() end})',
			'events.on(LLEvents, "listen", callback)',
			'LLTimers.once(timers, 0, function(time: number, interval: nil) end)',
			'local rules = llprim.ParamSetter.new()',
			'local rawRules = {}; rules.size(rawRules, vector.one)',
			'local LLTimers = {}; LLTimers.once()',
			'local lljson = {}; lljson.encode()'
		].join('\n');
		expect(analyzeTextWithDirectives(text, { registry })).toEqual([]);
	});

	it('validates aliased timer callback annotations and respects local shadowing', () => {
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const diagnostics = analyzeTextWithDirectives([
			'local timers = LLTimers',
			'timers:once(0, function(time: string) end)',
			'timers.every(LLTimers, 0, function(time: number, interval: string) end)',
			'local LLTimers = {}; LLTimers:once(0, function(time: string) end)'
		].join('\n'), { registry });
		expect(diagnostics.filter((d) => d.code === 'callback-param-type-mismatch')).toHaveLength(2);
	});

	it('flags dot-call for LLEvents.on', () => {
		const text = 'LLEvents.on("listen", function() end)';
		const diags = analyzeTextWithDirectives(text);
		expect(diags.some((d) => d.code === 'use-colon-call')).toBe(true);
	});

	it('flags unknown intrinsic methods', () => {
		const text = 'LLTimers:on(1.0, function() end)';
		const diags = analyzeTextWithDirectives(text);
		expect(diags.some((d) => d.code === 'unknown-intrinsic-method')).toBe(true);
	});

	it('flags dot-call for LLEvents.eventNames/handlers', () => {
		const text = [
			'LLEvents.eventNames()',
			'LLEvents.handlers("listen")'
		].join('\n');
		const diags = analyzeTextWithDirectives(text);
		expect(diags.filter((d) => d.code === 'use-colon-call')).toHaveLength(2);
	});

	it('allows colon-call for LLEvents:on', () => {
		const text = 'LLEvents:on("listen", function() end)';
		const diags = analyzeTextWithDirectives(text);
		expect(diags).toEqual([]);
	});

	it('flags dot-call for LLTimers.once/off/every', () => {
		const text = [
			'LLTimers.once(1.0, function() end)',
			'LLTimers.every(1.0, function() end)',
			'LLTimers.off()'
		].join('\n');
		const diags = analyzeTextWithDirectives(text);
		expect(diags.filter((d) => d.code === 'use-colon-call')).toHaveLength(3);
	});

	it('respects slua-lsp:disable directives', () => {
		const text = [
			'-- slua-lsp:disable use-colon-call',
			'LLEvents.on("listen", function() end)',
			'LLTimers.once(1.0, function() end)',
			'-- slua-lsp:enable use-colon-call'
		].join('\n');
		const diags = analyzeTextWithDirectives(text);
		expect(diags).toEqual([]);
	});

	it('flags colon-call for module functions (use dot-call)', () => {
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const text = [
			'local x = {}',
			'lljson:encode(x)',
			'llbase64:encode("hi")',
			'vector:abs(tovector("<1,2,3>"))'
		].join('\n');
		const parsed = parseSlua(text);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.ast).toBeTruthy();

		const diags = ruleIntrinsicMethodCalls(parsed.ast, registry);
		const codes = diags.map((d) => d.code);
		expect(codes.filter((c) => c === 'use-dot-call')).toHaveLength(3);
	});

	it('respects disable directives for use-dot-call', () => {
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const text = [
			'-- slua-lsp:disable use-dot-call',
			'local x = {}',
			'lljson:encode(x)',
			'llbase64:encode("hi")',
			'-- slua-lsp:enable use-dot-call'
		].join('\n');
		const diags = analyzeTextWithDirectives(text, { registry });
		expect(diags.some((d) => d.code === 'use-dot-call')).toBe(false);
	});
});
