import { describe, expect, it } from 'vitest';

import { buildSluaIntrinsicMethods } from '../src/slua/intrinsics.js';
import { slua } from '../src/slua/types.js';

describe('SLua intrinsics overrides', () => {
	it('defaults LLTimers.once to (seconds, callback)', () => {
		const intrinsics = buildSluaIntrinsicMethods();
		const once = intrinsics['LLTimers.once'];
		expect(once.source).toBe('default');
		expect(once.signature).toEqual({
			kind: 'function',
			params: [
				{ kind: 'primitive', name: 'number' },
				{ kind: 'function', params: [], returns: { kind: 'primitive', name: 'nil' } }
			],
			returns: { kind: 'function', params: [], returns: { kind: 'primitive', name: 'nil' } }
		});
	});

	it('can override LLTimers.once ordering for runtime reality', () => {
		const intrinsics = buildSluaIntrinsicMethods({
			'LLTimers.once': slua.fn([slua.fn([], slua.nil()), slua.number()], slua.fn([], slua.nil()))
		});
		const once = intrinsics['LLTimers.once'];
		expect(once.source).toBe('override');
		expect(once.signature).toEqual({
			kind: 'function',
			params: [
				{ kind: 'function', params: [], returns: { kind: 'primitive', name: 'nil' } },
				{ kind: 'primitive', name: 'number' }
			],
			returns: { kind: 'function', params: [], returns: { kind: 'primitive', name: 'nil' } }
		});
	});
});
