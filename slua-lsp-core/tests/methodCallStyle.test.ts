import { describe, expect, it } from 'vitest';

import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { ruleIntrinsicMethodCalls } from '../src/diagnostics/rules/intrinsicMethodCalls.js';
import { parseSlua } from '../src/parser/parseSlua.js';

describe('method call style', () => {
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

	it('flags dot-call for LLEvents.eventNames/listeners', () => {
		const text = [
			'LLEvents.eventNames()',
			'LLEvents.listeners("listen")'
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
