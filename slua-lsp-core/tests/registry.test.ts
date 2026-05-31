import { describe, expect, it } from 'vitest';

import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

describe('slua registry', () => {
	it('exposes ll module functions and constants', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const reg = buildSluaRegistryFromLslDefinitions(defs);

		const ll = reg.getModule('ll');
		expect(ll).toBeTruthy();
		expect(ll?.functions.Say).toBeTruthy();
		expect(ll?.values.ACTIVE).toBeTruthy();
	});

	it('exposes object type methods', () => {
		const reg = buildSluaRegistryFromLslDefinitions(null);
		expect(reg.getObjectType('LLTimers')?.methods.every).toBeTruthy();
		expect(reg.getObjectType('LLEvents')?.methods.on).toBeTruthy();
	});
});
