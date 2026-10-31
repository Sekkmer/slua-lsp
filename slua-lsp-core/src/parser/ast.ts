export type AstPosition = { line: number; column: number };
export type SourceLocation = { start: AstPosition; end: AstPosition };

export type AstNode = { type: string; location?: SourceLocation };
export type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string; isConst?: boolean; exported?: boolean };
export type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	indexer?: '.' | ':';
	colonCall?: boolean;
};
export type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };
export type StringNode = AstNode & { type: 'String'; value: string };
export type FunctionNode = AstNode & { type: 'Function'; parameters: unknown[]; body?: unknown[] };
export type FunctionDeclarationNode = AstNode & {
	type: 'FunctionDeclaration';
	identifier?: unknown;
	parameters?: unknown[];
	isLocal?: boolean;
	body?: unknown[];
};
export type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof value.type === 'string';
}

/** Native unary minus is folded only when its immediate, ungrouped operand is a literal. */
export function isIntegerLiteralExpression(value: unknown): boolean {
	if (!isAstNode(value)) return false;
	if (value.type === 'Integer') return true;
	const node = value as Record<string, unknown>;
	return value.type === 'UnaryExpression' && node.operator === '-' && isRecord(node.argument) &&
		node.argument.type === 'Integer' && !node.argument.parenthesized;
}

export function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

export function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression' && 'object' in value && 'property' in value;
}

export function isCallExpression(value: unknown): value is CallExpressionNode {
	return isAstNode(value) && value.type === 'CallExpression' && Array.isArray((value as Record<string, unknown>).arguments) && 'callee' in value;
}

export function isStringNode(value: unknown): value is StringNode {
	return isAstNode(value) && value.type === 'String' && typeof (value as Record<string, unknown>).value === 'string';
}

export function isFunctionNode(value: unknown): value is FunctionNode {
	return isAstNode(value) && value.type === 'Function' && Array.isArray((value as Record<string, unknown>).parameters);
}

export function isFunctionDeclarationNode(value: unknown): value is FunctionDeclarationNode {
	return isAstNode(value) && value.type === 'FunctionDeclaration';
}

export function isProgramNode(value: unknown): value is ProgramNode {
	return isAstNode(value) && value.type === 'Program' && Array.isArray((value as Record<string, unknown>).body);
}

export function posInLoc(pos: LspPosition, loc: SourceLocation): boolean {
	const line = pos.line + 1;
	const col = pos.character + 1;
	const afterStart = line > loc.start.line || (line === loc.start.line && col >= loc.start.column);
	const beforeEnd = line < loc.end.line || (line === loc.end.line && col <= loc.end.column);
	return afterStart && beforeEnd;
}

export function lspRangeFromLoc(loc: SourceLocation): LspRange {
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

export function rangeFromNode(node: AstNode): LspRange {
	const loc = node.location;
	if (!loc) {
		return {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 }
		};
	}
	return lspRangeFromLoc(loc);
}

export function visitAst(root: unknown, fn: (node: AstNode) => void): void {
	const seen = new WeakSet<object>();

	function visit(value: unknown): void {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isAstNode(value)) return;
		if (seen.has(value)) return;
		seen.add(value);
		fn(value);
		for (const key in value) {
			if (key === 'location') continue;
			visit((value as unknown as Record<string, unknown>)[key]);
		}
	}

	visit(root);
}
