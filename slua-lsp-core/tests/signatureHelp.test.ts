import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { getSignatureHelp } from '../src/typing/signatureHelp.js';

function signatureHelpAtCursor(codeWithCursor: string) {
	const cursorIndex = codeWithCursor.indexOf('$');
	if (cursorIndex < 0) throw new Error('Expected `$` cursor marker in code');

	const sourceText = codeWithCursor.replace('$', '');
	const beforeCursor = codeWithCursor.slice(0, cursorIndex);
	const lines = beforeCursor.split(/\r?\n/);
	const line = lines.length - 1;
	const character = (lines[lines.length - 1] ?? '').length;

	const parsed = parseSlua(sourceText);
	const registry = buildSluaRegistryFromLslDefinitions(null);
	return getSignatureHelp(parsed.ast, { line, character }, registry, sourceText);
}

describe('getSignatureHelp', () => {
	it('keeps later integer arguments on the variadic parameter', () => {
		const help = signatureHelpAtCursor('integer.band(integer.maxsigned, integer.maxsigned, $integer.maxsigned)');
		expect(help?.signatures[0]?.label).toContain('...: integer');
		expect(help?.signatures[0]?.parameters).toEqual([{ label: '...: integer' }]);
		expect(help?.activeParameter).toBe(0);
	});

	it('provides signature help for intrinsic object methods', () => {
		const help = signatureHelpAtCursor('LLTimers:every(1$, function() end)');
		expect(help).not.toBeNull();
		expect(help?.signatures[0]?.label).toContain('LLTimers:every');
		expect(help?.activeParameter).toBe(0);
		expect(help?.signatures[0]?.parameters.length).toBe(2);
	});

	it('computes activeParameter for later arguments', () => {
		const help = signatureHelpAtCursor('LLTimers:every(1, $function() end)');
		expect(help).not.toBeNull();
		expect(help?.activeParameter).toBe(1);
	});

	it('handles being right after a comma as the next argument', () => {
		const help = signatureHelpAtCursor('LLTimers:every(1, $ function() end)');
		expect(help).not.toBeNull();
		expect(help?.activeParameter).toBe(1);
	});
});
