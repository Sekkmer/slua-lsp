export type SluaPrimitiveType = 'number' | 'string' | 'boolean' | 'nil' | 'unknown';

export type SluaCustomType = 'uuid' | 'vector' | 'rotation' | 'integer' | 'DetectedEvent' | 'thread' | 'buffer';

export type SluaType =
	| { kind: 'primitive'; name: SluaPrimitiveType }
	| { kind: 'custom'; name: SluaCustomType }
	| { kind: 'array'; element: SluaType }
	| { kind: 'table' }
	| { kind: 'tuple'; items: SluaType[] }
	| { kind: 'union'; items: SluaType[] }
	| { kind: 'function'; params: SluaType[]; returns: SluaType };

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
	array(element: SluaType): SluaType {
		return { kind: 'array', element };
	},
	table(): SluaType {
		return { kind: 'table' };
	},
	tuple(items: SluaType[]): SluaType {
		return { kind: 'tuple', items: [...items] };
	},
	union(items: SluaType[]): SluaType {
		return { kind: 'union', items: [...items] };
	},
	fn(params: SluaType[], returns: SluaType): SluaType {
		return { kind: 'function', params, returns };
	}
};

function normalizeUnionItems(items: SluaType[]): SluaType[] {
	const flattened: SluaType[] = [];
	for (const item of items) {
		if (item.kind === 'union') flattened.push(...item.items);
		else flattened.push(item);
	}
	const unique = new Map<string, SluaType>();
	for (const item of flattened) {
		unique.set(sluaTypeToString(item), item);
	}
	return [...unique.values()].sort((a, b) => sluaTypeToString(a).localeCompare(sluaTypeToString(b)));
}

export function sluaTypeEquals(a: SluaType, b: SluaType): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case 'primitive':
			return b.kind === 'primitive' && a.name === b.name;
		case 'custom':
			return b.kind === 'custom' && a.name === b.name;
		case 'table':
			return true;
		case 'array':
			return b.kind === 'array' && sluaTypeEquals(a.element, b.element);
		case 'tuple': {
			if (b.kind !== 'tuple') return false;
			if (a.items.length !== b.items.length) return false;
			for (let i = 0; i < a.items.length; i++) {
				if (!sluaTypeEquals(a.items[i]!, b.items[i]!)) return false;
			}
			return true;
		}
		case 'union': {
			if (b.kind !== 'union') return false;
			const aItems = normalizeUnionItems(a.items);
			const bItems = normalizeUnionItems(b.items);
			if (aItems.length !== bItems.length) return false;
			for (let i = 0; i < aItems.length; i++) {
				if (!sluaTypeEquals(aItems[i]!, bItems[i]!)) return false;
			}
			return true;
		}
		case 'function': {
			if (b.kind !== 'function') return false;
			if (a.params.length !== b.params.length) return false;
			for (let i = 0; i < a.params.length; i++) {
				if (!sluaTypeEquals(a.params[i]!, b.params[i]!)) return false;
			}
			return sluaTypeEquals(a.returns, b.returns);
		}
		default: {
			const _exhaustive: never = a;
			return _exhaustive;
		}
	}
}

export function sluaTypeFromLuauAnnotationText(text: string | undefined | null): SluaType {
	if (!text) return slua.unknown();
	const norm = String(text).trim().toLowerCase();
	if (!norm) return slua.unknown();

	// Optional shorthand: T?
	if (norm.endsWith('?') && norm.length > 1) {
		const inner = norm.slice(0, -1).trim();
		if (inner) return slua.union([sluaTypeFromLuauAnnotationText(inner), slua.nil()]);
	}

	// Union: A | B | C (conservative split, no parentheses handling)
	if (norm.includes('|')) {
		const parts = norm
			.split('|')
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (parts.length > 1) return slua.union(parts.map((p) => sluaTypeFromLuauAnnotationText(p)));
	}

	// Best-effort tuple support: (t1, t2, ...)
	// This is intentionally conservative and does not attempt full Luau type parsing.
	if (norm.startsWith('(') && norm.endsWith(')')) {
		const inner = norm.slice(1, -1).trim();
		if (!inner) return slua.unknown();
		const parts = inner
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
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
			return slua.fn([], slua.unknown());
		default:
			return slua.unknown();
	}
}

export function sluaTypeFromLslType(lslType: string | undefined | null): SluaType {
	switch (lslType) {
		case 'integer':
			// Model integer distinctly so we can enforce integer-only call sites,
			// while still allowing integer values where numbers are expected.
			return slua.integer();
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
	switch (type.kind) {
		case 'primitive':
			return type.name;
		case 'custom':
			return type.name;
		case 'table':
			return 'table';
		case 'array':
			return `${sluaTypeToString(type.element)}[]`;
		case 'tuple':
			return `(${type.items.map((t) => sluaTypeToString(t)).join(', ')})`;
		case 'union': {
			const items = normalizeUnionItems(type.items);
			return items.map((t) => sluaTypeToString(t)).join(' | ');
		}
		case 'function': {
			const params = type.params.map((p) => sluaTypeToString(p)).join(', ');
			return `(${params}) -> ${sluaTypeToString(type.returns)}`;
		}
		default: {
			const _exhaustive: never = type;
			return String(_exhaustive);
		}
	}
}

export function sluaTypeIsAssignable(expected: SluaType, actual: SluaType): boolean {
	if (sluaTypeEquals(expected, actual)) return true;

	// Integer is a subtype of number (integer -> number allowed, not vice versa).
	if (expected.kind === 'primitive' && expected.name === 'number') {
		return actual.kind === 'custom' && actual.name === 'integer';
	}

	if (expected.kind === 'union') {
		return expected.items.some((item) => sluaTypeIsAssignable(item, actual));
	}

	if (actual.kind === 'union') {
		return actual.items.every((item) => sluaTypeIsAssignable(expected, item));
	}

	// Arrays and tuples can be compared structurally.
	if (expected.kind === 'array' && actual.kind === 'array') {
		return sluaTypeIsAssignable(expected.element, actual.element);
	}

	if (expected.kind === 'tuple' && actual.kind === 'tuple') {
		if (expected.items.length !== actual.items.length) return false;
		for (let i = 0; i < expected.items.length; i++) {
			if (!sluaTypeIsAssignable(expected.items[i]!, actual.items[i]!)) return false;
		}
		return true;
	}

	return false;
}
