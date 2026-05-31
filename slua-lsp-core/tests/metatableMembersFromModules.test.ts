import { describe, it, expect } from 'vitest';
import { MetatableRegistry, buildDefaultMetatables, augmentMetatableMembersFromModules } from '../src/slua/metatables.js';
import { slua } from '../src/slua/types.js';

describe('augmentMetatableMembersFromModules', () => {
	it('adds module functions as metatable members and drops receiver param', () => {
		const metatables = new MetatableRegistry();
		for (const mt of buildDefaultMetatables()) metatables.register(mt);

		const modules = new Map([
			[
				'string',
				{
					name: 'string',
					source: 'yaml',
					functions: {
						foo: {
							name: 'foo',
							source: 'yaml',
							docs: 'test',
							signature: slua.fn([slua.string(), slua.number()], slua.string())
						}
					}
				}
			]
		]);

		augmentMetatableMembersFromModules(modules, metatables);

		const members = metatables.getMembers('string');
		expect(members).toBeTruthy();
		expect(members?.foo).toBeTruthy();
		expect(members?.foo?.requiresColonCall).toBe(true);
		// receiver string param should be dropped for member-call display
		const t = members?.foo?.type;
		expect(t?.kind).toBe('function');
		if (t && t.kind === 'function') {
			expect(t.params.length).toBe(1);
			expect(t.params[0]).toEqual(slua.number());
			// returns unchanged
			expect(t.returns).toEqual(slua.string());
		}
	});
});
