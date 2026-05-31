import { describe, expect, test } from 'vitest';

import { sluaTypeFromLuauAnnotationText, sluaTypeToString } from '../src/slua/types.js';

describe('sluaTypeFromLuauAnnotationText', () => {
	test('parses tuple types', () => {
		const t = sluaTypeFromLuauAnnotationText('(number, string)');
		expect(sluaTypeToString(t)).toBe('(number, string)');
	});

	test('parses single-element parentheses', () => {
		const t = sluaTypeFromLuauAnnotationText('(number)');
		expect(sluaTypeToString(t)).toBe('number');
	});

	test('parses union types', () => {
		const t = sluaTypeFromLuauAnnotationText('thread | nil');
		expect(sluaTypeToString(t)).toBe('nil | thread');
	});

	test('parses optional types', () => {
		const t = sluaTypeFromLuauAnnotationText('thread?');
		expect(sluaTypeToString(t)).toBe('nil | thread');
	});

	test('parses structured table annotations as tables', () => {
		const t = sluaTypeFromLuauAnnotationText('{ readonly name: string, count: number }');
		expect(sluaTypeToString(t)).toBe('table');
	});

	test('parses array annotations', () => {
		expect(sluaTypeToString(sluaTypeFromLuauAnnotationText('{DetectedEvent}'))).toBe('DetectedEvent[]');
		expect(sluaTypeToString(sluaTypeFromLuauAnnotationText('Array<string>'))).toBe('string[]');
	});

	test('parses function annotations', () => {
		const t = sluaTypeFromLuauAnnotationText('(integer, string) -> boolean');
		expect(sluaTypeToString(t)).toBe('(integer, string) -> boolean');
	});
});
