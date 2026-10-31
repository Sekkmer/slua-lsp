import type { LlModule } from './llModule.js';
import { buildLlModuleFromLslDefinitions } from './llModule.js';
import type { SluaEventSignature } from './events.js';
import { buildSluaEventSignaturesFromLslDefinitions } from './events.js';
import type { SluaType } from './types.js';
import { slua } from './types.js';
import { augmentMetatableMembersFromModules, defaultMetatableRegistry } from './metatables.js';
import { buildBuiltinsFunctionSignature, loadBuiltinsYaml } from './builtins.js';
import type { CoreDiagnostic } from '../diagnostics/types.js';

export type SluaSource = 'default' | 'yaml' | 'override';

export type SluaValueDef = {
	name: string;
	/** Private upstream entry retained for explicit lookup, omitted from suggestions. */
	private?: boolean;
	type: SluaType;
	readonly: boolean;
	docs: string;
	deprecated: boolean;
	value?: unknown;
	source: SluaSource;
};

export type SluaParamDef = {
	name: string;
	type: SluaType;
	docs: string;
};

export type SluaFunctionDef = {
	name: string;
	/** Private upstream entry retained for explicit lookup, omitted from suggestions. */
	private?: boolean;
	/** Parameter names/types when available (e.g. from YAML). */
	params?: SluaParamDef[];
	signature: SluaType;
	docs: string;
	deprecated: boolean;
	source: SluaSource;
	meta?: {
		lslName?: string;
		sleepSeconds?: number | null;
		monoSleepSeconds?: number | null;
		godMode?: boolean;
	};
};

export type SluaMethodDef = {
	name: string;
	requiresColonCall: boolean;
	signature: SluaType;
	docs: string;
	source: SluaSource;
};

export type SluaObjectTypeDef = {
	name: string;
	/** Nominal instance type, not a global runtime singleton. */
	instanceOnly?: boolean;
	methods: Record<string, SluaMethodDef>;
	properties: Record<string, SluaValueDef>;
	source: SluaSource;
};

export type SluaModuleDef = {
	name: string;
	functions: Record<string, SluaFunctionDef>;
	values: Record<string, SluaValueDef>;
	source: SluaSource;
};

/**
 * A single uniform place to describe SLua globals/modules/object-types.
 *
 * - "modules" covers things accessed like `ll.Say(...)`, `ll.ACTIVE`, `lljson.encode(...)`, `os.time(...)`.
 * - "objectTypes" covers userdata-like globals accessed via colon calls, like `LLEvents:on(...)`.
 * - "globals" covers standalone functions like `vector(...)`.
 */
export class SluaRegistry {
	modules = new Map<string, SluaModuleDef>();
	objectTypes = new Map<string, SluaObjectTypeDef>();
	globals = new Map<string, SluaFunctionDef>();
	globalValues = new Map<string, SluaValueDef>();
	/** Per-project expression facts; base registries leave both collections empty. */
	expressionTypes = new WeakMap<object, SluaType>();
	sourceRequireCallees = new WeakSet<object>();
	/** Exact AST ownership and snapshot hashes for source navigation. */
	sourceNodeFiles = new WeakMap<object, string>();
	sourceFileHashes = new Map<string, string>();
	/** Explicit file-scoped source context; absent in the ordinary runtime registry. */
	sourceMacroUses = new WeakSet<object>();
	sourceMacroInvalidUses = new WeakSet<object>();
	sourceMacroDiagnostics: CoreDiagnostic[] = [];
	/** Original registry behind a temporary file-context overlay. */
	sourceContextBase?: SluaRegistry;
	/** Event signatures from YAML (+ overrides). Used for LLEvents callback inference. */
	eventSignatures: Record<string, SluaEventSignature> = {};

	getModule(name: string): SluaModuleDef | undefined {
		return this.modules.get(name);
	}

	getGlobalValue(name: string): SluaValueDef | undefined {
		return this.globalValues.get(name);
	}

	getObjectType(name: string): SluaObjectTypeDef | undefined {
		return this.objectTypes.get(name);
	}

	getGlobal(name: string): SluaFunctionDef | undefined {
		return this.globals.get(name);
	}

	getObjectMethod(receiver: string, method: string): SluaMethodDef | undefined {
		return this.objectTypes.get(receiver)?.methods[method];
	}
}

function llModuleToRegistryModule(name: string, ll: LlModule): SluaModuleDef {
	const functions: Record<string, SluaFunctionDef> = {};
	for (const [fnName, fn] of Object.entries(ll.functions)) {
		const returnHint = fn.returnLslType && fn.returnLslType !== 'void' ? `\n\nLSL return type: ${fn.returnLslType}.` : '';
		functions[fnName] = {
			name: fnName,
			params: fn.params.map((p) => {
				const typeHint = p.lslType ? ` (LSL: ${p.lslType})` : '';
				return { name: p.name, type: p.type, docs: (p.tooltip ?? '') + typeHint };
			}),
			signature: slua.fn(fn.params.map((p) => p.type), fn.returnType),
			docs: (fn.tooltip ?? '') + returnHint,
			deprecated: fn.deprecated,
			private: fn.private,
			source: 'yaml',
			meta: {
				lslName: fn.lslName,
				sleepSeconds: fn.sleepSeconds,
				monoSleepSeconds: fn.monoSleepSeconds,
				godMode: fn.godMode
			}
		};
	}

	const values: Record<string, SluaValueDef> = {};
	for (const [constName, c] of Object.entries(ll.constants)) {
		values[constName] = {
			name: constName,
			private: c.private,
			type: c.type,
			readonly: true,
			docs: c.tooltip,
			deprecated: false,
			value: c.value,
			source: 'yaml'
		};
	}

	return {
		name,
		functions,
		values,
		source: 'yaml'
	};
}

function buildDefaultObjectTypes(_eventSigs: Record<string, SluaEventSignature>): Record<string, SluaObjectTypeDef> {
	const genericEventHandler = slua.fn([slua.unknown()], slua.nil());
	const recurringTimerHandler = slua.fn([slua.number(), slua.number()], slua.unknown());
	const onceTimerHandler = slua.fn([slua.number(), slua.nil()], slua.unknown());
	const genericTimerHandler = slua.union([slua.fn([slua.number(), slua.union([slua.number(), slua.nil()])], slua.unknown()), slua.table()]);

	const LLEvents: SluaObjectTypeDef = {
		name: 'LLEvents',
		source: 'default',
		methods: {
			on: {
				name: 'on',
				requiresColonCall: true,
				signature: slua.fn([slua.string(), genericEventHandler], genericEventHandler),
				docs:
					'Add an event handler and return a handler token (usually the same function). Callback signature depends on event name. Note: SLua rejects handlers defined with method-style ":" (wrap in a plain function if needed).',
				source: 'default'
			},
			once: {
				name: 'once',
				requiresColonCall: true,
				signature: slua.fn([slua.string(), genericEventHandler], genericEventHandler),
				docs:
					'Add a one-shot event handler and return a handler token (wrapper) that can be passed to LLEvents:off(...).',
				source: 'default'
			},
			off: {
				name: 'off',
				requiresColonCall: true,
				signature: slua.fn([slua.string(), genericEventHandler], slua.boolean()),
				docs: 'Remove an event handler; returns true if removed.',
				source: 'default'
			},
			eventNames: {
				name: 'eventNames',
				requiresColonCall: true,
				signature: slua.fn([], slua.array(slua.string())),
				docs: 'Return event names with currently registered handlers.',
				source: 'default'
			},
			handlers: {
				name: 'handlers',
				requiresColonCall: true,
				signature: slua.fn([slua.string()], slua.array(genericEventHandler)),
				docs:
					'Return handlers for an event name. Note: the internal timer wrapper ("timer" event) is intentionally not directly callable/unregisterable; it may appear as a guard function.',
				source: 'default'
			}
		},
		properties: {}
	};

	const LLTimers: SluaObjectTypeDef = {
		name: 'LLTimers',
		source: 'default',
		methods: {
			every: {
				name: 'every',
				requiresColonCall: true,
				signature: slua.fn([slua.number(), slua.union([recurringTimerHandler, slua.table()])], genericTimerHandler),
				docs: 'Run callback(scheduled_time: number, interval: number) every N seconds (N must be >= 0); callback returns are ignored. Callable tables are supported. Returns a handler token (usually the same function) that can be passed to LLTimers:off(...).',
				source: 'default'
			},
			once: {
				name: 'once',
				requiresColonCall: true,
				signature: slua.fn([slua.number(), slua.union([onceTimerHandler, slua.table()])], genericTimerHandler),
				docs: 'Run callback(scheduled_time: number, interval: nil) once after N seconds (N must be >= 0); callback returns are ignored. Callable tables are supported. Returns a handler token for LLTimers:off(...).',
				source: 'default'
			},
			off: {
				name: 'off',
				requiresColonCall: true,
				signature: slua.fn([genericTimerHandler], slua.boolean()),
				docs: 'Remove a timer by handler token; returns true if removed.',
				source: 'default'
			}
		},
		properties: {}
	};

	return { LLEvents, LLTimers };
}

function buildDefaultGlobals(): Record<string, SluaFunctionDef> {
	const builtins = loadBuiltinsYaml();
	if (builtins) {
		const globals: Record<string, SluaFunctionDef> = {};
		for (const [name, fn] of Object.entries(builtins.globals)) {
			globals[name] = {
				name,
				signature: buildBuiltinsFunctionSignature(fn),
				docs: fn.docs,
				deprecated: fn.deprecated,
				source: 'yaml'
			};
		}
		return globals;
	}

	const f = (name: string, signature: SluaType, docs = ''): SluaFunctionDef => ({
		name,
		signature,
		docs,
		deprecated: false,
		source: 'default'
	});

	return {
		// Core Lua-ish builtins (best-effort; used for completion + ranking, not strict typing).
		type: f('type', slua.fn([slua.unknown()], slua.string())),
		tostring: f('tostring', slua.fn([slua.unknown()], slua.string())),
		tonumber: f('tonumber', slua.fn([slua.unknown()], slua.number())),
		pairs: f('pairs', slua.fn([slua.table()], slua.unknown())),
		ipairs: f('ipairs', slua.fn([slua.table()], slua.unknown())),
		getmetatable: f('getmetatable', slua.fn([slua.unknown()], slua.table())),
		setmetatable: f('setmetatable', slua.fn([slua.table(), slua.table()], slua.table())),

		vector: f('vector', slua.fn([slua.number(), slua.number(), slua.number()], slua.vector())),
		rotation: f('rotation', slua.fn([slua.number(), slua.number(), slua.number(), slua.number()], slua.rotation())),
		quaternion: f('quaternion', slua.fn([slua.number(), slua.number(), slua.number(), slua.number()], slua.rotation())),
		uuid: f('uuid', slua.fn([slua.union([slua.string(), slua.buffer(), slua.uuid()])], slua.uuid())),
		touuid: f('touuid', slua.fn([slua.union([slua.string(), slua.buffer(), slua.uuid(), slua.nil()])], slua.union([slua.uuid(), slua.nil()]), undefined, { min: 0, max: 1 })),
		tovector: f('tovector', slua.fn([slua.union([slua.string(), slua.vector(), slua.nil()])], slua.union([slua.vector(), slua.nil()]), undefined, { min: 1, max: 1 })),
		toquaternion: f('toquaternion', slua.fn([slua.union([slua.string(), slua.rotation(), slua.nil()])], slua.union([slua.rotation(), slua.nil()]), undefined, { min: 1, max: 1 })),
		torotation: f('torotation', slua.fn([slua.union([slua.string(), slua.rotation(), slua.nil()])], slua.union([slua.rotation(), slua.nil()]), undefined, { min: 1, max: 1 })),
		typeof: f('typeof', slua.fn([slua.unknown()], slua.string()))
	};
}

function buildDefaultModules(): Record<string, SluaModuleDef> {
	const builtins = loadBuiltinsYaml();
	if (builtins) {
		const modules: Record<string, SluaModuleDef> = {};
		for (const [name, mod] of Object.entries(builtins.modules)) {
			const functions: Record<string, SluaFunctionDef> = {};
			for (const [fnName, fn] of Object.entries(mod.functions)) {
				functions[fnName] = {
					name: fnName,
					signature: buildBuiltinsFunctionSignature(fn),
					docs: fn.docs,
					deprecated: fn.deprecated,
					source: 'yaml'
				};
			}
			const values: Record<string, SluaValueDef> = {};
			for (const [valName, v] of Object.entries(mod.values)) {
				values[valName] = {
					name: valName,
					type: v.type,
					readonly: v.readonly,
					docs: v.docs,
					deprecated: v.deprecated,
					value: v.value,
					source: 'yaml'
				};
			}
			modules[name] = { name, functions, values, source: 'yaml' };
		}
		return modules;
	}

	const stub = (name: string): SluaModuleDef => ({
		name,
		source: 'default',
		functions: {},
		values: {}
	});

	const fn = (name: string, signature: SluaType, docs = ''): SluaFunctionDef => ({
		name,
		signature,
		docs,
		deprecated: false,
		source: 'default'
	});

	const value = (name: string, type: SluaType, readonly: boolean, docs = ''): SluaValueDef => ({
		name,
		type,
		readonly,
		docs,
		deprecated: false,
		source: 'default'
	});

	return {
		lljson: {
			name: 'lljson',
			source: 'default',
			functions: {
				encode: fn('encode', slua.fn([slua.unknown(), slua.table()], slua.string(), undefined, { min: 1, max: 2 })),
				decode: fn('decode', slua.fn([slua.string(), slua.union([slua.table(), slua.anyFunction()])], slua.unknown(), undefined, { min: 1, max: 2 })),
				slencode: fn('slencode', slua.fn([slua.unknown(), slua.table()], slua.string(), undefined, { min: 1, max: 2 })),
				sldecode: fn('sldecode', slua.fn([slua.string(), slua.union([slua.table(), slua.anyFunction()])], slua.unknown(), undefined, { min: 1, max: 2 }))
			},
			values: {
				null: value('null', slua.unknown(), true),
				remove: value('remove', slua.unknown(), true),
				empty_array: value('empty_array', slua.table(), true),
				empty_object: value('empty_object', slua.table(), true),
				array_mt: value('array_mt', slua.table(), true),
				object_mt: value('object_mt', slua.table(), true)
			}
		},
		llbase64: {
			name: 'llbase64',
			source: 'default',
			functions: {
				encode: fn('encode', slua.fn([slua.string()], slua.string())),
				decode: fn('decode', slua.fn([slua.string()], slua.string()))
			},
			values: {}
		},
		vector: {
			name: 'vector',
			source: 'default',
			functions: {
				create: fn('create', slua.fn([slua.number(), slua.number(), slua.number()], slua.vector())),
				abs: fn('abs', slua.fn([slua.vector()], slua.vector())),
				angle: fn('angle', slua.fn([slua.vector(), slua.vector()], slua.number())),
				ceil: fn('ceil', slua.fn([slua.vector()], slua.vector())),
				clamp: fn('clamp', slua.fn([slua.vector(), slua.vector(), slua.vector()], slua.vector())),
				cross: fn('cross', slua.fn([slua.vector(), slua.vector()], slua.vector())),
				dot: fn('dot', slua.fn([slua.vector(), slua.vector()], slua.number())),
				floor: fn('floor', slua.fn([slua.vector()], slua.vector())),
				magnitude: fn('magnitude', slua.fn([slua.vector()], slua.number())),
				lerp: fn('lerp', slua.fn([slua.vector(), slua.vector(), slua.number()], slua.vector())),
				max: fn('max', slua.fn([slua.vector(), slua.vector()], slua.vector())),
				min: fn('min', slua.fn([slua.vector(), slua.vector()], slua.vector())),
				normalize: fn('normalize', slua.fn([slua.vector()], slua.vector())),
				sign: fn('sign', slua.fn([slua.vector()], slua.vector()))
			},
			values: {
				zero: value('zero', slua.vector(), true),
				one: value('one', slua.vector(), true)
			}
		},

		// Built-in Lua-ish stdlib modules (best-effort): give us good completion even without YAML.
		string: {
			name: 'string',
			source: 'default',
			functions: {
				len: fn('len', slua.fn([slua.string()], slua.number())),
				sub: fn('sub', slua.fn([slua.string(), slua.number(), slua.number()], slua.string())),
				lower: fn('lower', slua.fn([slua.string()], slua.string())),
				upper: fn('upper', slua.fn([slua.string()], slua.string())),
				reverse: fn('reverse', slua.fn([slua.string()], slua.string())),
				rep: fn('rep', slua.fn([slua.string(), slua.number()], slua.string())),
				find: fn('find', slua.fn([slua.string(), slua.string()], slua.tuple([slua.number(), slua.number()]))),
				match: fn('match', slua.fn([slua.string(), slua.string()], slua.string())),
				gsub: fn('gsub', slua.fn([slua.string(), slua.string(), slua.string()], slua.tuple([slua.string(), slua.number()])))
			},
			values: {}
		},
		table: {
			name: 'table',
			source: 'default',
			functions: {
				insert: fn('insert', slua.fn([slua.table(), slua.unknown()], slua.nil())),
				remove: fn('remove', slua.fn([slua.table(), slua.number()], slua.unknown())),
				sort: fn('sort', slua.fn([slua.table()], slua.nil())),
				concat: fn('concat', slua.fn([slua.table()], slua.string()))
			},
			values: {}
		},
		math: {
			name: 'math',
			source: 'default',
			functions: {
				abs: fn('abs', slua.fn([slua.number()], slua.number())),
				floor: fn('floor', slua.fn([slua.number()], slua.number())),
				ceil: fn('ceil', slua.fn([slua.number()], slua.number())),
				min: fn('min', slua.fn([slua.number(), slua.number()], slua.number())),
				max: fn('max', slua.fn([slua.number(), slua.number()], slua.number())),
				sqrt: fn('sqrt', slua.fn([slua.number()], slua.number())),
				sin: fn('sin', slua.fn([slua.number()], slua.number())),
				cos: fn('cos', slua.fn([slua.number()], slua.number())),
				tan: fn('tan', slua.fn([slua.number()], slua.number()))
			},
			values: {
				pi: value('pi', slua.number(), true)
			}
		},
		os: {
			name: 'os',
			source: 'default',
			functions: {
				time: fn('time', slua.fn([], slua.number())),
				clock: fn('clock', slua.fn([], slua.number())),
				difftime: fn('difftime', slua.fn([slua.number(), slua.number()], slua.number())),
				date: fn('date', slua.fn([], slua.string()))
			},
			values: {}
		},
		utf8: {
			name: 'utf8',
			source: 'default',
			functions: {
				len: fn('len', slua.fn([slua.string()], slua.number())),
				codepoint: fn('codepoint', slua.fn([slua.string()], slua.number())),
				char: fn('char', slua.fn([slua.number()], slua.string()))
			},
			values: {}
		},
		_G: stub('_G'),
		rotation: {
			name: 'rotation',
			source: 'default',
			functions: {
				create: fn('create', slua.fn([slua.number(), slua.number(), slua.number(), slua.number()], slua.rotation())),
				conjugate: fn('conjugate', slua.fn([slua.rotation()], slua.rotation())),
				dot: fn('dot', slua.fn([slua.rotation(), slua.rotation()], slua.number())),
				magnitude: fn('magnitude', slua.fn([slua.rotation()], slua.number())),
				normalize: fn('normalize', slua.fn([slua.rotation()], slua.rotation())),
				slerp: fn('slerp', slua.fn([slua.rotation(), slua.rotation(), slua.number()], slua.rotation())),
				tofwd: fn('tofwd', slua.fn([slua.rotation()], slua.vector())),
				toleft: fn('toleft', slua.fn([slua.rotation()], slua.vector())),
				toup: fn('toup', slua.fn([slua.rotation()], slua.vector()))
			},
			values: {
				identity: value('identity', slua.rotation(), true)
			}
		},
		quaternion: {
			name: 'quaternion',
			source: 'default',
			functions: {
				create: fn('create', slua.fn([slua.number(), slua.number(), slua.number(), slua.number()], slua.rotation())),
				conjugate: fn('conjugate', slua.fn([slua.rotation()], slua.rotation())),
				dot: fn('dot', slua.fn([slua.rotation(), slua.rotation()], slua.number())),
				magnitude: fn('magnitude', slua.fn([slua.rotation()], slua.number())),
				normalize: fn('normalize', slua.fn([slua.rotation()], slua.rotation())),
				slerp: fn('slerp', slua.fn([slua.rotation(), slua.rotation(), slua.number()], slua.rotation())),
				tofwd: fn('tofwd', slua.fn([slua.rotation()], slua.vector())),
				toleft: fn('toleft', slua.fn([slua.rotation()], slua.vector())),
				toup: fn('toup', slua.fn([slua.rotation()], slua.vector()))
			},
			values: {
				identity: value('identity', slua.rotation(), true)
			}
		},
		uuid: {
			name: 'uuid',
			source: 'default',
			functions: {
				create: fn('create', slua.fn([slua.string()], slua.uuid()))
			},
			values: {}
		}
	};
}

/** Keep loaded getter contracts local to this registry, including custom YAML. */
function buildDetectedEventType(ll?: LlModule): SluaObjectTypeDef {
	const result: SluaObjectTypeDef = { name: 'DetectedEvent', instanceOnly: true, methods: {}, properties: {}, source: 'default' };
	for (const member of Object.values(defaultMetatableRegistry.getMembers('DetectedEvent') ?? {})) {
		if (member.kind === 'property') result.properties[member.name] = { name: member.name, type: member.type, docs: member.docs ?? '', readonly: true, deprecated: false, source: 'default' };
		else result.methods[member.name] = { name: member.name, signature: member.type, docs: member.docs ?? '', requiresColonCall: member.requiresColonCall ?? true, source: 'default' };
	}
	for (const [name, method] of Object.entries(result.methods)) {
		const source = ll?.functions[name === 'adjustDamage' ? 'AdjustDamage' : `Detected${name.slice(3)}`];
		if (source) result.methods[name] = { ...method, signature: slua.fn(source.params.slice(1).map((p) => p.type), source.returnType), docs: `${source.tooltip}\n\nValid only during event dispatch.${name === 'adjustDamage' ? ' Requires canAdjustDamage; changes pending host damage.' : ''}`, source: 'yaml' };
	}
	return result;
}

export function buildSluaRegistryFromLslDefinitions(defs: unknown | null): SluaRegistry {
	const registry = new SluaRegistry();
	const sigs = defs ? buildSluaEventSignaturesFromLslDefinitions(defs) : {};
	registry.eventSignatures = sigs;

	// Object types (userdata-ish): LLEvents / LLTimers.
	const objs = buildDefaultObjectTypes(sigs);
	for (const obj of Object.values(objs)) registry.objectTypes.set(obj.name, obj);

	// Global helper functions.
	for (const fn of Object.values(buildDefaultGlobals())) registry.globals.set(fn.name, fn);

	// Modules.
	for (const mod of Object.values(buildDefaultModules())) registry.modules.set(mod.name, mod);

	// YAML-driven ll/llcompat module exports (functions + constants).
	if (defs) {
		const ll = buildLlModuleFromLslDefinitions(defs);
		const ordinary = llModuleToRegistryModule('ll', ll);
		registry.modules.set('ll', ordinary);
		// Official declarations expose these constants as globals too.
		for (const [name, value] of Object.entries(ordinary.values)) registry.globalValues.set(name, value);
		registry.modules.set('llcompat', llModuleToRegistryModule('llcompat', buildLlModuleFromLslDefinitions(defs, true)));
		registry.objectTypes.set('DetectedEvent', buildDetectedEventType(ll));
	}

	if (!registry.objectTypes.has('DetectedEvent')) registry.objectTypes.set('DetectedEvent', buildDetectedEventType());

	// Best-effort: enrich metatable member completion from available modules.
	augmentMetatableMembersFromModules(registry.modules);

	return registry;
}
