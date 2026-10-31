import { describe, expect, it } from 'vitest';

import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import {
	buildSluaEventSignaturesFromLslDefinitions,
	defaultSluaEventOverrides
} from '../src/slua/events.js';

describe('SLua events (from YAML + overrides)', () => {
	it('does not resurrect explicitly removed events through default or caller overrides', () => {
		const defs = { events: { touch_start: { 'slua-removed': true, arguments: [] }, listen: { arguments: [] } } };
		const sigs = buildSluaEventSignaturesFromLslDefinitions(defs);
		expect(sigs.touch_start).toBeUndefined();
		expect(sigs.listen.source).toBe('override');
		const custom = buildSluaEventSignaturesFromLslDefinitions(defs, { touch_start: defaultSluaEventOverrides.touch_start });
		expect(custom.touch_start).toBeUndefined();
	});
	it('uses YAML signature for listen', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const sigs = buildSluaEventSignaturesFromLslDefinitions(defs, defaultSluaEventOverrides);
		const listen = sigs.listen;

		expect(listen).toBeTruthy();
		expect(listen.source).toBe('override');
		expect(listen.params.map((p) => p.name)).toEqual(['Channel', 'Name', 'ID', 'Text']);
		expect(listen.params.map((p) => p.type)).toEqual([
			{ kind: 'primitive', name: 'number' },
			{ kind: 'primitive', name: 'string' },
			{ kind: 'custom', name: 'uuid' },
			{ kind: 'primitive', name: 'string' }
		]);
	});

	it('overrides touch_start to detected list', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const sigs = buildSluaEventSignaturesFromLslDefinitions(defs, defaultSluaEventOverrides);
		const touchStart = sigs.touch_start;

		expect(touchStart).toBeTruthy();
		expect(touchStart.source).toBe('override');
		expect(touchStart.params).toEqual([
			{ name: 'detected', type: { kind: 'array', element: { kind: 'custom', name: 'DetectedEvent' } } }
		]);
	});
});
