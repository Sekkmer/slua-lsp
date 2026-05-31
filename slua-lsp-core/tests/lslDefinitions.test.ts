import { describe, expect, it } from 'vitest';

import { getBundledLslDefinitionsYamlPath, loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';

describe('lslDefinitions', () => {
	it('loads the vendored YAML definitions', async () => {
		const filePath = getBundledLslDefinitionsYamlPath();
		const defs = await loadLslDefinitionsFromYamlFile(filePath);

		expect(defs).toBeTruthy();
		expect(defs).toHaveProperty('llsd-lsl-syntax-version');
	});
});
