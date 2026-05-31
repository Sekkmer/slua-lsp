import type { SluaType } from './types.js';
import { buildSluaRegistryFromLslDefinitions } from './registry.js';

export type SluaIntrinsicMethod = {
	receiver: string;
	name: string;
	requiresColonCall: boolean;
	signature: SluaType;
	// Where this came from (useful for debugging mismatches)
	source: 'default' | 'override';
};

export type SluaGlobalFunction = {
	name: string;
	signature: SluaType;
	source: 'default' | 'override';
};

export type SluaModuleFunction = {
	name: string;
	signature: SluaType;
};

export type SluaModule = {
	name: string;
	functions: Record<string, SluaModuleFunction>;
	source: 'default' | 'override';
};

export type SluaIntrinsicKey = `${string}.${string}`;

export function intrinsicKey(receiver: string, name: string): SluaIntrinsicKey {
	return `${receiver}.${name}`;
}

export type SluaIntrinsicOverrides = Partial<Record<SluaIntrinsicKey, SluaType>>;

export const defaultSluaIntrinsicOverrides: SluaIntrinsicOverrides = {
	// Keep empty by default.
	// Example override if SLua runtime differs:
	// 'LLTimers.once': slua.fn([slua.fn([], slua.nil()), slua.number()], slua.nil())
};

export type SluaGlobalFunctionOverrides = Partial<Record<string, SluaType>>;

export const defaultSluaGlobalFunctionOverrides: SluaGlobalFunctionOverrides = {
	// Example override:
	// integer: slua.fn([slua.number()], slua.number())
};

export type SluaModuleOverrides = Partial<
	Record<string, { functions?: Partial<Record<string, SluaType>> }>
>;

export const defaultSluaModuleOverrides: SluaModuleOverrides = {
	// Example override:
	// llbase64: { functions: { decode: slua.fn([slua.string(), slua.boolean()], slua.unknown()) } }
};

const defaultRegistry = buildSluaRegistryFromLslDefinitions(null);

export function buildSluaIntrinsicMethods(
	overrides: SluaIntrinsicOverrides = defaultSluaIntrinsicOverrides
): Record<SluaIntrinsicKey, SluaIntrinsicMethod> {
	const out: Record<string, SluaIntrinsicMethod> = {};
	for (const [receiver, obj] of defaultRegistry.objectTypes.entries()) {
		for (const [name, method] of Object.entries(obj.methods)) {
			out[intrinsicKey(receiver, name)] = {
				receiver,
				name,
				requiresColonCall: method.requiresColonCall,
				signature: method.signature,
				source: 'default'
			};
		}
	}

	for (const [key, signature] of Object.entries(overrides)) {
		if (!signature) continue;
		const [receiver, name] = key.split('.') as [string, string];
		const existing = out[key];
		out[key] = {
			receiver,
			name,
			requiresColonCall: existing?.requiresColonCall ?? true,
			signature,
			source: 'override'
		};
	}

	return out as Record<SluaIntrinsicKey, SluaIntrinsicMethod>;
}

// Kept for convenience when iterating (defaults + overrides applied).
export const sluaIntrinsicMethods: SluaIntrinsicMethod[] = Object.values(buildSluaIntrinsicMethods());

export function buildSluaGlobalFunctions(
	overrides: SluaGlobalFunctionOverrides = defaultSluaGlobalFunctionOverrides
): Record<string, SluaGlobalFunction> {
	const out: Record<string, SluaGlobalFunction> = {};
	for (const [name, fn] of defaultRegistry.globals.entries()) {
		out[name] = { name, signature: fn.signature, source: 'default' };
	}
	for (const [name, signature] of Object.entries(overrides)) {
		if (!signature) continue;
		out[name] = { name, signature, source: 'override' };
	}
	return out;
}

export const sluaGlobalFunctions: SluaGlobalFunction[] = Object.values(buildSluaGlobalFunctions());

export function buildSluaModules(overrides: SluaModuleOverrides = defaultSluaModuleOverrides): Record<string, SluaModule> {
	const out: Record<string, SluaModule> = {};
	for (const [name, mod] of defaultRegistry.modules.entries()) {
		const functions: Record<string, SluaModuleFunction> = {};
		for (const [fnName, fn] of Object.entries(mod.functions)) {
			functions[fnName] = { name: fnName, signature: fn.signature };
		}
		out[name] = { name, source: 'default', functions };
	}

	for (const [moduleName, patch] of Object.entries(overrides)) {
		if (!patch) continue;
		const existing = out[moduleName];
		const base: SluaModule =
			existing ?? ({ name: moduleName, source: 'override', functions: {} } as SluaModule);
		const mergedFunctions: Record<string, SluaModuleFunction> = { ...base.functions };
		for (const [fnName, sig] of Object.entries(patch.functions ?? {})) {
			if (!sig) continue;
			mergedFunctions[fnName] = { name: fnName, signature: sig };
		}
		out[moduleName] = { name: moduleName, source: 'override', functions: mergedFunctions };
	}

	return out;
}

export const sluaModules: SluaModule[] = Object.values(buildSluaModules());
