import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function findSafeIndices(source: string): number[] {
	const safe: number[] = [];
	let inString: '"' | '\'' | '`' | null = null;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}

		if (inBlockComment) {
			if (ch === ']' && next === ']') {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}

		if (inString) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}

		if (ch === '-' && next === '-') {
			if (source[i + 2] === '[' && source[i + 3] === '[') {
				inBlockComment = true;
				i += 3;
			} else {
				inLineComment = true;
				i += 1;
			}
			continue;
		}

		if (ch === '"' || ch === '\'' || ch === '`') {
			inString = ch;
			continue;
		}

		safe.push(i);
	}

	return safe;
}

function pickMiddleIndex(source: string, rng: () => number): number {
	if (source.length === 0) return 0;
	const start = Math.floor(source.length * 0.3);
	const end = Math.max(start + 1, Math.floor(source.length * 0.7));
	const safe = findSafeIndices(source).filter((i) => i >= start && i < end);
	if (safe.length === 0) return Math.min(start, Math.max(0, source.length - 1));
	return safe[Math.floor(rng() * safe.length)] ?? safe[0]!;
}

function mutateInsert(source: string, rng: () => number): string {
	const inserts = [')', '(', ']', '[', '}', '{', ',', '.', ':', '=', ' ', '\n', 'local ', 'return '];
	const insert = inserts[Math.floor(rng() * inserts.length)] ?? '';
	const idx = pickMiddleIndex(source, rng);
	return source.slice(0, idx) + insert + source.slice(idx);
}

function mutateDelete(source: string, rng: () => number): string {
	if (source.length === 0) return source;
	const idx = pickMiddleIndex(source, rng);
	return source.slice(0, idx) + source.slice(idx + 1);
}

function mutateDuplicate(source: string, rng: () => number): string {
	if (source.length === 0) return source;
	const idx = pickMiddleIndex(source, rng);
	const len = Math.max(1, Math.floor(rng() * 2));
	const chunk = source.slice(idx, idx + len);
	return source.slice(0, idx) + chunk + source.slice(idx);
}

function mutateReplace(source: string, rng: () => number): string {
	if (source.length === 0) return source;
	const replacements = ['a', 'b', '1', '_', '.', ',', ':', '=', ' '];
	const idx = pickMiddleIndex(source, rng);
	const rep = replacements[Math.floor(rng() * replacements.length)] ?? '';
	return source.slice(0, idx) + rep + source.slice(idx + 1);
}

function mutate(source: string, rng: () => number, count: number): string {
	let current = source;
	const mutators = [mutateInsert, mutateDelete, mutateDuplicate, mutateReplace];
	for (let i = 0; i < count; i += 1) {
		const mutator = mutators[Math.floor(rng() * mutators.length)] ?? mutateInsert;
		current = mutator(current, rng);
	}
	return current;
}

describe('parseSlua invalid code fuzzing', () => {
	it('does not throw and returns partial AST for corrupted inputs', () => {
		const baseSource = [
			'-- typed aliases and records',
			'export type Id<T> = T',
			'type Name = string',
			'type Vec2 = { x: number, y: number }',
			'type User = { id: integer, name: Name, tags: { string } }',
			'type Entity = { id: Id<integer>, name: Name } & { tags?: { string } }',
			'type MaybeVec = Vec2?',
			'type IdOrName = integer | Name',
			'',
			'local function add(a: number, b: number): number',
			'\treturn a + b',
			'end',
			'',
			'local function clamp<T>(value: T, fallback: T): T',
			'\tif value == nil then',
			'\t\treturn fallback',
			'\tend',
			'\treturn value',
			'end',
			'',
			'local function length(v: Vec2): number',
			'\treturn math.sqrt(v.x * v.x + v.y * v.y)',
			'end',
			'',
			'local users: { [string]: User } = {}',
			'users["a"] = { id = 1, name = "Ada", tags = { "math", "code" } }',
			'users["b"] = { id = 2, name = "Bob", tags = { "ops" } }',
			'',
			'local function findUser(id: integer): User?',
			'\tfor _, u in pairs(users) do',
			'\t\tif u.id == id then',
			'\t\t\treturn u',
			'\t\tend',
			'\t\tif u.id < 0 then',
			'\t\t\tcontinue',
			'\t\tend',
			'\tend',
			'\treturn nil',
			'end',
			'',
			'local function normalize(v: MaybeVec, fallback: Vec2): Vec2',
			'\tlocal picked = clamp(v, fallback)',
			'\tlocal d = length(picked)',
			'\tif d == 0 then',
			'\t\treturn fallback',
			'\tend',
			'\treturn { x = picked.x / d, y = picked.y / d }',
			'end',
			'',
			'local function format(u: User): string',
			'\treturn string.format("%d:%s", u.id, u.name)',
			'end',
			'',
			'local v: Vec2 = { x = 3, y = 4 }',
			'local total: number = add(v.x, v.y)',
			'local dist = length(v)',
			'local nv = normalize(v, { x = 1, y = 0 })',
			'',
			'local e: Entity = { id = 3, name = "Eve", tags = { "sec" } }',
			'local idOrName: IdOrName = e.name',
			'',
			'local function toLabel(value: IdOrName): string',
			'\tif type(value) == "number" then',
			'\t\treturn string.format("id:%d", value)',
			'\tend',
			'\treturn "name:" .. value',
			'end',
			'',
			'if total > 0 and dist > 0 then',
			'\tlocal u = findUser(2)',
			'\tif u then',
			'\t\tprint(format(u))',
			'\telse',
			'\t\tprint("missing")',
			'\tend',
			'end',
			'',
			'local function banner(name: string, score: number): string',
			'\tlocal label = toLabel(name)',
			'\treturn `User {name}: {label} score={score}`',
			'end',
			'',
			'local i = 0',
			'while i < 3 do',
			'\ti = i + 1',
			'\tprint(banner("Ada", i))',
			'end'
		].join('\n');

		const rng = makeRng(0xC0FFEE);
		const cases: string[] = [];

		for (let i = 0; i < 60; i += 1) {
			const edits = 1 + Math.floor(rng() * 2);
			cases.push(mutate(baseSource, rng, edits));
		}

		for (const text of cases) {
			expect(() => parseSlua(text)).not.toThrow();
			const result = parseSlua(text);
			if (!result.ast) {
				const preview = text.length > 400 ? `${text.slice(0, 400)}\n...` : text;
				throw new Error(`parseSlua returned null AST for mutated input:\n${preview}`);
			}
			expect(Array.isArray(result.diagnostics)).toBe(true);
		}
	});
});
