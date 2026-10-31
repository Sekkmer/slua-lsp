import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildSluaRegistryFromLslDefinitions } from '../slua/registry.js';
import { loadLslDefinitionsFromSource, type LslDefinitions } from './lslDefinitions.js';

export const MAX_DEFINITIONS_BYTES = 8 * 1024 * 1024;

export const DEFAULT_DEFINITIONS_UPDATE_URL =
	'https://raw.githubusercontent.com/secondlife/lsl-definitions/main/lsl_definitions.yaml';

export interface DefinitionUpdateMetadata {
	/** Format 2 selects an immutable content file with this metadata's digest. */
	cacheFormat?: 2;
	sourceUrl: string;
	sha256: string;
	etag?: string;
	checkedAt: string;
	activatedAt: string;
	version: string;
	sizeBytes: number;
}

export interface DefinitionUpdateResult {
	updated: boolean;
	notModified: boolean;
	definitionsPath: string;
	metadata: DefinitionUpdateMetadata;
}

export interface DefinitionUpdateOptions {
	cacheDir: string;
	sourceUrl?: string;
	fetch?: FetchLike;
	now?: Date;
}

export interface DefinitionUpdatePaths {
	definitionsPath: string;
	metadataPath: string;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	statusText: string;
	text(): Promise<string>;
	headers: { get(name: string): string | null };
}

export function definitionUpdatePaths(cacheDir: string): DefinitionUpdatePaths {
	return {
		definitionsPath: path.join(cacheDir, 'lsl_definitions.yaml'),
		metadataPath: path.join(cacheDir, 'lsl_definitions.metadata.json')
	};
}

export type CacheReadErrorHandler = (error: unknown) => void;

// The cache is optional. Read failures must not prevent offline startup; callers
// can report non-missing failures without discarding bundled definitions.
export async function readDefinitionUpdateMetadata(cacheDir: string, onError?: CacheReadErrorHandler): Promise<DefinitionUpdateMetadata | null> {
	const { metadataPath } = definitionUpdatePaths(cacheDir);
	try {
		const raw = await fs.readFile(metadataPath, 'utf8');
		return parseDefinitionUpdateMetadata(raw);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT' && code !== 'ENOTDIR') onError?.(err);
		return null;
	}
}

export async function cachedDefinitionPath(cacheDir: string, onError?: CacheReadErrorHandler): Promise<string | null> {
	return cachedPathForMetadata(cacheDir, await readDefinitionUpdateMetadata(cacheDir, onError), onError);
}

async function cachedPathForMetadata(cacheDir: string, metadata: DefinitionUpdateMetadata | null, onError?: CacheReadErrorHandler): Promise<string | null> {
	try {
		if (!metadata) return null;
		const definitionsPath = metadata.cacheFormat === 2
			? generationPath(cacheDir, metadata.sha256)
			: definitionUpdatePaths(cacheDir).definitionsPath;
		const raw = await fs.readFile(definitionsPath, 'utf8');
		if (Buffer.byteLength(raw, 'utf8') !== metadata.sizeBytes || hashSha256(raw) !== metadata.sha256) return null;
		return definitionsPath;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT' && code !== 'ENOTDIR') onError?.(err);
		return null;
	}
}

export async function shouldCheckDefinitionUpdate(cacheDir: string, intervalMs: number, now = new Date(), sourceUrl?: string): Promise<boolean> {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) return true;
	const metadata = await readDefinitionUpdateMetadata(cacheDir);
	if (!metadata || (sourceUrl && sourceUrl !== metadata.sourceUrl) || !(await cachedDefinitionPath(cacheDir))) return true;
	const checkedAt = Date.parse(metadata.checkedAt);
	return !Number.isFinite(checkedAt) || checkedAt > now.getTime() || now.getTime() - checkedAt >= intervalMs;
}

const updatesInProgress = new Map<string, Promise<DefinitionUpdateResult>>();

export async function updateDefinitions(options: DefinitionUpdateOptions): Promise<DefinitionUpdateResult> {
	const key = path.resolve(options.cacheDir);
	const pending = updatesInProgress.get(key);
	const current = (pending ? pending.catch(() => undefined) : Promise.resolve()).then(() => updateDefinitionsOnce(options));
	updatesInProgress.set(key, current);
	try {
		return await current;
	} finally {
		if (updatesInProgress.get(key) === current) updatesInProgress.delete(key);
	}
}

async function updateDefinitionsOnce(options: DefinitionUpdateOptions): Promise<DefinitionUpdateResult> {
	const sourceUrl = options.sourceUrl?.trim() || DEFAULT_DEFINITIONS_UPDATE_URL;
	if (!['http:', 'https:'].includes(new URL(sourceUrl).protocol)) throw new Error('Definition updates require an HTTP(S) URL');
	const now = options.now ?? new Date();
	const fetcher = options.fetch ?? defaultFetch;

	await fs.mkdir(options.cacheDir, { recursive: true });
	const paths = definitionUpdatePaths(options.cacheDir);
	const previous = await readDefinitionUpdateMetadata(options.cacheDir);
	const headers: Record<string, string> = {};
	const validCache = await cachedPathForMetadata(options.cacheDir, previous);
	if (previous?.etag && previous.sourceUrl === sourceUrl && validCache) headers['If-None-Match'] = previous.etag;

	const response = await fetcher(sourceUrl, { headers });
	if (response.status === 304 && previous?.sourceUrl === sourceUrl && headers['If-None-Match'] && validCache) {
		const metadata = { ...previous, checkedAt: now.toISOString() };
		await writeJsonAtomic(paths.metadataPath, metadata);
		return {
			updated: false,
			notModified: true,
			definitionsPath: validCache,
			metadata
		};
	}
	if (!response.ok) {
		throw new Error(`Definition update failed: HTTP ${response.status} ${response.statusText}`);
	}

	const length = Number(response.headers.get('content-length'));
	if (length > MAX_DEFINITIONS_BYTES) throw new Error('Definition download exceeds size limit');
	const raw = await response.text();
	if (Buffer.byteLength(raw, 'utf8') > MAX_DEFINITIONS_BYTES) throw new Error('Definition download exceeds size limit');
	const defs = loadLslDefinitionsFromSource(raw, '<downloaded lsl_definitions.yaml>');
	validateDefinitionUpdate(defs);

	const sha256 = hashSha256(raw);
	const metadata: DefinitionUpdateMetadata = {
		cacheFormat: 2,
		sourceUrl,
		sha256,
		etag: response.headers.get('etag') ?? undefined,
		checkedAt: now.toISOString(),
		activatedAt: previous?.sha256 === sha256 && validCache ? previous.activatedAt : now.toISOString(),
		version: definitionVersion(defs),
		sizeBytes: Buffer.byteLength(raw, 'utf8')
	};
	const updated = previous?.sha256 !== sha256 || !validCache;
	const definitionsPath = generationPath(options.cacheDir, sha256);
	// Publish content first, then atomically switch the sole pointer. Readers keep
	// a stable path even while other processes refresh the same cache. An interrupted
	// writer can leave unreferenced content, but cannot invalidate the active pair.
	await fs.mkdir(path.dirname(definitionsPath), { recursive: true });
	if (validCache !== definitionsPath) await writeTextAtomic(definitionsPath, raw);
	await writeJsonAtomic(paths.metadataPath, metadata);
	return {
		updated,
		notModified: false,
		definitionsPath,
		metadata
	};
}

async function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<FetchResponseLike> {
	if (!globalThis.fetch) throw new Error('No fetch implementation is available for definition updates');
	const response = await globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
	return {
		ok: response.ok, status: response.status, statusText: response.statusText, headers: response.headers,
		text: async () => {
			const reader = response.body?.getReader();
			if (!reader) return '';
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > MAX_DEFINITIONS_BYTES) throw new Error('Definition download exceeds size limit');
					chunks.push(value);
				}
				return Buffer.concat(chunks).toString('utf8');
			} finally {
				await reader.cancel();
			}
		}
	};
}

function parseDefinitionUpdateMetadata(raw: string): DefinitionUpdateMetadata | null {
	try {
		const parsed = JSON.parse(raw) as Partial<DefinitionUpdateMetadata>;
		if (!parsed || typeof parsed !== 'object') return null;
		if (
			(parsed.cacheFormat !== undefined && parsed.cacheFormat !== 2) ||
			typeof parsed.sourceUrl !== 'string' ||
			typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
			typeof parsed.checkedAt !== 'string' ||
			typeof parsed.activatedAt !== 'string' ||
			typeof parsed.version !== 'string' ||
			typeof parsed.sizeBytes !== 'number' || !Number.isSafeInteger(parsed.sizeBytes) || parsed.sizeBytes < 0 || parsed.sizeBytes > MAX_DEFINITIONS_BYTES
		) {
			return null;
		}
		return {
			cacheFormat: parsed.cacheFormat,
			sourceUrl: parsed.sourceUrl,
			sha256: parsed.sha256,
			etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
			checkedAt: parsed.checkedAt,
			activatedAt: parsed.activatedAt,
			version: parsed.version,
			sizeBytes: parsed.sizeBytes
		};
	} catch {
		return null;
	}
}

export function validateDefinitionUpdate(defs: LslDefinitions): void {
	const missing: string[] = [];
	if (!isRecord(defs)) {
		missing.push('definitions root');
	} else {
		if (!hasRecordEntry(defs, 'constants', 'NULL_KEY')) missing.push('constant NULL_KEY');
		if (!hasRecordEntry(defs, 'events', 'touch_start')) missing.push('event touch_start');
		if (!hasRecordEntry(defs, 'functions', 'llSay')) missing.push('function llSay');
		if (!hasRecordEntry(defs, 'functions', 'llMessageLinked')) missing.push('function llMessageLinked');

		const registry = buildSluaRegistryFromLslDefinitions(defs);
		const ll = registry.getModule('ll');
		if (!ll?.functions.Say) missing.push('SLua ll.Say registry entry');
		if (!ll?.values.NULL_KEY) missing.push('SLua ll.NULL_KEY registry entry');
		if (!registry.eventSignatures.touch_start) missing.push('SLua touch_start event signature');
	}
	if (missing.length > 0) {
		throw new Error(`Downloaded definitions are missing required entries: ${missing.join(', ')}`);
	}
}

function definitionVersion(defs: LslDefinitions): string {
	if (!isRecord(defs)) return 'unknown';
	const version = defs['llsd-lsl-syntax-version'];
	return typeof version === 'string' || (typeof version === 'number' && Number.isFinite(version)) ? String(version) : 'unknown';
}

function hasRecordEntry(parent: Record<string, unknown>, sectionName: string, entryName: string): boolean {
	const section = parent[sectionName];
	return isRecord(section) && isRecord(section[entryName]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashSha256(raw: string): string {
	return crypto.createHash('sha256').update(raw).digest('hex');
}

function generationPath(cacheDir: string, sha256: string): string {
	return path.join(cacheDir, 'generations', `${sha256}.yaml`);
}

async function writeTextAtomic(file: string, raw: string): Promise<void> {
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, raw, { encoding: 'utf8', flag: 'wx' });
		await fs.rename(tmp, file);
	} finally {
		await fs.rm(tmp, { force: true });
	}
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
