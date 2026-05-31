import type { SluaRegistry } from '../slua/registry.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };

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

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

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

export type DefinitionLocation = {
	name: string;
	identifier: IdentifierNode;
	kind: 'local' | 'parameter' | 'function';
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * Symbol definition with scope information.
 */
type SymbolDefinition = {
	name: string;
	identifier: IdentifierNode;
	kind: 'local' | 'parameter' | 'function';
	scopeId: number;
};

/**
 * Scope environment that tracks symbol definitions with proper scoping.
 */
class ScopeEnv {
	private readonly scopes: Array<Map<string, SymbolDefinition>> = [new Map()];
	private scopeCounter = 0;

	pushScope(): number {
		const scopeId = ++this.scopeCounter;
		this.scopes.push(new Map());
		return scopeId;
	}

	popScope(): void {
		if (this.scopes.length > 1) this.scopes.pop();
	}

	/**
	 * Define a symbol in the current scope.
	 */
	define(name: string, identifier: IdentifierNode, kind: 'local' | 'parameter' | 'function'): void {
		const scopeId = this.scopeCounter;
		this.scopes[this.scopes.length - 1]!.set(name, { name, identifier, kind, scopeId });
	}

	/**
	 * Find the definition of a symbol by searching from innermost to outermost scope.
	 */
	find(name: string): SymbolDefinition | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const def = this.scopes[i]!.get(name);
			if (def) return def;
		}
		return undefined;
	}

	/**
	 * Get all definitions from all scopes (for debugging/testing).
	 */
	getAllDefinitions(): SymbolDefinition[] {
		const all: SymbolDefinition[] = [];
		for (const scope of this.scopes) {
			all.push(...scope.values());
		}
		return all;
	}
}

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

function identifierAtPositionInText(sourceText: string, pos: { line: number; character: number }): string | null {
	const offset = posToOffset(sourceText, pos);
	if (offset < 0 || offset > sourceText.length) return null;
	let start = offset;
	let end = offset;
	while (start > 0 && IDENT_PART.test(sourceText[start - 1] ?? '')) start--;
	while (end < sourceText.length && IDENT_PART.test(sourceText[end] ?? '')) end++;
	const text = sourceText.slice(start, end);
	if (!text || !IDENT_START.test(text[0] ?? '')) return null;
	return text;
}

function isLocalStatement(value: unknown): value is LocalStatementNode {
	return isAstNode(value) && value.type === 'LocalStatement' && Array.isArray((value as Record<string, unknown>).variables);
}

function isAssignmentStatement(value: unknown): value is AssignmentStatementNode {
	return (
		isAstNode(value) &&
		value.type === 'AssignmentStatement' &&
		Array.isArray((value as Record<string, unknown>).variables) &&
		Array.isArray((value as Record<string, unknown>).init)
	);
}

function isFunctionDeclaration(value: unknown): value is FunctionDeclarationNode {
	return (
		isAstNode(value) &&
		value.type === 'FunctionDeclaration' &&
		typeof (value as Record<string, unknown>).isLocal === 'boolean' &&
		Array.isArray((value as Record<string, unknown>).parameters) &&
		Array.isArray((value as Record<string, unknown>).body)
	);
}

function isFunctionNode(value: unknown): value is FunctionNode {
	return (
		isAstNode(value) &&
		value.type === 'Function' &&
		Array.isArray((value as Record<string, unknown>).parameters) &&
		Array.isArray((value as Record<string, unknown>).body)
	);
}

function isIfStatement(value: unknown): value is IfStatementNode {
	return (
		isAstNode(value) &&
		value.type === 'IfStatement' &&
		isRecord((value as Record<string, unknown>).test) &&
		Array.isArray((value as Record<string, unknown>).consequent)
	);
}

function isReturnStatement(value: unknown): value is ReturnStatementNode {
	return isAstNode(value) && value.type === 'ReturnStatement' && Array.isArray((value as Record<string, unknown>).arguments);
}

function isForStatement(value: unknown): value is ForStatementNode {
	return (
		isAstNode(value) &&
		value.type === 'ForStatement' &&
		Array.isArray((value as Record<string, unknown>).body)
	);
}

function isGenericForStatement(value: unknown): value is GenericForStatementNode {
	return (
		isAstNode(value) &&
		value.type === 'GenericForStatement' &&
		Array.isArray((value as Record<string, unknown>).variables) &&
		Array.isArray((value as Record<string, unknown>).iterators) &&
		Array.isArray((value as Record<string, unknown>).body)
	);
}

function isScopedBodyStatement(value: unknown): value is ScopedBodyStatementNode {
	return isAstNode(value) && (value.type === 'DoStatement' || value.type === 'RepeatStatement') && Array.isArray((value as Record<string, unknown>).body);
}

/**
 * Check if a position is within a location range.
 */
function posInLoc(pos: { line: number; character: number }, loc: Loc): boolean {
	// Convert 0-based LSP position to 1-based parser position
	const line = pos.line + 1;
	const col = pos.character + 1;
	const afterStart = line > loc.start.line || (line === loc.start.line && col >= loc.start.column);
	const beforeEnd = line < loc.end.line || (line === loc.end.line && col <= loc.end.column);
	return afterStart && beforeEnd;
}

/**
 * Find the identifier node at the given position.
 */
function findIdentifierAtPosition(ast: unknown, pos: { line: number; character: number }): IdentifierNode | null {
	let best: IdentifierNode | null = null;
	let bestSpan = Infinity;

	function visit(value: unknown): void {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isRecord(value)) return;

		const node = value as AstNode;
		if (isIdentifier(node) && node.location && posInLoc(pos, node.location)) {
			const span = (node.location.end.line - node.location.start.line) * 10_000 + (node.location.end.column - node.location.start.column);
			// Prefer the smallest span (most specific)
			if (span < bestSpan) {
				best = node;
				bestSpan = span;
			}
		}

		// Recurse into children
		for (const child of Object.values(value)) {
			visit(child);
		}
	}

	visit(ast);
	return best;
}

/**
 * Build the scope environment visible at a cursor position (best-effort), for use in
 * situations where the AST doesn't contain identifier nodes (e.g. template string `{...}`).
 */
function buildScopeAtPosition(program: ProgramNode, pos: { line: number; character: number }): ScopeEnv {
	const env = new ScopeEnv();

	function visitStmts(stmts: unknown[]): boolean {
		for (const stmt of stmts) {
			if (visitStmt(stmt)) return true;
		}
		return false;
	}

	function visitStmt(stmt: unknown): boolean {
		if (!isAstNode(stmt)) return false;
		if (stmt.location && stmt.location.start.line > pos.line + 1) return false;
		const inThisStmt = !!(stmt.location && posInLoc(pos, stmt.location));

		if (isLocalStatement(stmt)) {
			// If the cursor is inside an initializer, the local isn't in scope yet.
			if (stmt.init) {
				for (const init of stmt.init) {
					if (isAstNode(init) && init.location && posInLoc(pos, init.location)) {
						visitExpr(init);
						return true;
					}
					visitExpr(init);
				}
			}
			const vars = stmt.variables.filter(isIdentifier);
			for (const v of vars) env.define(v.name, v, 'local');
			if (inThisStmt) return true;
			return false;
		}

		if (isAssignmentStatement(stmt)) {
			for (const init of stmt.init) visitExpr(init);
			if (inThisStmt) return true;
			return false;
		}

		if (isForStatement(stmt)) {
			for (const expr of [stmt.start, stmt.end, stmt.step]) {
				if (!expr) continue;
				visitExpr(expr);
				if (isAstNode(expr) && expr.location && posInLoc(pos, expr.location)) return true;
			}

			if (inThisStmt) {
				env.pushScope();
				if (isIdentifier(stmt.variable)) env.define(stmt.variable.name, stmt.variable, 'local');
				if (visitStmts(stmt.body)) return true;
				env.popScope();
				return true;
			}
			return false;
		}

		if (isGenericForStatement(stmt)) {
			for (const iterator of stmt.iterators) {
				visitExpr(iterator);
				if (isAstNode(iterator) && iterator.location && posInLoc(pos, iterator.location)) return true;
			}

			if (inThisStmt) {
				env.pushScope();
				for (const variable of stmt.variables) {
					if (isIdentifier(variable)) env.define(variable.name, variable, 'local');
				}
				if (visitStmts(stmt.body)) return true;
				env.popScope();
				return true;
			}
			return false;
		}

		if (isFunctionDeclaration(stmt)) {
			if (stmt.isLocal && stmt.identifier && isIdentifier(stmt.identifier)) {
				env.define(stmt.identifier.name, stmt.identifier, 'function');
			}

			if (inThisStmt) {
				env.pushScope();
				for (const p of stmt.parameters.filter(isIdentifier)) env.define(p.name, p, 'parameter');
				// Keep the function scope if the cursor is inside this function.
				visitStmts(stmt.body);
				return true;
			}
			return false;
		}

		if (isIfStatement(stmt)) {
			if (inThisStmt) {
				env.pushScope();
				if (visitStmts(stmt.consequent)) {
					return true;
				}
				env.popScope();

				const alt = stmt.alternate;
				if (Array.isArray(alt)) {
					env.pushScope();
					const foundAlt = visitStmts(alt);
					env.popScope();
					if (foundAlt) return true;
				} else if (isAstNode(alt) && alt.type === 'IfStatement') {
					env.pushScope();
					const foundAlt = visitStmts([alt]);
					env.popScope();
					if (foundAlt) return true;
				}

				return true;
			}
			return false;
		}

		if (isScopedBodyStatement(stmt)) {
			const rec = stmt as Record<string, unknown>;
			const test = rec.test;
			if (inThisStmt) {
				env.pushScope();
				if (visitStmts(stmt.body)) return true;
				if (isAstNode(test)) {
					visitExpr(test);
					if (test.location && posInLoc(pos, test.location)) return true;
				}
				env.popScope();
				return true;
			}
			if (isAstNode(test)) visitExpr(test);
			return false;
		}

		if (isReturnStatement(stmt)) {
			for (const arg of stmt.arguments) visitExpr(arg);
			if (inThisStmt) return true;
			return false;
		}

		// If the cursor is inside an unhandled statement type (e.g. CallStatement),
		// the current env is the best available scope snapshot.
		if (inThisStmt) return true;

		const rec = stmt as Record<string, unknown>;
		const body = rec.body;
		if (Array.isArray(body)) {
			env.pushScope();
			const found = visitStmts(body);
			env.popScope();
			if (found) return true;
		}
		return false;
	}

	function visitExpr(expr: unknown): void {
		if (!expr) return;
		if (Array.isArray(expr)) {
			for (const item of expr) visitExpr(item);
			return;
		}
		if (!isRecord(expr)) return;
		const node = expr as AstNode;
		if (isFunctionNode(node)) {
			env.pushScope();
			for (const p of node.parameters.filter(isIdentifier)) env.define(p.name, p, 'parameter');
			visitStmts(node.body);
			env.popScope();
			return;
		}
		for (const child of Object.values(expr)) {
			if (Array.isArray(child)) for (const item of child) visitExpr(item);
			else if (isRecord(child)) visitExpr(child);
		}
	}

	visitStmts(program.body);
	return env;
}

/**
 * Find the definition location at the given cursor position.
 * Returns the location of where the symbol is defined, or null if not found.
 * 
 * This implementation properly handles scope by:
 * 1. Finding the identifier at the cursor position
 * 2. Traversing the AST and building scopes as we go
 * 3. When we encounter the cursor position, we search the current scope chain
 */
export function findDefinitionAtPosition(
	ast: unknown,
	position: { line: number; character: number },
	_registry: SluaRegistry,
	sourceText?: string
): DefinitionLocation | null {
	if (!isProgram(ast)) return null;

	// Prefer real AST identifiers when available.
	// (If template strings are lexed into real expressions, this will work.)
	const targetIdentifier = findIdentifierAtPosition(ast, position);
	if (!targetIdentifier || !targetIdentifier.location) {
		// Fallback for legacy behavior where template strings were tokenized as a single String.
		if (sourceText) {
			const tpl = getTemplateInterpolationRange(sourceText, position);
			if (tpl) {
				const name = identifierAtPositionInText(sourceText, position);
				if (!name) return null;
				const env = buildScopeAtPosition(ast, position);
				const def = env.find(name);
				if (!def) return null;
				return { name: def.name, identifier: def.identifier, kind: def.kind };
			}
		}
		return null;
	}
	
	const targetName = targetIdentifier.name;
	const targetLoc = targetIdentifier.location;
	let foundDefinition: DefinitionLocation | null = null;

	// Traverse the AST and build scopes, looking for where the target identifier is used
	const env = new ScopeEnv();
	
	function checkIfAtTarget(node: AstNode): boolean {
		if (!node.location) return false;
		// Check if this is the exact same node (same location)
		return (
			node.location.start.line === targetLoc.start.line &&
			node.location.start.column === targetLoc.start.column &&
			node.location.end.line === targetLoc.end.line &&
			node.location.end.column === targetLoc.end.column
		);
	}

	function visitStatementsInCurrentScope(stmts: unknown[]): void {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			// Local variable declarations
			if (isLocalStatement(stmt)) {
				const vars = stmt.variables.filter(isIdentifier);
				
				// First check if we're looking at one of the variable usages in the init expressions
				if (stmt.init) {
					for (const init of stmt.init) {
						visitExpression(init);
						if (foundDefinition) return;
					}
				}
				
				// Then define the variables (they're not visible in their own init expressions)
				for (const v of vars) {
					env.define(v.name, v, 'local');
				}
				continue;
			}

			// Assignment statements
			if (isAssignmentStatement(stmt)) {
				for (const init of stmt.init) {
					visitExpression(init);
					if (foundDefinition) return;
				}
				continue;
			}

			if (isForStatement(stmt)) {
				visitExpression(stmt.start);
				if (foundDefinition) return;
				visitExpression(stmt.end);
				if (foundDefinition) return;
				if (stmt.step) {
					visitExpression(stmt.step);
					if (foundDefinition) return;
				}

				env.pushScope();
				if (isIdentifier(stmt.variable)) {
					env.define(stmt.variable.name, stmt.variable, 'local');
					if (checkIfAtTarget(stmt.variable)) {
						foundDefinition = {
							name: stmt.variable.name,
							identifier: stmt.variable,
							kind: 'local'
						};
					}
				}
				visitStatementsInCurrentScope(stmt.body);
				env.popScope();

				if (foundDefinition) return;
				continue;
			}

			if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) {
					visitExpression(iterator);
					if (foundDefinition) return;
				}

				env.pushScope();
				for (const variable of stmt.variables) {
					if (!isIdentifier(variable)) continue;
					env.define(variable.name, variable, 'local');
					if (checkIfAtTarget(variable)) {
						foundDefinition = {
							name: variable.name,
							identifier: variable,
							kind: 'local'
						};
					}
				}
				visitStatementsInCurrentScope(stmt.body);
				env.popScope();

				if (foundDefinition) return;
				continue;
			}

			// Function declarations
			if (isFunctionDeclaration(stmt)) {
				if (stmt.isLocal && stmt.identifier && isIdentifier(stmt.identifier)) {
					env.define(stmt.identifier.name, stmt.identifier, 'function');
				}
				
				// Function body introduces a new scope with parameters
				env.pushScope();
				const params = stmt.parameters.filter(isIdentifier);
				for (const p of params) {
					env.define(p.name, p, 'parameter');
				}
				visitStatementsInCurrentScope(stmt.body);
				env.popScope();
				
				if (foundDefinition) return;
				continue;
			}

			// If statements
			if (isIfStatement(stmt)) {
				// Visit test expression first
				visitExpression(stmt.test);
				if (foundDefinition) return;
				
				env.pushScope();
				visitStatementsInCurrentScope(stmt.consequent);
				env.popScope();
				
				if (foundDefinition) return;

				const alt = stmt.alternate;
				if (Array.isArray(alt)) {
					env.pushScope();
					visitStatementsInCurrentScope(alt);
					env.popScope();
				} else if (isAstNode(alt) && alt.type === 'IfStatement') {
					env.pushScope();
					visitStatementsInCurrentScope([alt]);
					env.popScope();
				}
				
				if (foundDefinition) return;
				continue;
			}

			if (isScopedBodyStatement(stmt)) {
				const rec = stmt as Record<string, unknown>;
				const test = rec.test;
				env.pushScope();
				visitStatementsInCurrentScope(stmt.body);
				if (isAstNode(test)) {
					visitExpression(test);
				}
				env.popScope();
				if (foundDefinition) return;
				continue;
			}

			// Return statements
			if (isReturnStatement(stmt)) {
				for (const arg of stmt.arguments) {
					visitExpression(arg);
					if (foundDefinition) return;
				}
				continue;
			}

			// Fallback: many statement nodes contain expressions (e.g. CallStatement).
			// Traverse them so definitions work inside argument lists.
			visitExpression(stmt);
			if (foundDefinition) return;

			// Recurse into common block nodes
			const stmtRec = stmt as Record<string, unknown>;
			const body = stmtRec.body;
			if (Array.isArray(body)) visitStatements(body);
			if (foundDefinition) return;
			
			const consequent = stmtRec.consequent;
			if (Array.isArray(consequent)) visitStatements(consequent);
			if (foundDefinition) return;
			
			const alternate = stmtRec.alternate;
			if (Array.isArray(alternate)) visitStatements(alternate);
			else if (isAstNode(alternate) && alternate.type === 'IfStatement') visitStatements([alternate]);
			if (foundDefinition) return;
		}
	}

	function visitStatements(stmts: unknown[]): void {
		env.pushScope();
		visitStatementsInCurrentScope(stmts);
		env.popScope();
	}

	function visitExpression(expr: unknown): void {
		if (!expr) return;
		if (foundDefinition) return;
		
		if (Array.isArray(expr)) {
			for (const item of expr) {
				visitExpression(item);
				if (foundDefinition) return;
			}
			return;
		}
		if (!isRecord(expr)) return;

		const node = expr as AstNode;
		
		// Check if this is the identifier we're looking for
		if (isIdentifier(node) && node.name === targetName && checkIfAtTarget(node)) {
			// Found the usage! Now look up its definition in the current scope
			const def = env.find(targetName);
			if (def) {
				foundDefinition = {
					name: def.name,
					identifier: def.identifier,
					kind: def.kind
				};
			}
			return;
		}

		// Handle anonymous function expressions
		if (isFunctionNode(node)) {
			env.pushScope();
			const params = node.parameters.filter(isIdentifier);
			for (const p of params) {
				env.define(p.name, p, 'parameter');
			}
			visitStatementsInCurrentScope(node.body);
			env.popScope();
			return;
		}

		// Recurse into expression children
		for (const child of Object.values(expr)) {
			if (foundDefinition) return;
			if (Array.isArray(child)) {
				for (const item of child) {
					visitExpression(item);
					if (foundDefinition) return;
				}
			} else if (isRecord(child)) {
				visitExpression(child);
			}
		}
	}

	visitStatements(ast.body);
	return foundDefinition;
}
