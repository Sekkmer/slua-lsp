import { describe, expect, it } from 'vitest';
import { DocumentParseCache } from '../src/documentParseCache.js';

describe('open document parse snapshots', () => {
	it('shares a snapshot between requests and invalidates it after edits', () => {
		const cache = new DocumentParseCache();
		const original = { uri: 'file:///script.luau', version: 1, getText: () => 'local count = 1\nprint(count)' };
		const parsed = cache.get(original);
		expect(parsed.diagnostics).toEqual([]);
		expect(cache.get(original)).toBe(parsed);
		const edited = cache.get({ ...original, version: 2, getText: () => 'local =' });
		expect(edited).not.toBe(parsed);
		expect(edited.diagnostics.some((d) => d.code === 'parse-error')).toBe(true);
	});

	it('isolates files and discards old versions when a URI is reopened', () => {
		const cache = new DocumentParseCache();
		const document = { uri: 'file:///one.luau', version: 1, getText: () => 'local =' };
		const old = cache.get(document);
		const other = cache.get({ ...document, uri: 'file:///two.luau', getText: () => 'print(1)' });
		expect(other.diagnostics).toEqual([]);
		cache.close(document.uri);
		const reopened = cache.get({ ...document, getText: () => 'print(2)' });
		expect(reopened).not.toBe(old);
		expect(reopened.diagnostics).toEqual([]);
	});
	it('keeps semantic data isolated by file/version and clears it on close and same-version reopen', () => {
		const cache = new DocumentParseCache();
		const original = { uri: 'file:///one.luau', version: 1, getText: () => 'local count = 1' };
		const first = cache.getSemanticData(original, () => [0, 0, 5, 0, 0]);
		expect(cache.getSemanticData(original, () => { throw new Error('unchanged source was reclassified'); })).toBe(first);
		expect(cache.getSemanticData({ ...original, uri: 'file:///two.luau' }, () => [0, 0, 3, 0, 0])).not.toBe(first);
		const edited = { ...original, version: 2, getText: () => 'print(2)' };
		expect(cache.getSemanticData(edited, () => [0, 0, 5, 1, 0])).not.toBe(first);
		cache.close(original.uri);
		const reopened = cache.getSemanticData(original, () => []);
		expect(reopened).toEqual([]);
		expect(cache.getSemanticData(original, () => { throw new Error('empty tokens were not cached'); })).toBe(reopened);
	});

});
