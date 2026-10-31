import { describe, expect, it } from 'vitest';
import { ClassMemberMap, ClassMemberSet, classOriginView } from '../src/typing/classMemberMap.js';
import { createClassConstructor } from '../src/typing/classConstructors.js';
import { slua, sluaTypeToString } from '../src/slua/types.js';

function entries<V>(map: ReadonlyMap<string, V>) { return [...map]; }
describe('shared class member snapshots', () => {
	it.each(['ascending', 'descending', 'mixed'])('matches insertion order and lookup through %s updates/deletions/forks', (order) => {
		let actual = new ClassMemberMap<number | undefined>(), expected = new Map<string, number | undefined>();
		const snapshots: Array<{ actual: ClassMemberMap<number | undefined>; expected: Map<string, number | undefined> }> = [];
		const names = ['', '__proto__', 'constructor', 'toString', 'α', '🦊', ...Array.from({ length: 96 }, (_, i) => 'member'+i.toString().padStart(3, '0'))];
		if (order === 'descending') names.reverse();
		let seed = 12345;
		for (let i = 0; i < 480; i++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const key = names[order === 'mixed' ? seed % names.length : i % names.length]!;
			if (i % 4 === 3) expect(actual.delete(key)).toBe(expected.delete(key));
			else { const value = i % 5 === 0 ? undefined : i; actual.set(key, value); expected.set(key, value); }
			if (i % 31 === 0) { snapshots.push({ actual, expected }); actual = actual.fork(); expected = new Map(expected); }
			expect(actual.size).toBe(expected.size); expect(entries(actual)).toEqual(entries(expected));
			for (const name of names) { expect(actual.get(name)).toBe(expected.get(name)); expect(actual.has(name)).toBe(expected.has(name)); }
		}
		for (const snapshot of snapshots) expect(entries(snapshot.actual)).toEqual(entries(snapshot.expected));
	});
	it('isolates parent, siblings and grandchildren even when existing signatures are replaced', () => {
		const parent = new ClassMemberMap<number>(); parent.set('z', 1).set('a', 2);
		const first = parent.fork(), second = parent.fork(); first.set('z', 3).set('b', 4); const grandchild = first.fork();
		first.delete('a'); second.set('a', 5); parent.set('z', 6); grandchild.delete('z'); grandchild.set('z', 7);
		expect([...parent]).toEqual([['z', 6], ['a', 2]]); expect([...first]).toEqual([['z', 3], ['b', 4]]);
		expect([...second]).toEqual([['z', 1], ['a', 5]]); expect([...grandchild]).toEqual([['a', 2], ['b', 4], ['z', 7]]);
	});
	it('implements read-only map keys, values and callback receiver', () => {
		const map = new ClassMemberMap<number>(); map.set('z', 1).set('a', 2); const receiver: unknown[] = [];
		map.forEach(function (this: unknown[], value, key, current) { this.push([key, value]); expect(current).toBe(map); }, receiver);
		expect(receiver).toEqual([['z', 1], ['a', 2]]); expect([...map.keys()]).toEqual(['z', 'a']); expect([...map.values()]).toEqual([1, 2]);
	});
	it('preserves method visibility snapshots independently of descendant overrides', () => {
		const parent = new ClassMemberSet(); parent.add('static').add('__init'); const child = parent.fork();
		child.delete('__init'); child.delete('static'); child.add('own'); parent.add('later');
		expect([...parent]).toEqual(['static', '__init', 'later']); expect([...child]).toEqual(['own']); expect(child.size).toBe(1);
	});
	it('combines member origins with method precedence and filters constructor visibility without copies', () => {
		const fields = new ClassMemberMap<number>(), methods = new ClassMemberMap<number>(); fields.set('z', 1).set('a', 2); methods.set('z', 3).set('method', 4);
		const instance = classOriginView(fields, methods), visible = new ClassMemberSet(); visible.add('method'); const constructor = classOriginView(new Map(), methods, visible);
		expect([...instance]).toEqual([['z', 3], ['a', 2], ['method', 4]]); expect(instance.size).toBe(3); expect(instance.get('z')).toBe(3);
		expect([...constructor]).toEqual([['method', 4]]); expect(constructor.get('z')).toBeUndefined(); expect(constructor.has('z')).toBe(false);
		const receiver: unknown[] = []; instance.forEach(function (this: unknown[], value, key, current) { this.push([key, value]); expect(current).toBe(instance); }, receiver);
		expect(receiver).toEqual([...instance]); expect([...instance.keys()]).toEqual(['z', 'a', 'method']); expect([...instance.values()]).toEqual([3, 2, 4]);
	});
	it('does not enumerate a default constructor table until its shape is requested', () => {
		let enumerations = 0;
		const fields = new Map([['x', slua.number()]]), original = fields[Symbol.iterator].bind(fields);
		fields[Symbol.iterator] = function () { enumerations++; return original(); };
		const constructor = createClassConstructor('Box', fields);
		expect(enumerations).toBe(0); expect(sluaTypeToString(constructor)).toBe('({ x: number }) -> Box'); expect(enumerations).toBe(1);
		expect(JSON.parse(JSON.stringify(constructor))).toMatchObject({ params: [{ fields: { x: { name: 'number' } } }] }); expect(enumerations).toBe(1);
	});
});
