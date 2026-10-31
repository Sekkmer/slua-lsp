import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getBundledLslDefinitionsYamlPath } from '../src/lsl/lslDefinitions.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromSource } from '../src/lsl/lslDefinitions.js';

import {
	cachedDefinitionPath,
	definitionUpdatePaths,
	readDefinitionUpdateMetadata,
	shouldCheckDefinitionUpdate,
	updateDefinitions,
	type FetchLike
} from '../src/lsl/definitionUpdate.js';

const VALID_DEFS = `llsd-lsl-syntax-version: test-update
constants:
  NULL_KEY:
    type: key
    value: "00000000-0000-0000-0000-000000000000"
    tooltip: Null key
events:
  touch_start:
    tooltip: Touch start
    detected-semantics: true
    arguments:
      - num_detected:
          type: integer
  state_entry:
    tooltip: Removed in SLua
    slua-removed: true
    arguments: []
functions:
  llSay:
    return: void
    arguments:
      - Channel:
          type: integer
      - Text:
          type: string
  llMessageLinked:
    return: void
    arguments:
      - Link:
          type: integer
      - Number:
          type: integer
      - Text:
          type: string
      - ID:
          type: key
`;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('definition updater', () => {
	it('accepts the actual bundled official YAML while excluding removed LSL state events', async () => {
		const raw = await fs.readFile(getBundledLslDefinitionsYamlPath(), 'utf8');
		const registry = buildSluaRegistryFromLslDefinitions(loadLslDefinitionsFromSource(raw));
		expect(registry.eventSignatures.state_entry).toBeUndefined();
		expect(registry.eventSignatures.touch_start).toBeDefined();
		const dir = await tempDir();
		const result = await updateDefinitions({ cacheDir: dir, fetch: okFetch(raw) });
		expect(await fs.readFile(result.definitionsPath, 'utf8')).toBe(raw);
		expect(await cachedDefinitionPath(dir)).toBe(result.definitionsPath);
	});
	it('rejects a removed required SLua event without replacing the active cache', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		const removed = VALID_DEFS.replace('  touch_start:', '  touch_start:\n    slua-removed: true');
		await expect(updateDefinitions({ cacheDir: dir, fetch: okFetch(removed) })).rejects.toThrow(/SLua touch_start event signature/);
		expect(await cachedDefinitionPath(dir)).toBe(first.definitionsPath);
		expect(await readDefinitionUpdateMetadata(dir)).toEqual(first.metadata);
	});
	it('downloads, validates, and caches definitions with metadata', async () => {
		const dir = await tempDir();
		const result = await updateDefinitions({
			cacheDir: dir,
			sourceUrl: 'https://example.test/defs.yaml',
			now: new Date('2026-05-26T10:00:00.000Z'),
			fetch: okFetch(VALID_DEFS, '"abc"')
		});

		expect(result.updated).toBe(true);
		expect(result.notModified).toBe(false);
		expect(await fs.readFile(result.definitionsPath, 'utf8')).toBe(VALID_DEFS);
		expect(await cachedDefinitionPath(dir)).toBe(result.definitionsPath);
		const metadata = await readDefinitionUpdateMetadata(dir);
		expect(metadata?.sourceUrl).toBe('https://example.test/defs.yaml');
		expect(metadata?.etag).toBe('"abc"');
		expect(metadata?.version).toBe('test-update');
		expect(metadata?.checkedAt).toBe('2026-05-26T10:00:00.000Z');
	});

	it('updates check time without rewriting definitions on 304', async () => {
		const dir = await tempDir();
		await updateDefinitions({
			cacheDir: dir,
			now: new Date('2026-05-26T10:00:00.000Z'),
			fetch: okFetch(VALID_DEFS, '"abc"')
		});

		const result = await updateDefinitions({
			cacheDir: dir,
			now: new Date('2026-05-26T12:00:00.000Z'),
			fetch: notModifiedFetch()
		});

		expect(result.updated).toBe(false);
		expect(result.notModified).toBe(true);
		expect(result.metadata.checkedAt).toBe('2026-05-26T12:00:00.000Z');
		expect(await fs.readFile(result.definitionsPath, 'utf8')).toBe(VALID_DEFS);
	});

	it('uses metadata age for interval checks', async () => {
		const dir = await tempDir();
		await updateDefinitions({
			cacheDir: dir,
			now: new Date('2026-05-26T10:00:00.000Z'),
			fetch: okFetch(VALID_DEFS)
		});

		await expect(shouldCheckDefinitionUpdate(dir, 24 * 60 * 60 * 1000, new Date('2026-05-26T11:00:00.000Z'))).resolves.toBe(
			false
		);
		await expect(shouldCheckDefinitionUpdate(dir, 24 * 60 * 60 * 1000, new Date('2026-05-27T11:00:00.000Z'))).resolves.toBe(
			true
		);
	});

	it('rejects downloaded definitions missing required smoke entries', async () => {
		const dir = await tempDir();
		await expect(
			updateDefinitions({
				cacheDir: dir,
				fetch: okFetch('llsd-lsl-syntax-version: bad\nconstants: {}\nevents: {}\nfunctions: {}\n')
			})
		).rejects.toThrow(/missing required entries/);
		await expect(cachedDefinitionPath(dir)).resolves.toBeNull();
	});
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-def-update-'));
	tempDirs.push(dir);
	return dir;
}

function okFetch(body: string, etag?: string): FetchLike {
	return async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: async () => body,
		headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) }
	});
}

function notModifiedFetch(): FetchLike {
	return async () => ({
		ok: false,
		status: 304,
		statusText: 'Not Modified',
		text: async () => '',
		headers: { get: () => null }
	});
}

describe('definition update recovery', () => {
	it('treats an invalid metadata filesystem entry as an unavailable optional cache', async () => {
		const dir = await tempDir();
		await fs.mkdir(definitionUpdatePaths(dir).metadataPath);
		const errors: unknown[] = [];
		expect(await cachedDefinitionPath(dir, (error) => errors.push(error))).toBeNull();
		expect(errors).toHaveLength(1);
		expect((errors[0] as NodeJS.ErrnoException).code).toBe('EISDIR');
		expect(await shouldCheckDefinitionUpdate(dir, 86400000)).toBe(true);
		await expect(updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) })).rejects.toThrow();
		expect((await fs.stat(definitionUpdatePaths(dir).metadataPath)).isDirectory()).toBe(true);
	});

	it.skipIf(process.getuid?.() === 0).each(['metadata', 'generation'] as const)('falls back when cached %s is unreadable without changing its permissions', async (entry) => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		const blocked = entry === 'metadata' ? definitionUpdatePaths(dir).metadataPath : first.definitionsPath;
		await fs.chmod(blocked, 0);
		try {
			const errors: unknown[] = [];
			expect(await cachedDefinitionPath(dir, (error) => errors.push(error))).toBeNull();
			expect(errors).toHaveLength(1);
			expect((errors[0] as NodeJS.ErrnoException).code).toBe('EACCES');
			expect((await fs.stat(blocked)).mode & 0o777).toBe(0);
		} finally { await fs.chmod(blocked, 0o600); }
		expect(await cachedDefinitionPath(dir)).toBe(first.definitionsPath);
	});

	it('keeps previously returned paths valid across later activations', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		const nextBody = VALID_DEFS.replace('test-update', 'next-version');
		const next = await updateDefinitions({ cacheDir: dir, fetch: okFetch(nextBody) });
		expect(next.definitionsPath).not.toBe(first.definitionsPath);
		expect(await fs.readFile(first.definitionsPath, 'utf8')).toBe(VALID_DEFS);
		expect(await fs.readFile(next.definitionsPath, 'utf8')).toBe(nextBody);
		expect(await cachedDefinitionPath(dir)).toBe(next.definitionsPath);
	});

	it('ignores content staged by an interrupted writer before metadata activation', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		await fs.writeFile(path.join(dir, 'generations', `${'0'.repeat(64)}.yaml`), 'incomplete write');
		expect(await cachedDefinitionPath(dir)).toBe(first.definitionsPath);
		expect(await readDefinitionUpdateMetadata(dir)).toEqual(first.metadata);
	});

	it('reads existing caches and migrates them without removing their old paths', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		const legacy = definitionUpdatePaths(dir);
		const metadata = { ...first.metadata };
		delete metadata.cacheFormat;
		await fs.writeFile(legacy.definitionsPath, VALID_DEFS);
		await fs.writeFile(legacy.metadataPath, JSON.stringify(metadata));
		expect(await cachedDefinitionPath(dir)).toBe(legacy.definitionsPath);
		const next = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		expect(next.metadata.cacheFormat).toBe(2);
		expect(next.updated).toBe(false);
		expect(await cachedDefinitionPath(dir)).toBe(next.definitionsPath);
		expect(await fs.readFile(legacy.definitionsPath, 'utf8')).toBe(VALID_DEFS);
	});

	it('refreshes immediately when the source URL changes or the cache disappears', async () => {
		const dir = await tempDir();
		const now = new Date('2026-10-29T12:00:00Z');
		const first = await updateDefinitions({ cacheDir: dir, now, sourceUrl: 'https://one.test/defs', fetch: okFetch(VALID_DEFS) });
		expect(await shouldCheckDefinitionUpdate(dir, 86400000, now, 'https://two.test/defs')).toBe(true);
		await fs.unlink(first.definitionsPath);
		expect(await shouldCheckDefinitionUpdate(dir, 86400000, now, 'https://one.test/defs')).toBe(true);
	});

	it('refuses corrupt cached bytes and fetches unconditionally to repair them', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS, '"old"') });
		await fs.writeFile(first.definitionsPath, 'corrupted');
		expect(await cachedDefinitionPath(dir)).toBeNull();
		const result = await updateDefinitions({ cacheDir: dir, fetch: async (_url, init) => {
			expect(init?.headers?.['If-None-Match']).toBeUndefined();
			return okFetch(VALID_DEFS, '"new"')('https://example.test');
		} });
		expect(result.updated).toBe(true);
		expect(await cachedDefinitionPath(dir)).toBe(result.definitionsPath);
	});

	it('does not reuse an unrelated source on an unexpected 304', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, sourceUrl: 'https://one.test', fetch: okFetch(VALID_DEFS, '"old"') });
		await expect(updateDefinitions({ cacheDir: dir, sourceUrl: 'https://two.test', fetch: notModifiedFetch() })).rejects.toThrow(/304/);
		expect(await readDefinitionUpdateMetadata(dir)).toEqual(first.metadata);
	});

	it('preserves the last good cache and metadata on invalid downloads and offline failures', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		await expect(updateDefinitions({ cacheDir: dir, fetch: okFetch('functions: {}') })).rejects.toThrow();
		await expect(updateDefinitions({ cacheDir: dir, fetch: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
		expect(await fs.readFile(first.definitionsPath, 'utf8')).toBe(VALID_DEFS);
		expect(await readDefinitionUpdateMetadata(dir)).toEqual(first.metadata);
	});

	it('serializes concurrent updates and continues after a failed update', async () => {
		const dir = await tempDir();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const first = updateDefinitions({ cacheDir: dir, fetch: async () => { enter(); await gate; throw new Error('offline'); } });
		const firstFailure = expect(first).rejects.toThrow('offline');
		await entered;
		let secondStarted = false;
		const second = updateDefinitions({ cacheDir: dir, fetch: async () => { secondStarted = true; return okFetch(VALID_DEFS)('https://example.test'); } });
		expect(secondStarted).toBe(false);
		release();
		await firstFailure;
		const result = await second;
		expect(await cachedDefinitionPath(dir)).toBe(result.definitionsPath);
		expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('does not suppress refresh indefinitely after a clock moves backwards', async () => {
		const dir = await tempDir();
		await updateDefinitions({ cacheDir: dir, now: new Date('2026-10-30T12:00:00Z'), fetch: okFetch(VALID_DEFS) });
		expect(await shouldCheckDefinitionUpdate(dir, 86400000, new Date('2026-10-29T12:00:00Z'))).toBe(true);
	});

	it('preserves activation time for an identical successful response', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, now: new Date('2026-10-28T12:00:00Z'), fetch: okFetch(VALID_DEFS) });
		const next = await updateDefinitions({ cacheDir: dir, now: new Date('2026-10-29T12:00:00Z'), fetch: okFetch(VALID_DEFS) });
		expect(next.updated).toBe(false);
		expect(next.metadata.activatedAt).toBe(first.metadata.activatedAt);
		expect(next.metadata.checkedAt).not.toBe(first.metadata.checkedAt);
	});

	it('rejects oversized downloads before parsing without damaging the existing cache', async () => {
		const dir = await tempDir();
		const first = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS) });
		await expect(updateDefinitions({ cacheDir: dir, fetch: okFetch('x'.repeat(8 * 1024 * 1024 + 1)) })).rejects.toThrow(/size limit/);
		expect(await fs.readFile(first.definitionsPath, 'utf8')).toBe(VALID_DEFS);
	});
});

describe('official YAML version metadata', () => {
	it('retains numeric upstream schema versions rather than displaying unknown', async () => {
		const dir = await tempDir();
		const result = await updateDefinitions({ cacheDir: dir, fetch: okFetch(VALID_DEFS.replace('test-update', '2')) });
		expect(result.metadata.version).toBe('2');
	});
});
