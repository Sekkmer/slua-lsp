import { Lexer, TokenType } from '../luau/vendor.js';
import {
	isCallExpression,
	isFunctionDeclarationNode,
	isIdentifier,
	isMemberExpression,
	type AstNode,
	visitAst
} from '../parser/ast.js';

import { buildSluaRegistryFromLslDefinitions } from '../slua/registry.js';
import { collectNavigationBindings } from '../typing/navigationBindings.js';
import type { SluaEventSignature } from '../slua/events.js';

import type { SluaSemanticTokenModifier, SluaSemanticTokenType } from './legend.js';
import { SourceTextIndex } from '../parser/sourceTextIndex.js';

export type ClassifiedSemanticToken = {
	line: number; // 0-based
	character: number; // 0-based
	length: number;
	tokenType: SluaSemanticTokenType;
	modifiers: SluaSemanticTokenModifier[];
};

export type ClassifySemanticTokensContext = {
	ast?: unknown;
	eventSignatures?: Record<string, SluaEventSignature>;
};

function rangeFromNode(node: AstNode): { line: number; character: number; length: number } | null {
	const loc = node.location;
	if (!loc) return null;
	const line = Math.max(0, loc.start.line - 1);
	const character = Math.max(0, loc.start.column - 1);
	const endLine = Math.max(0, loc.end.line - 1);
	const endChar = Math.max(0, loc.end.column - 1);
	if (endLine !== line) return null; // keep single-line only
	return { line, character, length: Math.max(0, endChar - character) };
}

const KEYWORD_TOKEN_TYPES = new Set<TokenType>([
	TokenType.AND,
	TokenType.BREAK,
	TokenType.CONTINUE,
	TokenType.DO,
	TokenType.ELSE,
	TokenType.ELSEIF,
	TokenType.END,
	TokenType.FOR,
	TokenType.FUNCTION,
	TokenType.IF,
	TokenType.IN,
	TokenType.LOCAL,
	TokenType.NOT,
	TokenType.OR,
	TokenType.REPEAT,
	TokenType.RETURN,
	TokenType.THEN,
	TokenType.UNTIL,
	TokenType.WHILE,
	TokenType.TYPE,
	TokenType.EXPORT,
	TokenType.TYPEOF,
	TokenType.AS
]);

const DEFAULT_REGISTRY = buildSluaRegistryFromLslDefinitions(null);

const BUILTIN_CLASSES = new Set<string>([...DEFAULT_REGISTRY.objectTypes.keys()]);
// Treat these as modules/namespaces (dot-called tables) for highlighting purposes.
const BUILTIN_NAMESPACES = new Set<string>([...DEFAULT_REGISTRY.modules.keys()]);
const BUILTIN_FUNCTIONS = new Set<string>([...DEFAULT_REGISTRY.globals.keys()]);

function buildAllowedIntrinsicMethods(): Record<string, Set<string>> {
	const out: Record<string, Set<string>> = {};
	for (const [receiver, obj] of DEFAULT_REGISTRY.objectTypes.entries()) {
		(out[receiver] ??= new Set());
		for (const methodName of Object.keys(obj.methods)) out[receiver]!.add(methodName);
	}
	return out;
}

function overlaps(occupied: Array<[number, number]>, start: number, end: number): boolean {
	for (const [s, e] of occupied) {
		if (start < e && end > s) return true;
	}
	return false;
}

export function classifySemanticTokens(text: string, ctx: ClassifySemanticTokensContext = {}): ClassifiedSemanticToken[] {
	const lexer = new Lexer(text);
	const lexTokens = lexer.tokenize(text);
	const index = new SourceTextIndex(text);

	const occupiedByLine = new Map<number, Array<[number, number]>>();
	function mark(line: number, start: number, end: number): void {
		const list = occupiedByLine.get(line) ?? [];
		list.push([start, end]);
		occupiedByLine.set(line, list);
	}
	function canPlace(line: number, start: number, end: number): boolean {
		const list = occupiedByLine.get(line);
		if (!list) return true;
		return !overlaps(list, start, end);
	}

	const out: ClassifiedSemanticToken[] = [];
	const bindings = text.includes('const') || text.includes('class') || text.includes('export') ? collectNavigationBindings(ctx.ast) : undefined;
	const bindingPositions = new Set(bindings?.occurrences.flatMap(({ identifier }) => {
		const range = rangeFromNode(identifier); return range ? [`${range.line}:${range.character}`] : [];
	}));
	const typeIdentifiers = new Set(bindings?.types.map((use) => use.identifier));
	const deferredKeywords = new Set<string>();
	const contextual = new Set([TokenType.CONTINUE, TokenType.EXPORT, TokenType.TYPE, TokenType.TYPEOF, TokenType.AS]);

	// 1) Lexer-based tokens: comments/strings/numbers/keywords. These define occupied ranges.
	for (const tok of lexTokens) {
		if (tok.type === TokenType.EOF) continue;
		if (tok.type === TokenType.WHITESPACE || tok.type === TokenType.NEWLINE) continue;
		let tokenType: SluaSemanticTokenType | null = null;
		if (tok.type === TokenType.COMMENT || tok.type === TokenType.MULTILINE_COMMENT) tokenType = 'comment';
		else if ([TokenType.STRING, TokenType.TEMPLATE_START, TokenType.TEMPLATE_END].includes(tok.type)) tokenType = 'string';
		else if (tok.type === TokenType.NUMBER) tokenType = 'number';
		else if (KEYWORD_TOKEN_TYPES.has(tok.type)) {
			const position = index.positionAt(tok.start), key = `${position.line}:${position.character}`;
			if (contextual.has(tok.type) && bindingPositions.has(key)) { deferredKeywords.add(key); continue; }
			tokenType = 'keyword';
		}

		if (!tokenType) continue;
		const start = index.positionAt(tok.start), end = index.positionAt(tok.end);
		for (let line = start.line; line <= end.line; line++) {
			const ch = line === start.line ? start.character : 0;
			const stop = line === end.line ? end.character : index.lineEnd(line) - index.starts[line]!;
			if (stop <= ch || !canPlace(line, ch, stop)) continue;
			out.push({ line, character: ch, length: stop - ch, tokenType, modifiers: [] });
			mark(line, ch, stop);
		}
	}

	// 2) AST overlays for identifiers/methods/types (best-effort; skip on overlap).
	const allowedIntrinsic = buildAllowedIntrinsicMethods();
	void ctx.eventSignatures;

	visitAst(ctx.ast, (node) => {
		const record = node as Record<string, unknown>;
		if (node.type === 'FunctionAttribute' && typeof record.name === 'string' && node.location) {
			const point = node.location.start, range = { line: point.line - 1, character: point.column - 1, length: record.name.length };
			if (canPlace(range.line, range.character, range.character + range.length)) { out.push({ ...range, tokenType: 'keyword', modifiers: [] }); mark(range.line, range.character, range.character + range.length); }
		}
		if (node.type === 'ClassDeclaration') for (const key of ['openKeywordLocation', 'classKeywordLocation', 'extendsKeywordLocation']) {
			if (!record[key]) continue;
			const keyword = rangeFromNode({ type: 'ClassKeyword', location: record[key] } as AstNode);
			if (keyword && canPlace(keyword.line, keyword.character, keyword.character + keyword.length)) {
				out.push({ ...keyword, tokenType: 'keyword', modifiers: [] }); mark(keyword.line, keyword.character, keyword.character + keyword.length);
			}
		}
		if ((record.isConst || record.conditionIsConst) && record.constKeywordLocation) {
			const keyword = rangeFromNode({ type: 'ConstKeyword', location: record.constKeywordLocation } as AstNode);
			if (keyword && canPlace(keyword.line, keyword.character, keyword.character + keyword.length)) {
				out.push({ ...keyword, tokenType: 'keyword', modifiers: [] }); mark(keyword.line, keyword.character, keyword.character + keyword.length);
			}
		}

		// Highlight function declarations: function foo() ...
		if (isFunctionDeclarationNode(node)) {
			const id = node.identifier;
			const nameNode = isIdentifier(id) ? id : isMemberExpression(id) && isIdentifier(id.property) ? id.property : null;
			if (nameNode) {
				const r = rangeFromNode(nameNode);
				if (!r) return;
				if (!canPlace(r.line, r.character, r.character + r.length)) return;
				out.push({ line: r.line, character: r.character, length: r.length, tokenType: 'function', modifiers: ['declaration'] });
				mark(r.line, r.character, r.character + r.length);
			}
			return;
		}

		// Highlight call targets.
		if (isCallExpression(node)) {
			const callee = node.callee;
			if (isIdentifier(callee)) {
				const r = rangeFromNode(callee);
				if (!r) return;
				let tt: SluaSemanticTokenType = 'function';
				if (BUILTIN_CLASSES.has(callee.name)) tt = 'class';
				else if (BUILTIN_NAMESPACES.has(callee.name)) tt = 'namespace';
				else if (BUILTIN_FUNCTIONS.has(callee.name)) tt = 'function';
				if (!canPlace(r.line, r.character, r.character + r.length)) return;
				out.push({ line: r.line, character: r.character, length: r.length, tokenType: tt, modifiers: [] });
				mark(r.line, r.character, r.character + r.length);
				return;
			}

			if (isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
				const obj = callee.object;
				const prop = callee.property;

				// Highlight receiver identifier (namespace/class).
				const objRange = rangeFromNode(obj);
				if (objRange && canPlace(objRange.line, objRange.character, objRange.character + objRange.length)) {
					let objType: SluaSemanticTokenType = 'variable';
					if (BUILTIN_CLASSES.has(obj.name)) objType = 'class';
					else if (BUILTIN_NAMESPACES.has(obj.name)) objType = 'namespace';
					out.push({ line: objRange.line, character: objRange.character, length: objRange.length, tokenType: objType, modifiers: [] });
					mark(objRange.line, objRange.character, objRange.character + objRange.length);
				}

				// Highlight property as method/function.
				const propRange = rangeFromNode(prop);
				if (propRange && canPlace(propRange.line, propRange.character, propRange.character + propRange.length)) {
					let propType: SluaSemanticTokenType = 'method';
					let modifiers: SluaSemanticTokenModifier[] = [];
					if (allowedIntrinsic[obj.name] && !allowedIntrinsic[obj.name]!.has(prop.name)) {
						// Unknown intrinsic method.
						modifiers = ['deprecated'];
					}
					// Module functions read like functions.
					if (BUILTIN_NAMESPACES.has(obj.name)) propType = 'function';
					out.push({ line: propRange.line, character: propRange.character, length: propRange.length, tokenType: propType, modifiers });
					mark(propRange.line, propRange.character, propRange.character + propRange.length);
				}

				// Intentionally no special highlighting for event-name strings.
			}
		}

		// Highlight type names in written type annotations: local x: Foo = ...
		if (isIdentifier(node) && node.typeAnnotation) {
			// Best-effort: highlight the identifier itself as variable, annotation as type is handled via TextMate.
			// Keep semantic tokens conservative here.
			return;
		}
	});

	// A contextual spelling that is a proven binding is a value/type token;
	// actual continue statements and export modifiers retain their keyword role.
	for (const occurrence of bindings?.occurrences ?? []) {
		const range = rangeFromNode(occurrence.identifier); if (!range) continue;
		if (deferredKeywords.has(`${range.line}:${range.character}`) && canPlace(range.line, range.character, range.character + range.length)) {
			out.push({ ...range, tokenType: typeIdentifiers.has(occurrence.identifier) ? 'class' : 'variable', modifiers: occurrence.kind === 'definition' ? ['declaration'] : [] });
			mark(range.line, range.character, range.character + range.length);
		}
	}

	// Preserve existing function/call categories while marking the resolved
	// immutable binding. Fields and mutable same-named shadows stay independent.
	const tokensByPosition = new Map(out.map((token) => [`${token.line}:${token.character}`, token]));
	for (const occurrence of bindings?.occurrences ?? []) {
		if (!occurrence.definition?.isConst) continue;
		const range = rangeFromNode(occurrence.identifier); if (!range) continue;
		const existing = tokensByPosition.get(`${range.line}:${range.character}`);
		const modifiers: SluaSemanticTokenModifier[] = [...(occurrence.kind === 'definition' ? ['declaration' as const] : []), 'readonly'];
		if (existing) {
			if (typeIdentifiers.has(occurrence.identifier)) existing.tokenType = 'class';
			existing.modifiers = [...new Set([...existing.modifiers, ...modifiers])];
		}
		else if (canPlace(range.line, range.character, range.character + range.length)) {
			const token: ClassifiedSemanticToken = { ...range, tokenType: typeIdentifiers.has(occurrence.identifier) ? 'class' : occurrence.definition.kind === 'function' ? 'function' : 'variable', modifiers };
			out.push(token); tokensByPosition.set(`${range.line}:${range.character}`, token); mark(range.line, range.character, range.character + range.length);
		}
	}

	// Sort tokens for stable server encoding.
	out.sort((a, b) => (a.line - b.line) || (a.character - b.character) || (a.length - b.length));
	return out;
}
