import { describe, expect, it } from 'vitest';

import { buildSluaIntrinsicMethods } from '../src/slua/intrinsics.js';

describe('LLEvents intrinsics (runtime-probed)', () => {
	it('models eventNames() and handlers(eventName)', () => {
		const intrinsics = buildSluaIntrinsicMethods();

		expect(intrinsics['LLEvents.eventNames']).toBeTruthy();
		expect(intrinsics['LLEvents.eventNames']?.signature).toEqual({
			kind: 'function',
			params: [],
			returns: { kind: 'array', element: { kind: 'primitive', name: 'string' } }
		});

		expect(intrinsics['LLEvents.handlers']).toBeTruthy();
		expect(intrinsics['LLEvents.handlers']?.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: {
				kind: 'array',
				element: {
					kind: 'function',
					params: [{ kind: 'primitive', name: 'unknown' }],
					returns: { kind: 'primitive', name: 'nil' }
				}
			}
		});
	});
});
