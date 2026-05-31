import { describe, expect, it } from 'vitest';

import { buildSluaGlobalFunctions, buildSluaModules } from '../src/slua/intrinsics.js';

describe('wiki intrinsics', () => {
	it('provides vector/rotation/uuid/integer/number constructors', () => {
		const globals = buildSluaGlobalFunctions();

		expect(globals.vector.signature).toEqual({
			kind: 'function',
			params: [
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' }
			],
			returns: { kind: 'custom', name: 'vector' }
		});

		expect(globals.rotation.signature).toEqual({
			kind: 'function',
			params: [
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' }
			],
			returns: { kind: 'custom', name: 'rotation' }
		});

		expect(globals.quaternion.signature).toEqual({
			kind: 'function',
			params: [
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' },
				{ kind: 'primitive', name: 'number' }
			],
			returns: { kind: 'custom', name: 'rotation' }
		});

		expect(globals.uuid.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: { kind: 'custom', name: 'uuid' }
		});

		expect(globals.touuid.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: { kind: 'custom', name: 'uuid' }
		});

		expect(globals.integer.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'number' }],
			returns: { kind: 'custom', name: 'integer' }
		});

		expect(globals.number.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'unknown' }],
			returns: { kind: 'primitive', name: 'number' }
		});

		expect(globals.torotation.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: { kind: 'custom', name: 'rotation' }
		});
	});

	it('provides lljson and llbase64 modules', () => {
		const mods = buildSluaModules();

		expect(mods.lljson.functions.encode.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'table' }],
			returns: { kind: 'primitive', name: 'string' }
		});

		expect(mods.lljson.functions.decode.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: { kind: 'table' }
		});

		expect(mods.llbase64.functions.encode.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: { kind: 'primitive', name: 'string' }
		});

		expect(mods.llbase64.functions.decode.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }],
			returns: { kind: 'primitive', name: 'string' }
		});
	});

	it('provides coroutine and bit32 modules', () => {
		const mods = buildSluaModules();

		expect(mods.coroutine.functions.create.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'function', params: [], returns: { kind: 'primitive', name: 'unknown' } }],
			returns: { kind: 'custom', name: 'thread' }
		});

		expect(mods.coroutine.functions.resume.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'custom', name: 'thread' }],
			returns: {
				kind: 'tuple',
				items: [{ kind: 'primitive', name: 'boolean' }, { kind: 'primitive', name: 'unknown' }]
			}
		});

		expect(mods.coroutine.functions.status.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'custom', name: 'thread' }],
			returns: { kind: 'primitive', name: 'string' }
		});

		expect(mods.coroutine.functions.close.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'custom', name: 'thread' }],
			returns: { kind: 'primitive', name: 'boolean' }
		});

		expect(mods.coroutine.functions.running.signature).toEqual({
			kind: 'function',
			params: [],
			returns: {
				kind: 'tuple',
				items: [
					{ kind: 'union', items: [{ kind: 'custom', name: 'thread' }, { kind: 'primitive', name: 'nil' }] },
					{ kind: 'primitive', name: 'boolean' }
				]
			}
		});

		expect(mods.bit32.functions.band.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'custom', name: 'integer' }, { kind: 'custom', name: 'integer' }],
			returns: { kind: 'custom', name: 'integer' }
		});
	});
});
