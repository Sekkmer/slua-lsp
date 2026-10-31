import path from 'node:path';
import { isRecord, isIdentifier, rangeFromNode, visitAst } from '../parser/ast.js';
import { collectLexicalBindings } from '../typing/lexicalBindings.js';
import { SluaRegistry } from '../slua/registry.js';
import { slua } from '../slua/types.js';

export type PreprocessorContext = { agentId?: string; agentName?: string; timestamp?: string };
export const SOURCE_MACRO_NAMES: ReadonlySet<string> = new Set(['__LINE__', '__FILE__', '__SHORTFILE__', '__AGENTID__', '__AGENTKEY__', '__AGENTNAME__', '__DATE__', '__TIME__', '__TIMESTAMP__', '__UNIXTIME__', '__AGENTIDRAW__']);

export function normalizePreprocessorContext(value: unknown): PreprocessorContext | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Array.isArray(value) || Object.keys(value).some((key) => !['agentId', 'agentName', 'timestamp'].includes(key))) throw new Error('Preprocessor context must contain only agentId, agentName and timestamp');
	const result: PreprocessorContext = {};
	if (value.agentId !== undefined) {
		if (typeof value.agentId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.agentId)) throw new Error('Preprocessor agentId must be a UUID');
		result.agentId = value.agentId.toLowerCase();
	}
	if (value.agentName !== undefined) {
		if (typeof value.agentName !== 'string' || value.agentName.length > 1024 || value.agentName.includes('\0') || Array.from(value.agentName).some((char) => char.length === 1 && /[\ud800-\udfff]/.test(char))) throw new Error('Preprocessor agentName must be a valid string of at most 1024 UTF-16 units');
		result.agentName = value.agentName;
	}
	if (value.timestamp !== undefined) {
		if (typeof value.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.timestamp)) throw new Error('Preprocessor timestamp must be an explicit UTC ISO timestamp');
		const date = new Date(value.timestamp);
		if (!Number.isFinite(date.valueOf()) || date.toISOString().replace('.000Z', 'Z') !== value.timestamp.replace('.000Z', 'Z')) throw new Error('Invalid preprocessor timestamp');
		result.timestamp = date.toISOString();
	}
	return result;
}

/** Luau supports decimal escapes, not JSON's control-character \uXXXX form. */
function quote(text: string): string {
	let result = '"';
	for (const char of text) {
		const value = char.charCodeAt(0);
		result += char === '\\' ? '\\\\' : char === '"' ? '\\"'
			: value < 32 || value >= 127 && value <= 159 ? '\\' + value.toString().padStart(3, '0') : char;
	}
	return result + '"';
}

export function expandSourceMacro(name: string, file: string, line: number, context: PreprocessorContext): string {
	if (name === '__LINE__') return String(line + 1);
	if (name === '__FILE__') return quote(file);
	if (name === '__SHORTFILE__') return quote(path.basename(file));
	if (name === '__AGENTIDRAW__') throw new Error('__AGENTIDRAW__ is not a SLua source macro');
	if (name === '__AGENTNAME__' && context.agentName !== undefined) return quote(context.agentName);
	if ((name === '__AGENTID__' || name === '__AGENTKEY__') && context.agentId !== undefined) return name === '__AGENTKEY__' ? `uuid(${quote(context.agentId)})` : quote(context.agentId);
	if (context.timestamp !== undefined) {
		if (name === '__DATE__') return quote(context.timestamp.slice(0, 10));
		if (name === '__TIME__') return quote(context.timestamp.slice(11, 19));
		if (name === '__TIMESTAMP__') return quote(context.timestamp);
		if (name === '__UNIXTIME__') return String(Math.floor(new Date(context.timestamp).valueOf() / 1000));
	}
	throw new Error(`Explicit preprocessor context is required for ${name}`);
}

/** Constant-pass lexical inspection, shared with generation. No per-use rewalk. */
export function inspectSourceMacroBindings(ast: unknown) {
	const occurrences = collectLexicalBindings(ast);
	const writes = new WeakSet<object>();
	visitAst(ast, (node) => {
		const record = node as unknown as Record<string, unknown>;
		if (record.type === 'AssignmentStatement' && Array.isArray(record.variables)) for (const target of record.variables) if (isIdentifier(target)) writes.add(target);
		if (record.type === 'FunctionDeclaration' && isIdentifier(record.identifier)) writes.add(record.identifier);
	});
	const keys = new Set(occurrences.filter((o) => !o.definition && o.identifier.name === '__AGENTKEY__').map((o) => o.identifier));
	const unsafeAgentKeys = new WeakSet<object>();
	if (keys.size) {
		const globalWrite = occurrences.some((o) => !o.definition && o.identifier.name === 'uuid' && writes.has(o.identifier));
		for (const occurrence of collectLexicalBindings(ast, keys, 'uuid')) {
			if (keys.has(occurrence.identifier) && (globalWrite || occurrence.definition)) unsafeAgentKeys.add(occurrence.identifier);
		}
	}
	return { occurrences, writes, unsafeAgentKeys };
}

/** Request/file-scoped source facts, never runtime declarations or base mutation. */
export function withSourceContext(ast: unknown, file: string, base: SluaRegistry, value?: unknown): SluaRegistry {
	const context = normalizePreprocessorContext(value);
	base = base.sourceContextBase ?? base;
	if (context === undefined) return base;
	const registry = Object.assign(new SluaRegistry(), base, { globalValues: new Map(base.globalValues),
		sourceContextBase: base, sourceMacroUses: new WeakSet<object>(), sourceMacroInvalidUses: new WeakSet<object>(), sourceMacroDiagnostics: [] as SluaRegistry['sourceMacroDiagnostics'] });
	const errors = new Map<string, string>();
	for (const name of SOURCE_MACRO_NAMES) {
		try {
			const expansion = expandSourceMacro(name, file, 0, context);
			registry.globalValues.set(name, { name, type: name === '__LINE__' || name === '__UNIXTIME__' ? slua.number() : name === '__AGENTKEY__' ? slua.uuid() : slua.string(),
				readonly: true, deprecated: false, source: 'override', ...(name === '__LINE__' ? {} : { value: expansion }),
				docs: 'Opt-in source macro, substituted during preprocessing; not a runtime global. __LINE__ uses the original source line.' });
		} catch (error) { errors.set(name, (error as Error).message); }
	}
	const { occurrences, writes, unsafeAgentKeys } = inspectSourceMacroBindings(ast);
	for (const occurrence of occurrences) {
		if (occurrence.kind !== 'usage' || occurrence.definition || !SOURCE_MACRO_NAMES.has(occurrence.identifier.name)) continue;
		const identifier = occurrence.identifier;
		registry.sourceMacroUses.add(identifier);
		const message = writes.has(identifier) ? 'Cannot assign to an enabled source macro' : errors.get(identifier.name)
			?? (unsafeAgentKeys.has(identifier) ? 'Cannot expand __AGENTKEY__ while the uuid constructor is shadowed or reassigned' : undefined);
		if (message) {
			registry.sourceMacroInvalidUses.add(identifier);
			registry.sourceMacroDiagnostics.push({ code: 'preprocessor-context', severity: 'error', range: rangeFromNode(identifier), message });
		}
	}
	return registry;
}
