import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';
import { sluaTypeFromLuauAnnotationText } from '../../slua/types.js';

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

type ReturnStatementNode = AstNode & { type: 'ReturnStatement'; arguments: unknown[] };

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown; indexer?: '.' | ':' };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type StringNode = AstNode & { type: 'String'; value: string };

type BinaryExpressionNode = AstNode & { type: 'BinaryExpression'; operator: string; left: unknown; right: unknown };

type UnaryExpressionNode = AstNode & { type: 'UnaryExpression'; operator: string; argument: unknown };

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
	return isAstNode(v) && v.type === 'AssignmentStatement' && Array.isArray((v as Record<string, unknown>).variables) && Array.isArray((v as Record<string, unknown>).init);
}

function isFunctionDeclaration(v: unknown): v is FunctionDeclarationNode {
	return isAstNode(v) && v.type === 'FunctionDeclaration' && typeof (v as Record<string, unknown>).isLocal === 'boolean' && Array.isArray((v as Record<string, unknown>).body);
}

function isFunctionNode(v: unknown): v is FunctionNode {
	return isAstNode(v) && v.type === 'Function' && Array.isArray((v as Record<string, unknown>).parameters) && Array.isArray((v as Record<string, unknown>).body);
}

function isReturnStatement(v: unknown): v is ReturnStatementNode {
	return isAstNode(v) && v.type === 'ReturnStatement' && Array.isArray((v as Record<string, unknown>).arguments);
}

function isIfStatement(v: unknown): v is IfStatementNode {
	return isAstNode(v) && v.type === 'IfStatement' && Array.isArray((v as Record<string, unknown>).consequent);
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

function isStringNode(v: unknown): v is StringNode {
	return isAstNode(v) && v.type === 'String' && typeof (v as Record<string, unknown>).value === 'string';
}

function _isBinaryExpression(v: unknown): v is BinaryExpressionNode {
	return isAstNode(v) && v.type === 'BinaryExpression' && typeof (v as Record<string, unknown>).operator === 'string';
}

function _isUnaryExpression(v: unknown): v is UnaryExpressionNode {
	return isAstNode(v) && v.type === 'UnaryExpression' && typeof (v as Record<string, unknown>).operator === 'string';
}

function exprNameKey(expr: unknown): string | null {
	// Normalize ':' sugar to '.'; we only need a stable lookup key.
	if (isIdentifier(expr)) return expr.name;
	if (isMemberExpression(expr) && isIdentifier(expr.property)) {
		const base = exprNameKey(expr.object);
		if (!base) return null;
		return `${base}.${expr.property.name}`;
	}
	if (isIndexExpression(expr) && isStringNode(expr.index)) {
		const base = exprNameKey(expr.object);
		if (!base) return null;
		return `${base}.${expr.index.value}`;
	}
	return null;
}

function rangeFromNode(node: AstNode): Range {
	const loc = node.location;
	if (!loc) return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

type ReturnCount = number | null;

class ReturnCountEnv {
	private readonly scopes: Array<Map<string, ReturnCount>> = [new Map()];

	clone(): ReturnCountEnv {
		const e = new ReturnCountEnv();
		e.scopes.length = 0;
		for (const scope of this.scopes) e.scopes.push(new Map(scope));
		return e;
	}

	pushScope(): void {
		this.scopes.push(new Map());
	}

	popScope(): void {
		if (this.scopes.length > 1) this.scopes.pop();
	}

	get(name: string): ReturnCount {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			if (this.scopes[i]!.has(name)) return this.scopes[i]!.get(name)!;
		}
		return null;
	}

	set(name: string, count: ReturnCount): void {
		this.scopes[this.scopes.length - 1]!.set(name, count);
	}
}

function signatureReturnCount(sig: SluaType | undefined | null): ReturnCount {
	if (!sig || sig.kind !== 'function') return null;
	const r = sig.returns;
	if (r.kind === 'tuple') return r.items.length;
	return 1;
}

function callReturnCount(call: CallExpressionNode, env: ReturnCountEnv, registry: SluaRegistry): ReturnCount {
	const callee = call.callee;

	if (isIdentifier(callee)) {
		const localCount = env.get(callee.name);
		if (localCount !== null) return localCount;
		const g = registry.getGlobal(callee.name);
		return signatureReturnCount(g?.signature);
	}

	if (isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
		const calleeKey = exprNameKey(callee);
		if (calleeKey) {
			const localCount = env.get(calleeKey);
			if (localCount !== null) return localCount;
		}
		const receiver = callee.object.name;
		const member = callee.property.name;
		const obj = registry.getObjectType(receiver);
		if (obj) return signatureReturnCount(obj.methods[member]?.signature);
		const mod = registry.getModule(receiver);
		if (mod) return signatureReturnCount(mod.functions[member]?.signature);
		return null;
	}

	if (isIndexExpression(callee) && isIdentifier(callee.object) && isStringNode(callee.index)) {
		const calleeKey = exprNameKey(callee);
		if (calleeKey) {
			const localCount = env.get(calleeKey);
			if (localCount !== null) return localCount;
		}
		const receiver = callee.object.name;
		const memberKey = callee.index.value;
		const obj = registry.getObjectType(receiver);
		if (obj) return signatureReturnCount(obj.methods[memberKey]?.signature);
		const mod = registry.getModule(receiver);
		if (mod) return signatureReturnCount(mod.functions[memberKey]?.signature);
		return null;
	}

	return null;
}

function exprReturnCount(expr: unknown, env: ReturnCountEnv, registry: SluaRegistry): ReturnCount {
	if (isCallExpression(expr)) return callReturnCount(expr, env, registry);
	// Any non-call expression produces exactly one value.
	return 1;
}

function returnListCount(exprs: unknown[], env: ReturnCountEnv, registry: SluaRegistry): ReturnCount {
	// Lua: `return` with no expressions returns nil (one value).
	if (exprs.length === 0) return 1;
	let fixed = 0;
	for (let i = 0; i < exprs.length; i++) {
		const isLast = i === exprs.length - 1;
		if (!isLast) {
			fixed += 1;
			continue;
		}
		const last = exprReturnCount(exprs[i], env, registry);
		if (last === null) return null;
		return fixed + last;
	}
	return fixed + 1;
}

function inferLocalFunctionReturnCountFromBody(body: unknown[], outerEnv: ReturnCountEnv, registry: SluaRegistry): ReturnCount {
	const env = outerEnv.clone();
	let inferred: ReturnCount = null;
	let sawAnyReturn = false;

	function merge(count: ReturnCount): void {
		if (count === null) {
			inferred = null;
			sawAnyReturn = true;
			return;
		}
		if (!sawAnyReturn) {
			inferred = count;
			sawAnyReturn = true;
			return;
		}
		if (inferred === null) return;
		if (inferred !== count) inferred = null;
	}

	function visitStatements(stmts: unknown[]): void {
		env.pushScope();
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			if (isLocalStatement(stmt)) {
				// Track `local f = function() ... end` inside the function body.
				const vars = stmt.variables.filter(isIdentifier);
				const init = stmt.init ?? [];
				for (let i = 0; i < Math.min(vars.length, init.length); i++) {
					const v = vars[i]!;
					const rhs = init[i];
					if (isFunctionNode(rhs)) {
						const ann = sluaTypeFromLuauAnnotationText(rhs.returnTypeAnnotation);
						const count = ann.kind === 'primitive' && ann.name !== 'unknown' ? 1 : inferLocalFunctionReturnCountFromBody(rhs.body, env, registry);
						env.set(v.name, count);
					}
				}
				continue;
			}

			if (isFunctionDeclaration(stmt) && stmt.identifier) {
				const key = exprNameKey(stmt.identifier);
				if (key) {
					const ann = sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation);
					const count = ann.kind === 'primitive' && ann.name !== 'unknown' ? 1 : inferLocalFunctionReturnCountFromBody(stmt.body, env, registry);
					env.set(key, count);
				}
				continue;
			}

			if (isReturnStatement(stmt)) {
				merge(returnListCount(stmt.arguments, env, registry));
				continue;
			}

			// Recurse into common blocks.
			if (isRecord(stmt)) {
				const stmtRec = stmt as Record<string, unknown>;
				if (Array.isArray(stmtRec.body)) visitStatements(stmtRec.body);
				if (Array.isArray(stmtRec.consequent)) visitStatements(stmtRec.consequent);
				if (Array.isArray(stmtRec.alternate)) visitStatements(stmtRec.alternate);
				if (isAstNode(stmtRec.alternate) && stmtRec.alternate.type === 'IfStatement') visitStatements([stmtRec.alternate]);
			}
		}
		env.popScope();
	}

	visitStatements(body);
	if (!sawAnyReturn) return 1;
	return inferred;
}

function assignmentProducedCount(init: unknown[] | undefined, env: ReturnCountEnv, registry: SluaRegistry): ReturnCount {
	if (!init || init.length === 0) return 0;
	let fixed = 0;
	for (let i = 0; i < init.length; i++) {
		const isLast = i === init.length - 1;
		if (!isLast) {
			fixed += 1;
			continue;
		}
		const last = exprReturnCount(init[i], env, registry);
		if (last === null) return null;
		return fixed + last;
	}
	return fixed;
}

function warnCountMismatch(diags: CoreDiagnostic[], stmt: AstNode, lhsCount: number, rhsCount: number): void {
	if (lhsCount === rhsCount) return;
	const direction = rhsCount > lhsCount ? 'discarded' : 'filled with nil';
	const diff = Math.abs(rhsCount - lhsCount);
	diags.push({
		code: 'assignment-return-count-mismatch',
		severity: 'warning',
		message: `Assignment count mismatch: ${lhsCount} target(s) but ${rhsCount} value(s) produced (${diff} will be ${direction}).`,
		range: rangeFromNode(stmt)
	});
}

export function ruleAssignmentReturnCountMismatch(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];
	const env = new ReturnCountEnv();

	function visitStatements(stmts: unknown[]): void {
		env.pushScope();
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			// Track local function declarations so we can resolve calls later.
			if (isFunctionDeclaration(stmt) && stmt.identifier) {
				const key = exprNameKey(stmt.identifier);
				if (key) {
					const ann = sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation);
					const count = ann.kind === 'primitive' && ann.name !== 'unknown' ? 1 : inferLocalFunctionReturnCountFromBody(stmt.body, env, registry);
					env.set(key, count);
				}
				// Continue into body to pick up nested locals for later, but don’t emit assignment warnings here.
				visitStatements(stmt.body);
				continue;
			}

			if (isLocalStatement(stmt)) {
				const lhsCount = stmt.variables.length;
				const init = stmt.init ?? [];
				// Track `local f = function() ... end`.
				const vars = stmt.variables.filter(isIdentifier);
				for (let i = 0; i < Math.min(vars.length, init.length); i++) {
					const v = vars[i]!;
					const rhs = init[i];
					if (isFunctionNode(rhs)) {
						const ann = sluaTypeFromLuauAnnotationText(rhs.returnTypeAnnotation);
						const count = ann.kind === 'primitive' && ann.name !== 'unknown' ? 1 : inferLocalFunctionReturnCountFromBody(rhs.body, env, registry);
						env.set(v.name, count);
					}
				}

				// Avoid warning on `local x` (no RHS); it's idiomatic and initializes to nil.
				if (init.length > 0) {
					const rhsCount = assignmentProducedCount(init, env, registry);
					if (rhsCount !== null) warnCountMismatch(diags, stmt, lhsCount, rhsCount);
				}
				continue;
			}

			if (isAssignmentStatement(stmt)) {
				const lhsCount = stmt.variables.length;
				const init = stmt.init;
				if (init.length > 0) {
					const rhsCount = assignmentProducedCount(init, env, registry);
					if (rhsCount !== null) warnCountMismatch(diags, stmt, lhsCount, rhsCount);
				}
				continue;
			}

			if (isIfStatement(stmt)) {
				visitStatements(stmt.consequent);
				const alt = stmt.alternate;
				if (Array.isArray(alt)) visitStatements(alt);
				else if (isAstNode(alt) && alt.type === 'IfStatement') visitStatements([alt]);
				continue;
			}

			// Generic recurse.
			if (isRecord(stmt)) {
				const stmtRec = stmt as Record<string, unknown>;
				if (Array.isArray(stmtRec.body)) visitStatements(stmtRec.body);
				if (Array.isArray(stmtRec.consequent)) visitStatements(stmtRec.consequent);
				if (Array.isArray(stmtRec.alternate)) visitStatements(stmtRec.alternate);
				if (isAstNode(stmtRec.alternate) && stmtRec.alternate.type === 'IfStatement') visitStatements([stmtRec.alternate]);
			}
		}
		env.popScope();
	}

	visitStatements(ast.body);
	return diags;
}
