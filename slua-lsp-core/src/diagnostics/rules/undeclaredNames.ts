import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import { buildSluaRegistryFromLslDefinitions } from '../../slua/registry.js';
import { REMOVED_LL_API_NAMES } from '../../slua/removedApis.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };

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

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

type WhileStatementNode = AstNode & { type: 'WhileStatement'; test: unknown; body: unknown[] };

type DoStatementNode = AstNode & { type: 'DoStatement'; body: unknown[] };

type RepeatStatementNode = AstNode & { type: 'RepeatStatement'; body: unknown[]; test: unknown };

type ReturnStatementNode = AstNode & { type: 'ReturnStatement'; arguments: unknown[] };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown; indexer?: '.' | ':' };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type TableNode = AstNode & { type: 'Table'; fields?: unknown[] };

type TableFieldNode = AstNode & { type: 'TableField'; key?: unknown; value?: unknown };

type TypeCastExpressionNode = AstNode & { type: 'TypeCastExpression'; expression: unknown; typeAnnotation?: string };

type ErrorStatementNode = AstNode & { type: 'ErrorStatement'; message?: string };

type TypeAliasNode = AstNode & { type: 'TypeAlias'; name: unknown; definition: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

function isAstNode(v: unknown): v is AstNode {
	return isRecord(v) && typeof (v as Record<string, unknown>).type === 'string';
}

function isProgram(v: unknown): v is ProgramNode {
	return isAstNode(v) && v.type === 'Program' && Array.isArray((v as Record<string, unknown>).body);
}

function isIdentifier(v: unknown): v is IdentifierNode {
	return isAstNode(v) && v.type === 'Identifier' && typeof (v as Record<string, unknown>).name === 'string';
}

function isLocalStatement(v: unknown): v is LocalStatementNode {
	return isAstNode(v) && v.type === 'LocalStatement' && Array.isArray((v as Record<string, unknown>).variables);
}

function isAssignmentStatement(v: unknown): v is AssignmentStatementNode {
	return (
		isAstNode(v) &&
		v.type === 'AssignmentStatement' &&
		Array.isArray((v as Record<string, unknown>).variables) &&
		Array.isArray((v as Record<string, unknown>).init)
	);
}

function isFunctionDeclaration(v: unknown): v is FunctionDeclarationNode {
	return isAstNode(v) && v.type === 'FunctionDeclaration' && typeof (v as Record<string, unknown>).isLocal === 'boolean' && Array.isArray((v as Record<string, unknown>).body);
}

function _isFunctionNode(v: unknown): v is FunctionNode {
	return isAstNode(v) && v.type === 'Function' && Array.isArray((v as Record<string, unknown>).parameters) && Array.isArray((v as Record<string, unknown>).body);
}

function isForStatement(v: unknown): v is ForStatementNode {
	return isAstNode(v) && v.type === 'ForStatement' && Array.isArray((v as Record<string, unknown>).body);
}

function isGenericForStatement(v: unknown): v is GenericForStatementNode {
	return isAstNode(v) && v.type === 'GenericForStatement' && Array.isArray((v as Record<string, unknown>).variables) && Array.isArray((v as Record<string, unknown>).iterators) && Array.isArray((v as Record<string, unknown>).body);
}

function isIfStatement(v: unknown): v is IfStatementNode {
	return isAstNode(v) && v.type === 'IfStatement' && Array.isArray((v as Record<string, unknown>).consequent);
}

function isWhileStatement(v: unknown): v is WhileStatementNode {
	return isAstNode(v) && v.type === 'WhileStatement' && Array.isArray((v as Record<string, unknown>).body);
}

function isDoStatement(v: unknown): v is DoStatementNode {
	return isAstNode(v) && v.type === 'DoStatement' && Array.isArray((v as Record<string, unknown>).body);
}

function isRepeatStatement(v: unknown): v is RepeatStatementNode {
	return isAstNode(v) && v.type === 'RepeatStatement' && Array.isArray((v as Record<string, unknown>).body) && 'test' in v;
}

function isReturnStatement(v: unknown): v is ReturnStatementNode {
	return isAstNode(v) && v.type === 'ReturnStatement' && Array.isArray((v as Record<string, unknown>).arguments);
}

function isCallExpression(v: unknown): v is CallExpressionNode {
	return isAstNode(v) && v.type === 'CallExpression' && Array.isArray((v as Record<string, unknown>).arguments);
}

function isMemberExpression(v: unknown): v is MemberExpressionNode {
	return isAstNode(v) && v.type === 'MemberExpression' && 'object' in (v as Record<string, unknown>) && 'property' in (v as Record<string, unknown>);
}

function isIndexExpression(v: unknown): v is IndexExpressionNode {
	return isAstNode(v) && v.type === 'IndexExpression' && 'object' in (v as Record<string, unknown>) && 'index' in (v as Record<string, unknown>);
}

function isTableNode(v: unknown): v is TableNode {
	return isAstNode(v) && v.type === 'Table';
}

function isTableField(v: unknown): v is TableFieldNode {
	return isAstNode(v) && v.type === 'TableField';
}

function isTypeCastExpression(v: unknown): v is TypeCastExpressionNode {
	return isAstNode(v) && v.type === 'TypeCastExpression' && 'expression' in v;
}

function isErrorStatement(v: unknown): v is ErrorStatementNode {
	return isAstNode(v) && v.type === 'ErrorStatement';
}

function isTypeAlias(v: unknown): v is TypeAliasNode {
	return isAstNode(v) && v.type === 'TypeAlias' && 'name' in (v as Record<string, unknown>) && 'definition' in (v as Record<string, unknown>);
}

function rangeFromNode(node: AstNode): Range {
	const loc = node.location;
	if (!loc) return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

const LUA_BUILTIN_GLOBALS = new Set<string>([
	// core
	'_G',
	'assert',
	'error',
	'print',
	'warn',
	'type',
	'pcall',
	'xpcall',
	'select',
	'next',
	'pairs',
	'ipairs',
	'tonumber',
	'tostring',
	// std libs / namespaces
	'math',
	'string',
	'table',
	'coroutine',
	'utf8',
	'os',

	// SLua/LuaLayer commonly-available globals (tests rely on these even without a registry)
	'LLEvents',
	'LLTimers',
	'lljson',
	'llbase64',
	'll',
	'llcompat',
	// SLua default helper globals
	'vector',
	'rotation',
	'quaternion',
	'uuid',
	'touuid',
	'integer',
	'tovector',
	'toquaternion',
	'torotation',
	'typeof'
]);

const BUILTIN_TYPE_NAMES = new Set<string>([
	'number',
	'string',
	'boolean',
	'nil',
	'any',
	'unknown',
	'table',
	// slua custom-ish
	'uuid',
	'key',
	'vector',
	'rotation',
	'quaternion',
	'integer',
	'thread'
]);

// SLua wiki convention: `{DetectedEvent}` is used in examples.
const SLUA_KNOWN_TYPES = new Set<string>(['DetectedEvent']);

const TYPE_TOKEN_STOPWORDS = new Set<string>([
	'and',
	'or',
	'not',
	'function',
	'typeof',
	'true',
	'false',
	'nil',
	'local',
	'return'
]);

function isIdentStart(ch: number): boolean {
	return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95;
}

function isIdentPart(ch: number): boolean {
	return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

function scanIdentifiers(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (!isIdentStart(c)) {
			i++;
			continue;
		}
		const start = i;
		i++;
		while (i < text.length && isIdentPart(text.charCodeAt(i))) i++;
		out.push(text.slice(start, i));
	}
	return out;
}

function exprNameKey(expr: unknown): string | null {
	// Normalize ':' sugar to '.'; we only need a stable lookup key.
	if (isIdentifier(expr)) return expr.name;
	if (isMemberExpression(expr) && isIdentifier(expr.property)) {
		const base = exprNameKey(expr.object);
		if (!base) return null;
		return `${base}.${expr.property.name}`;
	}
	if (isIndexExpression(expr)) {
		const base = exprNameKey(expr.object);
		if (!base) return null;
		// IndexExpression can be string key in some parsers; our lua parser uses IndexExpression with String.
		if (isAstNode(expr.index) && expr.index.type === 'String' && typeof (expr.index as Record<string, unknown>).value === 'string') {
			return `${base}.${(expr.index as Record<string, unknown>).value}`;
		}
	}
	return null;
}

class ScopeStack {
	private readonly scopes: Array<Set<string>> = [new Set()];

	push(): void {
		this.scopes.push(new Set());
	}

	pop(): void {
		if (this.scopes.length > 1) this.scopes.pop();
	}

	declare(name: string): void {
		this.scopes[this.scopes.length - 1]!.add(name);
	}

	declareGlobal(name: string): void {
		this.scopes[0]!.add(name);
	}

	has(name: string): boolean {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			if (this.scopes[i]!.has(name)) return true;
		}
		return false;
	}

	get depth(): number {
		return this.scopes.length;
	}
}

function isKnownGlobalName(name: string, registry: SluaRegistry | undefined): boolean {
	if (LUA_BUILTIN_GLOBALS.has(name)) return true;
	if (!registry) return false;
	if (registry.getGlobal(name)) return true;
	if (registry.getModule(name)) return true;
	if (registry.getObjectType(name)) return true;
	return false;
}

const defaultRegistry = buildSluaRegistryFromLslDefinitions(null);
const FALLBACK_MODULE_MEMBER_CHECK = new Set<string>(['lljson', 'llbase64']);

function isKnownTypeName(name: string, registry: SluaRegistry | undefined, declaredTypes: Set<string>): boolean {
	const norm = name.trim();
	if (!norm) return true;
	const lowered = norm.toLowerCase();
	if (BUILTIN_TYPE_NAMES.has(lowered)) return true;
	if (TYPE_TOKEN_STOPWORDS.has(lowered)) return true;
	if (SLUA_KNOWN_TYPES.has(norm)) return true;
	if (declaredTypes.has(norm)) return true;
	if (!registry) return false;
	// Treat object types as valid nominal types.
	if (registry.getObjectType(norm)) return true;
	return false;
}

function collectGenericTypeNames(node: unknown, out: Set<string>): void {
	if (!node) return;
	if (Array.isArray(node)) {
		for (const item of node) collectGenericTypeNames(item, out);
		return;
	}
	if (!isRecord(node)) return;
	const name = (node as Record<string, unknown>).name;
	if (node.type === 'GenericType' && typeof name === 'string') {
		out.add(name);
	}
	for (const child of Object.values(node)) collectGenericTypeNames(child, out);
}

function checkTypeAnnotation(
	owner: AstNode,
	annotation: string | undefined,
	registry: SluaRegistry | undefined,
	declaredTypes: Set<string>,
	diags: CoreDiagnostic[]
): void {
	if (!annotation) return;
	// Inline table annotations contain field names/modifiers (e.g. `readonly x`) that
	// aren't type identifiers. Skip naive token-scanning for these to avoid noise.
	if (annotation.includes('{') || annotation.includes('}')) return;
	const tokens = scanIdentifiers(annotation);
	if (tokens.length === 0) return;
	const seen = new Set<string>();
	for (const t of tokens) {
		if (seen.has(t)) continue;
		seen.add(t);
		if (isKnownTypeName(t, registry, declaredTypes)) continue;
		diags.push({
			code: 'unknown-type',
			severity: 'warning',
			message: `Unknown type '${t}'.`,
			range: rangeFromNode(owner)
		});
	}
}

function collectParseErrorAffectedLines(ast: ProgramNode): Set<number> {
	const lines = new Set<number>();

	function visit(node: unknown): void {
		if (!node) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isAstNode(node)) return;

		if (isErrorStatement(node) && node.location) {
			const start = Math.max(0, node.location.start.line - 2);
			const end = Math.max(start, node.location.end.line);
			for (let l = start; l <= end; l++) lines.add(l);
		}

		for (const child of Object.values(node)) visit(child);
	}

	visit(ast.body);
	return lines;
}

export function ruleUndeclaredNames(ast: unknown, registry?: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];

	const diags: CoreDiagnostic[] = [];
	const scopes = new ScopeStack();
	const parseErrorAffectedLines = collectParseErrorAffectedLines(ast);

	// Collect declared type aliases at top-level (and any exported types).
	const declaredTypes = new Set<string>();
	for (const stmt of ast.body) {
		if (!isAstNode(stmt)) continue;
		if (isTypeAlias(stmt) && isIdentifier(stmt.name)) {
			declaredTypes.add(stmt.name.name);
			collectGenericTypeNames(stmt.definition, declaredTypes);
		}
	}

	function warnUndeclared(id: IdentifierNode): void {
		if (id.location && parseErrorAffectedLines.has(Math.max(0, id.location.start.line - 1))) return;
		if (scopes.has(id.name)) return;
		if (isKnownGlobalName(id.name, registry)) return;
		diags.push({
			code: 'undeclared-name',
			severity: 'warning',
			message: `Undeclared name '${id.name}'.`,
			range: rangeFromNode(id)
		});
	}

	function warnAccidentalGlobalWrite(id: IdentifierNode): void {
		if (id.location && parseErrorAffectedLines.has(Math.max(0, id.location.start.line - 1))) return;
		// Only warn for writes inside a function scope (depth>1).
		if (scopes.depth <= 1) return;
		if (scopes.has(id.name)) return;
		if (isKnownGlobalName(id.name, registry)) return;
		diags.push({
			code: 'accidental-global-write',
			severity: 'warning',
			message: `Assignment to undeclared name '${id.name}' creates a global; did you mean 'local ${id.name}'?`,
			range: rangeFromNode(id)
		});
		// Treat it as global afterwards to avoid cascading warnings.
		scopes.declareGlobal(id.name);
	}

	function visitExpression(expr: unknown): void {
		if (!expr) return;
		if (Array.isArray(expr)) {
			for (const e of expr) visitExpression(e);
			return;
		}
		if (!isAstNode(expr)) return;

		if (isIdentifier(expr)) {
			warnUndeclared(expr);
			return;
		}

		if (isMemberExpression(expr)) {
			// Only the receiver expression can be undeclared.
			visitExpression(expr.object);
			return;
		}

		if (isIndexExpression(expr)) {
			visitExpression(expr.object);
			visitExpression(expr.index);
			return;
		}

		if (isTableNode(expr)) {
			for (const field of expr.fields ?? []) visitExpression(field);
			return;
		}

		if (isTableField(expr)) {
			// `foo = value` table keys are field names, not identifier reads.
			// For computed/non-identifier keys, still recurse defensively.
			if (expr.key && !isIdentifier(expr.key)) visitExpression(expr.key);
			if (expr.value) visitExpression(expr.value);
			return;
		}

		if (isTypeCastExpression(expr)) {
			visitExpression(expr.expression);
			checkTypeAnnotation(expr, expr.typeAnnotation, registry, declaredTypes, diags);
			return;
		}

		if (isCallExpression(expr)) {
			// Member-call validation for known modules (e.g. lljson.decode).
			// Object-type intrinsic methods are handled by ruleIntrinsicMethodCalls.
			const callee = expr.callee;
			if (isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
				const receiver = callee.object.name;
				const member = callee.property.name;
				if ((receiver === 'll' || receiver === 'llcompat') && REMOVED_LL_API_NAMES.has(member)) {
					// Intentionally removed from SLua runtime; handled by dedicated rule(s).
					// Avoid duplicating with a generic unknown-member error.
					// Still visit children to catch undeclared receiver, args, etc.
				}
				const reg = registry ?? defaultRegistry;
				const mod = reg.getModule(receiver);
				if (mod && (registry || FALLBACK_MODULE_MEMBER_CHECK.has(receiver))) {
					const ok = Boolean(mod.functions[member] || mod.values[member]);
					if (!ok && !((receiver === 'll' || receiver === 'llcompat') && REMOVED_LL_API_NAMES.has(member))) {
						diags.push({
							code: 'unknown-member',
							severity: 'error',
							message: `Unknown member ${receiver}.${member}(...).`,
							range: rangeFromNode(callee.property)
						});
					}
				}
			}
			if (isIndexExpression(callee) && isIdentifier(callee.object)) {
				const receiver = callee.object.name;
				const reg = registry ?? defaultRegistry;
				const mod = reg.getModule(receiver);
				if (mod && (registry || FALLBACK_MODULE_MEMBER_CHECK.has(receiver))) {
					const idx = callee.index;
					const member = isAstNode(idx) && idx.type === 'String' && typeof (idx as Record<string, unknown>).value === 'string' ? ((idx as Record<string, unknown>).value as string) : null;
					if (member && !mod.functions[member] && !mod.values[member] && !((receiver === 'll' || receiver === 'llcompat') && REMOVED_LL_API_NAMES.has(member))) {
						diags.push({
							code: 'unknown-member',
							severity: 'error',
							message: `Unknown member ${receiver}.${member}(...).`,
							range: rangeFromNode(idx as AstNode)
						});
					}
				}
			}

			visitExpression(expr.callee);
			for (const a of expr.arguments) visitExpression(a);
			return;
		}

		// Generic walk.
		for (const child of Object.values(expr)) visitExpression(child);
	}

	function declareFunctionParams(params: unknown[]): void {
		for (const p of params) {
			if (!isIdentifier(p)) continue;
			scopes.declare(p.name);
			checkTypeAnnotation(p, p.typeAnnotation, registry, declaredTypes, diags);
		}
	}

	function visitStatements(stmts: unknown[]): void {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			if (isTypeAlias(stmt)) {
				// Ensure type aliases are available for subsequent annotations.
				if (isIdentifier(stmt.name)) declaredTypes.add(stmt.name.name);
				collectGenericTypeNames(stmt.definition, declaredTypes);
				continue;
			}

			if (isLocalStatement(stmt)) {
				// Evaluate RHS first (Lua: RHS evaluated before LHS assignment).
				for (const initExpr of stmt.init ?? []) visitExpression(initExpr);
				for (const v of stmt.variables) {
					if (!isIdentifier(v)) continue;
					scopes.declare(v.name);
					checkTypeAnnotation(v, v.typeAnnotation, registry, declaredTypes, diags);
				}
				continue;
			}

			if (isFunctionDeclaration(stmt)) {
				// Declare the function name in the appropriate scope.
				if (stmt.identifier) {
					const key = exprNameKey(stmt.identifier);
					if (key) {
						if (stmt.isLocal) scopes.declare(key);
						else scopes.declareGlobal(key);
					}
				}

				// Enter function scope.
				scopes.push();
				declareFunctionParams(stmt.parameters);
				checkTypeAnnotation(stmt, stmt.returnTypeAnnotation, registry, declaredTypes, diags);
				visitStatements(stmt.body);
				scopes.pop();
				continue;
			}

			if (isAssignmentStatement(stmt)) {
				// Evaluate RHS first.
				for (const initExpr of stmt.init) visitExpression(initExpr);
				// Then validate writes.
				for (const target of stmt.variables) {
					if (!isIdentifier(target)) {
						visitExpression(target);
						continue;
					}
					warnAccidentalGlobalWrite(target);
				}
				continue;
			}

			if (isForStatement(stmt)) {
				visitExpression(stmt.start);
				visitExpression(stmt.end);
				if (stmt.step) visitExpression(stmt.step);

				scopes.push();
				if (isIdentifier(stmt.variable)) scopes.declare(stmt.variable.name);
				visitStatements(stmt.body);
				scopes.pop();
				continue;
			}

			if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) visitExpression(iterator);
				scopes.push();
				for (const variable of stmt.variables) {
					if (isIdentifier(variable)) scopes.declare(variable.name);
				}
				visitStatements(stmt.body);
				scopes.pop();
				continue;
			}

			if (isIfStatement(stmt)) {
				visitExpression(stmt.test);
				scopes.push();
				visitStatements(stmt.consequent);
				scopes.pop();
				const alt = stmt.alternate;
				if (Array.isArray(alt)) {
					scopes.push();
					visitStatements(alt);
					scopes.pop();
				} else if (isAstNode(alt) && alt.type === 'IfStatement') {
					scopes.push();
					visitStatements([alt]);
					scopes.pop();
				}
				continue;
			}

			if (isWhileStatement(stmt)) {
				visitExpression(stmt.test);
				scopes.push();
				visitStatements(stmt.body);
				scopes.pop();
				continue;
			}

			if (isDoStatement(stmt)) {
				scopes.push();
				visitStatements(stmt.body);
				scopes.pop();
				continue;
			}

			if (isRepeatStatement(stmt)) {
				scopes.push();
				visitStatements(stmt.body);
				visitExpression(stmt.test);
				scopes.pop();
				continue;
			}

			if (isReturnStatement(stmt)) {
				for (const a of stmt.arguments) visitExpression(a);
				continue;
			}

			// Generic recursion for statements containing nested blocks/expressions.
			for (const child of Object.values(stmt)) {
				if (Array.isArray(child)) visitStatements(child);
				else visitExpression(child);
			}
		}
	}

	// Seed global scope.
	for (const g of LUA_BUILTIN_GLOBALS) scopes.declareGlobal(g);
	if (registry) {
		for (const k of registry.modules.keys()) scopes.declareGlobal(k);
		for (const k of registry.objectTypes.keys()) scopes.declareGlobal(k);
		for (const k of registry.globals.keys()) scopes.declareGlobal(k);
	}
	for (const t of SLUA_KNOWN_TYPES) {
		// Types are checked separately; but allow type names to be used as identifiers too in some scripts.
		// (We don't declare them as values.)
		void t;
	}

	visitStatements(ast.body);
	return diags;
}
