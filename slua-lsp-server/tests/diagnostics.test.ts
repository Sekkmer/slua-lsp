import { describe, expect, it } from 'vitest';

import { buildSluaRegistryFromLslDefinitions } from 'slua-lsp-core';

import { computeDiagnosticsForText } from '../src/diagnostics.js';
import { SERVER_NAME } from '../src/constants.js';

describe('diagnostics integration', () => {
	it('surfaces use-dot-call for module colon-calls', () => {
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const text = [
			'local x = {}',
			'lljson:encode(x)'
		].join('\n');

		const diags = computeDiagnosticsForText(text, {
			registry,
			defsLoaded: true,
			serverName: SERVER_NAME
		});

		expect(diags.some((d) => d.code === 'use-dot-call')).toBe(true);
	});
});
