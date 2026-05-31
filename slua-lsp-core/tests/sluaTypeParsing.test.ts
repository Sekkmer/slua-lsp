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
});
