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

export type ReferenceLocation = {
	identifier: IdentifierNode;
	kind: 'definition' | 'usage';
};

/**
 * Symbol definition with scope information.
 */
type SymbolDefinition = {
	identifier: IdentifierNode;
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
	define(identifier: IdentifierNode): void {
		const scopeId = this.scopeCounter;
		this.scopes[this.scopes.length - 1]!.set(identifier.name, { identifier, scopeId });
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
 * Find all references to a symbol including its definition.
 * Returns all locations where the symbol is used within the correct scope.
 */
export function findAllReferences(
	ast: unknown,
	position: { line: number; character: number },
	_registry: SluaRegistry,
	includeDeclaration = true
): ReferenceLocation[] {
	if (!isProgram(ast)) return [];

	// Find the identifier at the cursor position
	const targetIdentifier = findIdentifierAtPosition(ast, position);
	if (!targetIdentifier || !targetIdentifier.location) return [];

	const targetName = targetIdentifier.name;
	const targetLoc = targetIdentifier.location;
	let targetDefinition: IdentifierNode | null = null;

	// First pass: find which definition the target identifier refers to
	{
		const env = new ScopeEnv();
		let found = false;

		function visitStmtsForDef(stmts: unknown[]): void {
			for (const stmt of stmts) {
				if (!isAstNode(stmt) || found) continue;

				if (isLocalStatement(stmt)) {
					const vars = stmt.variables.filter(isIdentifier);
					if (stmt.init) {
						for (const init of stmt.init) {
							visitExprForDef(init);
							if (found) return;
						}
					}
					// Check if the target is one of the variables being defined
					for (const v of vars) {
						if (v.location && 
							v.location.start.line === targetLoc.start.line &&
							v.location.start.column === targetLoc.start.column &&
							v.location.end.line === targetLoc.end.line &&
							v.location.end.column === targetLoc.end.column) {
							targetDefinition = v;
							found = true;
							return;
						}
						env.define(v);
					}
					continue;
				}

				if (isAssignmentStatement(stmt)) {
					for (const init of stmt.init) {
						visitExprForDef(init);
						if (found) return;
					}
					continue;
				}

				if (isForStatement(stmt)) {
					visitExprForDef(stmt.start);
					if (found) return;
					visitExprForDef(stmt.end);
					if (found) return;
					if (stmt.step) {
						visitExprForDef(stmt.step);
						if (found) return;
					}

					env.pushScope();
					if (isIdentifier(stmt.variable)) {
						const v = stmt.variable;
						if (
							v.location &&
							v.location.start.line === targetLoc.start.line &&
							v.location.start.column === targetLoc.start.column &&
							v.location.end.line === targetLoc.end.line &&
							v.location.end.column === targetLoc.end.column
						) {
							targetDefinition = v;
							found = true;
							env.define(v);
							env.popScope();
							return;
						}
						env.define(v);
					}
					visitStmtsForDef(stmt.body);
					env.popScope();
					if (found) return;
					continue;
				}

				if (isFunctionDeclaration(stmt)) {
					if (stmt.isLocal && stmt.identifier && isIdentifier(stmt.identifier)) {
						// Check if the target is the function identifier
						const id = stmt.identifier;
						if (id.location && 
							id.location.start.line === targetLoc.start.line &&
							id.location.start.column === targetLoc.start.column &&
							id.location.end.line === targetLoc.end.line &&
							id.location.end.column === targetLoc.end.column) {
							targetDefinition = id;
							found = true;
						}
						env.define(id);
					}
					env.pushScope();
					const params = stmt.parameters.filter(isIdentifier);
					for (const p of params) {
						// Check if the target is this parameter
						if (!found && p.location && 
							p.location.start.line === targetLoc.start.line &&
							p.location.start.column === targetLoc.start.column &&
							p.location.end.line === targetLoc.end.line &&
							p.location.end.column === targetLoc.end.column) {
							targetDefinition = p;
							found = true;
						}
						env.define(p);
					}
					visitStmtsForDef(stmt.body);
					env.popScope();
					if (found) return;
					continue;
				}

				if (isIfStatement(stmt)) {
					visitExprForDef(stmt.test);
					if (found) return;
					env.pushScope();
					visitStmtsForDef(stmt.consequent);
					env.popScope();
					if (found) return;
					const alt = stmt.alternate;
					if (Array.isArray(alt)) {
						env.pushScope();
						visitStmtsForDef(alt);
						env.popScope();
					} else if (isAstNode(alt) && alt.type === 'IfStatement') {
						env.pushScope();
						visitStmtsForDef([alt]);
						env.popScope();
					}
					if (found) return;
					continue;
				}

				if (isReturnStatement(stmt)) {
					for (const arg of stmt.arguments) {
						visitExprForDef(arg);
						if (found) return;
					}
					continue;
				}

				// Fallback: traverse unhandled statement nodes that may contain expressions
				// (e.g. CallStatement) so identifiers in argument lists resolve correctly.
				visitExprForDef(stmt);
				if (found) return;
			}
		}

		function visitExprForDef(expr: unknown): void {
			if (!expr || found) return;
			if (Array.isArray(expr)) {
				for (const item of expr) {
					visitExprForDef(item);
					if (found) return;
				}
				return;
			}
			if (!isRecord(expr)) return;

			const node = expr as AstNode;
			if (isIdentifier(node) && node.name === targetName && node.location) {
				const loc = node.location;
				if (
					loc.start.line === targetLoc.start.line &&
					loc.start.column === targetLoc.start.column &&
					loc.end.line === targetLoc.end.line &&
					loc.end.column === targetLoc.end.column
				) {
					const def = env.find(targetName);
					if (def) {
						targetDefinition = def.identifier;
						found = true;
					}
					return;
				}
			}

			if (isFunctionNode(node)) {
				env.pushScope();
				const params = node.parameters.filter(isIdentifier);
				for (const p of params) {
					// Check if the target is this parameter
					if (!found && p.location && 
						p.location.start.line === targetLoc.start.line &&
						p.location.start.column === targetLoc.start.column &&
						p.location.end.line === targetLoc.end.line &&
						p.location.end.column === targetLoc.end.column) {
						targetDefinition = p;
						found = true;
					}
					env.define(p);
				}
				visitStmtsForDef(node.body);
				env.popScope();
				return;
			}

			for (const child of Object.values(expr)) {
				if (found) return;
				visitExprForDef(child);
			}
		}

		env.pushScope();
		visitStmtsForDef(ast.body);
		env.popScope();
	}

	if (!targetDefinition) return [];

	// Second pass: collect all references to the same definition
	const references: ReferenceLocation[] = [];
	const env = new ScopeEnv();

	function isSameIdent(a: IdentifierNode, b: IdentifierNode): boolean {
		if (!a.location || !b.location) return false;
		return (
			a.location.start.line === b.location.start.line &&
			a.location.start.column === b.location.start.column &&
			a.location.end.line === b.location.end.line &&
			a.location.end.column === b.location.end.column
		);
	}

	function visitStmtsForRefs(stmts: unknown[]): void {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			if (isLocalStatement(stmt)) {
				const vars = stmt.variables.filter(isIdentifier);
				if (stmt.init) {
					for (const init of stmt.init) visitExprForRefs(init);
				}
				for (const v of vars) {
					env.define(v);
					if (includeDeclaration && isSameIdent(v, targetDefinition!)) {
						references.push({ identifier: v, kind: 'definition' });
					}
				}
				continue;
			}

			if (isAssignmentStatement(stmt)) {
				const vars = stmt.variables.filter(isIdentifier);
				for (const v of vars) {
					const def = env.find(v.name);
					if (def && isSameIdent(def.identifier, targetDefinition!)) {
						references.push({ identifier: v, kind: 'usage' });
					}
				}
				for (const init of stmt.init) visitExprForRefs(init);
				continue;
			}

			if (isForStatement(stmt)) {
				visitExprForRefs(stmt.start);
				visitExprForRefs(stmt.end);
				if (stmt.step) visitExprForRefs(stmt.step);

				env.pushScope();
				if (isIdentifier(stmt.variable)) {
					const v = stmt.variable;
					env.define(v);
					if (includeDeclaration && isSameIdent(v, targetDefinition!)) {
						references.push({ identifier: v, kind: 'definition' });
					}
				}
				visitStmtsForRefs(stmt.body);
				env.popScope();
				continue;
			}

			if (isFunctionDeclaration(stmt)) {
				if (stmt.isLocal && stmt.identifier && isIdentifier(stmt.identifier)) {
					env.define(stmt.identifier);
					if (includeDeclaration && isSameIdent(stmt.identifier, targetDefinition!)) {
						references.push({ identifier: stmt.identifier, kind: 'definition' });
					}
				}
				env.pushScope();
				const params = stmt.parameters.filter(isIdentifier);
				for (const p of params) {
					env.define(p);
					if (includeDeclaration && isSameIdent(p, targetDefinition!)) {
						references.push({ identifier: p, kind: 'definition' });
					}
				}
				visitStmtsForRefs(stmt.body);
				env.popScope();
				continue;
			}

			if (isIfStatement(stmt)) {
				visitExprForRefs(stmt.test);
				env.pushScope();
				visitStmtsForRefs(stmt.consequent);
				env.popScope();
				const alt = stmt.alternate;
				if (Array.isArray(alt)) {
					env.pushScope();
					visitStmtsForRefs(alt);
					env.popScope();
				} else if (isAstNode(alt) && alt.type === 'IfStatement') {
					env.pushScope();
					visitStmtsForRefs([alt]);
					env.popScope();
				}
				continue;
			}

			if (isReturnStatement(stmt)) {
				for (const arg of stmt.arguments) visitExprForRefs(arg);
				continue;
			}

			// Fallback: traverse unhandled statement nodes that may contain expressions
			// (e.g. CallStatement) so usages in argument lists are included.
			visitExprForRefs(stmt);
		}
	}

	function visitExprForRefs(expr: unknown): void {
		if (!expr) return;
		if (Array.isArray(expr)) {
			for (const item of expr) visitExprForRefs(item);
			return;
		}
		if (!isRecord(expr)) return;

		const node = expr as AstNode;
		if (isIdentifier(node) && node.name === targetName) {
			const def = env.find(targetName);
			if (def && isSameIdent(def.identifier, targetDefinition!)) {
				references.push({ identifier: node, kind: 'usage' });
			}
		}

		if (isFunctionNode(node)) {
			env.pushScope();
			const params = node.parameters.filter(isIdentifier);
			for (const p of params) {
				env.define(p);
				if (includeDeclaration && isSameIdent(p, targetDefinition!)) {
					references.push({ identifier: p, kind: 'definition' });
				}
			}
			visitStmtsForRefs(node.body);
			env.popScope();
			return;
		}

		for (const child of Object.values(expr)) {
			visitExprForRefs(child);
		}
	}

	env.pushScope();
	visitStmtsForRefs(ast.body);
	env.popScope();

	return references;
}
