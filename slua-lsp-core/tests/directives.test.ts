import { describe, expect, it } from 'vitest';

import { applyDirectives, parseDirectives, type CoreDiagnostic } from '../src/diagnostics/index.js';

describe('diagnostic directives', () => {
	it('ignores directive-like text inside short, long and interpolated string literals', () => {
		const text = [
			'local a = "-- slua-lsp:disable all"',
			'local b = \'-- slua-lsp:disable all\'',
			'local c = [==[',
			'-- slua-lsp:disable all',
			']==]',
			'local d = `literal -- slua-lsp:disable all {1}`',
			'--[=[',
			'-- slua-lsp:disable all',
			']=]',
			'missing()'
		].join('\n');
		expect(parseDirectives(text)).toEqual([]);
		expect(applyDirectives(text, [diag(9, 'undeclared-name')])).toHaveLength(1);
	});

	it('recognizes actual inline and interpolation comments without treating literals as directives', () => {
		const text = [
			'local value = "-- slua-lsp:disable all" -- slua-lsp:disable-next-line undeclared-name',
			'missing()',
			'local message = `value {',
			'-- slua-lsp:disable-next-line undeclared-name',
			'missing',
			'}`'
		].join('\n');
		expect(parseDirectives(text).map((d) => d.line)).toEqual([0, 3]);
		expect(applyDirectives(text, [diag(1, 'undeclared-name'), diag(4, 'undeclared-name')])).toEqual([]);
	});

	it('does not misread escaped quotes, nested template expressions or unfinished literals', () => {
		const text = [
			String.raw`local a = "escaped \" -- slua-lsp:disable all"`,
			'local b = `outer {`inner -- slua-lsp:disable all {"}"}`}`',
			'local c = [=[unfinished',
			'-- slua-lsp:disable all'
		].join('\n');
		expect(parseDirectives(text)).toEqual([]);
	});

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
