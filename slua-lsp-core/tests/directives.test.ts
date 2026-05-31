import { describe, expect, it } from 'vitest';

import { applyDirectives, type CoreDiagnostic } from '../src/diagnostics/index.js';

describe('diagnostic directives', () => {
	function diag(line: number, code: string): CoreDiagnostic {
		return {
			code,
			message: 'x',
			severity: 'warning',
			range: {
				start: { line, character: 0 },
				end: { line, character: 1 }
			}
		};
	}

	it('disable-next-line suppresses only the next line', () => {
		const text = [
			'-- slua-lsp:disable-next-line unused-variable',
			'local x = 1',
			'local y = 2'
		].join('\n');

		const diags = [diag(1, 'unused-variable'), diag(2, 'unused-variable')];
		const out = applyDirectives(text, diags);
		expect(out.map((d) => d.range.start.line)).toEqual([2]);
	});

	it('disable/enable toggles suppression for a code', () => {
		const text = [
			'-- slua-lsp:disable shadowed-local',
			'local x = 1',
			'-- slua-lsp:enable shadowed-local',
			'local y = 2'
		].join('\n');

		const diags = [diag(1, 'shadowed-local'), diag(3, 'shadowed-local')];
		const out = applyDirectives(text, diags);
		expect(out.map((d) => d.range.start.line)).toEqual([3]);
	});

	it('disable all suppresses everything until enable all', () => {
		const text = [
			'-- slua-lsp:disable all',
			'local x = 1',
			'-- slua-lsp:enable all',
			'local y = 2'
		].join('\n');

		const diags = [diag(1, 'unused-variable'), diag(3, 'some-other-warning')];
		const out = applyDirectives(text, diags);
		expect(out.map((d) => d.range.start.line)).toEqual([3]);
	});
});
