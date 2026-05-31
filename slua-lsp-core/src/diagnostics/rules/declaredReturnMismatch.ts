import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';
import { slua, sluaTypeEquals, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable, sluaTypeToString } from '../../slua/types.js';

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

type GenericForStatementNode = AstNode & { type: 'GenericForStatement'; variables: unknown[]; iterators: unknown[]; body: unknown[] };

type IfExpressionNode = AstNode & { type: 'IfExpression'; test: unknown; consequent: unknown; alternate: unknown };

type TypeCastExpressionNode = AstNode & { type: 'TypeCastExpression'; expression: unknown; typeAnnotation?: string };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type StringNode = AstNode & { type: 'String'; value: string };

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

function isIfStatement(v: unknown): v is IfStatementNode {
	return isAstNode(v) && v.type === 'IfStatement' && Array.isArray((v as Record<string, unknown>)['consequent']);
}

function isGenericForStatement(v: unknown): v is GenericForStatementNode {
	return isAstNode(v) && v.type === 'GenericForStatement' && Array.isArray((v as Record<string, unknown>)['variables']) && Array.isArray((v as Record<string, unknown>)['iterators']) && Array.isArray((v as Record<string, unknown>)['body']);
}

function isIfExpression(v: unknown): v is IfExpressionNode {
	return isAstNode(v) && v.type === 'IfExpression' && 'consequent' in v && 'alternate' in v;
}

function isTypeCastExpression(v: unknown): v is TypeCastExpressionNode {
	return isAstNode(v) && v.type === 'TypeCastExpression' && 'expression' in v;
}

function isCallExpression(v: unknown): v is CallExpressionNode {
	return isAstNode(v) && v.type === 'CallExpression' && Array.isArray((v as Record<string, unknown>)['arguments']);
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

function isStringNode(v: unknown): v is StringNode {
	return isAstNode(v) && v.type === 'String' && typeof (v as Record<string, unknown>)['value'] === 'string';
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

function mergeBranchTypes(a: SluaType, b: SluaType): SluaType {
	if (sluaTypeEquals(a, b)) return a;
	if ((a.kind === 'primitive' && a.name === 'unknown') || (b.kind === 'primitive' && b.name === 'unknown')) return slua.unknown();
	return slua.union([a, b]);
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

	if (isIfExpression(expr)) {
		const consequent = inferExpression(expr.consequent, env, registry).values[0] ?? slua.unknown();
		const alternate = inferExpression(expr.alternate, env, registry).values[0] ?? slua.unknown();
		return { values: [mergeBranchTypes(consequent, alternate)], expands: false };
	}

	if (isTypeCastExpression(expr)) {
		const annotated = sluaTypeFromLuauAnnotationText(expr.typeAnnotation);
		if (!(annotated.kind === 'primitive' && annotated.name === 'unknown')) return { values: [annotated], expands: false };
		return inferExpression(expr.expression, env, registry);
	}

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
		// Prefer env bindings, including member function declarations (normalized as `obj.foo`).
		const calleeKey = exprNameKey(expr.callee);
		if (calleeKey) {
			const local = env.get(calleeKey);
			if (local && local.kind === 'function') calleeSig = local;
		}
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
		if (!calleeSig && isIndexExpression(expr.callee) && isIdentifier(expr.callee.object) && isStringNode(expr.callee.index)) {
			const receiver = expr.callee.object.name;
			const key = expr.callee.index.value;
			const mod = registry.getModule(receiver);
			if (mod) {
				const fn = mod.functions[key];
				if (fn) calleeSig = fn.signature;
			}
			const objType = registry.getObjectType(receiver);
			if (!calleeSig && objType) {
				const method = objType.methods[key];
				if (method) calleeSig = method.signature;
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

function producedCount(exprs: unknown[], env: Env, registry: SluaRegistry): number {
	if (exprs.length === 0) return 1;
	if (exprs.length === 1) {
		const m = inferExpression(exprs[0], env, registry);
		return m.expands ? m.values.length : 1;
	}
	const last = inferExpression(exprs[exprs.length - 1], env, registry);
	return (exprs.length - 1) + (last.expands ? last.values.length : 1);
}

function declaredReturnSlots(declared: SluaType): { count: number; slots: SluaType[] } {
	if (declared.kind === 'tuple') return { count: declared.items.length, slots: declared.items };
	return { count: 1, slots: [declared] };
}

function isKnownNonUnknown(t: SluaType): boolean {
	return !(t.kind === 'primitive' && t.name === 'unknown');
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

function functionNameForMessage(fn: FunctionDeclarationNode | FunctionNode): string {
	if (isFunctionDeclaration(fn) && fn.identifier) {
		const key = exprNameKey(fn.identifier);
		if (key) return key;
	}
	return 'function';
}

function checkFunctionAgainstDeclared(
	fn: FunctionDeclarationNode | FunctionNode,
	declared: SluaType,
	outerEnv: Env,
	registry: SluaRegistry,
	diags: CoreDiagnostic[]
): void {
	const { count: declaredCount, slots: declaredSlots } = declaredReturnSlots(declared);
	const fnEnv = outerEnv.clone();
	let sawReturn = false;

	function warnCount(node: AstNode, actualCount: number): void {
		diags.push({
			code: 'declared-return-count-mismatch',
			severity: 'warning',
			message: `${functionNameForMessage(fn)} declares ${declaredCount} return value(s) but returns ${actualCount} here.`,
			range: rangeFromNode(node)
		});
	}

	function warnType(node: AstNode, index: number, actual: SluaType): void {
		const expected = declaredSlots[index] ?? slua.unknown();
		diags.push({
			code: 'declared-return-type-mismatch',
			severity: 'warning',
			message: `${functionNameForMessage(fn)} declares return #${index + 1} as '${sluaTypeToString(expected)}' but returns '${sluaTypeToString(actual)}' here.`,
			range: rangeFromNode(node)
		});
	}

	function visitStatements(stmts: unknown[]): void {
		fnEnv.pushScope();
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			// Track locals so `return x` can be compared meaningfully.
			if (isLocalStatement(stmt)) {
				const vars = stmt.variables.filter(isIdentifier);
				const inferred = inferAssignmentValues(stmt.init, vars.length, fnEnv, registry);
				for (let i = 0; i < vars.length; i++) {
					const v = vars[i]!;
					const ann = sluaTypeFromLuauAnnotationText(v.typeAnnotation);
					fnEnv.set(v.name, ann.kind === 'primitive' && ann.name === 'unknown' ? (inferred[i] ?? slua.unknown()) : ann);
				}

				// If we have `local f = function(): T ... end`, track its signature and validate it.
				const init = stmt.init ?? [];
				for (let i = 0; i < Math.min(vars.length, init.length); i++) {
					const v = vars[i]!;
					const rhs = init[i];
					if (!isFunctionNode(rhs)) continue;
					const ret = sluaTypeFromLuauAnnotationText(rhs.returnTypeAnnotation);
					fnEnv.set(v.name, slua.fn([], ret));
					if (rhs.returnTypeAnnotation) checkFunctionAgainstDeclared(rhs, ret, fnEnv, registry, diags);
				}
				continue;
			}

			if (isAssignmentStatement(stmt)) {
				const targets = stmt.variables;
				const inferred = inferAssignmentValues(stmt.init, targets.length, fnEnv, registry);
				for (let i = 0; i < targets.length; i++) {
					const t = targets[i];
					if (!isIdentifier(t)) continue;
					fnEnv.updateIfUnknown(t.name, inferred[i] ?? slua.unknown());
				}
				continue;
			}

			if (isFunctionDeclaration(stmt)) {
				// Track nested locals with their declared return type if present.
				if (stmt.identifier) {
					const key = exprNameKey(stmt.identifier);
					if (key) {
						const ret = sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation);
						fnEnv.set(key, slua.fn([], ret));
						if (stmt.returnTypeAnnotation) checkFunctionAgainstDeclared(stmt, ret, fnEnv, registry, diags);
					}
				}
				// Don’t traverse the body here; it’s validated above if annotated.
				continue;
			}

			if (isReturnStatement(stmt)) {
				sawReturn = true;
				const actualCount = producedCount(stmt.arguments, fnEnv, registry);
				if (actualCount !== declaredCount) warnCount(stmt, actualCount);
				const actualSlots = inferAssignmentValues(stmt.arguments, declaredCount, fnEnv, registry);
				for (let i = 0; i < declaredCount; i++) {
					const expected = declaredSlots[i] ?? slua.unknown();
					const actual = actualSlots[i] ?? slua.unknown();
					if (!isKnownNonUnknown(expected) || !isKnownNonUnknown(actual)) continue;
					if (!sluaTypeIsAssignable(expected, actual)) warnType(stmt, i, actual);
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

			if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) inferExpression(iterator, fnEnv, registry);
				fnEnv.pushScope();
				for (const variable of stmt.variables) {
					if (isIdentifier(variable)) fnEnv.set(variable.name, slua.unknown());
				}
				visitStatements(stmt.body);
				fnEnv.popScope();
				continue;
			}

			const r = stmt as Record<string, unknown>;
			if (Array.isArray(r['body'])) visitStatements(r['body'] as unknown[]);
			if (Array.isArray(r['consequent'])) visitStatements(r['consequent'] as unknown[]);
			if (Array.isArray(r['alternate'])) visitStatements(r['alternate'] as unknown[]);
		}
		fnEnv.popScope();
	}

	const body = (fn as Record<string, unknown>).body;
	if (Array.isArray(body)) visitStatements(body);

	if (!sawReturn) {
		// Lua: no explicit return => returns one nil.
		const actualCount = 1;
		if (actualCount !== declaredCount) warnCount(fn, actualCount);
		const expected0 = declaredSlots[0] ?? slua.unknown();
		if (declaredCount >= 1 && isKnownNonUnknown(expected0) && !sluaTypeEquals(expected0, slua.nil())) {
			warnType(fn, 0, slua.nil());
		}
	}
}

export function ruleDeclaredReturnMismatch(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];
	const env = new Env();

	function applyStatement(stmt: AstNode): void {
		if (isLocalStatement(stmt)) {
			const vars = stmt.variables.filter(isIdentifier);
			const inferred = inferAssignmentValues(stmt.init, vars.length, env, registry);
			for (let i = 0; i < vars.length; i++) {
				const v = vars[i]!;
				const ann = sluaTypeFromLuauAnnotationText(v.typeAnnotation);
				env.set(v.name, ann.kind === 'primitive' && ann.name === 'unknown' ? (inferred[i] ?? slua.unknown()) : ann);
			}
			// Track `local f = function(): T ... end`.
			const init = stmt.init ?? [];
			for (let i = 0; i < Math.min(vars.length, init.length); i++) {
				const v = vars[i]!;
				const rhs = init[i];
				if (!isFunctionNode(rhs)) continue;
				const ret = sluaTypeFromLuauAnnotationText(rhs.returnTypeAnnotation);
				env.set(v.name, slua.fn([], ret));
				if (rhs.returnTypeAnnotation) checkFunctionAgainstDeclared(rhs, ret, env, registry, diags);
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
			if (stmt.identifier) {
				const key = exprNameKey(stmt.identifier);
				if (key) {
					const ret = sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation);
					env.set(key, slua.fn([], ret));
				}
			}
			if (stmt.returnTypeAnnotation) {
				const declared = sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation);
				checkFunctionAgainstDeclared(stmt, declared, env, registry, diags);
			}
			return;
		}

		if (isIfStatement(stmt)) {
			env.pushScope();
			for (const s of stmt.consequent) if (isAstNode(s)) applyStatement(s);
			env.popScope();
			const alt = stmt.alternate;
			if (Array.isArray(alt)) {
				env.pushScope();
				for (const s of alt) if (isAstNode(s)) applyStatement(s);
				env.popScope();
			}
			return;
		}

		if (isGenericForStatement(stmt)) {
			for (const iterator of stmt.iterators) inferExpression(iterator, env, registry);
			env.pushScope();
			for (const variable of stmt.variables) {
				if (isIdentifier(variable)) env.set(variable.name, slua.unknown());
			}
			for (const s of stmt.body) if (isAstNode(s)) applyStatement(s);
			env.popScope();
			return;
		}

		const r = stmt as Record<string, unknown>;
		if (Array.isArray(r['body'])) {
			env.pushScope();
			for (const s of r['body'] as unknown[]) if (isAstNode(s)) applyStatement(s);
			env.popScope();
		}
	}

	for (const s of ast.body) if (isAstNode(s)) applyStatement(s);
	return diags;
}
