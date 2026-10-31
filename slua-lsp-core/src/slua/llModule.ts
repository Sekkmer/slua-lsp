import type { SluaType } from './types.js';
import { sluaTypeFromLslType } from './types.js';
import { sluaParameterType, sluaReturnType } from './definitionTypes.js';
import { REMOVED_LL_API_NAMES } from './removedApis.js';

export type LlParam = {
	name: string;
	type: SluaType;
	/** Original LSL type string from YAML (e.g. "integer"). */
	lslType?: string;
	tooltip: string;
};

export type LlFunction = {
	lslName: string;
	name: string;
	returnType: SluaType;
	/** Original LSL return type string from YAML (e.g. "integer"). */
	returnLslType?: string;
	params: LlParam[];
	tooltip: string;
	deprecated: boolean;
	/** Omitted from upstream public documentation; runtime absence is not implied. */
	private: boolean;
	/** Additional script sleep time (seconds) imposed by the LSL VM after the call. */
	sleepSeconds: number | null;
	/** Sleep time (seconds) in the legacy mono runtime (if provided by defs). */
	monoSleepSeconds: number | null;
	/** Whether this function requires god mode (if provided by defs). */
	godMode: boolean;
	pure: boolean;
	mustUse: boolean;
};

export type LlConstant = {
	name: string;
	private: boolean;
	type: SluaType;
	value: unknown;
	tooltip: string;
};

export type LlModule = {
	functions: Record<string, LlFunction>;
	constants: Record<string, LlConstant>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringProp(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === 'string' ? value : undefined;
}

function getBooleanProp(obj: Record<string, unknown>, key: string): boolean {
	return obj[key] === true;
}

function getNumberProp(obj: Record<string, unknown>, key: string): number | null {
	const value = obj[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getArgumentsArray(spec: Record<string, unknown>): unknown[] {
	const value = spec.arguments;
	return Array.isArray(value) ? value : [];
}

function normalizeParamName(name: string): string {
	if (!name) return name;
	// YAML uses TitleCase / ALLCAPS for many args; Lua style is typically lower.
	// Keep it simple: lowercase the first character.
	return name[0]!.toLowerCase() + name.slice(1);
}

function toLlMethodName(lslFunctionName: string): string | null {
	if (!lslFunctionName.startsWith('ll')) return null;
	const stripped = lslFunctionName.slice(2);
	if (!stripped) return null;
	return stripped;
}

function functionTooltip(spec: Record<string, unknown>, methodName: string): string {
	const tooltip = getStringProp(spec, 'tooltip') ?? '';
	// The pinned definitions have current PassMode metadata alongside an older
	// boolean-only description. Correct that known wording without replacing
	// custom documentation or changing the parameter's numeric contract.
	const kind = methodName === 'PassCollisions' ? 'collision' : methodName === 'PassTouches' ? 'touch' : undefined;
	const args = getArgumentsArray(spec);
	const first = args[0];
	const param = isRecord(first) ? first.pass : undefined;
	const oldTooltip = `Sets the pass-${kind === 'collision' ? 'collisions' : 'touches'} attribute. If pass is TRUE, ${kind} events are passed from child prims to the root; if FALSE (default), they only trigger events in the affected child prim.`;
	if (kind && isRecord(param) && param['enum-semantics'] === 'PassMode'
		&& tooltip === oldTooltip) {
		return `Controls whether ${kind} events detected on this prim pass to the root prim. PASS_ALWAYS (1) always passes them; PASS_NEVER (2) never passes them. The default PASS_IF_NOT_HANDLED (0) passes them only when no script in this prim handles the event. Has no known effect when called from the root prim.`;
	}
	return tooltip;
}

export function buildLlModuleFromLslDefinitions(defs: unknown, compatibility = false): LlModule {
	if (!isRecord(defs)) return { functions: {}, constants: {} };

	const constantsSectionValue = defs.constants;
	const constantsSection = isRecord(constantsSectionValue) ? constantsSectionValue : undefined;
	const constants: Record<string, LlConstant> = {};
	if (constantsSection) {
		for (const [name, spec] of Object.entries(constantsSection)) {
			if (!isRecord(spec) || spec['slua-removed'] === true) continue;
			constants[name] = {
				name,
				private: spec.private === true,
				type: sluaTypeFromLslType(getStringProp(spec, 'type')),
				value: spec.value,
				tooltip: getStringProp(spec, 'tooltip') ?? ''
			};
		}
	}

	const functionsSection = defs.functions;
	const funcsSection = isRecord(functionsSection) ? functionsSection : undefined;
	const functions: Record<string, LlFunction> = {};
	if (!funcsSection) return { functions, constants };

	for (const [lslName, spec] of Object.entries(funcsSection)) {
		const methodName = toLlMethodName(lslName);
		if (!methodName) continue;
		if (!isRecord(spec)) continue;
		// Upstream removes these from ll but retains the compatibility declarations.
		if (!compatibility && (REMOVED_LL_API_NAMES.has(methodName) || spec['slua-removed'] === true)) continue;

		const args = getArgumentsArray(spec);
		const params: LlParam[] = [];

		for (const argEntry of args) {
			if (!isRecord(argEntry)) continue;
			// YAML uses single-key maps to preserve ordering: [{ Name: { type, tooltip } }, ...]
			const first = Object.entries(argEntry)[0];
			if (!first) continue;
			const [paramName, paramSpec] = first;
			if (!isRecord(paramSpec)) continue;
			const lslType = getStringProp(paramSpec, 'type');
			params.push({
				name: normalizeParamName(String(paramName)),
				type: sluaParameterType(paramSpec),
				lslType,
				tooltip: getStringProp(paramSpec, 'tooltip') ?? ''
			});
		}

		const returnLslType = getStringProp(spec, 'return');
		functions[methodName] = {
			lslName,
			name: methodName,
			returnType: sluaReturnType(spec, compatibility),
			returnLslType,
			params,
			tooltip: functionTooltip(spec, methodName),
			deprecated: getBooleanProp(spec, 'deprecated'),
			private: spec.private === true,
			sleepSeconds: getNumberProp(spec, 'sleep'),
			monoSleepSeconds: getNumberProp(spec, 'mono-sleep'),
			godMode: getBooleanProp(spec, 'god-mode'),
			pure: getBooleanProp(spec, 'pure'),
			mustUse: getBooleanProp(spec, 'must-use')
		};
	}

	return { functions, constants };
}
