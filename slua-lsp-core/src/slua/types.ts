import { mergeSourceOrigins } from './sourceOrigins.js';
import { classType, nativeClassKind } from './classIdentity.js';

export type SluaPrimitiveType = 'number' | 'string' | 'boolean' | 'nil' | 'unknown';

export type SluaCustomType = 'uuid' | 'vector' | 'rotation' | 'integer' | 'DetectedEvent' | 'thread' | 'buffer' | (string & {});

/** Native argument presence is independent of whether a supplied value may be nil. */
export type SluaCallArity = { min: number; max: number };

export type SluaType =
	| { kind: 'primitive'; name: SluaPrimitiveType }
	| { kind: 'custom'; name: SluaCustomType }
	| { kind: 'array'; element: SluaType }
	| { kind: 'table'; module?: string; metatable?: string; fields?: Record<string, SluaType> }
	| { kind: 'literal'; value: string }
	| { kind: 'tuple'; items: SluaType[]; variadic?: SluaType; minimum?: number }
	| { kind: 'union'; items: SluaType[] }
	| { kind: 'function'; params: SluaType[]; returns: SluaType; variadic?: SluaType; untyped?: true; arity?: SluaCallArity };

export const slua = {
	unknown(): SluaType {
		return { kind: 'primitive', name: 'unknown' };
	},
	nil(): SluaType {
		return { kind: 'primitive', name: 'nil' };
	},
	number(): SluaType {
		return { kind: 'primitive', name: 'number' };
	},
	string(): SluaType {
		return { kind: 'primitive', name: 'string' };
	},
	boolean(): SluaType {
		return { kind: 'primitive', name: 'boolean' };
	},
	uuid(): SluaType {
		return { kind: 'custom', name: 'uuid' };
	},
	vector(): SluaType {
		return { kind: 'custom', name: 'vector' };
	},
	rotation(): SluaType {
		return { kind: 'custom', name: 'rotation' };
	},
	integer(): SluaType {
		return { kind: 'custom', name: 'integer' };
	},
	thread(): SluaType {
		return { kind: 'custom', name: 'thread' };
	},
	buffer(): SluaType {
		return { kind: 'custom', name: 'buffer' };
	},
	detectedEvent(): SluaType {
		return { kind: 'custom', name: 'DetectedEvent' };
	},
	custom(name: string): SluaType {
		return { kind: 'custom', name };
	},
	array(element: SluaType): SluaType {
		return { kind: 'array', element };
	},
	table(fields?: Record<string, SluaType>): SluaType {
		return { kind: 'table', ...(fields ? { fields } : {}) };
	},
	module(name: string): SluaType {
		return { kind: 'table', module: name };
	},
	withMetatable(name: string): SluaType {
		return { kind: 'table', metatable: name };
	},
	literal(value: string): SluaType {
		return { kind: 'literal', value };
	},
	tuple(items: SluaType[], variadic?: SluaType, minimum?: number): SluaType {
		return { kind: 'tuple', items: [...items], ...(variadic ? { variadic } : {}), ...(minimum !== undefined ? { minimum } : {}) };
	},
	union(items: SluaType[]): SluaType {
		return { kind: 'union', items: [...items] };
	},
	/** The bare `function` type carries no parameter/result contract. */
	anyFunction(): SluaType {
		return { kind: 'function', params: [], returns: slua.unknown(), variadic: slua.unknown(), untyped: true };
	},
	fn(params: SluaType[], returns: SluaType, variadic?: SluaType, arity?: SluaCallArity): SluaType {
		return { kind: 'function', params, returns, ...(variadic ? { variadic } : {}), ...(arity ? { arity: { ...arity } } : {}) };
	}
};

/** Read a result in a value context: an absent pack element becomes nil.
 * In a final argument/return context the original pack must stay unadjusted. */
export function sluaPackValue(items: SluaType[], index: number, variadic?: SluaType, minimum = items.length): SluaType {
	const value = items[index] ?? variadic ?? slua.nil();
	if (index < minimum || value.kind === 'primitive' && (value.name === 'unknown' || value.name === 'nil')) return value;
	if (value.kind === 'union' && value.items.some((item) => item.kind === 'primitive' && item.name === 'nil')) return value;
	return slua.union([value, slua.nil()]);
}

function normalizeUnionItems(items: SluaType[]): SluaType[] {
	const flattened: SluaType[] = [];
	for (const item of items) {
		if (item.kind === 'union') flattened.push(...item.items);
		else flattened.push(item);
	}
	const unique = new Map<string, SluaType[]>();
	for (const item of flattened) {
		const key = sluaTypeToString(item);
		const bucket = unique.get(key) ?? [];
		// Bounded display strings can coincide for different large table shapes.
		const index = bucket.findIndex((previous) => sluaTypeEquals(previous, item));
		if (index < 0) bucket.push(item);
		else bucket[index] = mergeSourceOrigins(bucket[index]!, item);
		unique.set(key, bucket);
	}
	return [...unique.values()].flat().sort((a, b) => sluaTypeToString(a).localeCompare(sluaTypeToString(b)));
}

function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depthParen = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	let depthAngle = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '(') depthParen++;
		else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
		else if (ch === '{') depthBrace++;
		else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
		else if (ch === '[') depthBracket++;
		else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
		else if (ch === '<') depthAngle++;
		else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
		else if (ch === separator && depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}

	parts.push(text.slice(start).trim());
	return parts.filter((part) => part.length > 0);
}

function findTopLevelArrow(text: string): number {
	let depthParen = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	let depthAngle = 0;

	for (let i = 0; i < text.length - 1; i++) {
		const ch = text[i];
		if (ch === '(') depthParen++;
		else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
		else if (ch === '{') depthBrace++;
		else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
		else if (ch === '[') depthBracket++;
		else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
		else if (ch === '<') depthAngle++;
		else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
		else if (ch === '-' && text[i + 1] === '>' && depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0) {
			return i;
		}
	}

	return -1;
}

export function sluaTypeEquals(a: SluaType, b: SluaType): boolean {
	const seen = new WeakMap<object, WeakSet<object>>();
	let remaining = 4096;
	function equal(a: SluaType, b: SluaType): boolean {
		if (a === b) return true;
		if (remaining-- <= 0) return false;
		const classA = classType(a), classB = classType(b);
		if (classA || classB) return !!classA && !!classB && classA.kind === classB.kind && classA.info.declaration === classB.info.declaration;
		if (a.kind === 'custom' && b.kind === 'custom') {
			const nativeA = nativeClassKind(a), nativeB = nativeClassKind(b);
			if (nativeA || nativeB) return nativeA === nativeB;
		}
		const matches = seen.get(a) ?? new WeakSet<object>();
		if (matches.has(b)) return true;
		if (a.kind !== b.kind) return false;
		matches.add(b); seen.set(a, matches);
		switch (a.kind) {
			case 'primitive':
				return b.kind === 'primitive' && a.name === b.name;
			case 'custom':
				return b.kind === 'custom' && a.name === b.name;
			case 'table':
				return b.kind === 'table' && a.module === b.module && a.metatable === b.metatable
					&& Object.keys(a.fields ?? {}).length === Object.keys(b.fields ?? {}).length
					&& Object.entries(a.fields ?? {}).every(([name, type]) => !!b.fields?.[name] && equal(type, b.fields[name]!));
			case 'literal':
				return b.kind === 'literal' && a.value === b.value;
			case 'array':
				return b.kind === 'array' && equal(a.element, b.element);
			case 'tuple': {
				if (b.kind !== 'tuple') return false;
				if (a.minimum !== b.minimum || Boolean(a.variadic) !== Boolean(b.variadic)) return false;
				if (a.variadic && b.variadic && !equal(a.variadic, b.variadic)) return false;
				if (a.items.length !== b.items.length) return false;
				for (let i = 0; i < a.items.length; i++) {
					if (!equal(a.items[i]!, b.items[i]!)) return false;
				}
				return true;
			}
			case 'union': {
				if (b.kind !== 'union') return false;
				const aItems = normalizeUnionItems(a.items);
				const bItems = normalizeUnionItems(b.items);
				if (aItems.length !== bItems.length) return false;
				for (let i = 0; i < aItems.length; i++) {
					if (!equal(aItems[i]!, bItems[i]!)) return false;
				}
				return true;
			}
			case 'function': {
				if (b.kind !== 'function') return false;
				if (a.untyped !== b.untyped) return false;
				if (a.arity?.min !== b.arity?.min || a.arity?.max !== b.arity?.max) return false;
				if (a.params.length !== b.params.length) return false;
				for (let i = 0; i < a.params.length; i++) {
					if (!equal(a.params[i]!, b.params[i]!)) return false;
				}
				if (Boolean(a.variadic) !== Boolean(b.variadic)) return false;
				if (a.variadic && b.variadic && !equal(a.variadic, b.variadic)) return false;
				return equal(a.returns, b.returns);
			}
			default: {
				const _exhaustive: never = a;
				return _exhaustive;
			}
		}
	}
	return equal(a, b);
}

export function sluaTypeFromLuauAnnotationText(text: string | undefined | null): SluaType {
	if (!text) return slua.unknown();
	const norm = String(text).trim().toLowerCase();
	if (!norm) return slua.unknown();

	const arrow = findTopLevelArrow(norm);
	if (arrow >= 0) {
		const paramsText = norm.slice(0, arrow).trim();
		const returnsText = norm.slice(arrow + 2).trim();
		const unwrappedParams = paramsText.startsWith('(') && paramsText.endsWith(')')
			? paramsText.slice(1, -1).trim()
			: paramsText;
		const params = unwrappedParams
			? splitTopLevel(unwrappedParams, ',').map((part) => sluaTypeFromLuauAnnotationText(part))
			: [];
		return slua.fn(params, sluaTypeFromLuauAnnotationText(returnsText));
	}

	// Optional shorthand: T?
	if (norm.endsWith('?') && norm.length > 1) {
		const inner = norm.slice(0, -1).trim();
		if (inner) return slua.union([sluaTypeFromLuauAnnotationText(inner), slua.nil()]);
	}

	// Union: A | B | C (conservative split, no parentheses handling)
	const unionParts = splitTopLevel(norm, '|');
	if (unionParts.length > 1) {
		const parts = unionParts;
		if (parts.length > 1) return slua.union(parts.map((p) => sluaTypeFromLuauAnnotationText(p)));
	}

	if (norm.startsWith('{') && norm.endsWith('}')) {
		const inner = norm.slice(1, -1).trim();
		if (!inner) return slua.table();
		const fields = splitTopLevel(inner, ',');
		if (fields.length === 1 && !fields[0]?.includes(':') && !fields[0]?.startsWith('[')) {
			return slua.array(sluaTypeFromLuauAnnotationText(fields[0]));
		}
		return slua.table();
	}

	const arrayMatch = /^(?:array|readonlyarray)<(.+)>$/.exec(norm);
	if (arrayMatch) return slua.array(sluaTypeFromLuauAnnotationText(arrayMatch[1]));

	// Best-effort tuple support: (t1, t2, ...)
	// This is intentionally conservative and does not attempt full Luau type parsing.
	if (norm.startsWith('(') && norm.endsWith(')')) {
		const inner = norm.slice(1, -1).trim();
		if (!inner) return slua.unknown();
		const parts = splitTopLevel(inner, ',');
		if (parts.length === 1) return sluaTypeFromLuauAnnotationText(parts[0]);
		if (parts.length > 1) return slua.tuple(parts.map((p) => sluaTypeFromLuauAnnotationText(p)));
	}

	// Very small, intentionally conservative subset.
	// This is for inlay hints + best-effort inference, not full Luau type parsing.
	switch (norm) {
		case 'number':
			return slua.number();
		case 'string':
			return slua.string();
		case 'boolean':
			return slua.boolean();
		case 'nil':
			return slua.nil();
		case 'any':
			return slua.unknown();
		case 'uuid':
		case 'key':
			return slua.uuid();
		case 'vector':
			return slua.vector();
		case 'rotation':
		case 'quaternion':
			return slua.rotation();
		case 'integer':
			return slua.integer();
		case 'thread':
			return slua.thread();
		case 'buffer':
			return slua.buffer();
		case 'detectedevent':
			return slua.detectedEvent();
		case 'table':
			return slua.table();
		case 'function':
			return slua.anyFunction();
		default:
			return slua.unknown();
	}
}

export function sluaTypeFromLslType(lslType: string | undefined | null): SluaType {
	switch (lslType) {
		case 'integer':
			// Ordinary SLua exposes LSL integer parameters/results/constants as
			// Luau numbers. The integer library uses the separate 64-bit type.
			return slua.number();
		case 'float':
			return slua.number();
		case 'string':
			return slua.string();
		case 'key':
			return slua.uuid();
		case 'vector':
			return slua.vector();
		case 'rotation':
			return slua.rotation();
		case 'list':
			// In SLua, lists are just tables.
			return slua.table();
		case 'void':
			return slua.nil();
		default:
			return slua.unknown();
	}
}


export function sluaTypeToString(type: SluaType): string {
	let remaining = 512;
	function format(type: SluaType, depth = 0): string {
		if (remaining-- <= 0 || depth >= 16) return type.kind === 'table' ? 'table' : 'unknown';
		const nested = (child: SluaType) => format(child, depth + 1);
		switch (type.kind) {
			case 'primitive':
				return type.name;
			case 'custom':
				return type.name;
			case 'table':
				return type.module ? `typeof(${type.module})` : type.metatable ? `${type.metatable}` : type.fields && Object.keys(type.fields).length
					? `{ ${Object.entries(type.fields).slice(0, Math.max(0, Math.min(128, remaining))).map(([name, field]) => `${name}: ${nested(field)}`).join(', ')} }` : 'table';
			case 'literal':
				return JSON.stringify(type.value);
			case 'array':
				return `${nested(type.element)}[]`;
			case 'tuple':
				return `(${[...type.items.map((t, i) => !type.variadic && type.minimum !== undefined && i >= type.minimum ? `[${nested(t)}]` : nested(t)), ...(type.variadic ? [`...${nested(type.variadic)}`] : [])].join(', ')})`;
			case 'union': {
				const items = normalizeUnionItems(type.items);
				return items.map((t) => nested(t)).join(' | ');
			}
			case 'function': {
				if (type.untyped) return 'function';
				const params = type.params.map((p, i) => type.arity && i >= type.arity.min ? `[${nested(p)}]` : nested(p));
				if (type.variadic) params.push(`...${nested(type.variadic)}`);
				return `(${params.join(', ')}) -> ${nested(type.returns)}`;
			}
			default: {
				const _exhaustive: never = type;
				return String(_exhaustive);
			}
		}
	}
	return format(type);
}

export function sluaTypeIsAssignable(expected: SluaType, actual: SluaType): boolean {
	if (sluaTypeEquals(expected, actual)) return true;

	// Every value can flow into unknown. Each possible actual union member must
	// fit the expected type (which may itself be a union).
	if (expected.kind === 'primitive' && expected.name === 'unknown') return true;
	if (actual.kind === 'union') {
		return actual.items.every((item) => sluaTypeIsAssignable(expected, item));
	}
	if (expected.kind === 'union') {
		return expected.items.some((item) => sluaTypeIsAssignable(item, actual));
	}
	const nativeClass = nativeClassKind(expected);
	if (nativeClass) return nativeClassKind(actual) === nativeClass || classType(actual)?.kind === nativeClass;
	const expectedClass = classType(expected), actualClass = classType(actual);
	if (expectedClass || actualClass) {
		if (expectedClass?.kind !== 'instance' || actualClass?.kind !== 'instance') return false;
		const seen = new Set<object>();
		for (let owner = actualClass.info; owner && !seen.has(owner); owner = owner.base!) {
			if (owner.declaration === expectedClass.info.declaration) return true;
			seen.add(owner);
		}
		return false;
	}
	if (expected.kind === 'function' && expected.untyped && actual.kind === 'function') return true;

	if (expected.kind === 'table' && !expected.module && !expected.metatable && actual.kind === 'array') return true;

	if (expected.kind === 'table' && actual.kind === 'table') {
		return (!expected.module || expected.module === actual.module) && (!expected.metatable || expected.metatable === actual.metatable);
	}
	if (expected.kind === 'primitive' && expected.name === 'string' && actual.kind === 'literal') return true;

	// Tagged integers are not a subtype of number. Some native C API calls
	// convert them at runtime, but that does not make a number annotation valid.

	// Arrays and tuples can be compared structurally.
	if (expected.kind === 'array' && actual.kind === 'array') {
		return sluaTypeIsAssignable(expected.element, actual.element);
	}

	if (expected.kind === 'tuple' && actual.kind === 'tuple') {
		if (expected.variadic || actual.variadic || expected.minimum !== actual.minimum) return sluaTypeEquals(expected, actual);
		if (expected.items.length !== actual.items.length) return false;
		for (let i = 0; i < expected.items.length; i++) {
			if (!sluaTypeIsAssignable(expected.items[i]!, actual.items[i]!)) return false;
		}
		return true;
	}

	return false;
}
