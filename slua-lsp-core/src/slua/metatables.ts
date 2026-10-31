import type { SluaType } from './types.js';
import { slua, sluaTypeEquals } from './types.js';
import { buildBuiltinsFunctionSignature, loadBuiltinsYaml } from './builtins.js';

/**
 * Lua metamethod names that can be defined on a metatable.
 */
export type MetamethodName =
	| '__add'
	| '__sub'
	| '__mul'
	| '__div'
	| '__idiv'
	| '__mod'
	| '__pow'
	| '__unm'
	| '__concat'
	| '__eq'
	| '__lt'
	| '__le'
	| '__index'
	| '__newindex'
	| '__call'
	| '__tostring'
	| '__len'
	| '__pairs'
	| '__ipairs'
	| '__gc'
	| '__close'
	| '__type'
	| '__iter';

const ALL_METAMETHOD_NAMES: ReadonlySet<MetamethodName> = new Set<MetamethodName>([
	'__add',
	'__sub',
	'__mul',
	'__div',
	'__idiv',
	'__mod',
	'__pow',
	'__unm',
	'__concat',
	'__eq',
	'__lt',
	'__le',
	'__index',
	'__newindex',
	'__call',
	'__tostring',
	'__len',
	'__pairs',
	'__ipairs',
	'__gc',
	'__close',
	'__type',
	'__iter'
]);

/**
 * A metamethod definition with its signature.
 */
export type MetamethodDef = {
	name: MetamethodName;
	signature: SluaType;
	docs?: string;
};

/**
 * Metatable definition for a type (custom or primitive).
 */
export type MetatableDef = {
	typeName: string;
	isPrimitive?: boolean;
	metamethods: Partial<Record<MetamethodName, MetamethodDef>>;
	/**
	 * Optional named members reachable via __index (best-effort for completion).
	 * These are not Lua metamethods; they represent the “member surface area” of values of this type.
	 */
	members?: Record<
		string,
		{
			name: string;
			kind: 'method' | 'property';
			type: SluaType;
			docs?: string;
			/** If true, prefer/suggest only for ':' member access. */
			requiresColonCall?: boolean;
		}
	>;
	docs?: string;
};

/**
 * Central registry for metatable definitions.
 * This allows us to track which types support which metamethods,
 * enabling proper type inference for operators and special Lua operations.
 */
export class MetatableRegistry {
	private metatables = new Map<string, MetatableDef>();

	/**
	 * Register a metatable definition for a type.
	 */
	register(def: MetatableDef): void {
		this.metatables.set(def.typeName, def);
	}

	/**
	 * Get the metatable definition for a type.
	 */
	get(typeName: string): MetatableDef | undefined {
		return this.metatables.get(typeName);
	}

	getMembers(typeName: string): MetatableDef['members'] | undefined {
		return this.metatables.get(typeName)?.members;
	}

	/**
	 * Get a specific metamethod for a type.
	 */
	getMetamethod(typeName: string, methodName: MetamethodName): MetamethodDef | undefined {
		return this.metatables.get(typeName)?.metamethods[methodName];
	}

	/**
	 * Check if a type has a specific metamethod.
	 */
	hasMetamethod(typeName: string, methodName: MetamethodName): boolean {
		return this.getMetamethod(typeName, methodName) !== undefined;
	}

	/**
	 * Get the return type for a binary operation between two types.
	 * Returns undefined if the operation is not supported.
	 */
	getBinaryOperationReturnType(
		leftType: SluaType,
		rightType: SluaType,
		operator: string
	): SluaType | undefined {
		if (['+', '-', '*', '/', '//', '%', '^'].includes(operator) &&
			(isVectorOrRotation(leftType) || isVectorOrRotation(rightType))) {
			return getVectorRotationOperationReturnType(leftType, rightType, operator);
		}
		const metamethod = operatorToMetamethod(operator, 'binary');
		if (!metamethod) return undefined;

		// Try left operand's metatable first (custom or primitive)
		if (leftType.kind === 'custom' || leftType.kind === 'primitive') {
			const method = this.getMetamethod(leftType.name, metamethod);
			if (method && method.signature.kind === 'function') {
				// Verify the parameters match
				if (method.signature.params.length === 2) {
					return method.signature.returns;
				}
			}
		}

		// Try right operand's metatable if left failed
		if (rightType.kind === 'custom' || rightType.kind === 'primitive') {
			const method = this.getMetamethod(rightType.name, metamethod);
			if (method && method.signature.kind === 'function') {
				if (method.signature.params.length === 2) {
					return method.signature.returns;
				}
			}
		}

		return undefined;
	}

	/**
	 * Get the return type for a unary operation on a type.
	 */
	getUnaryOperationReturnType(operandType: SluaType, operator: string): SluaType | undefined {
		const metamethod = operatorToMetamethod(operator, 'unary');
		if (!metamethod) return undefined;

		if (operandType.kind === 'custom' || operandType.kind === 'primitive') {
			const method = this.getMetamethod(operandType.name, metamethod);
			if (method && method.signature.kind === 'function') {
				return method.signature.returns;
			}
		}

		return undefined;
	}
}

type ModuleLike = {
	name: string;
	source?: string;
	functions: Record<string, { name: string; signature: SluaType; docs?: string; deprecated?: boolean; source?: string }>;
};

function typeNameToSluaReceiverType(typeName: string): SluaType | null {
	switch (typeName) {
		case 'string':
			return slua.string();
		case 'number':
			return slua.number();
		case 'boolean':
			return slua.boolean();
		case 'vector':
			return slua.vector();
		case 'rotation':
			return slua.rotation();
		case 'quaternion':
			return slua.rotation();
		case 'integer':
			return slua.integer();
		default:
			return null;
	}
}

/**
 * Best-effort: treat modules whose name matches a known type as the __index “surface area” for that type.
 *
 * Example: a `string` module with `sub(s, i, j)` becomes a `s:sub(i, j)` method completion.
 */
export function augmentMetatableMembersFromModules(
	modules: Map<string, ModuleLike>,
	metatables: MetatableRegistry = defaultMetatableRegistry
): void {
	// Runtime probing shows that for SLua, `vector`/`rotation`/`quaternion` instances do NOT expose
	// module functions as instance members (their metatable __index is a function that rejects them).
	// The one reliable case we currently want is `string`, where the `string` module functions act
	// like instance methods (e.g. `s:sub(...)`). Keep this intentionally conservative.
	const MODULE_DERIVED_INSTANCE_MEMBERS: ReadonlySet<string> = new Set(['string']);

	for (const [name, mod] of modules.entries()) {
		if (!MODULE_DERIVED_INSTANCE_MEMBERS.has(name)) continue;
		const receiverType = typeNameToSluaReceiverType(name);
		if (!receiverType) continue;
		const mt = metatables.get(name);
		if (!mt) continue;

		// Only treat a module as an instance-member surface if it actually has receiver-style functions.
		// This prevents constructor-style modules like `vector.create(...)` from polluting `v.` completions.
		let hasReceiverStyleFn = false;
		for (const fn of Object.values(mod.functions)) {
			if (fn.signature.kind !== 'function') continue;
			const first = fn.signature.params[0];
			if (first && sluaTypeEquals(first, receiverType)) {
				hasReceiverStyleFn = true;
				break;
			}
		}
		if (!hasReceiverStyleFn) continue;

		const existing = mt.members ?? {};
		const merged: NonNullable<MetatableDef['members']> = { ...existing };

		for (const fn of Object.values(mod.functions)) {
			if (fn.deprecated) continue;
			if (fn.signature.kind !== 'function') continue;

			const firstParam = fn.signature.params[0];
			const isReceiverFirst = !!firstParam && sluaTypeEquals(firstParam, receiverType);
			// Only treat receiver-first functions as instance members.
			if (!isReceiverFirst) continue;
			// If it looks like a “method” (receiver as first arg), prefer colon call.
			const requiresColonCall = true;

			const memberType = slua.fn(fn.signature.params.slice(1), fn.signature.returns);

			const existingMember = merged[fn.name];
			const moduleIsYaml = mod.source === 'yaml' || fn.source === 'yaml';
			// Prefer YAML-derived members over built-in stubs.
			if (!existingMember || moduleIsYaml) {
				merged[fn.name] = {
					name: fn.name,
					kind: 'method',
					type: memberType,
					docs: fn.docs ?? '',
					requiresColonCall
				};
			}
		}

		mt.members = merged;
	}
}

/**
 * Map operators to their corresponding metamethods.
 */
function operatorToMetamethod(operator: string, type: 'binary' | 'unary'): MetamethodName | undefined {
	if (type === 'binary') {
		switch (operator) {
			case '+':
				return '__add';
			case '-':
				return '__sub';
			case '*':
				return '__mul';
			case '/':
				return '__div';
			case '//':
				return '__idiv';
			case '%':
				return '__mod';
			case '^':
				return '__pow';
			case '==':
				return '__eq';
			case '<':
				return '__lt';
			case '<=':
				return '__le';
			case '..':
				return '__concat';
			default:
				return undefined;
		}
	} else {
		switch (operator) {
			case '-':
			case 'unm':
				return '__unm';
			case '#':
			case 'len':
				return '__len';
			default:
				return undefined;
		}
	}
}

/**
 * Build default metatable definitions for SLua built-in types.
 */
export function buildDefaultMetatables(): MetatableDef[] {
	// Built-in primitive types
	const numberMetatable: MetatableDef = {
		typeName: 'number',
		isPrimitive: true,
		docs: 'Number type with arithmetic operations',
		metamethods: {
			__add: {
				name: '__add',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number addition: number + number'
			},
			__sub: {
				name: '__sub',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number subtraction: number - number'
			},
			__mul: {
				name: '__mul',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number multiplication: number * number'
			},
			__div: {
				name: '__div',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number division: number / number'
			},
			__mod: {
				name: '__mod',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number modulo: number % number'
			},
			__idiv: {
				name: '__idiv',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number floor division: number // number'
			},
			__pow: {
				name: '__pow',
				signature: slua.fn([slua.number(), slua.number()], slua.number()),
				docs: 'Number exponentiation: number ^ number'
			},
			__unm: {
				name: '__unm',
				signature: slua.fn([slua.number()], slua.number()),
				docs: 'Number negation: -number'
			},
			__eq: {
				name: '__eq',
				signature: slua.fn([slua.number(), slua.number()], slua.boolean()),
				docs: 'Number equality: number == number'
			},
			__lt: {
				name: '__lt',
				signature: slua.fn([slua.number(), slua.number()], slua.boolean()),
				docs: 'Number less than: number < number'
			},
			__le: {
				name: '__le',
				signature: slua.fn([slua.number(), slua.number()], slua.boolean()),
				docs: 'Number less than or equal: number <= number'
			},
			__tostring: {
				name: '__tostring',
				signature: slua.fn([slua.number()], slua.string()),
				docs: 'Convert number to string'
			}
		}
	};

	const stringMetatable: MetatableDef = {
		typeName: 'string',
		isPrimitive: true,
		docs: 'String type with concatenation and comparison',
		metamethods: {
			__concat: {
				name: '__concat',
				signature: slua.fn([slua.string(), slua.unknown()], slua.string()),
				docs: 'String concatenation: string .. any'
			},
			__eq: {
				name: '__eq',
				signature: slua.fn([slua.string(), slua.string()], slua.boolean()),
				docs: 'String equality: string == string'
			},
			__lt: {
				name: '__lt',
				signature: slua.fn([slua.string(), slua.string()], slua.boolean()),
				docs: 'String less than: string < string'
			},
			__le: {
				name: '__le',
				signature: slua.fn([slua.string(), slua.string()], slua.boolean()),
				docs: 'String less than or equal: string <= string'
			},
			__len: {
				name: '__len',
				signature: slua.fn([slua.string()], slua.number()),
				docs: 'String length: #string'
			},
			__index: {
				name: '__index',
				signature: slua.fn([slua.string(), slua.unknown()], slua.unknown()),
				docs: 'String indexing for string library methods'
			}
		}
	};

	const booleanMetatable: MetatableDef = {
		typeName: 'boolean',
		isPrimitive: true,
		docs: 'Boolean type',
		metamethods: {
			__eq: {
				name: '__eq',
				signature: slua.fn([slua.boolean(), slua.boolean()], slua.boolean()),
				docs: 'Boolean equality: boolean == boolean'
			},
			__tostring: {
				name: '__tostring',
				signature: slua.fn([slua.boolean()], slua.string()),
				docs: 'Convert boolean to string'
			}
		}
	};

	const detectedEventMetatable: MetatableDef = {
		typeName: 'DetectedEvent',
		docs: 'Runtime-detected collision/touch entry (SLua).',
		metamethods: {},
		members: {
			index: {
				name: 'index',
				kind: 'property',
				type: slua.number(),
				docs: '1-based detected index (as seen in runtime probes).'
			},
			valid: {
				name: 'valid',
				kind: 'property',
				type: slua.boolean(),
				docs: 'Whether this detected entry is valid (as seen in runtime probes).'
			},
			canAdjustDamage: {
				name: 'canAdjustDamage',
				kind: 'property',
				type: slua.boolean(),
				docs: 'Whether damage can be adjusted for this entry (as seen in runtime probes).'
			},
			getKey: {
				name: 'getKey',
				kind: 'method',
				type: slua.fn([], slua.uuid()),
				docs: 'Detected object key (like llDetectedKey).',
				requiresColonCall: true
			},
			getName: {
				name: 'getName',
				kind: 'method',
				type: slua.fn([], slua.string()),
				docs: 'Detected object name (like llDetectedName).',
				requiresColonCall: true
			},
			getOwner: {
				name: 'getOwner',
				kind: 'method',
				type: slua.fn([], slua.uuid()),
				docs: 'Detected owner key (like llDetectedOwner).',
				requiresColonCall: true
			},
			getGroup: {
				name: 'getGroup',
				kind: 'method',
				type: slua.fn([], slua.boolean()),
				docs: 'Whether the detected entity has the same active group as the script prim. Valid only during dispatch; this is a boolean, not a group UUID.',
				requiresColonCall: true
			},
			getType: {
				name: 'getType',
				kind: 'method',
				type: slua.fn([], slua.number()),
				docs: 'Detected type flags (like llDetectedType).',
				requiresColonCall: true
			},
			getLinkNumber: {
				name: 'getLinkNumber',
				kind: 'method',
				type: slua.fn([], slua.number()),
				docs: 'Detected link number (like llDetectedLinkNumber).',
				requiresColonCall: true
			},
			getPos: {
				name: 'getPos',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Detected position (like llDetectedPos).',
				requiresColonCall: true
			},
			getRot: {
				name: 'getRot',
				kind: 'method',
				type: slua.fn([], slua.rotation()),
				docs: 'Detected rotation (like llDetectedRot).',
				requiresColonCall: true
			},
			getVel: {
				name: 'getVel',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Detected velocity (like llDetectedVel).',
				requiresColonCall: true
			},
			getGrab: {
				name: 'getGrab',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Detected grab offset (like llDetectedGrab).',
				requiresColonCall: true
			},
			getTouchBinormal: {
				name: 'getTouchBinormal',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Touch binormal (like llDetectedTouchBinormal).',
				requiresColonCall: true
			},
			getTouchNormal: {
				name: 'getTouchNormal',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Touch normal (like llDetectedTouchNormal).',
				requiresColonCall: true
			},
			getTouchPos: {
				name: 'getTouchPos',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Touch position (like llDetectedTouchPos).',
				requiresColonCall: true
			},
			getTouchFace: {
				name: 'getTouchFace',
				kind: 'method',
				type: slua.fn([], slua.number()),
				docs: 'Touch face index (like llDetectedTouchFace).',
				requiresColonCall: true
			},
			getTouchST: {
				name: 'getTouchST',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Touch ST coordinates (like llDetectedTouchST).',
				requiresColonCall: true
			},
			getTouchUV: {
				name: 'getTouchUV',
				kind: 'method',
				type: slua.fn([], slua.vector()),
				docs: 'Touch UV coordinates (like llDetectedTouchUV).',
				requiresColonCall: true
			},
			getRezzer: {
				name: 'getRezzer',
				kind: 'method',
				type: slua.fn([], slua.uuid()),
				docs: 'Detected rezzer key (like llDetectedRezzer).',
				requiresColonCall: true
			},
			getDamage: {
				name: 'getDamage',
				kind: 'method',
				type: slua.fn([], slua.table()),
				docs: 'Pending damage information list: current damage, damage type and original damage. Valid only during dispatch.',
				requiresColonCall: true
			},
			adjustDamage: {
				name: 'adjustDamage',
				kind: 'method',
				type: slua.fn([slua.number()], slua.nil()),
				docs: 'Adjust damage for this entry (like llAdjustDamage); errors if unsupported.',
				requiresColonCall: true
			}
		}
	};

	const vectorMetatable: MetatableDef = {
		typeName: 'vector',
		docs: 'Vector type (Luau/SLua): component fields x/y/z (and sometimes w), supports arithmetic; no instance methods.',
		metamethods: {
			__add: {
				name: '__add',
				signature: slua.fn([slua.vector(), slua.vector()], slua.vector()),
				docs: 'Vector addition: vector + vector'
			},
			__sub: {
				name: '__sub',
				signature: slua.fn([slua.vector(), slua.vector()], slua.vector()),
				docs: 'Vector subtraction: vector - vector'
			},
			__mul: {
				name: '__mul',
				signature: slua.fn([slua.unknown(), slua.unknown()], slua.unknown()),
				docs: 'Vector multiplication: v*q rotates; v*v multiplies components. Use vector.dot for the dot product.'
			},
			__div: {
				name: '__div',
				signature: slua.fn([slua.unknown(), slua.unknown()], slua.unknown()),
				docs: 'Vector division; specific combos are refined by the type engine (e.g. v/number, v/q inverse-rotate).'
			},
			__mod: {
				name: '__mod',
				signature: slua.fn([slua.vector(), slua.vector()], slua.vector()),
				docs: 'Vector cross product: vector % vector'
			},
			__unm: {
				name: '__unm',
				signature: slua.fn([slua.vector()], slua.vector()),
				docs: 'Vector negation: -vector'
			},
			__eq: {
				name: '__eq',
				signature: slua.fn([slua.vector(), slua.vector()], slua.boolean()),
				docs: 'Vector equality: vector == vector'
			},
			__tostring: {
				name: '__tostring',
				signature: slua.fn([slua.vector()], slua.string()),
				docs: 'Convert vector to string: tostring(vector)'
			},
			__index: {
				name: '__index',
				signature: slua.fn([slua.vector(), slua.string()], slua.number()),
				docs: 'Access vector components via x/y/z (and sometimes w). Unknown fields error at runtime.'
			},
			__type: {
				name: '__type',
				signature: slua.fn([slua.vector()], slua.string()),
				docs: 'Get type name: typeof(vector) returns "vector"'
			}
		},
		members: {
			x: { name: 'x', kind: 'property', type: slua.number(), docs: 'Vector component x.' },
			y: { name: 'y', kind: 'property', type: slua.number(), docs: 'Vector component y.' },
			z: { name: 'z', kind: 'property', type: slua.number(), docs: 'Vector component z.' },
			w: { name: 'w', kind: 'property', type: slua.number(), docs: 'Optional 4th component (only if enabled in the runtime build).' }
		}
	};

	const rotationMetatable: MetatableDef = {
		typeName: 'rotation',
		docs: 'Rotation/quaternion type (SLua): component fields x/y/z/s; supports quaternion ops; no instance methods.',
		metamethods: {
			__add: {
				name: '__add',
				signature: slua.fn([slua.rotation(), slua.rotation()], slua.rotation()),
				docs: 'Quaternion addition: rotation + rotation'
			},
			__sub: {
				name: '__sub',
				signature: slua.fn([slua.rotation(), slua.rotation()], slua.rotation()),
				docs: 'Quaternion subtraction: rotation - rotation'
			},
			__mul: {
				name: '__mul',
				signature: slua.fn([slua.rotation(), slua.rotation()], slua.rotation()),
				docs: 'Quaternion multiplication: rotation * rotation'
			},
			__div: {
				name: '__div',
				signature: slua.fn([slua.rotation(), slua.rotation()], slua.rotation()),
				docs: 'Quaternion division: rotation / rotation'
			},
			__unm: {
				name: '__unm',
				signature: slua.fn([slua.rotation()], slua.rotation()),
				docs: 'Quaternion negation: -rotation'
			},
			__eq: {
				name: '__eq',
				signature: slua.fn([slua.rotation(), slua.rotation()], slua.boolean()),
				docs: 'Quaternion equality: rotation == rotation'
			},
			__tostring: {
				name: '__tostring',
				signature: slua.fn([slua.rotation()], slua.string()),
				docs: 'Convert quaternion to string: tostring(rotation)'
			},
			__index: {
				name: '__index',
				signature: slua.fn([slua.rotation(), slua.string()], slua.number()),
				docs: 'Access rotation components via x/y/z/s. Unknown fields error at runtime.'
			},
			__type: {
				name: '__type',
				signature: slua.fn([slua.rotation()], slua.string()),
				docs: 'Get type name: typeof(rotation) returns "quaternion" (SLua quirk: rotation/quaternion share one userdata type).'
			}
		},
		members: {
			x: { name: 'x', kind: 'property', type: slua.number(), docs: 'Quaternion component x.' },
			y: { name: 'y', kind: 'property', type: slua.number(), docs: 'Quaternion component y.' },
			z: { name: 'z', kind: 'property', type: slua.number(), docs: 'Quaternion component z.' },
			s: { name: 's', kind: 'property', type: slua.number(), docs: 'Quaternion scalar component s.' }
		}
	};

	// quaternion is an alias for rotation (same runtime userdata).
	const quaternionMetatable: MetatableDef = {
		...rotationMetatable,
		typeName: 'quaternion'
	};

	return [
		numberMetatable,
		stringMetatable,
		booleanMetatable,
		detectedEventMetatable,
		vectorMetatable,
		rotationMetatable,
		quaternionMetatable
	];
}

/**
 * The default global metatable registry instance.
 */
export const defaultMetatableRegistry = new MetatableRegistry();

// Register default metatables
for (const metatable of buildDefaultMetatables()) {
	defaultMetatableRegistry.register(metatable);
}

function applyBuiltinsMetatableMembers(registry: MetatableRegistry): void {
	const builtins = loadBuiltinsYaml();
	if (!builtins) return;
	for (const [typeName, mt] of Object.entries(builtins.metatables)) {
		let def = registry.get(typeName);
		if (!def) {
			def = {
				typeName,
				isPrimitive: typeName === 'number' || typeName === 'string' || typeName === 'boolean',
				metamethods: {},
				members: {},
				docs: ''
			};
			registry.register(def);
		}

		// Merge metamethods (used for operator typing).
		if (mt.metamethods) {
			for (const [name, fn] of Object.entries(mt.metamethods)) {
				if (!name.startsWith('__')) continue;
				// Runtime guard: only accept metamethods we model.
				if (!ALL_METAMETHOD_NAMES.has(name as MetamethodName)) continue;
				def.metamethods[name as MetamethodName] = {
					name: name as MetamethodName,
					signature: buildBuiltinsFunctionSignature(fn),
					docs: fn.docs
				};
			}
		}

		const existing = def.members ?? {};
		const merged: NonNullable<MetatableDef['members']> = { ...existing };
		for (const m of Object.values(mt.members)) {
			merged[m.name] = {
				name: m.name,
				kind: m.kind,
				type: m.type,
				docs: m.docs,
				requiresColonCall: m.requiresColonCall
			};
		}
		def.members = merged;
	}
}

applyBuiltinsMetatableMembers(defaultMetatableRegistry);

/** Native SLua arithmetic, distinct from LSL vector dot-product semantics. */
export function isVectorOrRotation(type: SluaType): boolean {
	return type.kind === 'custom' && (type.name === 'vector' || type.name === 'rotation');
}

export function getVectorRotationOperationReturnType(left: SluaType, right: SluaType, operator: string): SluaType | undefined {
	const name = (type: SluaType) => type.kind === 'custom' || type.kind === 'primitive' ? type.name : undefined;
	const a = name(left), b = name(right);
	if (operator === '+' || operator === '-') {
		if (a === 'vector' && b === 'vector') return slua.vector();
		if (a === 'rotation' && b === 'rotation') return slua.rotation();
	}
	if (operator === '*' || operator === '/' || operator === '//') {
		if (a === 'vector' && (b === 'vector' || b === 'number') || a === 'number' && b === 'vector') return slua.vector();
		// Floor division does not invoke rotation/inverse-rotation operations.
		if (operator !== '//') {
			if (a === 'vector' && b === 'rotation') return slua.vector();
			if (a === 'rotation' && b === 'rotation') return slua.rotation();
		}
	}
	if (operator === '%' && a === 'vector' && b === 'vector') return slua.vector();
	return undefined;
}

export function getSpecificMultiplicationReturnType(left: SluaType, right: SluaType): SluaType | undefined {
	return getVectorRotationOperationReturnType(left, right, '*');
}

export function getSpecificDivisionReturnType(left: SluaType, right: SluaType, operator: '/' | '//' = '/'): SluaType | undefined {
	return getVectorRotationOperationReturnType(left, right, operator);
}
