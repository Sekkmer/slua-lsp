import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { run } from '../src/index.js';

const tempDirs: string[] = [];

class BufferStream {
	text = '';

	write(chunk: string | Uint8Array): boolean {
		this.text += String(chunk);
		return true;
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('slua-lsp CLI', () => {
	it('checks a valid file successfully', async () => {
		const file = await tempFile('local n = 1\nprint(n)\n');
		const stdout = new BufferStream();
		const stderr = new BufferStream();

		const code = await run(['node', 'slua-lsp', 'check', file], {
			stdout: stdout as unknown as NodeJS.WritableStream,
			stderr: stderr as unknown as NodeJS.WritableStream
		});

		expect(code).toBe(0);
		expect(stdout.text).toBe('');
		expect(stderr.text).toBe('');
	});

	it('reports parse diagnostics and exits non-zero', async () => {
		const file = await tempFile('local =\n');
		const stdout = new BufferStream();
		const stderr = new BufferStream();

		const code = await run(['node', 'slua-lsp', 'check', file], {
			stdout: stdout as unknown as NodeJS.WritableStream,
			stderr: stderr as unknown as NodeJS.WritableStream
		});

		expect(code).toBe(1);
		expect(stdout.text).toContain(`${file}:1:`);
		expect(stdout.text).toContain('error parse-error');
		expect(stderr.text).toBe('');
	});

	it('can emit JSON diagnostics', async () => {
		const file = await tempFile('local =\n');
		const stdout = new BufferStream();
		const stderr = new BufferStream();

		const code = await run(['node', 'slua-lsp', 'check', '--format', 'json', file], {
			stdout: stdout as unknown as NodeJS.WritableStream,
			stderr: stderr as unknown as NodeJS.WritableStream
		});

		expect(code).toBe(1);
		const parsed = JSON.parse(stdout.text) as { diagnostics: unknown[] };
		expect(parsed.diagnostics).toHaveLength(1);
		expect(stderr.text).toBe('');
	});
});

async function tempFile(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-cli-'));
	tempDirs.push(dir);
	const file = path.join(dir, 'script.luau');
	await fs.writeFile(file, source, 'utf8');
	return file;
}
