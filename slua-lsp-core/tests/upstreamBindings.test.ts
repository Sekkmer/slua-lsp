import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultMetatableRegistry } from '../src/slua/metatables.js';

function getUpstreamDetectedEventMethodNames(upstreamLlleventsCpp: string): string[] {
	const contents = fs.readFileSync(upstreamLlleventsCpp, 'utf8');

	// Methods are added via:
	//   ADD_DETECTED_GETTER("getKey", "DetectedKey");
	// plus an explicit:
	//   lua_setfield(L, -2, "adjustDamage");
	const getterRe = /ADD_DETECTED_GETTER\("([^"]+)"\s*,\s*"[^"]+"\)/g;
	const names = new Set<string>();
	for (const match of contents.matchAll(getterRe)) {
		names.add(match[1]);
	}

	if (contents.includes('"adjustDamage"')) {
		names.add('adjustDamage');
	}

	return [...names].sort();
}

describe('Upstream SLua bindings (optional)', () => {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const upstreamLlleventsCpp = path.resolve(__dirname, '../../slua/VM/src/lllevents.cpp');

	const itIfUpstreamPresent = fs.existsSync(upstreamLlleventsCpp) ? it : it.skip;

	itIfUpstreamPresent('DetectedEvent method surface matches upstream lllevents.cpp', () => {
		const upstreamMethods = getUpstreamDetectedEventMethodNames(upstreamLlleventsCpp);

		const detectedEvent = defaultMetatableRegistry.get('DetectedEvent');
		expect(detectedEvent).toBeTruthy();
		expect(detectedEvent?.members).toBeTruthy();

		const modeledMethods = Object.values(detectedEvent!.members!)
			.filter((m) => m.kind === 'method')
			.map((m) => m.name)
			.sort();

		expect(modeledMethods).toEqual(upstreamMethods);
	});
});
