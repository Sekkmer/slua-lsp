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
import type { SluaEventSignature } from '../slua/events.js';

import type { SluaSemanticTokenModifier, SluaSemanticTokenType } from './legend.js';

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

	// 1) Lexer-based tokens: comments/strings/numbers/keywords. These define occupied ranges.
	for (const tok of lexTokens) {
		if (tok.type === TokenType.EOF) continue;
		if (tok.type === TokenType.WHITESPACE || tok.type === TokenType.NEWLINE) continue;
		const line = Math.max(0, tok.line - 1);
		const ch = Math.max(0, tok.column - 1);
		const len = Math.max(0, tok.value.length);
		if (len === 0) continue;

		let tokenType: SluaSemanticTokenType | null = null;
		if (tok.type === TokenType.COMMENT || tok.type === TokenType.MULTILINE_COMMENT) tokenType = 'comment';
		else if (tok.type === TokenType.STRING) tokenType = 'string';
		else if (tok.type === TokenType.NUMBER) tokenType = 'number';
		else if (KEYWORD_TOKEN_TYPES.has(tok.type)) tokenType = 'keyword';

		if (!tokenType) continue;
		if (!canPlace(line, ch, ch + len)) continue;
		out.push({ line, character: ch, length: len, tokenType, modifiers: [] });
		mark(line, ch, ch + len);
	}

	// 2) AST overlays for identifiers/methods/types (best-effort; skip on overlap).
	const allowedIntrinsic = buildAllowedIntrinsicMethods();
	void ctx.eventSignatures;

	visitAst(ctx.ast, (node) => {
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

	// Sort tokens for stable server encoding.
	out.sort((a, b) => (a.line - b.line) || (a.character - b.character) || (a.length - b.length));
	return out;
}
