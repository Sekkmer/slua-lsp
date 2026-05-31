import { describe, expect, it } from 'vitest';

import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { buildLlModuleFromLslDefinitions } from '../src/slua/llModule.js';

describe('ll module (from YAML)', () => {
	it('builds ll.Say with typed params', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const ll = buildLlModuleFromLslDefinitions(defs);

		const say = ll.functions.Say;
		expect(say).toBeTruthy();
		expect(say.lslName).toBe('llSay');

		// llSay(integer channel, string msg)
		expect(say.params.map((p) => p.name)).toEqual(['channel', 'text']);
		expect(say.params[0]?.type).toEqual({ kind: 'custom', name: 'integer' });
		expect(say.params[1]?.type).toEqual({ kind: 'primitive', name: 'string' });
	});

	it('loads constants with value and type', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const ll = buildLlModuleFromLslDefinitions(defs);

		const active = ll.constants.ACTIVE;
		expect(active).toBeTruthy();
		expect(active.type).toEqual({ kind: 'custom', name: 'integer' });
		expect(active.value).toBeDefined();
	});
});
