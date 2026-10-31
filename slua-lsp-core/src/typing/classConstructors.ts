import { slua, type SluaType } from '../slua/types.js';

// Signature identity survives ordinary aliases and stored function values.
// Weak ownership avoids retaining project/class generations after close.
const constructors = new WeakMap<SluaType, { name: string; defaultFields?: ReadonlyMap<string, SluaType>; requiresInitializer?: boolean }>();

export function createClassConstructor(name: string, fields: ReadonlyMap<string, SluaType>, initializer?: SluaType, instance: SluaType = slua.custom(name), requiresInitializer = false): SluaType {
	// Most declarations never display or compare their default field-table shape.
	// Retain the shared field snapshot and materialize only when requested.
	let shape: Record<string, SluaType> | undefined;
	const table: SluaType = { kind: 'table', get fields() { return shape ??= Object.fromEntries(fields); } };
	const signature = initializer?.kind === 'function'
		? slua.fn(initializer.params.slice(1), instance, initializer.variadic)
		: slua.fn([table], instance, undefined, { min: 1, max: 1 });
	constructors.set(signature, { name, ...(!initializer ? { defaultFields: fields } : {}), ...(requiresInitializer ? { requiresInitializer: true } : {}) });
	return signature;
}

export function classConstructorInfo(type: SluaType): { name: string; defaultFields?: ReadonlyMap<string, SluaType>; requiresInitializer?: boolean } | undefined {
	return constructors.get(type);
}
