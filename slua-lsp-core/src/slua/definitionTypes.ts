import { slua, sluaTypeFromLslType, sluaTypeFromLuauAnnotationText, type SluaType } from './types.js';

type Definition = Record<string, unknown>;

/** Match the official LSLArgument.compute_slua_type ordinary SLua contract. */
export function sluaParameterType(spec: Definition, event = false): SluaType {
	if (typeof spec['slua-type'] === 'string') return sluaTypeFromLuauAnnotationText(spec['slua-type']);
	if (spec.type === 'integer' && spec['bool-semantics'] === true) return event ? slua.boolean() : slua.union([slua.boolean(), slua.number()]);
	if (spec.type === 'string' && spec['asset-semantics'] === true) return slua.union([slua.string(), slua.uuid()]);
	return sluaTypeFromLslType(typeof spec.type === 'string' ? spec.type : undefined);
}

/** Compatibility changes index/boolean results, but shares parameter coercion. */
export function sluaReturnType(spec: Definition, compatibility = false): SluaType {
	if (typeof spec['slua-return'] === 'string') return sluaTypeFromLuauAnnotationText(spec['slua-return']);
	if (!compatibility && spec.return === 'integer') {
		if (spec['index-semantics'] === true) return slua.union([slua.number(), slua.nil()]);
		if (spec['bool-semantics'] === true) return slua.boolean();
	}
	return sluaTypeFromLslType(typeof spec.return === 'string' ? spec.return : undefined);
}
