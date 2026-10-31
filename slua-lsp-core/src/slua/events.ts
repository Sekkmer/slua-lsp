import type { SluaType } from './types.js';
import { slua } from './types.js';
import { sluaParameterType } from './definitionTypes.js';

export type SluaEventParam = {
	name: string;
	type: SluaType;
};

export type SluaEventSignature = {
	name: string;
	params: SluaEventParam[];
	tooltip: string;
	// Where this came from (useful for debugging mismatches)
	source: 'yaml' | 'override';
};

export type SluaEventOverrides = Partial<Record<string, SluaEventSignature>>;

export const defaultSluaEventOverrides: SluaEventOverrides = {
	// Runtime probe:
	//   typeof(channel)=number, typeof(name)=string, typeof(id)=uuid, typeof(text)=string
	// YAML models Channel as integer, but SLua runtime appears to expose number.
	listen: {
		name: 'listen',
		params: [
			{ name: 'Channel', type: slua.number() },
			{ name: 'Name', type: slua.string() },
			{ name: 'ID', type: slua.uuid() },
			{ name: 'Text', type: slua.string() }
		],
		tooltip: 'SLua override: runtime-probed param types (channel is number).',
		source: 'override'
	},
	// YAML says touch_start passes NumberOfTouches:int, but SLua sample scripts show
	// `LLEvents:on("touch_start", function(detected: {DetectedEvent}) ...)`.
	// Keep this override explicit so we can adjust once runtime probing confirms details.
	touch_start: {
		name: 'touch_start',
		params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }],
		tooltip: 'SLua override: detected list (runtime-probed DetectedEvent[]).',
		source: 'override'
	},
	// Current native MULTI_EVENT_NAMES also wraps these events, not just touches/collisions.
	sensor: { name: 'sensor', params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }], tooltip: 'Read-only detected entries, valid only during event dispatch.', source: 'override' },
	on_damage: { name: 'on_damage', params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }], tooltip: 'Detected damage entries; canAdjustDamage is true during this dispatch.', source: 'override' },
	final_damage: { name: 'final_damage', params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }], tooltip: 'Final damage entries; canAdjustDamage is false.', source: 'override' },

	// Runtime probe shows touch/touch_end match touch_start (DetectedEvent[]).
	touch: {
		name: 'touch',
		params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }],
		tooltip: 'SLua override: detected list (runtime-probed DetectedEvent[]).',
		source: 'override'
	},
	touch_end: {
		name: 'touch_end',
		params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }],
		tooltip: 'SLua override: detected list (runtime-probed DetectedEvent[]).',
		source: 'override'
	},
	// Runtime probe shows collision* match touch* (DetectedEvent[]).
	collision_start: {
		name: 'collision_start',
		params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }],
		tooltip: 'SLua override: detected list (runtime-probed DetectedEvent[]).',
		source: 'override'
	},
	collision: {
		name: 'collision',
		params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }],
		tooltip: 'SLua override: detected list (runtime-probed DetectedEvent[]).',
		source: 'override'
	},
	collision_end: {
		name: 'collision_end',
		params: [{ name: 'detected', type: slua.array(slua.detectedEvent()) }],
		tooltip: 'SLua override: detected list (runtime-probed DetectedEvent[]).',
		source: 'override'
	}
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringProp(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === 'string' ? value : undefined;
}

function getArgumentsArray(spec: Record<string, unknown>): unknown[] {
	const value = spec.arguments;
	return Array.isArray(value) ? value : [];
}

export function buildSluaEventSignaturesFromLslDefinitions(
	defs: unknown,
	overrides: SluaEventOverrides = defaultSluaEventOverrides
): Record<string, SluaEventSignature> {
	if (!isRecord(defs)) return {};
	const eventsSectionValue = defs.events;
	const eventsSection = isRecord(eventsSectionValue) ? eventsSectionValue : undefined;
	const out: Record<string, SluaEventSignature> = {};
	if (!eventsSection) return out;

	for (const [eventName, spec] of Object.entries(eventsSection)) {
		if (!isRecord(spec) || spec['slua-removed'] === true) continue;
		const args = getArgumentsArray(spec);
		const params: SluaEventParam[] = [];

		for (const argEntry of args) {
			if (!isRecord(argEntry)) continue;
			const first = Object.entries(argEntry)[0];
			if (!first) continue;
			const [paramName, paramSpec] = first;
			if (!isRecord(paramSpec)) continue;
			params.push({
				name: String(paramName),
				type: sluaParameterType(paramSpec, true)
			});
		}

		out[eventName] = {
			name: eventName,
			params,
			tooltip: getStringProp(spec, 'tooltip') ?? '',
			source: 'yaml'
		};
	}

	for (const [eventName, sig] of Object.entries(overrides)) {
		const spec = eventsSection[eventName];
		// An adaptation must not resurrect an event explicitly removed upstream.
		if (sig && !(isRecord(spec) && spec['slua-removed'] === true)) out[eventName] = sig;
	}

	return out;
}

export function getSluaLLEventsOnCallbackSignature(
	eventName: string,
	eventSigs: Record<string, SluaEventSignature>
): SluaType {
	const sig = eventSigs[eventName];
	if (!sig) return slua.fn([slua.unknown()], slua.nil());
	return slua.fn(sig.params.map((p) => p.type), slua.nil());
}
