import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { isCallExpression, isFunctionDeclarationNode, isIdentifier, isStringNode, rangeFromNode, visitAst, type LspRange, type LspPosition } from '../parser/ast.js';
import { parseSourceAliases, splitSourceAlias } from './sourceConfig.js';
import { parseSlua, type ParseResult } from '../parser/parseSlua.js';
import { collectLexicalBindings } from '../typing/lexicalBindings.js';
import type { CoreDiagnostic } from '../diagnostics/types.js';

export type SourceRequire = { specifier?: string; range: LspRange };
export type SourceModuleDiagnostic = CoreDiagnostic & { file: string };
export type SourceModuleEdge = SourceRequire & { from: string; target?: string };
export type SourceModuleGraph = {
	entry: string;
	modules: Array<{ file: string; sourceSha256: string; bytes: number }>;
	configs: Array<{ file: string; sourceSha256: string }>;
	edges: SourceModuleEdge[];
	diagnostics: SourceModuleDiagnostic[];
};
export type SourceModuleOptions = {
	/** Absolute source paths; undefined means absent. A host may supply unsaved buffers. */
	readFile?: (file: string) => Promise<string | undefined>;
	entryText?: string;
	maxDepth?: number;
	/** Optional editor cache; the returned AST must describe these exact text bytes. */
	parseFile?: (file: string, text: string) => ParseResult;
	signal?: AbortSignal;
	onRead?: (file: string) => void;
};
export type SourceModuleSnapshot = { graph: SourceModuleGraph; documents: Map<string, { text: string; parsed: ParseResult }> };
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MODULES = 256;
const zeroRange: LspRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

export function sourceModuleRangeContains(range: LspRange, position: LspPosition): boolean {
	return (position.line > range.start.line || position.line === range.start.line && position.character >= range.start.character)
		&& (position.line < range.end.line || position.line === range.end.line && position.character < range.end.character);
}

/** Only unbound direct calls participate; explicit global replacement is also deferred. */
export function collectSourceRequires(ast: unknown): SourceRequire[] {
	return sourceRequireCalls(ast).map((node) => {
		const argument = node.arguments[0];
		return { range: rangeFromNode(isStringNode(argument) ? argument : node),
			...(node.arguments.length === 1 && isStringNode(argument) ? { specifier: argument.value } : {}) };
	});
}

export function sourceRequireCalls(ast: unknown) {
	const unbound = new WeakSet(collectLexicalBindings(ast)
		.filter((item) => item.kind === 'usage' && !item.definition && item.identifier.name === 'require')
		.map((item) => item.identifier));
	const result: Array<import('../parser/ast.js').CallExpressionNode> = [];
	let replaced = false;
	visitAst(ast, (node) => {
		const record = node as unknown as Record<string, unknown>;
		if (node.type === 'AssignmentStatement' && Array.isArray(record.variables)
			&& record.variables.some((target) => isIdentifier(target) && unbound.has(target))) replaced = true;
		if (isFunctionDeclarationNode(node) && !node.isLocal && isIdentifier(node.identifier) && unbound.has(node.identifier)) replaced = true;
		if (!isCallExpression(node) || !isIdentifier(node.callee) || !unbound.has(node.callee)) return;
		result.push(node);
	});
	// Generated scripts install their own global numeric-ID loader, including
	// inside an IIFE. Do not perform source IO or assign the string-path contract
	// when a direct global write can replace require. Execution order and dynamic
	// environment mutation are outside this source inspection pass.
	return replaced ? [] : result;
}

/** Bounded ordinary source IO. Never opens a FIFO/device or executes a module. */
export async function readSourceModuleFile(file: string): Promise<string | undefined> {
	let handle;
	try {
		handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (stat.isDirectory()) return undefined;
		if (!stat.isFile()) throw new Error(`Not a regular source file: ${file}`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`Source file exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
		const chunks: Buffer[] = [];
		let length = 0;
		for (;;) {
			const bytes = Buffer.alloc(Math.min(65536, MAX_FILE_BYTES + 1 - length));
			const read = await handle.read(bytes, 0, bytes.length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
			if (length > MAX_FILE_BYTES) throw new Error(`Source file exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
			chunks.push(bytes.subarray(0, read.bytesRead));
		}
		// Retain U+FEFF: decoding must not rewrite source bytes, hashes or positions.
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length));
		if (text.includes('\0')) throw new Error(`Binary source file: ${file}`);
		return text;
	} catch (error) {
		if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
		throw error;
	} finally { await handle?.close(); }
}

/**
 * Inspect SLua source includes, not a simulator loader or generated-code executor.
 * Alias inheritance follows the Luau RFC: nearest config overrides its parent.
 * Every invocation takes a fresh snapshot, so edits/config changes need no stale cache eviction.
 */
export async function getSourceModuleGraph(entry: string, options: SourceModuleOptions = {}): Promise<SourceModuleGraph> {
	return (await getSourceModuleSnapshot(entry, options)).graph;
}

export async function getSourceModuleSnapshot(entry: string, options: SourceModuleOptions = {}): Promise<SourceModuleSnapshot> {
	const maxDepth = options.maxDepth ?? 5;
	if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 50) throw new Error('Module depth must be an integer from 1 to 50');
	entry = path.resolve(entry);
	const graph: SourceModuleGraph = { entry, modules: [], configs: [], edges: [], diagnostics: [] };
	const documents: SourceModuleSnapshot['documents'] = new Map();
	const read = options.readFile ?? readSourceModuleFile;
	const files = new Map<string, Promise<string | undefined>>();
	let totalBytes = 0;
	function snapshot(file: string): Promise<string | undefined> {
		options.signal?.throwIfAborted();
		options.onRead?.(file);
		let pending = files.get(file);
		if (!pending) {
			pending = (file === entry && options.entryText !== undefined ? Promise.resolve(options.entryText) : read(file)).then((text) => {
				if (text === undefined) return undefined;
				if (/[\ud800-\udfff]/u.test(text)) throw new Error(`Invalid Unicode source buffer: ${file}`);
				const bytes = Buffer.byteLength(text);
				if (bytes > MAX_FILE_BYTES || text.includes('\0')) throw new Error(`Invalid or oversized source file: ${file}`);
				totalBytes += bytes;
				if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Source module graph exceeds ${MAX_TOTAL_BYTES} bytes`);
				return text;
			});
			files.set(file, pending);
		}
		return pending;
	}
	function diagnostic(file: string, range: LspRange, code: string, message: string): void {
		graph.diagnostics.push({ file, range, code, message, severity: 'error' });
	}
	type AliasConfig = { directory: string; aliases: Map<string, string> };
	const aliases = new Map<string, Promise<AliasConfig[]>>();
	const configs = new Map<string, Promise<AliasConfig>>();
	const recordedConfigs = new Set<string>();
	function recordConfig(file: string, text: string): void {
		if (!recordedConfigs.has(file)) {
			recordedConfigs.add(file);
			graph.configs.push({ file, sourceSha256: createHash('sha256').update(text).digest('hex') });
		}
	}
	function configFor(directory: string): Promise<AliasConfig> {
		let pending = configs.get(directory);
		if (!pending) {
			pending = (async () => {
				const file = path.join(directory, '.luaurc'), luau = path.join(directory, '.config.luau');
				const text = await snapshot(file), luauText = await snapshot(luau);
				if (text !== undefined) recordConfig(file, text);
				if (luauText !== undefined) recordConfig(luau, luauText);
				if (text !== undefined && luauText !== undefined) throw new Error(`Ambiguous source configuration: both ${file} and ${luau} exist`);
				if (luauText !== undefined) throw new Error(`Executable .config.luau is unsupported by source inspection: ${luau}; convert to a .luaurc data configuration`);
				return { directory, aliases: text === undefined ? new Map() : parseSourceAliases(text, file) };
			})();
			configs.set(directory, pending);
		}
		return pending;
	}
	function aliasesFor(file: string): Promise<AliasConfig[]> {
		const directory = path.dirname(file);
		let pending = aliases.get(directory);
		if (!pending) {
			pending = (async () => {
				const result: AliasConfig[] = [];
				let dir = directory;
				for (;;) {
					result.push(await configFor(dir));
					const parent = path.dirname(dir);
					if (parent === dir) return result;
					dir = parent;
				}
			})();
			aliases.set(directory, pending);
		}
		return pending;
	}
	function resolveAlias(specifier: string, chain: AliasConfig[], start = 0, active: readonly string[] = []): string {
		const { name, parts } = splitSourceAlias(specifier);
		for (let index = start; index < chain.length; index++) {
			const config = chain[index]!, target = config.aliases.get(name);
			if (target === undefined) continue;
			const identity = `${config.directory}/.luaurc:@${name}`;
			if (active.includes(identity)) throw new Error(`Circular source alias: ${[...active, identity].join(' -> ')}`);
			if (active.length >= 64) throw new Error('Source alias chain exceeds 64 declarations');
			const root = target.startsWith('@') ? resolveAlias(target, chain, index, [...active, identity]) : path.resolve(config.directory, target);
			return path.join(root, ...parts);
		}
		throw new Error(`Module alias not found: @${name}`);
	}

	async function resolve(from: string, specifier: string): Promise<string> {
		if (!specifier || /[\uD800-\uDFFF]/u.test(specifier) || /[\0\r\n\\]/.test(specifier) || path.isAbsolute(specifier) || /^[A-Za-z]:/.test(specifier)) throw new Error(`Expected a Unicode relative module path or @alias using forward slashes: ${specifier}`);
		let base: string;
		if (specifier.startsWith('@')) base = resolveAlias(specifier, await aliasesFor(from));
		else base = path.resolve(path.dirname(from), specifier);
		const candidates = /\.(luau|lua)$/i.test(base) ? [base] : [base, `${base}.luau`, `${base}.lua`, path.join(base, 'init.luau'), path.join(base, 'init.lua')];
		for (const candidate of candidates) if (await snapshot(candidate) !== undefined) return candidate;
		throw new Error(`Source module not found: ${specifier}`);
	}
	const visited = new Set<string>();
	async function visit(file: string, depth: number, stack: readonly string[]): Promise<void> {
		if (visited.has(file)) return;
		if (visited.size >= MAX_MODULES) throw new Error(`Source module graph exceeds ${MAX_MODULES} modules`);
		const text = await snapshot(file);
		if (text === undefined) throw new Error(`Source file not found: ${file}`);
		visited.add(file);
		graph.modules.push({ file, bytes: Buffer.byteLength(text), sourceSha256: createHash('sha256').update(text).digest('hex') });
		const parsed = options.parseFile?.(file, text) ?? parseSlua(text);
		documents.set(file, { text, parsed });
		graph.diagnostics.push(...parsed.diagnostics.map((item) => ({ ...item, file })));
		if (parsed.diagnostics.length) return;
		for (const include of collectSourceRequires(parsed.ast)) {
			if (graph.edges.length >= 8192) throw new Error('Source module graph exceeds 8192 requires');
			const edge: SourceModuleEdge = { ...include, from: file };
			graph.edges.push(edge);
			if (include.specifier === undefined) { diagnostic(file, include.range, 'module-dynamic-require', 'Source require needs exactly one literal string path'); continue; }
			try {
				edge.target = await resolve(file, include.specifier);
				if (stack.includes(edge.target)) { diagnostic(file, include.range, 'module-cycle', `Circular source require: ${[...stack, edge.target].join(' -> ')}`); continue; }
				if (depth >= maxDepth) { diagnostic(file, include.range, 'module-depth', `Maximum source require depth (${maxDepth}) exceeded`); continue; }
				await visit(edge.target, depth + 1, [...stack, edge.target]);
			} catch (error) { diagnostic(file, include.range, 'module-resolution', error instanceof Error ? error.message : String(error)); }
		}
	}
	try { await visit(entry, 0, [entry]); }
	catch (error) { diagnostic(entry, zeroRange, 'module-input', error instanceof Error ? error.message : String(error)); }
	// A shared dependency can first be seen along a shorter path. Revalidate
	// its outgoing edges for longer paths without reparsing or exponential walks.
	const outgoing = new Map<string, SourceModuleEdge[]>();
	for (const edge of graph.edges) {
		const list = outgoing.get(edge.from) ?? []; list.push(edge); outgoing.set(edge.from, list);
	}
	const deepest = new Map<string, number>();
	const queue: Array<[string, number]> = [[entry, 0]];
	for (let index = 0; index < queue.length; index++) {
		const [file, depth] = queue[index]!;
		if ((deepest.get(file) ?? -1) >= depth) continue;
		deepest.set(file, depth);
		for (const edge of outgoing.get(file) ?? []) if (edge.target) {
			if (depth >= maxDepth) {
				if (!graph.diagnostics.some((item) => item.code === 'module-depth' && item.file === edge.from && item.range === edge.range)) diagnostic(file, edge.range, 'module-depth', `Maximum source require depth (${maxDepth}) exceeded`);
			} else queue.push([edge.target, depth + 1]);
		}
	}
	return { graph, documents };
}
