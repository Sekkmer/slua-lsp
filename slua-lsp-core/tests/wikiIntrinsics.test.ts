import { describe, expect, it } from 'vitest';

import { buildSluaGlobalFunctions, buildSluaModules } from '../src/slua/intrinsics.js';

describe('wiki intrinsics', () => {
	it('provides current constructors and excludes nonexistent integer/number constructors', () => {
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

		expect(globals.uuid.signature).toMatchObject({ kind: 'function', returns: { kind: 'custom', name: 'uuid' } });
		expect(globals.touuid.signature).toMatchObject({ kind: 'function', arity: { min: 0, max: 1 }, returns: { kind: 'union' } });
		expect(globals.integer).toBeUndefined();
		expect(globals.number).toBeUndefined();
		expect(globals.torotation.signature).toMatchObject({ kind: 'function', arity: { min: 1, max: 1 }, returns: { kind: 'union' } });
	});

	it('provides lljson and llbase64 modules', () => {
		const mods = buildSluaModules();

		expect(mods.lljson.functions.encode.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'unknown' }, { kind: 'table' }],
			arity: { min: 1, max: 2 },
			returns: { kind: 'primitive', name: 'string' }
		});

		expect(mods.lljson.functions.decode.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'primitive', name: 'string' }, { kind: 'union', items: [{ kind: 'table' }, { kind: 'function', params: [], returns: { kind: 'primitive', name: 'unknown' }, variadic: { kind: 'primitive', name: 'unknown' }, untyped: true }] }],
			arity: { min: 1, max: 2 },
			returns: { kind: 'primitive', name: 'unknown' }
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
			params: [{ kind: 'function', params: [], returns: { kind: 'primitive', name: 'unknown' }, variadic: { kind: 'primitive', name: 'unknown' }, untyped: true }],
			returns: { kind: 'custom', name: 'thread' }
		});

		expect(mods.coroutine.functions.resume.signature).toEqual({
			kind: 'function',
			params: [{ kind: 'custom', name: 'thread' }],
			variadic: { kind: 'primitive', name: 'unknown' },
			returns: {
				kind: 'tuple',
				items: [{ kind: 'primitive', name: 'boolean' }],
				variadic: { kind: 'primitive', name: 'unknown' },
				minimum: 1
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
			returns: { kind: 'tuple', items: [{ kind: 'primitive', name: 'boolean' }, { kind: 'primitive', name: 'unknown' }], minimum: 1 }
		});

		expect(mods.coroutine.functions.running.signature).toEqual({
			kind: 'function',
			params: [],
			returns: { kind: 'union', items: [{ kind: 'custom', name: 'thread' }, { kind: 'primitive', name: 'nil' }] }
		});

		expect(mods.bit32.functions.band.signature).toEqual({
			kind: 'function',
			params: [],
			variadic: { kind: 'primitive', name: 'number' },
			returns: { kind: 'primitive', name: 'number' }
		});
	});
});
