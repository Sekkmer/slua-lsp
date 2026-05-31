import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';
import { slua, sluaTypeEquals, sluaTypeFromLuauAnnotationText, sluaTypeToString } from '../../slua/types.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

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

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type BinaryExpressionNode = AstNode & { type: 'BinaryExpression'; operator: string; left: unknown; right: unknown };

type UnaryExpressionNode = AstNode & { type: 'UnaryExpression'; operator: string; argument: unknown };

type StringNode = AstNode & { type: 'String'; value: string };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type FunctionNode = AstNode & { type: 'Function'; parameters: unknown[]; body: unknown[]; returnTypeAnnotation?: string };

type ReturnStatementNode = AstNode & { type: 'ReturnStatement'; arguments: unknown[] };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type NumberNode = AstNode & { type: 'Number'; value: number };

type BooleanNode = AstNode & { type: 'Boolean'; value: boolean };

type NilNode = AstNode & { type: 'Nil' };

type TableNode = AstNode & { type: 'Table' };

function rangeFromNode(node: AstNode): Range {
	const loc = node.location;
	if (!loc) return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

function isAstNode(v: unknown): v is AstNode {
	if (!isRecord(v)) return false;
	return typeof v['type'] === 'string';
}

function isProgram(v: unknown): v is ProgramNode {
	return isAstNode(v) && v.type === 'Program' && Array.isArray((v as Record<string, unknown>)['body']);
}

function isIdentifier(v: unknown): v is IdentifierNode {
	return isAstNode(v) && v.type === 'Identifier' && typeof (v as Record<string, unknown>)['name'] === 'string';
}

function isStringNode(v: unknown): v is StringNode {
	return isAstNode(v) && v.type === 'String' && typeof (v as Record<string, unknown>)['value'] === 'string';
}

function isLocalStatement(v: unknown): v is LocalStatementNode {
	return isAstNode(v) && v.type === 'LocalStatement' && Array.isArray((v as Record<string, unknown>)['variables']);
}

function isAssignmentStatement(v: unknown): v is AssignmentStatementNode {
	return (
		isAstNode(v) &&
        v.type === 'AssignmentStatement' &&
        Array.isArray((v as Record<string, unknown>)['variables']) &&
        Array.isArray((v as Record<string, unknown>)['init'])
	);
}

function isFunctionDeclaration(v: unknown): v is FunctionDeclarationNode {
	return (
		isAstNode(v) &&
        v.type === 'FunctionDeclaration' &&
        typeof (v as Record<string, unknown>)['isLocal'] === 'boolean' &&
        Array.isArray((v as Record<string, unknown>)['body'])
	);
}

function isIfStatement(v: unknown): v is IfStatementNode {
	return isAstNode(v) && v.type === 'IfStatement' && Array.isArray((v as Record<string, unknown>)['consequent']);
}

function isCallExpression(v: unknown): v is CallExpressionNode {
	return isAstNode(v) && v.type === 'CallExpression' && Array.isArray((v as Record<string, unknown>)['arguments']);
}

function isBinaryExpression(v: unknown): v is BinaryExpressionNode {
	return isAstNode(v) && v.type === 'BinaryExpression' && typeof (v as Record<string, unknown>)['operator'] === 'string';
}

function isUnaryExpression(v: unknown): v is UnaryExpressionNode {
	return isAstNode(v) && v.type === 'UnaryExpression' && typeof (v as Record<string, unknown>)['operator'] === 'string';
}

function isFunctionNode(v: unknown): v is FunctionNode {
	return (
		isAstNode(v) &&
        v.type === 'Function' &&
        Array.isArray((v as Record<string, unknown>)['parameters']) &&
        Array.isArray((v as Record<string, unknown>)['body'])
	);
}

function isReturnStatement(v: unknown): v is ReturnStatementNode {
	return isAstNode(v) && v.type === 'ReturnStatement' && Array.isArray((v as Record<string, unknown>)['arguments']);
}

function isMemberExpression(v: unknown): v is MemberExpressionNode {
	if (!isAstNode(v) || v.type !== 'MemberExpression') return false;
	const r = v as Record<string, unknown>;
	return 'object' in r && 'property' in r;
}

function isIndexExpression(v: unknown): v is IndexExpressionNode {
	if (!isAstNode(v) || v.type !== 'IndexExpression') return false;
	const r = v as Record<string, unknown>;
	return 'object' in r && 'index' in r;
}

function isNumberNode(v: unknown): v is NumberNode {
	return isAstNode(v) && v.type === 'Number' && typeof (v as Record<string, unknown>)['value'] === 'number';
}

function isBooleanNode(v: unknown): v is BooleanNode {
	return isAstNode(v) && v.type === 'Boolean' && typeof (v as Record<string, unknown>)['value'] === 'boolean';
}

function isNilNode(v: unknown): v is NilNode {
	return isAstNode(v) && v.type === 'Nil';
}

function isTableNode(v: unknown): v is TableNode {
	return isAstNode(v) && v.type === 'Table';
}

class Env {
	private readonly scopes: Array<Map<string, SluaType>> = [new Map()];

	clone(): Env {
		const e = new Env();
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

	get(name: string): SluaType | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const v = this.scopes[i]!.get(name);
			if (v) return v;
		}
		return undefined;
	}

	set(name: string, t: SluaType): void {
        this.scopes[this.scopes.length - 1]!.set(name, t);
	}

	updateIfUnknown(name: string, t: SluaType): void {
		const existing = this.get(name);
		if (!existing || (existing.kind === 'primitive' && existing.name === 'unknown')) this.set(name, t);
	}
}

type Multi = { values: SluaType[]; expands: boolean };

function inferExpression(expr: unknown, env: Env, registry: SluaRegistry): Multi {
	if (!isAstNode(expr)) return { values: [slua.unknown()], expands: false };
	if (isStringNode(expr)) return { values: [slua.string()], expands: false };
	if (isNumberNode(expr)) return { values: [slua.number()], expands: false };
	if (isBooleanNode(expr)) return { values: [slua.boolean()], expands: false };
	if (isNilNode(expr)) return { values: [slua.nil()], expands: false };
	if (isTableNode(expr)) return { values: [slua.table()], expands: false };

	if (isIdentifier(expr)) {
		const local = env.get(expr.name);
		if (local) return { values: [local], expands: false };
		const g = registry.getGlobal(expr.name);
		if (g) return { values: [g.signature], expands: false };
		if (registry.getModule(expr.name)) return { values: [slua.table()], expands: false };
		if (registry.getObjectType(expr.name)) return { values: [slua.table()], expands: false };
		return { values: [slua.unknown()], expands: false };
	}

	if (isFunctionNode(expr)) {
		const paramTypes = expr.parameters.map((p) => (isIdentifier(p) ? sluaTypeFromLuauAnnotationText(p.typeAnnotation) : slua.unknown()));
		const annotatedReturn = sluaTypeFromLuauAnnotationText(expr.returnTypeAnnotation);
		return { values: [slua.fn(paramTypes, annotatedReturn)], expands: false };
	}

	if (isCallExpression(expr)) {
		let calleeSig: SluaType | null = null;
		if (isIdentifier(expr.callee)) {
			const local = env.get(expr.callee.name);
			if (local && local.kind === 'function') calleeSig = local;
			else {
				const g = registry.getGlobal(expr.callee.name);
				if (g) calleeSig = g.signature;
			}
		}
		if (!calleeSig && isMemberExpression(expr.callee) && isIdentifier(expr.callee.object) && isIdentifier(expr.callee.property)) {
			const receiver = expr.callee.object.name;
			const member = expr.callee.property.name;
			const objType = registry.getObjectType(receiver);
			if (objType) {
				const method = objType.methods[member];
				if (method) calleeSig = method.signature;
			}
			const mod = registry.getModule(receiver);
			if (!calleeSig && mod) {
				const fn = mod.functions[member];
				if (fn) calleeSig = fn.signature;
			}
		}
		if (!calleeSig || calleeSig.kind !== 'function') return { values: [slua.unknown()], expands: false };
		const returns = calleeSig.returns;
		if (returns.kind === 'tuple') return { values: returns.items, expands: true };
		return { values: [returns], expands: false };
	}

	if (isMemberExpression(expr) && isIdentifier(expr.object) && isIdentifier(expr.property)) {
		const receiver = expr.object.name;
		const member = expr.property.name;
		const objType = registry.getObjectType(receiver);
		if (objType) {
			const method = objType.methods[member];
			if (method) return { values: [method.signature], expands: false };
			const prop = objType.properties[member];
			if (prop) return { values: [prop.type], expands: false };
		}
		const mod = registry.getModule(receiver);
		if (mod) {
			const fn = mod.functions[member];
			if (fn) return { values: [fn.signature], expands: false };
			const v = mod.values[member];
			if (v) return { values: [v.type], expands: false };
		}
		return { values: [slua.unknown()], expands: false };
	}

	if (isIndexExpression(expr) && isIdentifier(expr.object) && isStringNode(expr.index)) {
		const receiver = expr.object.name;
		const key = expr.index.value;
		const mod = registry.getModule(receiver);
		if (mod) {
			const fn = mod.functions[key];
			if (fn) return { values: [fn.signature], expands: false };
			const v = mod.values[key];
			if (v) return { values: [v.type], expands: false };
		}
		const objType = registry.getObjectType(receiver);
		if (objType) {
			const method = objType.methods[key];
			if (method) return { values: [method.signature], expands: false };
			const prop = objType.properties[key];
			if (prop) return { values: [prop.type], expands: false };
		}
		return { values: [slua.unknown()], expands: false };
	}

	return { values: [slua.unknown()], expands: false };
}

function inferAssignmentValues(init: unknown[] | undefined, count: number, env: Env, registry: SluaRegistry): SluaType[] {
	if (!init || init.length === 0) return new Array(count).fill(slua.nil());
	const rhs = init;
	const out: SluaType[] = [];
	for (let i = 0; i < count; i++) {
		if (i < rhs.length - 1) {
			out.push(inferExpression(rhs[i], env, registry).values[0] ?? slua.unknown());
			continue;
		}
		const tailIndex = i - (rhs.length - 1);
		const last = inferExpression(rhs[rhs.length - 1], env, registry);
		if (!last.expands) {
			out.push(tailIndex === 0 ? (last.values[0] ?? slua.unknown()) : slua.nil());
			continue;
		}
		out.push(last.values[tailIndex] ?? slua.nil());
	}
	return out;
}

function sluaTypeToTypeName(t: SluaType): string | null {
	if (t.kind === 'primitive') {
		// Note: Lua's `type()` never returns "unknown".
		return t.name === 'unknown' ? null : t.name;
	}
	if (t.kind === 'table') return 'table';
	if (t.kind === 'function') return 'function';
	// Be conservative for custom/tuple/array.
	return null;
}

function sluaTypeToTypeofName(t: SluaType): string | null {
	if (t.kind === 'primitive') return t.name === 'unknown' ? null : t.name;
	if (t.kind === 'custom') return t.name;
	if (t.kind === 'table') return 'table';
	if (t.kind === 'function') return 'function';
	return null;
}

function typeNameToSluaType(name: string): SluaType | null {
	switch (name) {
		case 'string':
			return slua.string();
		case 'number':
			return slua.number();
		case 'boolean':
			return slua.boolean();
		case 'nil':
			return slua.nil();
		case 'table':
			return slua.table();
		case 'function':
			return slua.fn([], slua.unknown());
		case 'thread':
			return slua.thread();
		default:
			return null;
	}
}

function typeofNameToSluaType(name: string): SluaType | null {
	// In SLua, `typeof()` is often used for custom runtime types.
	return (
		typeNameToSluaType(name) ??
        (name === 'uuid' ? slua.uuid() : null) ??
        (name === 'vector' ? slua.vector() : null) ??
        (name === 'rotation' ? slua.rotation() : null) ??
        // SLua runtime reports typeof(rotationValue) == "quaternion".
        (name === 'quaternion' ? slua.rotation() : null) ??
        (name === 'integer' ? slua.integer() : null) ??
        (name === 'thread' ? slua.thread() : null)
	);
}

type TypeGuard = { kind: 'type' | 'typeof'; varName: string; asserted: SluaType; isEqual: boolean; node: AstNode };

function parseTypeGuard(expr: unknown): TypeGuard | null {
	if (!isBinaryExpression(expr)) return null;
	const op = expr.operator;
	if (op !== '==' && op !== '~=') return null;
	const isEqual = op === '==';

	function unwrap(call: unknown, other: unknown): TypeGuard | null {
		if (!isCallExpression(call) || !isStringNode(other)) return null;
		if (!isIdentifier(call.callee)) return null;
		const calleeName = call.callee.name;
		if (calleeName !== 'type' && calleeName !== 'typeof') return null;
		if (call.arguments.length !== 1) return null;
		const arg = call.arguments[0];
		if (!isIdentifier(arg)) return null;
		const asserted = calleeName === 'type' ? typeNameToSluaType(other.value) : typeofNameToSluaType(other.value);
		if (!asserted) return null;
		return { kind: calleeName, varName: arg.name, asserted, isEqual, node: expr as AstNode };
	}

	return unwrap(expr.left, expr.right) ?? unwrap(expr.right, expr.left);
}

function parseTypeGuardOrNegated(expr: unknown): TypeGuard | null {
	const direct = parseTypeGuard(expr);
	if (direct) return direct;
	if (isUnaryExpression(expr) && expr.operator === 'not') {
		const inner = parseTypeGuard(expr.argument);
		if (!inner) return null;
		// not (A == B)  <=> (A ~= B)
		// not (A ~= B) <=> (A == B)
		return { ...inner, isEqual: !inner.isEqual, node: expr as AstNode };
	}
	return null;
}

function collectTypeGuards(expr: unknown): TypeGuard[] {
	// Conservative: walk `and`/`or` trees and pick out guard leaves.
	// (We intentionally avoid trying to prove anything about the whole expression.)
	if (isBinaryExpression(expr) && (expr.operator === 'and' || expr.operator === 'or')) {
		return [...collectTypeGuards(expr.left), ...collectTypeGuards(expr.right)];
	}
	if (isUnaryExpression(expr) && expr.operator === 'not') {
		// Prefer a single negated guard if present; else keep searching.
		const neg = parseTypeGuardOrNegated(expr);
		return neg ? [neg] : collectTypeGuards(expr.argument);
	}
	const g = parseTypeGuardOrNegated(expr);
	return g ? [g] : [];
}

function inferFunctionReturns(body: unknown[], env: Env, registry: SluaRegistry): SluaType {
	let hasAny = false;
	let merged: SluaType | null = null;

	function merge(t: SluaType): void {
		if (!hasAny) {
			hasAny = true;
			merged = t;
			return;
		}
		if (!merged) {
			merged = t;
			return;
		}
		merged = sluaTypeEquals(merged, t) ? merged : slua.unknown();
	}

	function visitStatements(stmts: unknown[]): void {
		env.pushScope();
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;
			if (isLocalStatement(stmt)) {
				const vars = stmt.variables.filter(isIdentifier);
				const inferred = inferAssignmentValues(stmt.init, vars.length, env, registry);
				for (let i = 0; i < vars.length; i++) {
					const v = vars[i]!;
					const ann = sluaTypeFromLuauAnnotationText(v.typeAnnotation);
					env.set(v.name, ann.kind === 'primitive' && ann.name === 'unknown' ? (inferred[i] ?? slua.unknown()) : ann);
				}
				continue;
			}
			if (isAssignmentStatement(stmt)) {
				const targets = stmt.variables;
				const inferred = inferAssignmentValues(stmt.init, targets.length, env, registry);
				for (let i = 0; i < targets.length; i++) {
					const t = targets[i];
					if (!isIdentifier(t)) continue;
					env.updateIfUnknown(t.name, inferred[i] ?? slua.unknown());
				}
				continue;
			}
			if (isFunctionDeclaration(stmt)) {
				if (stmt.isLocal && stmt.identifier && isIdentifier(stmt.identifier)) {
					env.set(stmt.identifier.name, slua.fn([], slua.unknown()));
				}
				continue;
			}
			if (isReturnStatement(stmt)) {
				const first = stmt.arguments[0];
				merge(inferExpression(first, env, registry).values[0] ?? slua.unknown());
				continue;
			}
			const r = stmt as Record<string, unknown>;
			if (Array.isArray(r['body'])) visitStatements(r['body'] as unknown[]);
			if (Array.isArray(r['consequent'])) visitStatements(r['consequent'] as unknown[]);
			if (Array.isArray(r['alternate'])) visitStatements(r['alternate'] as unknown[]);
		}
		env.popScope();
	}

	visitStatements(body);
	return merged ?? slua.nil();
}

export function ruleTypeGuardConditions(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];
	const rootEnv = new Env();

	function warnAlways(node: AstNode, truth: boolean, kind: 'type' | 'typeof', varName: string, asserted: SluaType, known: SluaType): void {
		const assertedName = sluaTypeToString(asserted);
		const knownName = sluaTypeToString(known);
		diags.push({
			code: truth ? 'type-guard-always-true' : 'type-guard-always-false',
			severity: 'warning',
			message: `Condition is always ${truth ? 'true' : 'false'}: ${kind}(${varName}) is '${knownName}' here, compared to '${assertedName}'.`,
			range: rangeFromNode(node)
		});
	}

	function visitBlock(stmts: unknown[], env: Env): void {
		env.pushScope();
		for (const s of stmts) if (isAstNode(s)) applyStatement(s, env);
		env.popScope();
	}

	function applyStatement(stmt: AstNode, env: Env): void {
		if (isLocalStatement(stmt)) {
			const vars = stmt.variables.filter(isIdentifier);
			const inferred = inferAssignmentValues(stmt.init, vars.length, env, registry);
			for (let i = 0; i < vars.length; i++) {
				const v = vars[i]!;
				const ann = sluaTypeFromLuauAnnotationText(v.typeAnnotation);
				const t = ann.kind === 'primitive' && ann.name === 'unknown' ? (inferred[i] ?? slua.unknown()) : ann;
				env.set(v.name, t);
			}
			return;
		}
		if (isAssignmentStatement(stmt)) {
			const targets = stmt.variables;
			const inferred = inferAssignmentValues(stmt.init, targets.length, env, registry);
			for (let i = 0; i < targets.length; i++) {
				const t = targets[i];
				if (!isIdentifier(t)) continue;
				env.updateIfUnknown(t.name, inferred[i] ?? slua.unknown());
			}
			return;
		}
		if (isFunctionDeclaration(stmt)) {
			if (!stmt.isLocal || !stmt.identifier || !isIdentifier(stmt.identifier)) return;
			// Best-effort function type; return inference isn’t needed for guard truthiness.
			const returns = inferFunctionReturns(stmt.body, env.clone(), registry);
			env.set(stmt.identifier.name, slua.fn([], returns));
			return;
		}
		if (isIfStatement(stmt)) {
			const guards = collectTypeGuards(stmt.test);
			for (const guard of guards) {
				const known = env.get(guard.varName);
				const knownName =
                    known && guard.kind === 'type' ? sluaTypeToTypeName(known) : known && guard.kind === 'typeof' ? sluaTypeToTypeofName(known) : null;
				const assertedName = guard.kind === 'type' ? sluaTypeToTypeName(guard.asserted) : sluaTypeToTypeofName(guard.asserted);
				if (known && knownName && assertedName) {
					const match = knownName === assertedName;
					const truth = guard.isEqual ? match : !match;
					warnAlways(guard.node, truth, guard.kind, guard.varName, guard.asserted, known);
				}
			}

			// Best-effort branch narrowing: only apply a single, top-level guard.
			const top = parseTypeGuard(stmt.test);
			if (top) {
				const thenEnv = env.clone();
				const elseEnv = env.clone();
				if (top.isEqual) thenEnv.set(top.varName, top.asserted);
				else elseEnv.set(top.varName, top.asserted);
				visitBlock(stmt.consequent, thenEnv);
				const alt = stmt.alternate;
				if (Array.isArray(alt)) visitBlock(alt, elseEnv);
				else if (isAstNode(alt) && alt.type === 'IfStatement') applyStatement(alt, elseEnv);
				return;
			}

			// No recognized guard: still recurse.
			visitBlock(stmt.consequent, env.clone());
			const alt = stmt.alternate;
			if (Array.isArray(alt)) visitBlock(alt, env.clone());
			else if (isAstNode(alt) && alt.type === 'IfStatement') applyStatement(alt, env.clone());
			return;
		}

		// Generic recurse.
		const r = stmt as Record<string, unknown>;
		if (Array.isArray(r['body'])) visitBlock(r['body'] as unknown[], env);
		if (Array.isArray(r['consequent'])) visitBlock(r['consequent'] as unknown[], env);
		if (Array.isArray(r['alternate'])) visitBlock(r['alternate'] as unknown[], env);
	}

	rootEnv.pushScope();
	for (const stmt of ast.body) if (isAstNode(stmt)) applyStatement(stmt, rootEnv);
	rootEnv.popScope();

	return diags;
}
