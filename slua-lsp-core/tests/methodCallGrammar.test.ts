import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';

const cases = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/method-call-grammar.json', import.meta.url), 'utf8')) as { name: string; source: string; valid: boolean }[];

describe('colon method calls require arguments', () => {
	for (const item of cases) it(item.name, () => {
		const parsed = parseSlua(item.source);
		expect(parsed.ast).not.toBeNull();
		expect(parsed.diagnostics.some((d) => d.code === 'parse-error')).toBe(!item.valid);
	});

	it('retains the receiver and method token for incomplete editor requests', () => {
		const parsed = parseSlua('local obj = {}\nlocal method = obj:run\nlocal after = 42');
		expect(parsed.diagnostics.some((d) => d.code === 'parse-error')).toBe(true);
		const ast = parsed.ast as { body: { init?: { type: string; indexer?: string; property?: { name: string } }[]; variables?: { name: string }[] }[] };
		expect(ast.body[1]?.init?.[0]).toMatchObject({ type: 'MemberExpression', indexer: ':', property: { name: 'run' } });
		expect(ast.body[2]?.variables?.[0]?.name).toBe('after');
	});
});
