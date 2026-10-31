import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { SluaType, SluaCallArity } from './types.js';
import { slua, sluaTypeFromLuauAnnotationText } from './types.js';
import { nativeClassType, markClassOf } from './classIdentity.js';

export type BuiltinsFunction = {
	intrinsic?: 'classof';
	arity?: SluaCallArity;
	params: SluaType[];
	variadic?: SluaType;
	returns: SluaType;
	docs: string;
	deprecated: boolean;
	overloads?: Array<{ params: SluaType[]; returns: SluaType; variadic?: SluaType; arity?: SluaCallArity }>;
};

export type BuiltinsValue = {
	type: SluaType;
	readonly: boolean;
	docs: string;
	deprecated: boolean;
	value?: unknown;
};

export type BuiltinsModule = {
	functions: Record<string, BuiltinsFunction>;
	values: Record<string, BuiltinsValue>;
};

export type BuiltinsMetatableMember = {
	name: string;
	kind: 'method' | 'property';
	type: SluaType;
	docs: string;
	requiresColonCall?: boolean;
};

export type BuiltinsMetatable = {
	metamethods?: Record<string, BuiltinsFunction>;
	members: Record<string, BuiltinsMetatableMember>;
};

export type BuiltinsData = {
	globals: Record<string, BuiltinsFunction>;
	modules: Record<string, BuiltinsModule>;
	metatables: Record<string, BuiltinsMetatable>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findWorkspaceRootDir(startDir = process.cwd()): string | null {
	let current = startDir;
	for (let i = 0; i < 50; i++) {
		try {
			const candidate = path.join(current, 'pnpm-workspace.yaml');
			if (fs.existsSync(candidate)) return current;
		} catch {
			// ignore
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

function readBundledBuiltinsYamlText(): string | null {
	const candidates: string[] = [];

	// Built output (CommonJS): builtins.yaml is copied to the same directory as builtins.js/registry.js
	if (typeof __dirname !== 'undefined') {
		candidates.push(path.join(__dirname, 'builtins.yaml'));
	}

	// Dev/test: locate from repo root.
	const wsRoot = findWorkspaceRootDir();
	if (wsRoot) {
		candidates.push(path.join(wsRoot, 'slua-lsp-core', 'src', 'slua', 'builtins.yaml'));
		candidates.push(path.join(wsRoot, 'slua-lsp-core', 'out', 'slua', 'builtins.yaml'));
	}

	// Fallback: relative to current working dir
	candidates.push(path.join(process.cwd(), 'src', 'slua', 'builtins.yaml'));
	candidates.push(path.join(process.cwd(), 'out', 'slua', 'builtins.yaml'));

	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
		} catch {
			// ignore
		}
	}

	return null;
}

function parseArity(value: unknown, params: unknown): SluaCallArity | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Number.isSafeInteger(value.min) || !Number.isSafeInteger(value.max) ||
		typeof value.min !== 'number' || typeof value.max !== 'number' || value.min < 0 || value.max < value.min ||
		!Array.isArray(params) || value.max > params.length) throw new Error('Invalid builtin argument arity');
	return { min: value.min, max: value.max };
}

function parseTypeSpec(spec: unknown): SluaType {
	if (typeof spec === 'string') return sluaTypeFromLuauAnnotationText(spec);
	if (!isRecord(spec)) return slua.unknown();
	if (spec.nativeClass === 'constructor' || spec.nativeClass === 'instance') return nativeClassType(spec.nativeClass);
	if (typeof spec.module === 'string') return slua.module(spec.module);
	if (typeof spec.metatable === 'string') return slua.withMetatable(spec.metatable);
	if (typeof spec.literal === 'string') return slua.literal(spec.literal);
	if (Array.isArray(spec.union)) return slua.union(spec.union.map(parseTypeSpec));

	// fn: { params: [...], returns: <type> }
	if ('fn' in spec && isRecord(spec.fn)) {
		const fnSpec = spec.fn as Record<string, unknown>;
		const params = Array.isArray(fnSpec.params) ? fnSpec.params.map((p) => parseTypeSpec(p)) : [];
		const returns = parseTypeSpec(fnSpec.returns ?? 'unknown');
		return slua.fn(params, returns, fnSpec.variadic === undefined ? undefined : parseTypeSpec(fnSpec.variadic), parseArity(fnSpec.arity, fnSpec.params));
	}

	// tuple: [t1, t2, ...]
	if ('tuple' in spec && Array.isArray(spec.tuple)) {
		if (spec.minimum !== undefined && (!Number.isSafeInteger(spec.minimum) || typeof spec.minimum !== 'number' || spec.minimum < 0 || spec.minimum > 4096)) throw new Error('Invalid builtin return-pack minimum');
		if (spec.variadic === undefined && typeof spec.minimum === 'number' && spec.minimum > spec.tuple.length) throw new Error('Builtin return-pack minimum exceeds finite maximum');
		return slua.tuple(spec.tuple.map((t) => parseTypeSpec(t)), spec.variadic === undefined ? undefined : parseTypeSpec(spec.variadic), spec.minimum as number | undefined);
	}

	// array: t
	if ('array' in spec) {
		return slua.array(parseTypeSpec(spec.array));
	}

	return slua.unknown();
}

function toSluaType(typeText: unknown): SluaType {
	return parseTypeSpec(typeText);
}

function toParamTypeList(params: unknown): SluaType[] {
	if (!Array.isArray(params)) return [];
	return params.map((p) => parseTypeSpec(p));
}

function parseBuiltinsYaml(text: string): BuiltinsData {
	const root = yaml.load(text) as unknown;
	const globals: Record<string, BuiltinsFunction> = {};
	const modules: Record<string, BuiltinsModule> = {};
	const metatables: Record<string, BuiltinsMetatable> = {};
	if (!isRecord(root)) return { globals, modules, metatables };

	const globalsSection = isRecord(root.globals) ? (root.globals as Record<string, unknown>) : undefined;
	if (globalsSection) {
		for (const [name, spec] of Object.entries(globalsSection)) {
			if (!isRecord(spec)) continue;
			const overloads = Array.isArray(spec.overloads)
				? spec.overloads
					.filter((o) => isRecord(o))
					.map((o) => ({
						params: toParamTypeList((o as Record<string, unknown>).params),
						arity: parseArity(o.arity, o.params),
						returns: toSluaType((o as Record<string, unknown>).returns ?? 'unknown'),
						variadic: (o as Record<string, unknown>).variadic === undefined ? undefined : toSluaType((o as Record<string, unknown>).variadic)
					}))
				: undefined;
			globals[name] = {
				params: toParamTypeList(spec.params),
				arity: parseArity(spec.arity, spec.params),
				variadic: spec.variadic === undefined ? undefined : toSluaType(spec.variadic),
				returns: toSluaType(spec.returns ?? 'unknown'),
				docs: typeof spec.docs === 'string' ? spec.docs : '',
				deprecated: spec.deprecated === true,
				overloads
			};
		}
	}

	const modulesSection = isRecord(root.modules) ? (root.modules as Record<string, unknown>) : undefined;
	if (modulesSection) {
		for (const [name, modSpec] of Object.entries(modulesSection)) {
			if (!isRecord(modSpec)) continue;
			const functions: Record<string, BuiltinsFunction> = {};
			const values: Record<string, BuiltinsValue> = {};

			const functionsSection = isRecord(modSpec.functions) ? (modSpec.functions as Record<string, unknown>) : undefined;
			if (functionsSection) {
				for (const [fnName, fnSpec] of Object.entries(functionsSection)) {
					if (!isRecord(fnSpec)) continue;
					const overloads = Array.isArray(fnSpec.overloads)
						? fnSpec.overloads
							.filter((o) => isRecord(o))
							.map((o) => ({
								params: toParamTypeList((o as Record<string, unknown>).params),
								arity: parseArity(o.arity, o.params),
								returns: toSluaType((o as Record<string, unknown>).returns ?? 'unknown'),
								variadic: (o as Record<string, unknown>).variadic === undefined ? undefined : toSluaType((o as Record<string, unknown>).variadic)
							}))
						: undefined;
					functions[fnName] = {
						intrinsic: fnSpec.intrinsic === 'classof' ? 'classof' : undefined,
						params: toParamTypeList(fnSpec.params),
						arity: parseArity(fnSpec.arity, fnSpec.params),
						variadic: fnSpec.variadic === undefined ? undefined : toSluaType(fnSpec.variadic),
						returns: toSluaType(fnSpec.returns ?? 'unknown'),
						docs: typeof fnSpec.docs === 'string' ? fnSpec.docs : '',
						deprecated: fnSpec.deprecated === true,
						overloads
					};
				}
			}

			const valuesSection = isRecord(modSpec.values) ? (modSpec.values as Record<string, unknown>) : undefined;
			if (valuesSection) {
				for (const [valName, valSpec] of Object.entries(valuesSection)) {
					if (!isRecord(valSpec)) continue;
					values[valName] = {
						type: toSluaType(valSpec.type ?? 'unknown'),
						readonly: valSpec.readonly === true,
						docs: typeof valSpec.docs === 'string' ? valSpec.docs : '',
						deprecated: valSpec.deprecated === true,
						value: valSpec.value
					};
				}
			}

			modules[name] = { functions, values };
		}
	}

	const metatablesSection = isRecord(root.metatables) ? (root.metatables as Record<string, unknown>) : undefined;
	if (metatablesSection) {
		for (const [typeName, mtSpec] of Object.entries(metatablesSection)) {
			if (!isRecord(mtSpec)) continue;

			const metamethods: Record<string, BuiltinsFunction> = {};
			const metamethodsSection = isRecord(mtSpec.metamethods)
				? (mtSpec.metamethods as Record<string, unknown>)
				: undefined;
			if (metamethodsSection) {
				for (const [mmName, mmSpec] of Object.entries(metamethodsSection)) {
					if (!isRecord(mmSpec)) continue;
					const overloads = Array.isArray(mmSpec.overloads)
						? mmSpec.overloads
							.filter((o) => isRecord(o))
							.map((o) => ({
								params: toParamTypeList((o as Record<string, unknown>).params),
								arity: parseArity(o.arity, o.params),
								returns: toSluaType((o as Record<string, unknown>).returns ?? 'unknown'),
								variadic: (o as Record<string, unknown>).variadic === undefined ? undefined : toSluaType((o as Record<string, unknown>).variadic)
							}))
						: undefined;
					metamethods[mmName] = {
						params: toParamTypeList(mmSpec.params),
						variadic: mmSpec.variadic === undefined ? undefined : toSluaType(mmSpec.variadic),
						returns: toSluaType(mmSpec.returns ?? 'unknown'),
						docs: typeof mmSpec.docs === 'string' ? mmSpec.docs : '',
						deprecated: mmSpec.deprecated === true,
						overloads
					};
				}
			}

			const members: Record<string, BuiltinsMetatableMember> = {};
			const membersSection = isRecord(mtSpec.members) ? (mtSpec.members as Record<string, unknown>) : undefined;
			if (membersSection) {
				for (const [memberName, memberSpec] of Object.entries(membersSection)) {
					if (!isRecord(memberSpec)) continue;
					const kind = memberSpec.kind === 'method' || memberSpec.kind === 'property' ? memberSpec.kind : undefined;
					if (!kind) continue;

					const memberType: SluaType =
						kind === 'property'
							? toSluaType(memberSpec.type ?? 'unknown')
							: slua.fn(toParamTypeList(memberSpec.params), toSluaType(memberSpec.returns ?? 'unknown'));

					members[memberName] = {
						name: memberName,
						kind,
						type: memberType,
						docs: typeof memberSpec.docs === 'string' ? memberSpec.docs : '',
						requiresColonCall: memberSpec.requiresColonCall === true
					};
				}
			}

			metatables[typeName] = {
				metamethods: Object.keys(metamethods).length > 0 ? metamethods : undefined,
				members
			};
		}
	}

	return { globals, modules, metatables };
}

export function buildBuiltinsFunctionSignature(fn: BuiltinsFunction): SluaType {
	const overloads = fn.overloads ?? [];
	const types = (overloads.length ? overloads : [{ params: fn.params, returns: fn.returns, variadic: fn.variadic, arity: fn.arity }]).map((o) =>
		slua.fn(o.params, o.returns, o.variadic, o.arity)
	);
	if (fn.intrinsic === 'classof') for (const type of types) markClassOf(type);
	return types.length === 1 ? types[0] : slua.union(types);
}

let cachedBuiltins: BuiltinsData | null | undefined;

export function loadBuiltinsYaml(): BuiltinsData | null {
	if (cachedBuiltins !== undefined) return cachedBuiltins;
	const text = readBundledBuiltinsYamlText();
	if (!text) {
		cachedBuiltins = null;
		return cachedBuiltins;
	}
	try {
		cachedBuiltins = parseBuiltinsYaml(text);
		return cachedBuiltins;
	} catch {
		cachedBuiltins = null;
		return cachedBuiltins;
	}
}
