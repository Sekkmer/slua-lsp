import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringProp(obj: unknown, key: string): string | undefined {
	if (!isRecord(obj)) return undefined;
	const v = obj[key];
	return typeof v === 'string' ? v : undefined;
}

function findFirstFunctionDeclaration(ast: unknown): Record<string, unknown> | null {
	if (!ast) return null;
	const queue: unknown[] = [ast];
	while (queue.length > 0) {
		const v = queue.shift();
		if (!v) continue;
		if (Array.isArray(v)) {
			for (const item of v) queue.push(item);
			continue;
		}
		if (!isRecord(v)) continue;
		if (v.type === 'FunctionDeclaration') return v;
		for (const child of Object.values(v)) queue.push(child);
	}
	return null;
}

describe('function method declaration parsing', () => {
	it('parses `function obj:fun(a)` and injects implicit self param', () => {
		const text = ['function obj:fun(a)', '\treturn a', 'end'].join('\n');
		const result = parseSlua(text);
		expect(result.diagnostics).toEqual([]);
		expect(result.ast).toBeTruthy();

		const fn = findFirstFunctionDeclaration(result.ast);
		expect(fn).toBeTruthy();

		const params = fn ? fn['parameters'] : undefined;
		const paramNames = Array.isArray(params) ? params.map((p) => getStringProp(p, 'name')).filter((n): n is string => typeof n === 'string') : [];
		expect(paramNames).toEqual(['self', 'a']);

		const identifier = fn ? fn['identifier'] : undefined;
		expect(isRecord(identifier) ? identifier['type'] : undefined).toBe('MemberExpression');
		expect(isRecord(identifier) ? identifier['indexer'] : undefined).toBe(':');

		const obj = isRecord(identifier) ? identifier['object'] : undefined;
		expect(isRecord(obj) ? obj['type'] : undefined).toBe('Identifier');
		expect(getStringProp(obj, 'name')).toBe('obj');

		const prop = isRecord(identifier) ? identifier['property'] : undefined;
		expect(isRecord(prop) ? prop['type'] : undefined).toBe('Identifier');
		expect(getStringProp(prop, 'name')).toBe('fun');
	});

	it('parses `function obj.fun(self, a)` without injecting another self', () => {
		const text = ['function obj.fun(self, a)', '\treturn a', 'end'].join('\n');
		const result = parseSlua(text);
		expect(result.diagnostics).toEqual([]);
		expect(result.ast).toBeTruthy();

		const fn = findFirstFunctionDeclaration(result.ast);
		expect(fn).toBeTruthy();

		const params = fn ? fn['parameters'] : undefined;
		const paramNames = Array.isArray(params) ? params.map((p) => getStringProp(p, 'name')).filter((n): n is string => typeof n === 'string') : [];
		expect(paramNames).toEqual(['self', 'a']);

		const identifier = fn ? fn['identifier'] : undefined;
		expect(isRecord(identifier) ? identifier['type'] : undefined).toBe('MemberExpression');
		expect(isRecord(identifier) ? identifier['indexer'] : undefined).toBe('.');

		const obj = isRecord(identifier) ? identifier['object'] : undefined;
		expect(isRecord(obj) ? obj['type'] : undefined).toBe('Identifier');
		expect(getStringProp(obj, 'name')).toBe('obj');

		const prop = isRecord(identifier) ? identifier['property'] : undefined;
		expect(isRecord(prop) ? prop['type'] : undefined).toBe('Identifier');
		expect(getStringProp(prop, 'name')).toBe('fun');
	});
});
