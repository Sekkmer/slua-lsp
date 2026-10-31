import { sourceFunctionInfo, sourceFunctionMarkdown } from '../slua/sourceFunction.js';
import { functionAttributeCompletions, FUNCTION_ATTRIBUTE_DOCS } from '../parser/functionAttributePresentation.js';
import { conditionalBinding, conditionalBindingType, conditionalGuard } from './conditionalBindings.js';
import { identityTableUpdate, tableWrite, tableAssignments } from './tableWrites.js';
import { inferFunctionSignature, inferAssignmentTypes, inferClassDeclaration, type ClassInfo } from './inferLocals.js';
import { classType, classMember, classMemberSignature, classAnnotationType } from './classMembers.js';
import { conditionRefinements, assertionCondition, joinFlowTypes, blockReturns } from './refinements.js';
import { callbackContext, eventDeclarationContext, arrayIterationContext } from '../slua/callbackContext.js';
import type { SluaRegistry } from '../slua/registry.js';
import { builtinPathExpression, resolveBuiltinExpression } from '../slua/resolveBuiltin.js';
import { visitAst } from '../parser/ast.js';
import type { SluaType } from '../slua/types.js';
import { slua, sluaTypeEquals, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable, sluaTypeToString } from '../slua/types.js';
import { defaultMetatableRegistry, type MetamethodName } from '../slua/metatables.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string; isConst?: boolean };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type LocalStatementNode = AstNode & { type: 'LocalStatement'; variables: unknown[]; init?: unknown[] };

type AssignmentStatementNode = AstNode & { type: 'AssignmentStatement'; variables: unknown[]; init: unknown[] };

type FunctionDeclarationNode = AstNode & {
	type: 'FunctionDeclaration';
	identifier?: unknown;
	isLocal: boolean;
	parameters: unknown[];
	body: unknown[];
	returnTypeAnnotation?: string;
};

type FunctionNode = AstNode & { type: 'Function'; parameters: unknown[]; body: unknown[]; returnTypeAnnotation?: string };

type ReturnStatementNode = AstNode & { type: 'ReturnStatement'; arguments: unknown[] };

type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	/** Luau parser uses '.' or ':' */
	indexer?: '.' | ':';
	/** Legacy/older shape (kept for safety) */
	colonCall?: boolean;
};

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type BinaryExpressionNode = AstNode & { type: 'BinaryExpression'; operator: string; left: unknown; right: unknown };

type TableNode = AstNode & { type: 'Table'; fields?: unknown[] };

type TableFieldNode = AstNode & { type: 'TableField'; key?: unknown; value?: unknown };

type StringNode = AstNode & { type: 'String'; value: string };

type NumberNode = AstNode & { type: 'Number'; value: number };

type BooleanNode = AstNode & { type: 'Boolean'; value: boolean };

type NilNode = AstNode & { type: 'Nil' };

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown;
	thenKeywordLocation?: Loc; alternateKeywordLocation?: Loc };

type ForStatementNode = AstNode & {
	type: 'ForStatement';
	variable: unknown;
	start: unknown;
	end: unknown;
	step?: unknown;
	body: unknown[];
};

type GenericForStatementNode = AstNode & {
	type: 'GenericForStatement';
	variables: unknown[];
	iterators: unknown[];
	body: unknown[];
};

type ScopedBodyStatementNode = AstNode & {
	type: 'DoStatement' | 'RepeatStatement';
	body: unknown[];
};
type ClassDeclarationNode = AstNode & { type: 'ClassDeclaration'; name: unknown; fields: unknown[]; methods: unknown[] };

export type CompletionItemKind =
	| 'keyword'
	| 'variable'
	| 'function'
	| 'parameter'
	| 'property'
	| 'method'
	| 'module'
	| 'type'
	| 'constant'
	| 'event';

export type CompletionItem = {
	label: string;
	kind: CompletionItemKind;
	detail?: string;
	documentation?: string;
	insertText?: string;
	/** When true, `insertText` is a snippet. */
	isSnippet?: boolean;
	priority: number; // Higher = better
	type?: SluaType;
	deprecated?: boolean;
	requiresColonCall?: boolean;
};

export type CompletionTriggerContext = {
	/** Full document text (used for trigger heuristics on incomplete code). */
	sourceText?: string;
	/** LSP trigger character, if any (e.g. '.', ':'). */
	triggerCharacter?: string;
	/** True when completion was explicitly invoked (Ctrl+Space). */
	invoked?: boolean;
};

const LUA_RESERVED_WORDS = new Set([
	'and',
	'break',
	'do',
	'else',
	'elseif',
	'end',
	'false',
	'for',
	'function',
	'goto',
	'if',
	'in',
	'local',
	'nil',
	'not',
	'or',
	'repeat',
	'return',
	'then',
	'true',
	'until',
	'while'
]);

function toSnakeCase(name: string): string {
	// Normalize separators first.
	let out = name.trim().replace(/[^A-Za-z0-9]+/g, '_');
	// Handle camel/PascalCase and acronym boundaries.
	out = out
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, '$1_$2');
	out = out.toLowerCase();
	// Collapse duplicates.
	out = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
	return out;
}

function safeLuaIdentifier(name: string, fallback: string): string {
	let out = toSnakeCase(name);
	if (!out) out = fallback;
	// Lua identifiers: [A-Za-z_][A-Za-z0-9_]*
	out = out.replace(/[^a-z0-9_]/g, '_');
	if (!/^[a-z_]/.test(out)) out = `_${out}`;
	if (LUA_RESERVED_WORDS.has(out)) out = `${out}_`;
	return out;
}

function isValidSluaEventName(eventName: string, registry: SluaRegistry): boolean {
	return Boolean(registry.eventSignatures[eventName]);
}

function getCallTarget(call: CallExpressionNode): { receiver: string; method: string; indexer?: '.' | ':' } | null {
	if (!isMemberExpression(call.callee)) return null;
	const { object, property } = call.callee;
	if (!isIdentifier(object) || !isIdentifier(property)) return null;
	return { receiver: object.name, method: property.name, indexer: call.callee.indexer };
}

function findInnermostCallAtPosition(program: ProgramNode, pos: { line: number; character: number }): CallExpressionNode | null {
	let best: CallExpressionNode | null = null;
	function visit(value: unknown): void {
		if (!isAstNode(value) || !value.location) return;
		if (!posInLoc(pos, value.location)) return;
		if (isCallExpression(value)) {
			if (!best) best = value;
			else {
				const cur = best.location;
				const next = value.location;
				if (cur && next) {
					const curSpan = (cur.end.line - cur.start.line) * 10_000 + (cur.end.column - cur.start.column);
					const nextSpan = (next.end.line - next.start.line) * 10_000 + (next.end.column - next.start.column);
					if (nextSpan <= curSpan) best = value;
				}
			}
		}
		for (const child of Object.values(value as Record<string, unknown>)) {
			if (child === (value as Record<string, unknown>).location) continue;
			if (Array.isArray(child)) for (const item of child) visit(item);
			else if (isRecord(child)) visit(child);
		}
	}
	for (const stmt of program.body) visit(stmt);
	return best;
}

function buildLLEventsCallbackSnippet(eventName: string, registry: SluaRegistry): string {
	const sig = registry.eventSignatures[eventName];
	const params = sig?.params ?? [];
	const rendered = params
		.map((p, i) => {
			const safe = safeLuaIdentifier(p.name, `arg${i + 1}`);
			return `${safe}: ${formatTypeString(p.type)}`;
		})
		.join(', ');
	return `function(${rendered})\n\t$0\nend`;
}

function tryGetLLEventsCallbackSnippetFromText(
	sourceText: string,
	pos: { line: number; character: number },
	registry: SluaRegistry,
	triggerChar: string | null,
	invoked: boolean
): CompletionItem[] | null {
	if (!invoked && triggerChar !== ',') return null;
	const prefix = getLineText(sourceText, pos.line).slice(0, pos.character);
	// Example being typed: LLEvents:on("listen", 
	const m = prefix.match(/\bLLEvents\s*:\s*(on|once)\s*\(\s*(['"])([^'"\\]*)\2\s*,\s*$/);
	if (!m) return null;
	const eventName = m[3] ?? '';
	if (!isValidSluaEventName(eventName, registry)) return null;
	return [
		{
			label: `handler (${eventName})`,
			kind: 'function',
			detail: 'function',
			documentation: registry.eventSignatures[eventName]?.tooltip,
			insertText: buildLLEventsCallbackSnippet(eventName, registry),
			isSnippet: true,
			priority: 210
		}
	];
}

function getLLEventsArgumentCompletions(
	program: ProgramNode,
	pos: { line: number; character: number },
	registry: SluaRegistry,
	triggerChar: string | null,
	invoked: boolean
): CompletionItem[] | null {
	const call = findInnermostCallAtPosition(program, pos);
	if (!call) return null;
	const target = getCallTarget(call);
	if (!target) return null;
	if (target.receiver !== 'LLEvents') return null;
	if (target.method !== 'on' && target.method !== 'once' && target.method !== 'off') return null;

	const args = call.arguments;
	const first = args[0];
	const second = args[1];

	// 1) Event name completion (first arg) — only when cursor is in the string literal.
	if (first && isStringNode(first) && first.location && posInLoc(pos, first.location)) {
		// Only trigger automatically on quote, or when explicitly invoked.
		if (!invoked && triggerChar !== '"' && triggerChar !== '\'') return null;
		const items: CompletionItem[] = [];
		for (const eventName of Object.keys(registry.eventSignatures)) {
			if (!isValidSluaEventName(eventName, registry)) continue;
			const eventSig = registry.eventSignatures[eventName];
			items.push({
				label: eventName,
				kind: 'event',
				detail: 'event',
				documentation: eventSig?.tooltip,
				insertText: eventName,
				priority: 200
			});
		}
		items.sort((a, b) => b.priority - a.priority);
		return items;
	}

	// 2) Callback skeleton completion (second arg).
	// Trigger on comma (typical after finishing the event string) or explicit invocation.
	if ((invoked || triggerChar === ',') && first && isStringNode(first)) {
		const eventName = first.value;
		if (!isValidSluaEventName(eventName, registry)) return null;
		// Only offer if second arg is missing, or cursor is inside it.
		const inSecond = second && isAstNode(second) && second.location ? posInLoc(pos, second.location) : false;
		if (second && !inSecond) return null;
		const snippet = buildLLEventsCallbackSnippet(eventName, registry);
		return [
			{
				label: `handler (${eventName})`,
				kind: 'function',
				detail: 'function',
				documentation: registry.eventSignatures[eventName]?.tooltip,
				insertText: snippet,
				isSnippet: true,
				priority: 210
			}
		];
	}

	return null;
}

function getLineText(sourceText: string, line: number): string {
	const lines = sourceText.split(/\r\n|\r|\n/);
	return lines[line] ?? '';
}

function prevNonWhitespaceChar(sourceText: string, pos: { line: number; character: number }): string | null {
	const lineText = getLineText(sourceText, pos.line);
	let i = Math.min(pos.character - 1, lineText.length - 1);
	for (; i >= 0; i--) {
		const ch = lineText[i]!;
		if (!/\s/.test(ch)) return ch;
	}
	return null;
}

function posToOffset(sourceText: string, pos: { line: number; character: number }): number {
	let offset = 0;
	let line = 0;
	for (let i = 0; i < sourceText.length && line < pos.line; i++) {
		const ch = sourceText[i]!;
		offset++;
		if (ch === '\n') line++;
	}
	return Math.min(sourceText.length, offset + pos.character);
}

function findPrevUnescapedChar(sourceText: string, fromExclusive: number, ch: string): number {
	for (let i = Math.min(fromExclusive - 1, sourceText.length - 1); i >= 0; i--) {
		if (sourceText[i] !== ch) continue;
		if (i > 0 && sourceText[i - 1] === '\\') continue;
		return i;
	}
	return -1;
}

function findNextUnescapedChar(sourceText: string, fromInclusive: number, ch: string): number {
	for (let i = Math.max(0, fromInclusive); i < sourceText.length; i++) {
		if (sourceText[i] !== ch) continue;
		if (i > 0 && sourceText[i - 1] === '\\') continue;
		return i;
	}
	return -1;
}

/**
 * Best-effort detection for being inside a backtick template string interpolation:
 *   `hello {expr}`
 * Returns the interpolation expression range (exclusive of braces) if the cursor is inside it.
 */
function getTemplateInterpolationRange(
	sourceText: string,
	pos: { line: number; character: number }
): { exprStart: number; exprEnd: number } | null {
	const cursor = posToOffset(sourceText, pos);
	const tickStart = findPrevUnescapedChar(sourceText, cursor, '`');
	if (tickStart < 0) return null;
	const tickEnd = findNextUnescapedChar(sourceText, tickStart + 1, '`');
	if (tickEnd < 0) return null;
	if (cursor <= tickStart || cursor >= tickEnd) return null;

	let depth = 0;
	let currentExprStart = -1;
	for (let i = tickStart + 1; i < cursor; i++) {
		const c = sourceText[i]!;
		if (c === '{' && sourceText[i - 1] !== '\\') {
			depth++;
			if (depth === 1) currentExprStart = i + 1;
			continue;
		}
		if (c === '}' && sourceText[i - 1] !== '\\') {
			if (depth > 0) depth--;
			if (depth === 0) currentExprStart = -1;
			continue;
		}
	}
	if (depth <= 0 || currentExprStart < 0) return null;

	// Find the matching closing brace for the currently open interpolation.
	let scanDepth = depth;
	for (let i = cursor; i < tickEnd; i++) {
		const c = sourceText[i]!;
		if (c === '{' && sourceText[i - 1] !== '\\') scanDepth++;
		else if (c === '}' && sourceText[i - 1] !== '\\') {
			scanDepth--;
			if (scanDepth === 0) return { exprStart: currentExprStart, exprEnd: i };
		}
	}

	return null;
}

function extractIdentifierBeforeTrigger(
	sourceText: string,
	pos: { line: number; character: number },
	trigger: '.' | ':'
): string | null {
	const lineText = getLineText(sourceText, pos.line);
	// Start just before cursor and skip whitespace.
	let i = Math.min(pos.character - 1, lineText.length - 1);
	for (; i >= 0 && /\s/.test(lineText[i]!); i--) {
		// skip
	}
	if (i < 0) return null;

	// If cursor is after the trigger (e.g. `ll.|` or `ll:|`), the trigger is at i.
	if (lineText[i] !== trigger) {
		// If cursor is after some whitespace, the trigger might be earlier.
		while (i >= 0 && /\s/.test(lineText[i]!)) i--;
		if (i < 0 || lineText[i] !== trigger) return null;
	}

	// Move left from trigger, skipping whitespace.
	i--;
	for (; i >= 0 && /\s/.test(lineText[i]!); i--) {
		// skip
	}
	if (i < 0) return null;

	const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/.exec(lineText.slice(0, i + 1));
	return match?.[1]?.replace(/\s/g, '') ?? null;
}

function isTypeAnnotationTrigger(sourceText: string, pos: { line: number; character: number }): boolean {
	const lineText = getLineText(sourceText, pos.line);
	const prefix = lineText.slice(0, Math.min(pos.character, lineText.length));
	// We only trigger type completion when the cursor is after ':' (optionally with whitespace) in declarations.
	// Heuristics:
	// - local x:|
	// - local x : |
	// - function f(x:|, y:|)
	// - function f(x : |)
	// - ) : |  (return type annotation)
	const localDecl = /\blocal\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(prefix);
	const paramDecl = /[,(]\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(prefix) && /\bfunction\b/.test(prefix);
	const returnDecl = /\)\s*:\s*$/.test(prefix) && /\bfunction\b/.test(prefix);
	return localDecl || paramDecl || returnDecl;
}

function isInTypeAnnotationContext(sourceText: string, pos: { line: number; character: number }): boolean {
	const lineText = getLineText(sourceText, pos.line);
	const prefix = lineText.slice(0, Math.min(pos.character, lineText.length));

	// This is intentionally heuristic: we want type completions while editing an existing type,
	// e.g. `local x: vector | `, not just immediately after ':'.
	// We only consider "declaration-like" contexts to avoid leaking type snippets into normal code.
	const localDecl = /\blocal\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^=]*$/.test(prefix);
	const paramDecl = /\bfunction\b.*[,(]\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^),]*$/.test(prefix);
	const returnDecl = /\bfunction\b.*\)\s*:\s*[^\n]*$/.test(prefix);
	return localDecl || paramDecl || returnDecl;
}

function identifierPrefixAt(sourceText: string, pos: { line: number; character: number }): string {
	const lineText = getLineText(sourceText, pos.line);
	let i = Math.min(pos.character - 1, lineText.length - 1);
	let start = i;
	for (; i >= 0; i--) {
		const ch = lineText[i]!;
		if (!/[A-Za-z0-9_]/.test(ch)) break;
		start = i;
	}
	return start <= (pos.character - 1) ? lineText.slice(start, Math.min(pos.character, lineText.length)) : '';
}

type SymbolDefinition = {
	name: string;
	identifier: IdentifierNode;
	kind: 'local' | 'parameter' | 'function' | 'class';
	type: SluaType;
	scopeId: number;
	writes: number;
	initializer?: unknown;
};

class ScopeEnv {
	private scopes: Array<Map<string, SymbolDefinition>> = [new Map()];
	private readonly classes = new Map<string, ClassInfo>();
	private scopeCounter = 0;

	pushScope(): number {
		const scopeId = ++this.scopeCounter;
		this.scopes.push(new Map());
		return scopeId;
	}

	popScope(): void {
		if (this.scopes.length > 1) this.scopes.pop();
	}

	define(name: string, identifier: IdentifierNode, kind: 'local' | 'parameter' | 'function' | 'class', type: SluaType, initializer?: unknown): void {
		const scopeId = this.scopeCounter;
		this.scopes[this.scopes.length - 1]!.set(name, { name, identifier, kind, type, scopeId, initializer, writes: 0 });
	}

	refine(expression: unknown, truth: boolean): void {
		for (const [name, type] of conditionRefinements(expression, truth, (name) => this.find(name)?.type)) {
			for (let i = this.scopes.length - 1; i >= 0; i--) {
				const definition = this.scopes[i]!.get(name);
				if (definition) { this.scopes[i]!.set(name, { ...definition, type }); break; }
			}
		}
	}

	assign(name: string, type: SluaType): void {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const definition = this.scopes[i]!.get(name);
			if (definition) { this.scopes[i]!.set(name, { ...definition, type, writes: definition.writes + 1 }); return; }
		}
	}

	writeTable(target: unknown, value: SluaType, registry: SluaRegistry): void {
		this.rewriteTables(tableWrite(target, value, registry, (name) => this.find(name)?.type));
	}

	rewriteTables(update: (type: SluaType) => SluaType): void {
		if (update === identityTableUpdate) return;
		for (const scope of this.scopes) for (const [name, binding] of scope) {
			const type = update(binding.type);
			if (type !== binding.type) scope.set(name, { ...binding, type, writes: binding.writes + 1 });
		}
	}

	checkpoint(): ScopeEnv['scopes'] {
		return this.scopes.map((scope) => new Map([...scope].map(([name, def]) => [name, { ...def }])));
	}

	restore(other: ScopeEnv['scopes']): void {
		this.scopes = other.map((scope) => new Map([...scope].map(([name, def]) => [name, { ...def }])));
	}

	join(base: ScopeEnv['scopes'], a: ScopeEnv['scopes'], b: ScopeEnv['scopes']): void {
		this.restore(base);
		for (const [i, scope] of base.entries()) for (const [name, binding] of scope) {
			const left = a[i]?.get(name) ?? binding;
			const right = b[i]?.get(name) ?? binding;
			if (left.writes === binding.writes && right.writes === binding.writes) continue;
			this.scopes[i]!.set(name, { ...binding, type: joinFlowTypes(left.type, right.type), writes: Math.max(left.writes, right.writes) });
		}
	}

	defineClass(info: ClassInfo, identifier: IdentifierNode): void {
		this.classes.set(info.name, info);
		this.define(info.name, identifier, 'class', info.constructorType);
	}

	getClass(name: string): ClassInfo | undefined {
		return this.classes.get(name);
	}

	getClasses(): Iterable<ClassInfo> { return this.classes.values(); }

	find(name: string): SymbolDefinition | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const def = this.scopes[i]!.get(name);
			if (def) return def;
		}
		return undefined;
	}

	getAllInScope(): SymbolDefinition[] {
		return this.getAllInScopeWithDistance().map((x) => x.def);
	}

	getAllInScopeWithDistance(): Array<{ def: SymbolDefinition; distance: number }> {
		const result: Array<{ def: SymbolDefinition; distance: number }> = [];
		const seen = new Set<string>();
		const innermost = this.scopes.length - 1;
		for (let i = innermost; i >= 0; i--) {
			const distance = innermost - i; // 0 = innermost, increasing outward
			for (const [name, def] of this.scopes[i]!.entries()) {
				if (seen.has(name)) continue;
				seen.add(name);
				result.push({ def, distance });
			}
		}
		return result;
	}
}

// Type guards
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof value.type === 'string';
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

function isProgram(value: unknown): value is ProgramNode {
	return isAstNode(value) && value.type === 'Program' && Array.isArray((value as Record<string, unknown>).body);
}

function isLocalStatement(value: unknown): value is LocalStatementNode {
	return isAstNode(value) && value.type === 'LocalStatement' && Array.isArray((value as Record<string, unknown>).variables);
}

function isAssignmentStatement(value: unknown): value is AssignmentStatementNode {
	return isAstNode(value) && value.type === 'AssignmentStatement' && Array.isArray((value as Record<string, unknown>).variables);
}

function isFunctionDeclaration(value: unknown): value is FunctionDeclarationNode {
	return isAstNode(value) && value.type === 'FunctionDeclaration' && Array.isArray((value as Record<string, unknown>).parameters);
}

function isFunctionNode(value: unknown): value is FunctionNode {
	return isAstNode(value) && value.type === 'Function' && Array.isArray((value as Record<string, unknown>).parameters);
}

function isReturnStatement(value: unknown): value is ReturnStatementNode {
	return isAstNode(value) && value.type === 'ReturnStatement' && Array.isArray((value as Record<string, unknown>).arguments);
}


function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression';
}


function isCallExpression(value: unknown): value is CallExpressionNode {
	return isAstNode(value) && value.type === 'CallExpression';
}

function isBinaryExpression(value: unknown): value is BinaryExpressionNode {
	return isAstNode(value) && value.type === 'BinaryExpression' && typeof (value as Record<string, unknown>).operator === 'string';
}

function isTableNode(value: unknown): value is TableNode {
	return isAstNode(value) && value.type === 'Table';
}

function isTableFieldNode(value: unknown): value is TableFieldNode {
	return isAstNode(value) && value.type === 'TableField';
}

function isStringNode(value: unknown): value is StringNode {
	return isAstNode(value) && value.type === 'String' && typeof (value as Record<string, unknown>).value === 'string';
}

function isNumberNode(value: unknown): value is NumberNode {
	return isAstNode(value) && value.type === 'Number' && typeof (value as Record<string, unknown>).value === 'number';
}

function isBooleanNode(value: unknown): value is BooleanNode {
	return isAstNode(value) && value.type === 'Boolean';
}

function isNilNode(value: unknown): value is NilNode {
	return isAstNode(value) && value.type === 'Nil';
}

function isIfStatement(value: unknown): value is IfStatementNode {
	return isAstNode(value) && value.type === 'IfStatement' && Array.isArray((value as Record<string, unknown>).consequent);
}

function isForStatement(value: unknown): value is ForStatementNode {
	return isAstNode(value) && value.type === 'ForStatement' && Array.isArray((value as Record<string, unknown>).body);
}

function isGenericForStatement(value: unknown): value is GenericForStatementNode {
	return isAstNode(value) && value.type === 'GenericForStatement' && Array.isArray((value as Record<string, unknown>).variables) && Array.isArray((value as Record<string, unknown>).iterators) && Array.isArray((value as Record<string, unknown>).body);
}

function isScopedBodyStatement(value: unknown): value is ScopedBodyStatementNode {
	return isAstNode(value) && (value.type === 'DoStatement' || value.type === 'RepeatStatement') && Array.isArray((value as Record<string, unknown>).body);
}

function isClassDeclaration(value: unknown): value is ClassDeclarationNode {
	return isAstNode(value) && value.type === 'ClassDeclaration' && Array.isArray((value as Record<string, unknown>).fields) && Array.isArray((value as Record<string, unknown>).methods);
}

/**
 * Check if a position is within a location range.
 */
function posInLoc(pos: { line: number; character: number }, loc: Loc): boolean {
	// LSP uses 0-based line/character, parser uses 1-based line/column
	const pLine = pos.line + 1;
	const pCol = pos.character + 1;

	if (pLine < loc.start.line || pLine > loc.end.line) return false;
	if (pLine === loc.start.line && pCol < loc.start.column) return false;
	if (pLine === loc.end.line && pCol > loc.end.column) return false;
	return true;
}

/**
 * Calculate priority based on type match and naming conventions.
 */
function calculatePriority(item: Omit<CompletionItem, 'priority'>, expectedType?: SluaType): number {
	let priority = 50; // Base priority

	// Expected-type ranking
	if (expectedType && item.type) {
		// Exact match
		if (sluaTypeEquals(item.type, expectedType)) {
			priority += 100;
		} else if (sluaTypeIsAssignable(expectedType, item.type)) {
			priority += 80;
		} else if (item.type.kind === 'function') {
			// If a function returns the expected type, still consider it a strong match.
			if (sluaTypeEquals(item.type.returns, expectedType) || sluaTypeIsAssignable(expectedType, item.type.returns)) {
				priority += 70;
			} else if (expectedType.kind === 'function') {
				// In a function-typed position, any function is a decent candidate.
				priority += 35;
			}
		}
	}

	// Deprioritize items starting with underscore
	if (item.label.startsWith('_')) {
		priority -= 30;
	}

	// Boost based on kind
	switch (item.kind) {
		case 'function':
		case 'method':
			priority += 10;
			break;
		case 'variable':
		case 'parameter':
			priority += 5;
			break;
		case 'property':
			priority += 8;
			break;
		case 'constant':
			priority += 7;
			break;
	}

	// Deprecate deprecated items
	if (item.deprecated) {
		priority -= 20;
	}

	return priority;
}

function defineConditional(node: unknown, env: ScopeEnv, registry: SluaRegistry): IdentifierNode | undefined {
	const binding = conditionalBinding(node);
	if (!binding) return undefined;
	const test = (node as Record<string, unknown>).test;
	const inferred = inferAssignmentTypes([test], 1, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses())[0] ?? slua.unknown();
	env.define(binding.name, binding, 'local', conditionalBindingType(binding, inferred), test);
	return binding;
}

/**
 * Infer the expected type at a given position based on context.
 */
function inferExpressionType(expr: unknown, env: ScopeEnv, registry: SluaRegistry): SluaType | undefined {
	const known = resolveBuiltinExpression(expr, registry, (name) => env.find(name)?.type ?? (env.find(name) ? slua.unknown() : undefined));
	if (known) return known.type;
	if (!isAstNode(expr)) return undefined;

	if (expr.type === 'IfExpression') {
		const conditional = expr as AstNode & { test: unknown; consequent: unknown; alternate: unknown };
		const before = env.checkpoint();
		env.refine(conditionalGuard(conditional), true);
		env.pushScope();
		defineConditional(conditional, env, registry);
		const a = inferExpressionType(conditional.consequent, env, registry) ?? slua.unknown();
		env.restore(before);
		env.refine(conditionalGuard(conditional), false);
		const b = inferExpressionType(conditional.alternate, env, registry) ?? slua.unknown();
		env.restore(before);
		return joinFlowTypes(a, b);
	}

	if (isFunctionNode(expr)) return inferFunctionSignature(expr, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses());
	if (isStringNode(expr)) return slua.string();
	if (isNumberNode(expr)) return slua.number();
	if (isBooleanNode(expr)) return slua.boolean();
	if (isNilNode(expr)) return slua.nil();
	if (isTableNode(expr)) return slua.table();

	if (isIdentifier(expr)) {
		const def = env.find(expr.name);
		if (def) return def.type;

		const global = registry.getGlobal(expr.name);
		if (global) return global.signature;
		const constant = registry.getGlobalValue(expr.name);
		if (constant) return constant.type;

		const module = registry.getModule(expr.name);
		if (module) return slua.table();

		const objType = registry.getObjectType(expr.name);
		if (objType && !objType.instanceOnly) return slua.table();
	}

	if (isMemberExpression(expr)) {
		if (!isIdentifier(expr.object) || !isIdentifier(expr.property)) return undefined;
		const receiverName = expr.object.name;

		// Module member access
		const mod = registry.getModule(receiverName);
		if (mod) {
			const memberName = expr.property.name;
			const fn = mod.functions[memberName];
			if (fn) return fn.signature;
			const val = mod.values[memberName];
			if (val) return val.type;
		}

		// Object type method access
		const objType = registry.getObjectType(receiverName);
		if (objType) {
			const memberName = expr.property.name;
			const method = objType.methods[memberName];
			if (method) return method.signature;
			const prop = objType.properties[memberName];
			if (prop) return prop.type;
		}

	}

	if (isCallExpression(expr)) {
		const calleeType = inferExpressionType(expr.callee, env, registry);
		if (calleeType?.kind === 'function') return calleeType.returns;
	}

	return undefined;
}


function getFunctionTypeForCallee(
	expr: unknown,
	env: ScopeEnv,
	registry: SluaRegistry
): Extract<SluaType, { kind: 'function' }> | undefined {
	const t = inferExpressionType(expr, env, registry);
	return t?.kind === 'function' ? (t as Extract<SluaType, { kind: 'function' }>) : undefined;
}

function spanOfLoc(loc: Loc): number {
	return (loc.end.line - loc.start.line) * 10_000 + (loc.end.column - loc.start.column);
}

function inferCustomMemberExpectedType(receiverType: SluaType, memberName: string): SluaType | undefined {
	if (receiverType.kind !== 'custom') return undefined;
	if ((receiverType.name === 'vector' || receiverType.name === 'rotation') && (memberName === 'x' || memberName === 'y' || memberName === 'z')) {
		return slua.number();
	}
	return undefined;
}

function inferLValueType(lvalue: unknown, env: ScopeEnv, registry: SluaRegistry): SluaType | undefined {
	if (!isAstNode(lvalue)) return undefined;
	if (isIdentifier(lvalue)) return env.find(lvalue.name)?.type;

	if (isMemberExpression(lvalue)) {
		// Try custom instance members (vector/rotation x/y/z)
		if (isIdentifier(lvalue.object) && isIdentifier(lvalue.property)) {
			const recv = env.find(lvalue.object.name)?.type;
			if (recv) {
				const custom = inferCustomMemberExpectedType(recv, lvalue.property.name);
				if (custom) return custom;
			}
			// Object type modeled in registry
			const objType = registry.getObjectType(lvalue.object.name);
			if (objType) {
				const prop = objType.properties[lvalue.property.name];
				if (prop) return prop.type;
			}
		}
	}

	return undefined;
}

function inferExpectedTypeAtPosition(
	ast: ProgramNode,
	pos: { line: number; character: number },
	env: ScopeEnv,
	registry: SluaRegistry
): SluaType | undefined {
	const best: { current: { expected: SluaType; span: number } | null } = { current: null };
	const fnReturnStack: SluaType[] = [];

	function consider(loc: Loc | undefined, expected: SluaType | undefined): void {
		if (!loc || !expected) return;
		if (expected.kind === 'primitive' && expected.name === 'unknown') return;
		const span = spanOfLoc(loc);
		const cur = best.current;
		if (!cur || span < cur.span) best.current = { expected, span };
	}

	function expectedFromBinary(op: string, other: unknown | null): SluaType | undefined {
		if (op === '..') return slua.string();
		if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%' || op === '^') return slua.number();
		if (op === '==' || op === '~=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
			if (other) return inferExpressionType(other, env, registry);
		}
		return undefined;
	}

	function visit(value: unknown): void {
		if (!isAstNode(value) || !value.location) return;
		if (!posInLoc(pos, value.location)) return;

		// Track function return types for return-statement contexts.
		if (isFunctionDeclaration(value) || isFunctionNode(value)) {
			const rt = value.returnTypeAnnotation ? sluaTypeFromLuauAnnotationText(value.returnTypeAnnotation) : slua.unknown();
			fnReturnStack.push(rt);
			for (const stmt of value.body) visit(stmt);
			fnReturnStack.pop();
			return;
		}

		// local x: T = <expr>
		if (isLocalStatement(value)) {
			const vars = value.variables;
			const init = value.init ?? [];
			for (let i = 0; i < init.length; i++) {
				const rhs = init[i];
				if (!isAstNode(rhs) || !rhs.location) continue;
				if (!posInLoc(pos, rhs.location)) continue;
				const lhs = vars[i];
				if (isIdentifier(lhs)) {
					const t = lhs.typeAnnotation ? sluaTypeFromLuauAnnotationText(lhs.typeAnnotation) : env.find(lhs.name)?.type;
					consider(rhs.location, t);
				}
			}
		}

		// x = <expr>
		if (isAssignmentStatement(value)) {
			const vars = value.variables;
			const init = value.init;
			for (let i = 0; i < init.length; i++) {
				const rhs = init[i];
				if (!isAstNode(rhs) || !rhs.location) continue;
				if (!posInLoc(pos, rhs.location)) continue;
				const lhs = vars[i];
				consider(rhs.location, inferLValueType(lhs, env, registry));
			}
		}

		// return <expr>
		if (isReturnStatement(value)) {
			const expected = fnReturnStack.length > 0 ? fnReturnStack[fnReturnStack.length - 1] : undefined;
			for (const arg of value.arguments) {
				if (!isAstNode(arg) || !arg.location) continue;
				if (!posInLoc(pos, arg.location)) continue;
				consider(arg.location, expected);
			}
		}

		// f(arg1, arg2, ...)
		if (isCallExpression(value)) {
			const fnType = getFunctionTypeForCallee(value.callee, env, registry);
			for (let i = 0; i < value.arguments.length; i++) {
				const arg = value.arguments[i];
				if (!isAstNode(arg) || !arg.location) continue;
				if (!posInLoc(pos, arg.location)) continue;
				const expected = fnType?.params[i];
				consider(arg.location, expected);
			}
		}

		// <expr> + <expr>, comparisons, concat
		if (isBinaryExpression(value)) {
			if (isAstNode(value.left) && value.left.location && posInLoc(pos, value.left.location)) {
				consider(value.left.location, expectedFromBinary(value.operator, value.right));
			}
			if (isAstNode(value.right) && value.right.location && posInLoc(pos, value.right.location)) {
				consider(value.right.location, expectedFromBinary(value.operator, value.left));
			}
		}

		// Table literal fields (best-effort). Today we don't model structural table types, but this still
		// lets us drill into field values for future/expanded type models.
		if (isTableNode(value) && Array.isArray(value.fields)) {
			for (const f of value.fields) {
				if (!isTableFieldNode(f)) continue;
				if (!f.value || !isAstNode(f.value) || !f.value.location) continue;
				if (!posInLoc(pos, f.value.location)) continue;
				// No strong expected type available for plain tables.
				consider(f.value.location, undefined);
			}
		}

		// Recurse into children for more-specific expected-type hits.
		for (const child of Object.values(value)) {
			if (Array.isArray(child)) {
				for (const item of child) visit(item);
			} else if (isRecord(child)) {
				visit(child);
			}
		}
	}

	visit(ast);
	const out = best.current;
	return out ? out.expected : undefined;
}


/**
 * Get completions for member access (. or :).
 */
function getMemberCompletionsByName(
	receiverName: string,
	isColonCall: boolean,
	env: ScopeEnv,
	registry: SluaRegistry,
	inferredReceiver?: SluaType
): CompletionItem[] {
	const items: CompletionItem[] = [];

	// Check if it's a module
	const bound = inferredReceiver ?? resolveBuiltinExpression(builtinPathExpression(receiverName), registry, (name) => env.find(name)?.type ?? (env.find(name) ? slua.unknown() : undefined))?.type;
	const sourceClass = bound && classType(bound);
	if (bound && sourceClass) {
		const names = sourceClass.kind === 'constructor' ? [...sourceClass.info.staticMethods] : [...sourceClass.info.fields.keys(), ...sourceClass.info.methods.keys()];
		for (const name of names) {
			const member = classMember(bound, name)!;
			if (isColonCall && member.type?.kind !== 'function') continue;
			const type = classMemberSignature(member, isColonCall);
			const item: Omit<CompletionItem, 'priority'> = { label: name, kind: type.kind === 'function' ? isColonCall ? 'method' : 'function' : 'property',
				detail: formatTypeString(type), type, ...(isColonCall ? { requiresColonCall: true } : {}) };
			items.push({ ...item, priority: calculatePriority(item) + 20 });
		}
		return items;
	}
	const mod = bound?.kind === 'table' && bound.module ? registry.getModule(bound.module) : undefined;
	if (bound?.kind === 'table' && bound.fields) {
		return Object.entries(bound.fields).map(([name, type]) => {
			const item: Omit<CompletionItem, 'priority'> = { label: name, kind: type.kind === 'function' ? 'function' : 'property',
				detail: formatTypeString(type), type, deprecated: !!sourceFunctionInfo(type)?.deprecated, documentation: sourceFunctionMarkdown(type).trim() || undefined };
			return { ...item, priority: calculatePriority(item) };
		});
	}
	if (mod) {
		// Add module functions
		for (const [name, fn] of Object.entries(mod.functions)) {
			if (fn.private) continue;
			const item: Omit<CompletionItem, 'priority'> = {
				label: name,
				kind: 'function',
				detail: formatFunctionSignature(fn.signature),
				documentation: fn.docs,
				type: fn.signature,
				deprecated: fn.deprecated
			};
			items.push({ ...item, priority: calculatePriority(item) });
		}

		// Add module values (constants)
		for (const [name, val] of Object.entries(mod.values)) {
			if (val.private) continue;
			const item: Omit<CompletionItem, 'priority'> = {
				label: name,
				kind: 'constant',
				detail: formatTypeString(val.type),
				documentation: val.docs,
				type: val.type,
				deprecated: val.deprecated
			};
			items.push({ ...item, priority: calculatePriority(item) });
		}

		return items;
	}

	// Check if it's an object type
	const objType = bound?.kind === 'table' && bound.metatable ? registry.getObjectType(bound.metatable) : bound?.kind === 'custom' ? registry.getObjectType(bound.name) : undefined;
	if (objType) {
		// Add methods
		for (const [name, method] of Object.entries(objType.methods)) {
			// Filter based on call style
			if (isColonCall && !method.requiresColonCall) continue;
			if (!isColonCall && method.requiresColonCall) continue;

			const item: Omit<CompletionItem, 'priority'> = {
				label: name,
				kind: 'method',
				detail: formatFunctionSignature(method.signature),
				documentation: method.docs,
				type: method.signature,
				requiresColonCall: method.requiresColonCall
			};
			items.push({ ...item, priority: calculatePriority(item) });
		}

		// Add properties (dot access only)
		if (!isColonCall) {
			for (const [name, prop] of Object.entries(objType.properties)) {
				const item: Omit<CompletionItem, 'priority'> = {
					label: name,
					kind: 'property',
					detail: formatTypeString(prop.type),
					documentation: prop.docs,
					type: prop.type,
					deprecated: prop.deprecated
				};
				items.push({ ...item, priority: calculatePriority(item) });
			}
		}

		return items;
	}

	// Check for local variable with known type
	const localDef = env.find(receiverName);
	const localType = inferredReceiver ?? localDef?.type;
	if (localType) {
		if (!isColonCall && isTableNode(localDef?.initializer)) {
			for (const field of localDef.initializer.fields ?? []) {
				if (!isTableFieldNode(field)) continue;
				const name = isIdentifier(field.key) ? field.key.name : isStringNode(field.key) ? field.key.value : undefined;
				if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
				const type = inferExpressionType(field.value, env, registry) ?? slua.unknown();
				const item: Omit<CompletionItem, 'priority'> = { label: name, kind: 'property', detail: formatTypeString(type), type, deprecated: !!sourceFunctionInfo(type)?.deprecated, documentation: sourceFunctionMarkdown(type).trim() || undefined };
				items.push({ ...item, priority: calculatePriority(item) + 20 });
			}
			return items;
		}

		const t = localType;

		// Provide metatable-driven member completion for known SLua custom/primitive types.
		if (t.kind === 'custom' || t.kind === 'primitive' || (t.kind === 'table' && t.metatable)) {
			const def = defaultMetatableRegistry.get(t.kind === 'table' ? t.metatable! : t.name);
			const members = def?.members;
			if (members) {
				for (const m of Object.values(members)) {
					const requiresColon = m.requiresColonCall ?? (m.kind === 'method');
					if (isColonCall && !requiresColon) continue;
					if (!isColonCall && requiresColon) continue;

					const detail = m.type.kind === 'function' ? formatFunctionSignature(m.type) : formatTypeString(m.type);
					const item: Omit<CompletionItem, 'priority'> = {
						label: m.name,
						kind: m.kind === 'method' ? 'method' : 'property',
						detail,
						documentation: m.docs,
						type: m.type,
						requiresColonCall: requiresColon
					};
					items.push({ ...item, priority: calculatePriority(item) + 20 });
				}
				if (items.length > 0) return items;
			}
		}

		// Fallback: known custom instance members (vector/rotation x/y/z) even without explicit member lists.
		if (t.kind === 'custom' && (t.name === 'vector' || t.name === 'rotation')) {
			if (!isColonCall) {
				for (const name of ['x', 'y', 'z']) {
					const item: Omit<CompletionItem, 'priority'> = {
						label: name,
						kind: 'property',
						detail: 'number',
						type: slua.number()
					};
					items.push({ ...item, priority: calculatePriority(item) });
				}
				return items;
			}
		}

	}

	return items;
}

const METAMETHOD_NAMES: MetamethodName[] = [
	'__index',
	'__newindex',
	'__call',
	'__tostring',
	'__len',
	'__pairs',
	'__ipairs',
	'__iter',
	'__type',
	'__add',
	'__sub',
	'__mul',
	'__div',
	'__mod',
	'__pow',
	'__unm',
	'__concat',
	'__eq',
	'__lt',
	'__le',
	'__gc',
	'__close'
];

function getMetamethodKeyCompletions(): CompletionItem[] {
	return METAMETHOD_NAMES.map((name) => {
		const sig = defaultMetatableRegistry.getMetamethod('vector', name)?.signature; // use any known def for formatting if available
		const detail = sig ? formatFunctionSignature(sig) : 'metamethod';
		const item: Omit<CompletionItem, 'priority'> = {
			label: name,
			kind: 'property',
			detail,
			insertText: `${name} = `
		};
		return { ...item, priority: calculatePriority(item) + 40 };
	});
}

function isMetatableTableAtPosition(program: ProgramNode, pos: { line: number; character: number }): boolean {
	let found = false;

	function visit(value: unknown): void {
		if (found) return;
		if (!isAstNode(value) || !value.location) return;
		if (!posInLoc(pos, value.location)) return;

		if (isCallExpression(value)) {
			// setmetatable(x, { ... })
			if (isIdentifier(value.callee) && value.callee.name === 'setmetatable') {
				const mtArg = value.arguments[1];
				if (isTableNode(mtArg) && mtArg.location && posInLoc(pos, mtArg.location)) {
					found = true;
					return;
				}
			}
		}

		if (isTableNode(value) && Array.isArray((value as Record<string, unknown>).fields)) {
			const fields = (value as Record<string, unknown>).fields as unknown[];
			for (const f of fields) {
				if (!isTableFieldNode(f)) continue;
				if (!f.key) continue;
				if (isIdentifier(f.key) && f.key.name.startsWith('__')) {
					found = true;
					return;
				}
			}
		}

		for (const child of Object.values(value)) {
			if (Array.isArray(child)) {
				for (const item of child) visit(item);
			} else if (isRecord(child)) {
				visit(child);
			}
		}
	}

	visit(program);
	return found;
}

/**
 * Get completions for type annotation positions.
 */
function getTypeCompletions(): CompletionItem[] {
	const items: CompletionItem[] = [];

	const primitiveTypes = ['number', 'string', 'boolean', 'nil', 'table', 'any'];
	for (const typeName of primitiveTypes) {
		items.push({
			label: typeName,
			kind: 'type',
			priority: 60
		});
	}

	const customTypes = ['uuid', 'key', 'vector', 'rotation', 'quaternion', 'integer', 'thread'];
	for (const typeName of customTypes) {
		items.push({
			label: typeName,
			kind: 'type',
			priority: 55
		});
	}

	// Luau-ish type syntax snippets
	items.push({
		label: 'optional (T?)',
		kind: 'type',
		detail: 'T?',
		insertText: '${1:T}?',
		isSnippet: true,
		priority: 80
	});
	items.push({
		label: 'union (A | B)',
		kind: 'type',
		detail: 'A | B',
		insertText: '${1:A} | ${2:B}',
		isSnippet: true,
		priority: 78
	});
	items.push({
		label: 'union with nil (T | nil)',
		kind: 'type',
		detail: 'T | nil',
		insertText: '${1:T} | nil',
		isSnippet: true,
		priority: 77
	});
	items.push({
		label: 'intersection (A & B)',
		kind: 'type',
		detail: 'A & B',
		insertText: '${1:A} & ${2:B}',
		isSnippet: true,
		priority: 76
	});
	items.push({
		label: 'function type ((...) -> R)',
		kind: 'type',
		detail: '(T1, T2) -> R',
		insertText: '(${1:T1}, ${2:T2}) -> ${3:R}',
		isSnippet: true,
		priority: 74
	});
	items.push({
		label: 'tuple type ((A, B))',
		kind: 'type',
		detail: '(A, B)',
		insertText: '(${1:A}, ${2:B})',
		isSnippet: true,
		priority: 73
	});
	items.push({
		label: 'typeof(expr)',
		kind: 'type',
		detail: 'typeof(expr)',
		insertText: 'typeof(${1:expr})',
		isSnippet: true,
		priority: 72
	});

	return items;
}

/**
 * Get completions based on current scope.
 */
function getScopeCompletions(env: ScopeEnv, expectedType?: SluaType): CompletionItem[] {
	const items: CompletionItem[] = [];
	const allDefs = env.getAllInScopeWithDistance();

	for (const { def, distance } of allDefs) {
		const item: Omit<CompletionItem, 'priority'> = {
			label: def.name,
			kind: def.kind === 'function' || def.kind === 'class' ? 'function' : def.kind === 'parameter' ? 'parameter' : def.identifier.isConst ? 'constant' : 'variable',
			detail: (def.identifier.isConst || def.kind === 'class' ? 'const ' : '') + formatTypeString(def.type),
			type: def.type, deprecated: !!sourceFunctionInfo(def.type)?.deprecated, documentation: sourceFunctionMarkdown(def.type).trim() || undefined
		};

		// Strongly prefer locals/parameters/functions in scope over globals.
		// And prefer symbols from the closest (innermost) scope.
		const base = calculatePriority(item, expectedType);
		const localBonus = 80;
		const proximityBonus = Math.max(0, 30 - distance * 5);
		items.push({ ...item, priority: base + localBonus + proximityBonus });
	}

	return items;
}

/**
 * Get global completions (functions, modules, object types).
 */
function getGlobalCompletions(registry: SluaRegistry, expectedType?: SluaType): CompletionItem[] {
	const items: CompletionItem[] = [];

	// Global functions
	for (const [name, fn] of registry.globals.entries()) {
		if (fn.private) continue;
		const item: Omit<CompletionItem, 'priority'> = {
			label: name,
			kind: 'function',
			detail: formatFunctionSignature(fn.signature),
			documentation: fn.docs,
			type: fn.signature,
			deprecated: fn.deprecated
		};
		items.push({ ...item, priority: calculatePriority(item, expectedType) });
	}

	// Official YAML constants are global values as well as module entries.
	for (const [name, value] of registry.globalValues) {
		if (value.private) continue;
		const item: Omit<CompletionItem, 'priority'> = { label: name, kind: 'constant',
			detail: formatTypeString(value.type), documentation: value.docs, type: value.type };
		items.push({ ...item, priority: calculatePriority(item, expectedType) });
	}

	// Modules
	for (const name of registry.modules.keys()) {
		if (name.includes('.')) continue;
		const item: Omit<CompletionItem, 'priority'> = {
			label: name,
			kind: 'module',
			detail: 'module',
			type: slua.table()
		};
		items.push({ ...item, priority: calculatePriority(item, expectedType) });
	}

	// Object types
	for (const [name, object] of registry.objectTypes) {
		if (object.instanceOnly) continue;
		const item: Omit<CompletionItem, 'priority'> = {
			label: name,
			kind: 'module',
			detail: 'object',
			type: slua.table()
		};
		items.push({ ...item, priority: calculatePriority(item, expectedType) });
	}

	// Event names (for LLEvents)
	const eventNames = Object.keys(registry.eventSignatures);
	for (const eventName of eventNames) {
		const eventSig = registry.eventSignatures[eventName];
		const item: Omit<CompletionItem, 'priority'> = {
			label: eventName,
			kind: 'event',
			detail: 'event',
			documentation: eventSig?.tooltip
		};
		items.push({ ...item, priority: calculatePriority(item, expectedType) });
	}

	return items;
}

/**
 * Format a function signature for display.
 */
function formatFunctionSignature(type: SluaType): string {
	if (type.kind !== 'function') return formatTypeString(type);
	
	const parameters = type.params.map((p, i) => `arg${i + 1}: ${formatTypeString(p)}`);
	if (type.variadic) parameters.push(`...: ${formatTypeString(type.variadic)}`);
	const params = parameters.join(', ');
	const returns = formatTypeString(type.returns);
	return `(${params}) -> ${returns}`;
}

/**
 * Format a type as a string.
 */
function formatTypeString(type: SluaType): string {
	switch (type.kind) {
		case 'primitive':
			return type.name;
		case 'custom':
			return type.name;
		case 'table':
			return sluaTypeToString(type);
		case 'literal':
			return JSON.stringify(type.value);
		case 'array':
			return `${formatTypeString(type.element)}[]`;
		case 'tuple':
			return `(${type.items.map(formatTypeString).join(', ')})`;
		case 'function':
			return 'function';
		default:
			return 'unknown';
	}
}

/**
 * Build scope environment by traversing the AST up to the cursor position.
 */
function buildScopeAtPosition(
	ast: unknown,
	pos: { line: number; character: number },
	registry: SluaRegistry
): ScopeEnv {
	const env = new ScopeEnv();

	if (!isProgram(ast)) return env;

	function visitStmts(stmts: unknown[]): boolean {
		for (const stmt of stmts) {
			const foundInStmt = visitStmt(stmt);
			if (foundInStmt) return true;
		}
		return false;
	}

	function localType(name: string): SluaType | undefined { return env.find(name)?.type; }
	function visitExpressionAtPosition(value: unknown, context: SluaType[] = []): boolean {
		if (Array.isArray(value)) {
			for (const child of value) if (visitExpressionAtPosition(child)) return true;
			return false;
		}
		if (!isAstNode(value) || (value.location && !posInLoc(pos, value.location))) return false;
		if (isFunctionNode(value)) {
			env.pushScope();
			for (const [index, parameter] of value.parameters.entries()) if (isIdentifier(parameter)) {
				const type = parameter.typeAnnotation ? classAnnotationType(parameter.typeAnnotation, (name) => env.getClass(name), (name) => env.find(name)?.type) : context[index] ?? slua.unknown();
				env.define(parameter.name, parameter, 'parameter', type);
			}
			visitStmts(value.body);
			return true;
		}
		if (value.type === 'IfExpression') {
			const conditional = value as AstNode & { test: unknown; consequent: unknown; alternate: unknown };
			if (visitExpressionAtPosition(conditional.test)) return true;
			const before = env.checkpoint();
			env.refine(conditionalGuard(conditional), true);
			env.pushScope();
			const binding = defineConditional(conditional, env, registry);
			if (binding?.location && posInLoc(pos, binding.location)) return true;
			if (visitExpressionAtPosition(conditional.consequent)) return true;
			env.restore(before);
			env.refine(conditionalGuard(conditional), false);
			if (visitExpressionAtPosition(conditional.alternate)) return true;
			env.restore(before);
			return false;
		}
		if (value.type === 'BinaryExpression') {
			const binary = value as AstNode & { operator?: string; left: unknown; right: unknown };
			if (binary.operator === 'and' || binary.operator === 'or') {
				if (visitExpressionAtPosition(binary.left)) return true;
				env.pushScope();
				env.refine(binary.left, binary.operator === 'and');
				if (visitExpressionAtPosition(binary.right)) return true;
				env.popScope();
				return false;
			}
		}
		if (isCallExpression(value)) {
			const contexts = callbackContext(value, registry, localType);
			for (const argument of value.arguments) if (visitExpressionAtPosition(argument, contexts.get(argument))) return true;
			return visitExpressionAtPosition(value.callee);
		}
		for (const key of Object.keys(value)) if (key !== 'location' && visitExpressionAtPosition((value as unknown as Record<string, unknown>)[key])) return true;
		return !!value.location && posInLoc(pos, value.location);
	}

	function visitStmt(stmt: unknown): boolean {
		if (!isAstNode(stmt)) return false;

		// Check if cursor is beyond this statement
		if (stmt.location && (stmt.location.start.line > pos.line + 1 || (stmt.location.start.line === pos.line + 1 && stmt.location.start.column > pos.character + 1))) {
			return false;
		}

		if (isLocalStatement(stmt)) {
			if (visitExpressionAtPosition(stmt.init)) return true;
			const vars = stmt.variables.filter(isIdentifier);
			const values = inferAssignmentTypes(stmt.init ?? [], vars.length, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses());
			for (const [i, v] of vars.entries()) {
				const type = v.typeAnnotation ? classAnnotationType(v.typeAnnotation, (name) => env.getClass(name), (name) => env.find(name)?.type) : values[i] ?? slua.unknown();
				env.define(v.name, v, 'local', type, (stmt.init ?? [])[i]);
			}
			
			// Check if cursor is in this statement
			if (stmt.location && posInLoc(pos, stmt.location)) return true;
		}

		if (isAssignmentStatement(stmt)) {
			if (visitExpressionAtPosition(stmt.init)) return true;
			const values = inferAssignmentTypes(stmt.init, stmt.variables.length, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses());
			const writes = tableAssignments(stmt.variables, values, registry, localType);
			env.rewriteTables(writes.update);
			for (const [index, variable] of stmt.variables.entries()) if (isIdentifier(variable)) env.assign(variable.name, writes.values[index] ?? slua.nil());
			if (stmt.location && posInLoc(pos, stmt.location)) return true;
		}

		if (isFunctionDeclaration(stmt)) {
			if (stmt.identifier && isIdentifier(stmt.identifier)) {
				const fnType = inferFunctionSignature(stmt, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses());
				if (!stmt.isLocal && env.find(stmt.identifier.name)) env.assign(stmt.identifier.name, fnType);
				else env.define(stmt.identifier.name, stmt.identifier, 'function', fnType);
			} else {
				const type = inferFunctionSignature(stmt, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses());
				env.writeTable(stmt.identifier, type, registry);
			}

			// Check if cursor is inside function body
			if (stmt.location && posInLoc(pos, stmt.location)) {
				env.pushScope();
				const self = isMemberExpression(stmt.identifier) && stmt.identifier.indexer === ':' ? resolveBuiltinExpression(stmt.identifier.object, registry, localType)?.type : undefined;
				const params = stmt.parameters.filter(isIdentifier);
				const context = eventDeclarationContext(stmt.identifier, registry, localType);
				for (const [index, p] of params.entries()) {
					const type = p.typeAnnotation ? classAnnotationType(p.typeAnnotation, (name) => env.getClass(name), (name) => env.find(name)?.type) : index === 0 && self ? self : context[index] ?? slua.unknown();
					env.define(p.name, p, 'parameter', type);
				}
				visitStmts(stmt.body);
				return true;
			}
		}

		if (isClassDeclaration(stmt)) {
			const info = inferClassDeclaration(stmt, registry, new Map(env.getAllInScope().map((def) => [def.name, def.type])), env.getClasses());
			if (info && isIdentifier(stmt.name)) {
				env.defineClass(info, stmt.name);
				for (const method of stmt.methods) {
					if (!isFunctionDeclaration(method) || !method.location || !posInLoc(pos, method.location)) continue;
					env.pushScope();
					for (const [index, parameter] of method.parameters.entries()) {
						if (!isIdentifier(parameter)) continue;
						const type = index === 0 && parameter.name === 'self' ? info.instanceType : classAnnotationType(parameter.typeAnnotation, (name) => env.getClass(name));
						env.define(parameter.name, parameter, 'parameter', type);
					}
					visitStmts(method.body);
					return true;
				}
			}
			if (stmt.location && posInLoc(pos, stmt.location)) return true;
		}

		if (isIfStatement(stmt)) {
			if (visitExpressionAtPosition(stmt.test)) return true;
			const before = env.checkpoint();
			env.refine(conditionalGuard(stmt), true);
			env.pushScope();
			const binding = defineConditional(stmt, env, registry);
			if (binding?.location && posInLoc(pos, binding.location)) return true;
			if (visitStmts(stmt.consequent)) return true;
			// Empty lines have no expression/statement AST. Keep the branch scope
			// until its actual else/elseif keyword, including an empty then body.
			if (stmt.thenKeywordLocation && stmt.alternateKeywordLocation &&
				posInLoc(pos, { start: stmt.thenKeywordLocation.end, end: stmt.alternateKeywordLocation.start }) &&
				!(pos.line + 1 === stmt.alternateKeywordLocation.start.line && pos.character + 1 === stmt.alternateKeywordLocation.start.column)) return true;
			if (!stmt.alternate && stmt.location && posInLoc(pos, stmt.location)) return true;
			env.popScope();
			const consequent = env.checkpoint();
			env.restore(before);
			env.refine(conditionalGuard(stmt), false);
			env.pushScope();
			if (Array.isArray(stmt.alternate)) {
				if (visitStmts(stmt.alternate)) return true;
				if (stmt.alternateKeywordLocation && stmt.location && posInLoc(pos, { start: stmt.alternateKeywordLocation.end, end: stmt.location.end })) return true;
			} else if (visitStmt(stmt.alternate)) return true;
			env.popScope();
			if (blockReturns(stmt.consequent) && !blockReturns(stmt.alternate)) { /* Keep the false continuation. */ }
			else if (blockReturns(stmt.alternate) && !blockReturns(stmt.consequent)) env.restore(consequent);
			else env.join(before, consequent, env.checkpoint());
			if (stmt.location && posInLoc(pos, stmt.location)) return true;
		}

		if (isForStatement(stmt) || isGenericForStatement(stmt) || isScopedBodyStatement(stmt) ||
			(stmt.type === 'WhileStatement' && Array.isArray((stmt as unknown as { body?: unknown }).body))) {
			const before = env.checkpoint();
			const record = stmt as AstNode & { type: string; test?: unknown; body: unknown[] };
			if (isForStatement(stmt)) {
				for (const expr of [stmt.start, stmt.end, stmt.step]) if (visitExpressionAtPosition(expr)) return true;
			} else if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) if (visitExpressionAtPosition(iterator)) return true;
			} else if (record.type === 'WhileStatement' && visitExpressionAtPosition(record.test)) return true;
			if (record.type === 'WhileStatement') env.refine(record.test, true);
			env.pushScope();
			if (isForStatement(stmt) && isIdentifier(stmt.variable)) env.define(stmt.variable.name, stmt.variable, 'local', slua.number());
			if (isGenericForStatement(stmt)) {
				const context = arrayIterationContext(stmt.iterators, registry, localType);
				for (const [index, variable] of stmt.variables.entries()) if (isIdentifier(variable)) env.define(variable.name, variable, 'local', context[index] ?? slua.unknown());
			}
			if (visitStmts(record.body)) return true;
			if (record.type === 'RepeatStatement' && visitExpressionAtPosition(record.test)) return true;
			// A blank line in the body has no expression node, but still owns
			// the loop/block scope up to its closing keyword.
			if (stmt.location && posInLoc(pos, stmt.location)) return true;
			env.popScope();
			if (record.type !== 'DoStatement' && record.type !== 'RepeatStatement') env.join(before, env.checkpoint(), before);
			if (stmt.location && posInLoc(pos, stmt.location)) return true;
		}

		if (visitExpressionAtPosition(stmt)) return true;
		const expression = (stmt as AstNode & { expression?: unknown }).expression ?? stmt;
		env.refine(assertionCondition(expression, localType), true);
		return false;
	}

	visitStmts(ast.body);
	return env;
}

/**
 * Main entry point for getting completions at a given position.
 */
export function getVisibleLocalTypes(ast: unknown, pos: { line: number; character: number }, registry: SluaRegistry): Map<string, SluaType> {
	const env = buildScopeAtPosition(ast, pos, registry);
	return new Map(env.getAllInScope().map((binding) => [binding.name, binding.type ?? slua.unknown()]));
}

export function getCompletions(
	ast: unknown,
	pos: { line: number; character: number },
	registry: SluaRegistry,
	trigger?: CompletionTriggerContext
): CompletionItem[] {
	if (!isProgram(ast)) return [];

	const sourceText = trigger?.sourceText;
	const attributes = sourceText ? functionAttributeCompletions(sourceText, pos) : undefined;
	if (attributes) return attributes.map((label) => ({ label, kind: 'keyword', priority: 200, insertText: label, detail: '@'+label, documentation: FUNCTION_ATTRIBUTE_DOCS[label] }));
	const invoked = trigger?.invoked ?? false;

	// Build scope environment up to cursor position (for locals + receiver typing).
	const env = buildScopeAtPosition(ast, pos, registry);
	function expressionReceiver(): SluaType | undefined {
		let found: SluaType | undefined;
		visitAst(ast, (node) => {
			if (!isMemberExpression(node) || !isIdentifier(node.property) || !isCallExpression(node.object)) return;
			if (node.property.location && posInLoc(pos, node.property.location)) found = inferExpressionType(node.object, env, registry);
		});
		return found;
	}

	// Best-effort expected-type inference for ranking.
	const expectedType = inferExpectedTypeAtPosition(ast, pos, env, registry);

	// Determine trigger character.
	let triggerChar: string | null = null;
	if (typeof trigger?.triggerCharacter === 'string' && trigger.triggerCharacter.length === 1) {
		triggerChar = trigger.triggerCharacter;
	} else if (sourceText) {
		triggerChar = prevNonWhitespaceChar(sourceText, pos);
	}

	const templateRange = sourceText ? getTemplateInterpolationRange(sourceText, pos) : null;
	const inTemplateInterpolation = Boolean(templateRange);
	const effectiveInvoked = invoked || (inTemplateInterpolation && triggerChar === '{');

	// LLEvents contextual completions:
	// - inside first string arg: event enum names
	// - at second arg: callback skeleton with typed, snake_case params
	if (sourceText) {
		const special = getLLEventsArgumentCompletions(ast, pos, registry, triggerChar, invoked);
		if (special) return special;
		const fallback = tryGetLLEventsCallbackSnippetFromText(sourceText, pos, registry, triggerChar, invoked);
		if (fallback) return fallback;
		// Avoid noisy completions on quote trigger unless we handled the special case.
		if (!invoked && !inTemplateInterpolation && (triggerChar === '"' || triggerChar === '\'')) return [];
	}

	// Metatable editing: when inside a metatable table and typing `__...`, prioritize metamethod keys.
	if (sourceText) {
		const prefix = identifierPrefixAt(sourceText, pos);
		if ((invoked || prefix.startsWith('__')) && isMetatableTableAtPosition(ast, pos)) {
			const metas = getMetamethodKeyCompletions();
			metas.sort((a, b) => b.priority - a.priority);
			return metas;
		}
	}

	// Type annotations: ONLY in declaration-like type positions.
	if (sourceText && !inTemplateInterpolation && isInTypeAnnotationContext(sourceText, pos)) {
		const typeTriggers = new Set([':', '|', '&', '?', '(', ',', ')']);
		if (triggerChar && typeTriggers.has(triggerChar)) {
			const types = getTypeCompletions();
			types.sort((a, b) => b.priority - a.priority);
			return types;
		}
		// If explicitly invoked in a type annotation, still show types/snippets.
		if (invoked) {
			const types = getTypeCompletions();
			types.sort((a, b) => b.priority - a.priority);
			return types;
		}
	}

	// Backwards-compatible: immediate ':' trigger detection (kept for safety).
	if (sourceText && !inTemplateInterpolation && triggerChar === ':' && isTypeAnnotationTrigger(sourceText, pos)) {
		const types = getTypeCompletions();
		types.sort((a, b) => b.priority - a.priority);
		return types;
	}

	// Member access: ONLY when after '.' or ':' (non-type context).
	if (sourceText && (triggerChar === '.' || triggerChar === ':')) {
		const receiverName = extractIdentifierBeforeTrigger(sourceText, pos, triggerChar);
		const receiverType = receiverName ? undefined : expressionReceiver();
		if (!receiverName && !receiverType) return [];
		const members = getMemberCompletionsByName(receiverName ?? '', triggerChar === ':', env, registry, receiverType);
		members.sort((a, b) => b.priority - a.priority);
		return members;
	}

	// Explicit completion after a partially typed member must keep the receiver.
	// The editor can request again after the initial '.' list has been dismissed.
	if (sourceText) {
		const prefix = identifierPrefixAt(sourceText, pos);
		const beforePrefix = { line: pos.line, character: Math.max(0, pos.character - prefix.length) };
		const separator = prevNonWhitespaceChar(sourceText, beforePrefix);
		if (prefix && (separator === '.' || separator === ':')) {
			const receiver = extractIdentifierBeforeTrigger(sourceText, beforePrefix, separator);
			const receiverType = receiver ? undefined : expressionReceiver();
			if (receiver || receiverType) {
				const members = getMemberCompletionsByName(receiver ?? '', separator === ':', env, registry, receiverType);
				members.sort((a, b) => b.priority - a.priority);
				return members;
			}
		}
	}

	// Non-member completion:
	// - always include locals (scope) to avoid flooding
	// - include globals only when explicitly invoked
	const scopeItemsWithExpected = getScopeCompletions(env, expectedType);
	const globalItems = effectiveInvoked ? getGlobalCompletions(registry, expectedType) : [];

	const bestByLabel = new Map<string, CompletionItem>();
	for (const item of [...scopeItemsWithExpected, ...globalItems]) {
		const existing = bestByLabel.get(item.label);
		if (!existing || item.priority > existing.priority) bestByLabel.set(item.label, item);
	}

	const items = [...bestByLabel.values()];
	items.sort((a, b) => b.priority - a.priority);
	return items;
}
