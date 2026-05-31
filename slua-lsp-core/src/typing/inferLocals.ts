import type { SluaRegistry } from '../slua/registry.js';
import type { SluaType } from '../slua/types.js';
import { slua, sluaTypeEquals, sluaTypeFromLuauAnnotationText } from '../slua/types.js';
import { defaultMetatableRegistry, getSpecificMultiplicationReturnType, getSpecificDivisionReturnType } from '../slua/metatables.js';

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

type _ExpressionNode = AstNode;

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown; indexer?: '.' | ':' };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type BinaryExpressionNode = AstNode & { type: 'BinaryExpression'; operator: string; left: unknown; right: unknown };

type UnaryExpressionNode = AstNode & { type: 'UnaryExpression'; operator: string; argument: unknown };

type VarargLiteralNode = AstNode & { type: 'VarargLiteral' };

type TableNode = AstNode & { type: 'Table' };

type StringNode = AstNode & { type: 'String'; value: string };

type NumberNode = AstNode & { type: 'Number'; value: number };

type BooleanNode = AstNode & { type: 'Boolean'; value: boolean };

type NilNode = AstNode & { type: 'Nil' };

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

type GenericForStatementNode = AstNode & { type: 'GenericForStatement'; variables: unknown[]; iterators: unknown[]; body: unknown[] };

type IfExpressionNode = AstNode & { type: 'IfExpression'; test: unknown; consequent: unknown; alternate: unknown };

type TypeCastExpressionNode = AstNode & { type: 'TypeCastExpression'; expression: unknown; typeAnnotation?: string };

export type InferredLocal = {
    name: string;
    identifier: IdentifierNode;
    type: SluaType;
};

type Multi = { values: SluaType[]; expands: boolean };

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

function isReturnStatement(value: unknown): value is ReturnStatementNode {
	return isAstNode(value) && value.type === 'ReturnStatement' && Array.isArray((value as Record<string, unknown>).arguments);
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression' && 'object' in value && 'property' in value;
}

function isIndexExpression(value: unknown): value is IndexExpressionNode {
	return isAstNode(value) && value.type === 'IndexExpression' && 'object' in value && 'index' in value;
}

function isCallExpression(value: unknown): value is CallExpressionNode {
	return isAstNode(value) && value.type === 'CallExpression' && Array.isArray((value as Record<string, unknown>).arguments) && 'callee' in value;
}

function isBinaryExpression(value: unknown): value is BinaryExpressionNode {
	return isAstNode(value) && value.type === 'BinaryExpression' && typeof (value as Record<string, unknown>).operator === 'string';
}

function isUnaryExpression(value: unknown): value is UnaryExpressionNode {
	return isAstNode(value) && value.type === 'UnaryExpression' && typeof (value as Record<string, unknown>).operator === 'string';
}

function isVarargLiteral(value: unknown): value is VarargLiteralNode {
	return isAstNode(value) && value.type === 'VarargLiteral';
}

function isTableNode(value: unknown): value is TableNode {
	return isAstNode(value) && value.type === 'Table';
}

function isStringNode(value: unknown): value is StringNode {
	return isAstNode(value) && value.type === 'String' && typeof (value as Record<string, unknown>).value === 'string';
}

function isNumberNode(value: unknown): value is NumberNode {
	return isAstNode(value) && value.type === 'Number' && typeof (value as Record<string, unknown>).value === 'number';
}

function isBooleanNode(value: unknown): value is BooleanNode {
	return isAstNode(value) && value.type === 'Boolean' && typeof (value as Record<string, unknown>).value === 'boolean';
}

function isNilNode(value: unknown): value is NilNode {
	return isAstNode(value) && value.type === 'Nil';
}

function isIfStatement(value: unknown): value is IfStatementNode {
	return isAstNode(value) && value.type === 'IfStatement' && Array.isArray((value as Record<string, unknown>).consequent);
}

function isGenericForStatement(value: unknown): value is GenericForStatementNode {
	return isAstNode(value) && value.type === 'GenericForStatement' && Array.isArray((value as Record<string, unknown>).variables) && Array.isArray((value as Record<string, unknown>).iterators) && Array.isArray((value as Record<string, unknown>).body);
}

function isIfExpression(value: unknown): value is IfExpressionNode {
	return isAstNode(value) && value.type === 'IfExpression' && 'consequent' in value && 'alternate' in value;
}

function isTypeCastExpression(value: unknown): value is TypeCastExpressionNode {
	return isAstNode(value) && value.type === 'TypeCastExpression' && 'expression' in value;
}

function mergeBranchTypes(a: SluaType, b: SluaType): SluaType {
	if (sluaTypeEquals(a, b)) return a;
	if ((a.kind === 'primitive' && a.name === 'unknown') || (b.kind === 'primitive' && b.name === 'unknown')) return slua.unknown();
	return slua.union([a, b]);
}

type TypeGuard = { kind: 'type' | 'typeof'; varName: string; asserted: SluaType; isEqual: boolean };

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

function inferCustomMemberAccess(receiver: SluaType, memberName: string): SluaType | null {
	// From runtime probes:
	// - vector instances expose x/y/z numeric fields.
	// - rotation/quaternion instances expose x/y/z numeric fields (w is NOT a field).
	if (receiver.kind !== 'custom') return null;
	if (receiver.name === 'vector' && (memberName === 'x' || memberName === 'y' || memberName === 'z')) return slua.number();
	if (receiver.name === 'rotation' && (memberName === 'x' || memberName === 'y' || memberName === 'z')) return slua.number();
	return null;
}

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
		return { kind: calleeName, varName: arg.name, asserted, isEqual };
	}

	return unwrap(expr.left, expr.right) ?? unwrap(expr.right, expr.left);
}

function collectTypeGuardsWhenTruthy(expr: unknown): TypeGuard[] {
	// Conservative: only `and` guarantees both sides are truthy.
	// For `or`, truthiness does not imply either side specifically.
	if (isUnaryExpression(expr) && expr.operator === 'not') {
		return collectTypeGuardsWhenFalsy(expr.argument);
	}
	if (isBinaryExpression(expr) && expr.operator === 'and') {
		return [...collectTypeGuardsWhenTruthy(expr.left), ...collectTypeGuardsWhenTruthy(expr.right)];
	}
	const g = parseTypeGuard(expr);
	return g ? [g] : [];
}

function collectTypeGuardsWhenFalsy(expr: unknown): TypeGuard[] {
	// Conservative rules:
	// - `not X` is falsy => X truthy
	// - `X or Y` is falsy => X falsy AND Y falsy
	// - `X and Y` is falsy => (X falsy) OR (X truthy AND Y falsy) => cannot assume either
	if (isUnaryExpression(expr) && expr.operator === 'not') {
		return collectTypeGuardsWhenTruthy(expr.argument);
	}
	if (isBinaryExpression(expr) && expr.operator === 'or') {
		return [...collectTypeGuardsWhenFalsy(expr.left), ...collectTypeGuardsWhenFalsy(expr.right)];
	}
	const g = parseTypeGuard(expr);
	if (!g) return [];
	// When a `~=` guard is falsy, it implies equality.
	if (!g.isEqual) return [{ ...g, isEqual: true }];
	// When a `==` guard is falsy, it implies inequality (not representable with current types).
	return [];
}

class InferEnv {
	private readonly scopes: Array<Map<string, SluaType>> = [new Map()];

	clone(): InferEnv {
		const e = new InferEnv();
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

	set(name: string, type: SluaType): void {
        this.scopes[this.scopes.length - 1]!.set(name, type);
	}

	updateIfUnknown(name: string, type: SluaType): void {
		const existing = this.get(name);
		if (!existing || (existing.kind === 'primitive' && existing.name === 'unknown')) this.set(name, type);
	}
}

function inferExpression(expr: unknown, env: InferEnv, registry: SluaRegistry): Multi {
	if (!isAstNode(expr)) return { values: [slua.unknown()], expands: false };

	if (isStringNode(expr)) return { values: [slua.string()], expands: false };
	if (isNumberNode(expr)) return { values: [slua.number()], expands: false };
	if (isBooleanNode(expr)) return { values: [slua.boolean()], expands: false };
	if (isNilNode(expr)) return { values: [slua.nil()], expands: false };
	if (isTableNode(expr)) return { values: [slua.table()], expands: false };
	if (isVarargLiteral(expr)) return { values: [slua.unknown()], expands: true };

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
		// Globals (functions) read as function values.
		const g = registry.getGlobal(expr.name);
		if (g) return { values: [g.signature], expands: false };
		// Modules read as tables.
		const m = registry.getModule(expr.name);
		if (m) return { values: [slua.table()], expands: false };
		// Object-types are global singletons (e.g. LLEvents). Treat as table-ish.
		if (registry.getObjectType(expr.name)) return { values: [slua.table()], expands: false };
		return { values: [slua.unknown()], expands: false };
	}

	if (isUnaryExpression(expr)) {
		const op = expr.operator;
		const argType = inferExpression(expr.argument, env, registry).values[0] ?? slua.unknown();
        
		// Check for metatable-based unary operations first
		const metatableResult = defaultMetatableRegistry.getUnaryOperationReturnType(argType, op);
		if (metatableResult) return { values: [metatableResult], expands: false };
        
		// Fallback for operations without metatable definitions
		if (op === 'not') return { values: [slua.boolean()], expands: false };
		if (op === '#' || op === 'len') {
			// The length operator on tables and strings returns a number
			if (argType.kind === 'table' || (argType.kind === 'primitive' && argType.name === 'string')) {
				return { values: [slua.number()], expands: false };
			}
		}
		return { values: [slua.unknown()], expands: false };
	}

	if (isBinaryExpression(expr)) {
		const op = expr.operator;
		const l = inferExpression(expr.left, env, registry).values[0] ?? slua.unknown();
		const r = inferExpression(expr.right, env, registry).values[0] ?? slua.unknown();
        
		// String concatenation
		if (op === '..') {
			const metatableResult = defaultMetatableRegistry.getBinaryOperationReturnType(l, r, op);
			if (metatableResult) return { values: [metatableResult], expands: false };
			return { values: [slua.string()], expands: false };
		}
        
		// Arithmetic operators
		if (
			op === '+' ||
            op === '-' ||
            op === '*' ||
            op === '/' ||
            op === '//' ||
            op === '%' ||
            op === '^'
		) {
			// Check for specific multiplication/division operations first (vector*rotation, etc.)
			if (op === '*') {
				const specificResult = getSpecificMultiplicationReturnType(l, r);
				if (specificResult) return { values: [specificResult], expands: false };
			}
			if (op === '/' || op === '//') {
				const specificResult = getSpecificDivisionReturnType(l, r);
				if (specificResult) return { values: [specificResult], expands: false };
			}
            
			// Check for metatable-based binary operations (now includes number+number, etc.)
			const metatableResult = defaultMetatableRegistry.getBinaryOperationReturnType(l, r, op);
			if (metatableResult) return { values: [metatableResult], expands: false };
            
			// Fallback to unknown if no metatable found
			return { values: [slua.unknown()], expands: false };
		}
        
		// Comparison operators
		if (op === '==' || op === '~=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
			// Check metatable for comparison
			if (op === '==' || op === '<' || op === '<=') {
				const metatableResult = defaultMetatableRegistry.getBinaryOperationReturnType(l, r, op);
				if (metatableResult) return { values: [metatableResult], expands: false };
			}
			return { values: [slua.boolean()], expands: false };
		}
        
		// Logical operators
		if (op === 'and' || op === 'or') {
			// Lua short-circuit returns one of the operands.
			return { values: [sluaTypeEquals(l, r) ? l : slua.unknown()], expands: false };
		}
        
		return { values: [slua.unknown()], expands: false };
	}

	if (isFunctionNode(expr)) {
		const paramTypes = expr.parameters.map((p) => (isIdentifier(p) ? sluaTypeFromLuauAnnotationText(p.typeAnnotation) : slua.unknown()));
		const annotatedReturn = sluaTypeFromLuauAnnotationText(expr.returnTypeAnnotation);
		const returns = annotatedReturn.kind === 'primitive' && annotatedReturn.name === 'unknown'
			? inferFunctionReturns(expr.body, env, registry)
			: annotatedReturn;
		return { values: [slua.fn(paramTypes, returns)], expands: false };
	}

	if (isCallExpression(expr)) {
		return inferCallExpression(expr, env, registry);
	}

	if (isMemberExpression(expr)) {
		// Reading a member value: treat methods as function values, properties as their type.
		if (isIdentifier(expr.object) && isIdentifier(expr.property)) {
			const receiverName = expr.object.name;
			const memberName = expr.property.name;

			const objType = registry.getObjectType(receiverName);
			if (objType) {
				const method = objType.methods[memberName];
				if (method) return { values: [method.signature], expands: false };
				const prop = objType.properties[memberName];
				if (prop) return { values: [prop.type], expands: false };
			}

			const mod = registry.getModule(receiverName);
			if (mod) {
				const fn = mod.functions[memberName];
				if (fn) return { values: [fn.signature], expands: false };
				const v = mod.values[memberName];
				if (v) return { values: [v.type], expands: false };
			}
		}

		// If this is instance member access (e.g. local v = tovector(...); local x = v.x),
		// attempt to infer known fields for custom runtime types.
		if (isIdentifier(expr.property)) {
			const receiverType = inferExpression(expr.object, env, registry).values[0] ?? slua.unknown();
			const inferred = inferCustomMemberAccess(receiverType, expr.property.name);
			if (inferred) return { values: [inferred], expands: false };
		}
		return { values: [slua.unknown()], expands: false };
	}

	if (isIndexExpression(expr)) {
		// Best-effort: resolve known module/object-type members by string key.
		if (isIdentifier(expr.object) && isStringNode(expr.index)) {
			const receiverName = expr.object.name;
			const key = expr.index.value;
			const objType = registry.getObjectType(receiverName);
			if (objType) {
				const method = objType.methods[key];
				if (method) return { values: [method.signature], expands: false };
				const prop = objType.properties[key];
				if (prop) return { values: [prop.type], expands: false };
			}
			const mod = registry.getModule(receiverName);
			if (mod) {
				const fn = mod.functions[key];
				if (fn) return { values: [fn.signature], expands: false };
				const v = mod.values[key];
				if (v) return { values: [v.type], expands: false };
			}
		}
		return { values: [slua.unknown()], expands: false };
	}

	// Default: unknown.
	return { values: [slua.unknown()], expands: false };
}

function inferCallExpression(call: CallExpressionNode, env: InferEnv, registry: SluaRegistry): Multi {
	// Calls can expand (multi-return) if the callee returns a tuple or is vararg-like.
	let calleeSig: SluaType | null = null;

	const callee = call.callee;
	if (isIdentifier(callee)) {
		const local = env.get(callee.name);
		if (local && local.kind === 'function') calleeSig = local;
		else {
			const g = registry.getGlobal(callee.name);
			if (g) calleeSig = g.signature;
		}
	}

	if (!calleeSig && isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
		const receiver = callee.object.name;
		const member = callee.property.name;

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

function inferReturnExpressionList(exprs: unknown[], env: InferEnv, registry: SluaRegistry): SluaType[] {
	if (exprs.length === 0) return [slua.nil()];

	const out: SluaType[] = [];
	for (let i = 0; i < exprs.length; i++) {
		const multi = inferExpression(exprs[i], env, registry);
		const isLast = i === exprs.length - 1;
		if (!isLast || !multi.expands) {
			out.push(multi.values[0] ?? slua.unknown());
			continue;
		}
		// Last expression expands to all values.
		out.push(...multi.values);
	}
	return out.length > 0 ? out : [slua.nil()];
}

function inferFunctionReturns(body: unknown[], outerEnv: InferEnv, registry: SluaRegistry): SluaType {
	// Best-effort: infer a stable multi-return shape across all return statements.
	// Start from a clone of the outer env so identifiers referenced in return expressions
	// can resolve to known types while keeping this analysis side-effect free.
	const env = outerEnv.clone();

	const merged: SluaType[] = [];
	let hasAnyReturn = false;

	function mergeReturnTypes(types: SluaType[]): void {
		if (!hasAnyReturn) {
			merged.length = 0;
			merged.push(...types);
			hasAnyReturn = true;
			return;
		}
		const max = Math.max(merged.length, types.length);
		for (let i = 0; i < max; i++) {
			const a = merged[i] ?? slua.nil();
			const b = types[i] ?? slua.nil();
			merged[i] = sluaTypeEquals(a, b) ? a : slua.unknown();
		}
	}

	function visitStatementsInCurrentScope(stmts: unknown[]): void {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			if (isLocalStatement(stmt)) {
				applyLocalStatement(stmt, env, registry, null);
				continue;
			}
			if (isAssignmentStatement(stmt)) {
				applyAssignmentStatement(stmt, env, registry);
				continue;
			}
			if (isFunctionDeclaration(stmt)) {
				applyFunctionDeclaration(stmt, env, registry, null);
				continue;
			}
			if (isReturnStatement(stmt)) {
				mergeReturnTypes(inferReturnExpressionList(stmt.arguments, env, registry));
				continue;
			}
			if (isIfStatement(stmt)) {
				const guards = collectTypeGuardsWhenTruthy(stmt.test);
				const elseGuards = collectTypeGuardsWhenFalsy(stmt.test);
				env.pushScope();
				for (const g of guards) {
					if (g.isEqual) env.set(g.varName, g.asserted);
				}
				visitStatementsInCurrentScope(stmt.consequent);
				env.popScope();

				const alt = stmt.alternate;
				if (Array.isArray(alt)) {
					env.pushScope();
					for (const g of elseGuards) {
						if (g.isEqual) env.set(g.varName, g.asserted);
					}
					visitStatementsInCurrentScope(alt);
					env.popScope();
				} else if (isAstNode(alt) && alt.type === 'IfStatement') {
					env.pushScope();
					for (const g of elseGuards) {
						if (g.isEqual) env.set(g.varName, g.asserted);
					}
					visitStatementsInCurrentScope([alt]);
					env.popScope();
				}
				continue;
			}

			if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) inferExpression(iterator, env, registry);
				env.pushScope();
				for (const variable of stmt.variables) {
					if (isIdentifier(variable)) env.set(variable.name, slua.unknown());
				}
				visitStatementsInCurrentScope(stmt.body);
				env.popScope();
				continue;
			}

			// Recurse into common blocks.
			const stmtRec = stmt as Record<string, unknown>;
			const body = stmtRec.body;
			if (Array.isArray(body)) visitStatements(body);
			const consequent = stmtRec.consequent;
			if (Array.isArray(consequent)) visitStatements(consequent);
			const alternate = stmtRec.alternate;
			if (Array.isArray(alternate)) visitStatements(alternate);
			if (isAstNode(alternate) && alternate.type === 'IfStatement') visitStatements([alternate]);
		}
	}

	function visitStatements(stmts: unknown[]): void {
		env.pushScope();
		visitStatementsInCurrentScope(stmts);
		env.popScope();
	}

	visitStatements(body);

	if (!hasAnyReturn) return slua.nil();
	if (merged.length === 0) return slua.nil();
	if (merged.length === 1) return merged[0]!;
	return slua.tuple(merged);
}

function inferAssignmentValues(init: unknown[] | undefined, count: number, env: InferEnv, registry: SluaRegistry): SluaType[] {
	if (!init || init.length === 0) return new Array(count).fill(slua.nil());

	const rhs = init;
	const out: SluaType[] = [];
	for (let i = 0; i < count; i++) {
		if (i < rhs.length - 1) {
			out.push(inferExpression(rhs[i], env, registry).values[0] ?? slua.unknown());
			continue;
		}

		// i is within the expansion tail of the last expression.
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

function applyLocalStatement(stmt: LocalStatementNode, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[] | null): void {
	const vars = stmt.variables.filter(isIdentifier);
	const inferred = inferAssignmentValues(stmt.init, vars.length, env, registry);
	for (let i = 0; i < vars.length; i++) {
		const v = vars[i]!;
		const annotated = sluaTypeFromLuauAnnotationText(v.typeAnnotation);
		const type = annotated.kind === 'primitive' && annotated.name === 'unknown' ? (inferred[i] ?? slua.unknown()) : annotated;
		env.set(v.name, type);
		if (sink && (!v.typeAnnotation || v.typeAnnotation.trim() === '') && !(type.kind === 'primitive' && type.name === 'unknown')) {
			sink.push({ name: v.name, identifier: v, type });
		}
	}
}

function applyFunctionDeclaration(stmt: FunctionDeclarationNode, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[] | null): void {
	if (!stmt.isLocal) return;
	if (!stmt.identifier || !isIdentifier(stmt.identifier)) return;
	const id = stmt.identifier;
	const paramTypes = stmt.parameters.map((p) => (isIdentifier(p) ? sluaTypeFromLuauAnnotationText(p.typeAnnotation) : slua.unknown()));
	const annotatedReturn = sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation);
	const returns = annotatedReturn.kind === 'primitive' && annotatedReturn.name === 'unknown'
		? inferFunctionReturns(stmt.body, env, registry)
		: annotatedReturn;
	const fnType = slua.fn(paramTypes, returns);
	// Local function declarations are a form of local variable creation.
	if (!id.typeAnnotation && sink) {
		sink.push({ name: id.name, identifier: id, type: fnType });
	}
	env.set(id.name, fnType);
}

function applyAssignmentStatement(stmt: AssignmentStatementNode, env: InferEnv, registry: SluaRegistry): void {
	const targets = stmt.variables;
	const rhs = stmt.init;
	const inferred = inferAssignmentValues(rhs, targets.length, env, registry);
	for (let i = 0; i < targets.length; i++) {
		const t = targets[i];
		if (!isIdentifier(t)) continue;
		const type = inferred[i] ?? slua.unknown();
		env.updateIfUnknown(t.name, type);
	}
}

function visitProgram(program: ProgramNode, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[]): void {
	function visitStatementsInCurrentScope(stmts: unknown[]): void {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			if (isLocalStatement(stmt)) {
				applyLocalStatement(stmt, env, registry, sink);
				continue;
			}
			if (isAssignmentStatement(stmt)) {
				applyAssignmentStatement(stmt, env, registry);
				continue;
			}
			if (isFunctionDeclaration(stmt)) {
				applyFunctionDeclaration(stmt, env, registry, sink);
				continue;
			}
			if (isIfStatement(stmt)) {
				const guards = collectTypeGuardsWhenTruthy(stmt.test);
				const elseGuards = collectTypeGuardsWhenFalsy(stmt.test);
				env.pushScope();
				for (const g of guards) {
					if (g.isEqual) env.set(g.varName, g.asserted);
				}
				visitStatementsInCurrentScope(stmt.consequent);
				env.popScope();

				const alt = stmt.alternate;
				if (Array.isArray(alt)) {
					env.pushScope();
					for (const g of elseGuards) {
						if (g.isEqual) env.set(g.varName, g.asserted);
					}
					visitStatementsInCurrentScope(alt);
					env.popScope();
				} else if (isAstNode(alt) && alt.type === 'IfStatement') {
					env.pushScope();
					for (const g of elseGuards) {
						if (g.isEqual) env.set(g.varName, g.asserted);
					}
					visitStatementsInCurrentScope([alt]);
					env.popScope();
				}
				continue;
			}

			if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) inferExpression(iterator, env, registry);
				env.pushScope();
				for (const variable of stmt.variables) {
					if (isIdentifier(variable)) env.set(variable.name, slua.unknown());
				}
				visitStatementsInCurrentScope(stmt.body);
				env.popScope();
				continue;
			}

			// Recurse into common block nodes.
			const stmtRec = stmt as Record<string, unknown>;
			const body = stmtRec.body;
			if (Array.isArray(body)) visitStatements(body);
			const consequent = stmtRec.consequent;
			if (Array.isArray(consequent)) visitStatements(consequent);
			const alternate = stmtRec.alternate;
			if (Array.isArray(alternate)) visitStatements(alternate);
			if (isAstNode(alternate) && alternate.type === 'IfStatement') visitStatements([alternate]);
		}
	}

	function visitStatements(stmts: unknown[]): void {
		env.pushScope();
		visitStatementsInCurrentScope(stmts);
		env.popScope();
	}

	visitStatements(program.body);
}

export function inferLocalVariableTypes(ast: unknown, registry: SluaRegistry): InferredLocal[] {
	if (!isProgram(ast)) return [];
	const sink: InferredLocal[] = [];
	const env = new InferEnv();
	visitProgram(ast, env, registry, sink);
	return sink;
}
