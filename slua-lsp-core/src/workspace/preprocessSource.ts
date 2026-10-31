import { createHash } from 'node:crypto';
import { isIdentifier, isStringNode, rangeFromNode, type LspPosition, type LspRange } from '../parser/ast.js';
import { getSourceModuleSnapshot, readSourceModuleFile, sourceRequireCalls, sourceModuleRangeContains, type SourceModuleOptions, type SourceModuleGraph, type SourceModuleDiagnostic } from './sourceModules.js';

import { normalizePreprocessorContext, expandSourceMacro, inspectSourceMacroBindings, SOURCE_MACRO_NAMES, type PreprocessorContext } from './sourceContext.js';
export type { PreprocessorContext } from './sourceContext.js';
export type PreprocessedMapping = { generated: LspRange; file: string; original: LspRange; kind: 'copy' | 'replacement' };
export type PreprocessedSource = {
	profile: 'slua-sandbox-cache-v1'; success: boolean; content: string | null; contentSha256: string | null;
	contextSha256: string | null; graph: SourceModuleGraph; diagnostics: SourceModuleDiagnostic[];
	moduleIds: Array<{ file: string; id: number }>; mappings: PreprocessedMapping[];
};
const MAX_OUTPUT = 48 * 1024 * 1024;
const MAX_REPLACEMENTS = 65536;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const compare = (left: LspPosition, right: LspPosition) => left.line - right.line || left.character - right.character;

/** Generate text only. Source/config IO uses one bounded snapshot; user code is never executed. */
export async function preprocessSource(entry: string, options: SourceModuleOptions & { context?: PreprocessorContext } = {}): Promise<PreprocessedSource> {
	const context = normalizePreprocessorContext(options.context);
	const snapshot = await getSourceModuleSnapshot(entry, options);
	options.signal?.throwIfAborted();
	const { graph, documents } = snapshot;
	const result: PreprocessedSource = { profile: 'slua-sandbox-cache-v1', success: false, content: null, contentSha256: null,
		contextSha256: context === undefined ? null : digest(JSON.stringify(context)), graph, diagnostics: [...graph.diagnostics], moduleIds: [], mappings: [] };
	const diagnostic = (file: string, range: LspRange, code: string, message: string) => result.diagnostics.push({ file, range, code, message, severity: 'error' });
	if (result.diagnostics.length) return result;
	const ids = new Map(graph.modules.filter((module) => module.file !== graph.entry).map((module, index) => [module.file, index + 1]));
	result.moduleIds = [...ids].map(([file, id]) => ({ file, id }));
	type Replacement = { range: LspRange; text: string };
	const replacements = new Map<string, Replacement[]>();
	let count = 0;
	for (const [file, document] of documents) {
		options.signal?.throwIfAborted();
		const items: Replacement[] = [];
		const calls = sourceRequireCalls(document.parsed.ast);
		const callees = new WeakSet<object>(calls.flatMap((call) => isIdentifier(call.callee) ? [call.callee] : []));
		const edges = graph.edges.filter((edge) => edge.from === file);
		for (const [index, call] of calls.entries()) {
			const target = edges[index]?.target, id = target === undefined ? undefined : ids.get(target);
			if (id === undefined || !isStringNode(call.arguments[0]) || !call.arguments[0].location) throw new Error('Incomplete source snapshot for generation');
			// Parentheses work for ordinary calls and Luau's string-call shorthand.
			items.push({ range: rangeFromNode(call.arguments[0]), text: `(${id})` });
		}
		const { occurrences, writes, unsafeAgentKeys } = inspectSourceMacroBindings(document.parsed.ast);
		const constantExpansions = new Map<string, string>();
		for (const occurrence of occurrences) {
			if (occurrence.kind !== 'usage' || occurrence.definition) continue;
			const identifier = occurrence.identifier, range = rangeFromNode(identifier);
			if (identifier.name === 'require' && !callees.has(identifier)) diagnostic(file, range, 'preprocessor-require-value', 'Generated SLua supports direct literal require calls; indirect or overwritten global require values are unsupported');
			if (context !== undefined && SOURCE_MACRO_NAMES.has(identifier.name)) {
				try {
					if (writes.has(identifier)) throw new Error('Cannot assign to an enabled source macro');
					let text = constantExpansions.get(identifier.name);
					if (text === undefined) {
						text = expandSourceMacro(identifier.name, file, range.start.line, context);
						if (identifier.name !== '__LINE__') constantExpansions.set(identifier.name, text);
					}
					if (identifier.name === '__AGENTKEY__' && unsafeAgentKeys.has(identifier)) throw new Error('Cannot expand __AGENTKEY__ while the uuid constructor is shadowed or reassigned');
					items.push({ range, text });
				} catch (error) { diagnostic(file, range, 'preprocessor-context', (error as Error).message); }
			}
		}
		items.sort((left, right) => compare(left.range.start, right.range.start));
		count += items.length;
		if (count > MAX_REPLACEMENTS) { diagnostic(file, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, 'preprocessor-limit', `Generation exceeds ${MAX_REPLACEMENTS} replacements`); return result; }
		replacements.set(file, items);
	}
	if (result.diagnostics.length) return result;
	const chunks: string[] = [];
	const generated: LspPosition = { line: 0, character: 0 };
	let bytes = 0;
	let previousCR = false;
	function append(text: string, source?: { file: string; original: LspRange; kind: PreprocessedMapping['kind'] }): void {
		if (!text.length) return;
		bytes += Buffer.byteLength(text);
		if (bytes > MAX_OUTPUT) throw new Error(`Generated source exceeds ${MAX_OUTPUT} bytes`);
		const start = { ...generated };
		for (let index = 0; index < text.length; index++) {
			const char = text.charCodeAt(index);
			if (char === 13 || char === 10 && !previousCR) { generated.line++; generated.character = 0; }
			else if (char !== 10) generated.character++;
			previousCR = char === 13;
		}
		chunks.push(text);
		if (source) result.mappings.push({ ...source, generated: { start, end: { ...generated } } });
	}
	function source(file: string): void {
		const text = documents.get(file)!.text;
		const items = replacements.get(file)!;
		let offset = 0;
		const original: LspPosition = { line: 0, character: 0 };
		function until(position?: LspPosition): number {
			while (offset < text.length && (position === undefined || compare(original, position) < 0)) {
				const char = text.charCodeAt(offset++);
				if (char === 13 || char === 10) {
					if (char === 13 && text.charCodeAt(offset) === 10) offset++;
					original.line++; original.character = 0;
				} else original.character++;
			}
			if (position && compare(original, position) !== 0) throw new Error('Invalid source location while generating SLua');
			return offset;
		}
		for (const item of items) {
			options.signal?.throwIfAborted();
			const copyStart = offset, from = { ...original };
			until(item.range.start);
			append(text.slice(copyStart, offset), { file, original: { start: from, end: { ...original } }, kind: 'copy' });
			until(item.range.end);
			append(item.text, { file, original: item.range, kind: 'replacement' });
		}
		const copyStart = offset, from = { ...original }; until();
		append(text.slice(copyStart), { file, original: { start: from, end: { ...original } }, kind: 'copy' });
	}
	try {
		if (ids.size) {
			append('-- Generated SLua: slua-sandbox-cache-v1\n(function()\n  local modules = {\n');
			for (const file of ids.keys()) {
				append('function()\n'); source(file);
				// Keep a terminal CR inside its source copy, rather than joining it to a synthetic LF.
				append(/[\r\n]$/.test(documents.get(file)!.text) ? 'end,\n' : '\nend,\n');
			}
			append('  }\n  local cache = {}\n  function require(mod)\n    if not cache[mod] then\n      if not modules[mod] then error(`unknown module \'{mod}\'`) end\n      cache[mod] = dangerouslyexecuterequiredmodule(modules[mod])\n    end\n    return cache[mod]\n  end\nend)();\n');
		}
		source(graph.entry);
		result.content = chunks.join(''); result.contentSha256 = digest(result.content); result.success = true;
	} catch (error) {
		options.signal?.throwIfAborted();
		result.mappings = [];
		diagnostic(graph.entry, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, 'preprocessor-limit', (error as Error).message);
	}
	return result;
}

/** Zero-based UTF-16 lookup. Helpers are intentionally unmapped; replacements map to their original expression. */
export function mapPreprocessedPosition(result: Pick<PreprocessedSource, 'mappings' | 'content'>, position: LspPosition): { file: string; position: LspPosition } | null {
	if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
	if (result.content === null) return null;
	let start = 0;
	for (let line = 0; line < position.line; line++) {
		while (start < result.content.length && result.content[start] !== '\r' && result.content[start] !== '\n') start++;
		if (start >= result.content.length) return null;
		if (result.content[start++] === '\r' && result.content[start] === '\n') start++;
	}
	let end = start;
	while (end < result.content.length && result.content[end] !== '\r' && result.content[end] !== '\n') end++;
	if (position.character > end - start) return null;
	let low = 0, high = result.mappings.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (compare(result.mappings[middle]!.generated.start, position) <= 0) low = middle + 1;
		else high = middle;
	}
	const mapping = result.mappings[low - 1];
	if (!mapping || !sourceModuleRangeContains(mapping.generated, position)) return null;
	const delta = position.line - mapping.generated.start.line;
	return { file: mapping.file, position: mapping.kind === 'replacement' ? { ...mapping.original.start }
		: { line: mapping.original.start.line + delta, character: delta === 0 ? mapping.original.start.character + position.character - mapping.generated.start.character : position.character } };
}

export type PreprocessedSourceLocation =
	| { status: 'mapped'; file: string; position: LspPosition; sourceSha256: string }
	| { status: 'unmapped' }
	| { status: 'stale'; file: string; expectedSourceSha256: string; actualSourceSha256: string }
	| { status: 'unavailable'; file: string; message: string };

/** Resolve only when the target text still matches the generated snapshot. No source is written or executed. */
export async function resolvePreprocessedPosition(result: PreprocessedSource, position: LspPosition,
	options: Pick<SourceModuleOptions, 'readFile' | 'signal'> = {}): Promise<PreprocessedSourceLocation> {
	options.signal?.throwIfAborted();
	const mapped = result.success ? mapPreprocessedPosition(result, position) : null;
	if (!mapped) return { status: 'unmapped' };
	const module = result.graph.modules.find((item) => item.file === mapped.file);
	if (!module) return { status: 'unmapped' };
	try {
		const text = await (options.readFile ?? readSourceModuleFile)(mapped.file);
		options.signal?.throwIfAborted();
		if (text === undefined) return { status: 'unavailable', file: mapped.file, message: 'Original source is unavailable' };
		if (Buffer.byteLength(text) > 8388608 || text.includes('\0') || /[\ud800-\udfff]/u.test(text)) {
			return { status: 'unavailable', file: mapped.file, message: 'Original source is oversized, binary or invalid Unicode' };
		}
		const actualSourceSha256 = digest(text);
		if (actualSourceSha256 !== module.sourceSha256) return { status: 'stale', file: mapped.file, expectedSourceSha256: module.sourceSha256, actualSourceSha256 };
		return { status: 'mapped', ...mapped, sourceSha256: actualSourceSha256 };
	} catch (error) {
		options.signal?.throwIfAborted();
		return { status: 'unavailable', file: mapped.file, message: error instanceof Error ? error.message : String(error) };
	}
}
