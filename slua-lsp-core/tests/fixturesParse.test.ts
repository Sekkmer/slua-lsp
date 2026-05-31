import { describe, expect, it } from 'vitest';

import fs from 'node:fs/promises';
import path from 'node:path';

import { parseSlua } from '../src/parser/parseSlua.js';

describe('SLua wiki fixtures parse', () => {
	it('parses all fixtures without parse errors', async () => {
		const fixturesDir = path.resolve(__dirname, 'fixtures');
		const entries = await fs.readdir(fixturesDir);
		const luaFiles = entries.filter((e) => e.endsWith('.lua')).sort();
		expect(luaFiles.length).toBeGreaterThan(0);

		for (const file of luaFiles) {
			const fullPath = path.join(fixturesDir, file);
			const text = await fs.readFile(fullPath, 'utf8');
			const result = parseSlua(text);
			const parseErrors = result.diagnostics.filter((d) => d.code === 'parse-error');
			expect(parseErrors, `fixture ${file} should parse`).toEqual([]);
		}
	});
});
