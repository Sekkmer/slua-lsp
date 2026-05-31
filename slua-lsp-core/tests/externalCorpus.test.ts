import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSlua } from '../src/parser/parseSlua.js';

const corpusRoot = process.env.SLUA_EXTERNAL_CORPUS_DIR;
const maxFailures = Number(process.env.SLUA_EXTERNAL_CORPUS_MAX_FAILURES ?? '0');
const minFiles = Number(process.env.SLUA_EXTERNAL_CORPUS_MIN_FILES ?? '1');

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next']);
const externalDescribe = corpusRoot ? describe : describe.skip;

externalDescribe('external Luau corpus parsing', () => {
	it('parses an external Lua/Luau source corpus within the configured failure ceiling', async () => {
		const files = await collectScripts(corpusRoot!);
		expect(files.length).toBeGreaterThanOrEqual(minFiles);

		const failures = [];
		for (const file of files) {
			const text = await fs.readFile(file, 'utf8');
			const parsed = parseSlua(text);
			if (!parsed.ast || parsed.diagnostics.length > 0) {
				failures.push({
					file: path.relative(corpusRoot!, file),
					diagnostics: parsed.diagnostics.slice(0, 3).map((diagnostic) => ({
						message: diagnostic.message,
						line: diagnostic.range.start.line + 1,
						character: diagnostic.range.start.character + 1
					}))
				});
			}
		}

		const summary = {
			total: files.length,
			ok: files.length - failures.length,
			failed: failures.length,
			firstFailures: failures.slice(0, 20)
		};
		expect(failures.length, JSON.stringify(summary, null, 2)).toBeLessThanOrEqual(maxFailures);
	});
});

async function collectScripts(directory: string, out: string[] = []): Promise<string[]> {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) await collectScripts(file, out);
			continue;
		}
		if (/\.(lua|luau)$/.test(entry.name)) out.push(file);
	}
	return out.sort();
}
