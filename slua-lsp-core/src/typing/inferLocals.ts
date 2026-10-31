import { withSourceFunctionInfo } from '../slua/sourceFunction.js';
import { setSourceMemberOrigins, mergeSourceOrigins, freezeSourceTable, type SourceMemberOrigin } from '../slua/sourceOrigins.js';
import { conditionalBinding, conditionalBindingType, conditionalGuard } from './conditionalBindings.js';
import { ClassMemberMap, ClassMemberSet } from './classMemberMap.js';
import { createClassConstructor } from './classConstructors.js';
import { registerClassMembers, classAnnotationType, type ClassInfo } from './classMembers.js';
export type { ClassInfo } from './classMembers.js';
import { identityTableUpdate, tableWrite, tableAssignments } from './tableWrites.js';
import { conditionRefinements, assertionCondition, joinFlowTypes, blockReturns, truthyType } from './refinements.js';
import { callbackContext, eventDeclarationContext, arrayIterationContext } from '../slua/callbackContext.js';
import type { SluaRegistry } from '../slua/registry.js';
import { resolveBuiltinExpression, selectBuiltinCallSignature } from '../slua/resolveBuiltin.js';
import { isClassOf, classOfValue, classType } from '../slua/classIdentity.js';
import type { SluaType } from '../slua/types.js';
import { slua, sluaPackValue, sluaTypeEquals } from '../slua/types.js';
import { defaultMetatableRegistry, getSpecificMultiplicationReturnType, getSpecificDivisionReturnType } from '../slua/metatables.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc; parenthesized?: boolean };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string; exported?: boolean };

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

type TableNode = AstNode & { type: 'Table'; fields?: unknown[] };

type StringNode = AstNode & { type: 'String'; value: string };

type NumberNode = AstNode & { type: 'Number'; value: number };

type BooleanNode = AstNode & { type: 'Boolean'; value: boolean };

type NilNode = AstNode & { type: 'Nil' };

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

type GenericForStatementNode = AstNode & { type: 'GenericForStatement'; variables: unknown[]; iterators: unknown[]; body: unknown[] };

type IfExpressionNode = AstNode & { type: 'IfExpression'; test: unknown; consequent: unknown; alternate: unknown };

type TypeCastExpressionNode = AstNode & { type: 'TypeCastExpression'; expression: unknown; typeAnnotation?: string };

type ClassFieldNode = AstNode & { type: 'ClassField'; name: unknown; typeAnnotation?: string };

type ClassDeclarationNode = AstNode & { type: 'ClassDeclaration'; name: unknown; fields: unknown[]; methods: unknown[]; open?: boolean; superClass?: unknown };

export type InferredLocal = {
    name: string;
    identifier: IdentifierNode;
    type: SluaType;
};

type Multi = { values: SluaType[]; expands: boolean; variadic?: SluaType; minimum?: number };

function adjustedValue(result: Multi, index = 0): SluaType {
	return sluaPackValue(result.values, index, result.variadic, result.minimum);
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

function isClassDeclaration(value: unknown): value is ClassDeclarationNode {
	return isAstNode(value) && value.type === 'ClassDeclaration' && Array.isArray((value as Record<string, unknown>).fields) && Array.isArray((value as Record<string, unknown>).methods);
}

function isClassField(value: unknown): value is ClassFieldNode {
	return isAstNode(value) && value.type === 'ClassField' && 'name' in value;
}

function mergeBranchTypes(a: SluaType, b: SluaType): SluaType {
	if (sluaTypeEquals(a, b)) return mergeSourceOrigins(a, b);
	if ((a.kind === 'primitive' && a.name === 'unknown') || (b.kind === 'primitive' && b.name === 'unknown')) return slua.unknown();
	return slua.union([a, b]);
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

type InferBinding = Readonly<{ type: SluaType; writes: number; exported?: IdentifierNode }>;
type SharedMap<K, V> = { values: Map<K, V>; shared: boolean };

class InferEnv {
	// Binding records and persistent table types are replaced on writes. A fork
	// can share their maps until that particular scope is changed. No AST/global
	// cache is involved; a request owns the entire snapshot graph.
	private scopes: Array<SharedMap<string, InferBinding>> = [{ values: new Map(), shared: false }];
	private readonly classes = new Map<string, ClassInfo>();
	private exported?: SharedMap<IdentifierNode, SluaType>;
	constructor(collectExports = false) { if (collectExports) this.exported = { values: new Map(), shared: false }; }

	clone(): InferEnv {
		const e = new InferEnv();
		e.scopes.length = 0;
		for (const scope of this.scopes) { scope.shared = true; e.scopes.push(scope); }
		for (const [name, info] of this.classes) e.classes.set(name, info);
		if (this.exported) { this.exported.shared = true; e.exported = this.exported; }
		return e;
	}

	/** A synchronous function analysis only mutates the child. Mark its scope
	 * wrappers shared without forcing the paused parent to copy on its next
	 * declaration after the child has been discarded. Never retain this child
	 * while resuming writes in the parent; branch checkpoints use clone(). */
	borrow(): InferEnv {
		const e = new InferEnv();
		e.scopes = this.scopes.map((scope) => ({ values: scope.values, shared: true }));
		for (const [name, info] of this.classes) e.classes.set(name, info);
		if (this.exported) e.exported = { values: this.exported.values, shared: true };
		return e;
	}

	private writableScope(index: number): Map<string, InferBinding> {
		let scope = this.scopes[index]!;
		if (scope.shared) this.scopes[index] = scope = { values: new Map(scope.values), shared: false };
		return scope.values;
	}

	private setExport(identifier: IdentifierNode, type: SluaType): void {
		let exported = this.exported;
		if (!exported || exported.values.get(identifier) === type) return;
		if (exported.shared) this.exported = exported = { values: new Map(exported.values), shared: false };
		exported.values.set(identifier, type);
	}

	pushScope(): void {
		this.scopes.push({ values: new Map(), shared: false });
	}

	popScope(): void {
		if (this.scopes.length > 1) this.scopes.pop();
	}

	get(name: string): SluaType | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const v = this.scopes[i]!.values.get(name);
			if (v) return v.type;
		}
		return undefined;
	}

	set(name: string, type: SluaType, identifier?: IdentifierNode): void {
		const exported = this.exported && identifier?.exported ? identifier : undefined;
		this.writableScope(this.scopes.length - 1).set(name, { type, writes: 0, ...(exported ? { exported } : {}) });
		if (exported) this.setExport(exported, type);
	}

	assign(name: string, type: SluaType): void {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const binding = this.scopes[i]!.values.get(name);
			if (binding) {
				this.writableScope(i).set(name, { ...binding, type, writes: binding.writes + 1 });
				if (binding.exported) this.setExport(binding.exported, type);
				return;
			}
		}
	}

	writeTable(target: unknown, value: SluaType, registry: SluaRegistry): void {
		this.rewriteTables(tableWrite(target, value, registry, (name) => this.get(name)));
	}

	rewriteTables(update: (type: SluaType) => SluaType): void {
		if (update === identityTableUpdate) return;
		for (const [index, scope] of this.scopes.entries()) for (const [name, binding] of scope.values) {
			const type = update(binding.type);
			if (type !== binding.type) this.writableScope(index).set(name, { ...binding, type, writes: binding.writes + 1 });
		}
		if (this.exported) for (const [identifier, type] of this.exported.values) this.setExport(identifier, update(type));
	}

	refine(expression: unknown, truth: boolean): void {
		for (const [name, type] of conditionRefinements(expression, truth, (name) => this.get(name))) {
			for (let i = this.scopes.length - 1; i >= 0; i--) {
				const binding = this.scopes[i]!.values.get(name);
				if (binding) { this.writableScope(i).set(name, { ...binding, type }); break; }
			}
		}
	}

	restore(other: InferEnv): void {
		const copy = other.clone(); this.scopes = copy.scopes; this.exported = copy.exported;
	}

	join(base: InferEnv, a: InferEnv, b: InferEnv): void {
		this.restore(base);
		for (const [i, scope] of base.scopes.entries()) for (const [name, binding] of scope.values) {
			const left = a.scopes[i]?.values.get(name) ?? binding;
			const right = b.scopes[i]?.values.get(name) ?? binding;
			if (left.writes === binding.writes && right.writes === binding.writes) continue;
			this.writableScope(i).set(name, { ...binding, type: joinFlowTypes(left.type, right.type), writes: Math.max(left.writes, right.writes) });
		}
		if (this.exported) for (const [id, type] of this.exported.values) this.setExport(id, joinFlowTypes(a.exported?.values.get(id) ?? type, b.exported?.values.get(id) ?? type));
	}

	defineClass(info: ClassInfo, identifier?: IdentifierNode): void {
		this.classes.set(info.name, info);
		this.set(info.name, info.constructorType, identifier);
	}

	moduleExports(): SluaType | undefined {
		if (!this.exported?.values.size) return undefined;
		const fields: Record<string, SluaType> = Object.create(null), origins = new Map<string, SourceMemberOrigin>();
		for (const [id, type] of this.exported.values) { fields[id.name] = type; origins.set(id.name, { name: id.name, node: id }); }
		const table = slua.table(fields); setSourceMemberOrigins(table, origins); freezeSourceTable(table); return table;
	}

	getClass(name: string): ClassInfo | undefined {
		return this.classes.get(name);
	}

	annotation(text: string | undefined): SluaType {
		return classAnnotationType(text, (name) => this.getClass(name), (name) => this.get(name));
	}
}

function methodParameters(method: FunctionDeclarationNode, info: ClassInfo, outerEnv: InferEnv): { params: SluaType[]; variadic?: SluaType } {
	const params: SluaType[] = [];
	let variadic: SluaType | undefined;
	for (const [index, parameter] of method.parameters.entries()) {
		const type = isIdentifier(parameter) ? index === 0 && parameter.name === 'self' ? info.instanceType : classAnnotationType(parameter.typeAnnotation, (name) => name === info.name ? info : outerEnv.getClass(name)) : slua.unknown();
		if (isIdentifier(parameter) && parameter.name === '...') variadic = type;
		else params.push(type);
	}
	return { params, variadic };
}

function methodType(method: FunctionDeclarationNode, info: ClassInfo, outerEnv: InferEnv, registry: SluaRegistry): SluaType {
	const { params: paramTypes, variadic } = methodParameters(method, info, outerEnv);
	let returns = classAnnotationType(method.returnTypeAnnotation, (name) => name === info.name ? info : outerEnv.getClass(name));
	if (returns.kind === 'primitive' && returns.name === 'unknown') {
		const methodEnv = outerEnv.borrow();
		methodEnv.defineClass(info);
		methodEnv.pushScope();
		for (let i = 0; i < method.parameters.length; i++) {
			const p = method.parameters[i];
			if (!isIdentifier(p)) continue;
			const paramType = p.name === 'self' && i === 0
				? info.instanceType
				: paramTypes[i] ?? slua.unknown();
			methodEnv.set(p.name, paramType);
		}
		returns = inferFunctionReturns(method.body, methodEnv, registry).type;
		methodEnv.popScope();
	}
	return slua.fn(paramTypes, returns, variadic);
}

function classInfoFromDeclaration(stmt: ClassDeclarationNode, env: InferEnv, registry: SluaRegistry): ClassInfo | null {
	if (!isIdentifier(stmt.name)) return null;
	// The native parser introduces the declaration before its base expression.
	// A same-name reference cannot silently select an older value binding.
	const baseIsSelf = isIdentifier(stmt.superClass) && stmt.superClass.name === stmt.name.name;
	const baseType = stmt.superClass && !baseIsSelf ? resolveBuiltinExpression(stmt.superClass, registry, (name) => env.get(name))?.type : undefined;
	const nominal = baseType && classType(baseType);
	const base = nominal?.kind === 'constructor' ? nominal.info : undefined;
	const hasOwnInitializer = stmt.methods.some((method) => isFunctionDeclaration(method) && isIdentifier(method.identifier) && method.identifier.name === '__init');
	const info: ClassInfo = {
		name: stmt.name.name,
		declaration: stmt.name,
		open: stmt.open === true,
		base, baseType, baseIsSelf, hasOwnInitializer,
		hasUnresolvedBase: !!stmt.superClass && !base || base?.hasUnresolvedBase === true,
		hasUserInitializerInChain: hasOwnInitializer || base?.hasUserInitializerInChain === true,
		fields: base?.fields.fork() ?? new ClassMemberMap(),
		methods: base?.methods.fork() ?? new ClassMemberMap(),
		staticMethods: base?.staticMethods.fork() ?? new ClassMemberSet(),
		selfMethods: base?.selfMethods.fork() ?? new ClassMemberSet(),
		fieldOrigins: base?.fieldOrigins.fork() ?? new ClassMemberMap(),
		methodOrigins: base?.methodOrigins.fork() ?? new ClassMemberMap(),
		instanceType: slua.custom(stmt.name.name),
		constructorType: slua.unknown(),
	};
	const { fieldOrigins, methodOrigins } = info;
	info.methods.delete('__init'); info.staticMethods.delete('__init'); info.selfMethods.delete('__init'); methodOrigins.delete('__init');
	for (const field of stmt.fields) {
		if (!isClassField(field) || !isIdentifier(field.name)) continue;
		info.fields.set(field.name.name, classAnnotationType(field.typeAnnotation, (name) => name === info.name ? info : env.getClass(name)));
		fieldOrigins.set(field.name.name, { name: field.name.name, node: field.name });
	}
	for (const method of stmt.methods) {
		if (!isFunctionDeclaration(method) || !method.identifier || !isIdentifier(method.identifier)) continue;
		const { params, variadic } = methodParameters(method, info, env);
		if (isIdentifier(method.parameters[0]) && method.parameters[0].name === 'self') {
			info.selfMethods.add(method.identifier.name); info.staticMethods.delete(method.identifier.name);
		} else { info.staticMethods.add(method.identifier.name); info.selfMethods.delete(method.identifier.name); }
		// Explicit user initializers are callable through their class at runtime,
		// including a parent initializer applied to a child. Default initializers
		// remain hidden: they require an instance of exactly their own class.
		if (method.identifier.name === '__init') info.staticMethods.add('__init');
		methodOrigins.set(method.identifier.name, { name: method.identifier.name, node: method.identifier });
		info.methods.set(method.identifier.name, slua.fn(params, classAnnotationType(method.returnTypeAnnotation, (name) => name === info.name ? info : env.getClass(name)), variadic));
	}
	// Install the declared constructor before inferring any method body. A
	// factory can call its class even when __init appears later in the body.
	info.constructorType = createClassConstructor(info.name, info.fields, info.methods.get('__init'), info.instanceType, !hasOwnInitializer && base?.hasUserInitializerInChain === true);
	registerClassMembers(info, fieldOrigins, methodOrigins);
	for (const method of stmt.methods) {
		if (!isFunctionDeclaration(method) || !method.identifier || !isIdentifier(method.identifier)) continue;
		info.methods.set(method.identifier.name, methodType(method, info, env, registry));
	}
	return info;
}

function inferExpression(expr: unknown, env: InferEnv, registry: SluaRegistry, tableDepth = 0): Multi {
	const known = resolveBuiltinExpression(expr, registry, (name) => env.get(name));
	if (known && !isCallExpression(expr)) return { values: [known.type], expands: false };
	if (!isAstNode(expr)) return { values: [slua.unknown()], expands: false };

	if (isStringNode(expr)) return { values: [slua.string()], expands: false };
	if (isNumberNode(expr)) return { values: [slua.number()], expands: false };
	if (isBooleanNode(expr)) return { values: [slua.boolean()], expands: false };
	if (isNilNode(expr)) return { values: [slua.nil()], expands: false };
	if (isTableNode(expr)) {
		if (tableDepth >= 16) return { values: [slua.table()], expands: false };
		const fields: Record<string, SluaType> = Object.create(null);
		const origins = new Map<string, SourceMemberOrigin>();
		let unknownKeys = false;
		if ((expr.fields?.length ?? 0) <= 128) for (const field of expr.fields ?? []) {
			if (!isRecord(field)) continue;
			const key = field.key;
			const name = isIdentifier(key) && !field.computed ? key.name : isStringNode(key) ? key.value : undefined;
			if (field.computed && name === undefined && !isNumberNode(key) && !isBooleanNode(key) && !(isAstNode(key) && key.type === 'Integer')) unknownKeys = true;
			if (name !== undefined) {
				fields[name] = adjustedValue(inferExpression(field.value, env, registry, tableDepth + 1));
				if (isAstNode(key) && key.location) origins.set(name, { name, node: key });
			}
		}
		const type = unknownKeys ? slua.table() : slua.table(fields);
		setSourceMemberOrigins(type, unknownKeys ? new Map() : origins);
		return { values: [type], expands: false };
	}
	if (isVarargLiteral(expr)) return { values: [slua.unknown()], expands: !expr.parenthesized };

	if (isIfExpression(expr)) {
		const thenEnv = env.clone();
		thenEnv.refine(conditionalGuard(expr), true);
		thenEnv.pushScope();
		applyConditionalBinding(expr, thenEnv, registry, null);
		const elseEnv = env.clone();
		elseEnv.refine(conditionalGuard(expr), false);
		const consequent = adjustedValue(inferExpression(expr.consequent, thenEnv, registry));
		const alternate = adjustedValue(inferExpression(expr.alternate, elseEnv, registry));
		return { values: [mergeBranchTypes(consequent, alternate)], expands: false };
	}

	if (isTypeCastExpression(expr)) {
		const annotated = env.annotation(expr.typeAnnotation);
		if (!(annotated.kind === 'primitive' && annotated.name === 'unknown')) return { values: [annotated], expands: false };
		return inferExpression(expr.expression, env, registry);
	}

	if (isIdentifier(expr)) {
		const local = env.get(expr.name);
		if (local) return { values: [local], expands: false };
		// Globals (functions) read as function values.
		const g = registry.getGlobal(expr.name);
		if (g) return { values: [g.signature], expands: false };
		const constant = registry.getGlobalValue(expr.name);
		if (constant) return { values: [constant.type], expands: false };
		// Modules read as tables.
		const m = registry.getModule(expr.name);
		if (m) return { values: [slua.table()], expands: false };
		// Object-types are global singletons (e.g. LLEvents). Treat as table-ish.
		if (registry.getObjectType(expr.name)) return { values: [slua.table()], expands: false };
		return { values: [slua.unknown()], expands: false };
	}

	if (isUnaryExpression(expr)) {
		const op = expr.operator;
		const argType = adjustedValue(inferExpression(expr.argument, env, registry));
        
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
		const l = adjustedValue(inferExpression(expr.left, env, registry));
		const r = adjustedValue(inferExpression(expr.right, env, registry));
        
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
				const specificResult = getSpecificDivisionReturnType(l, r, op);
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
			return { values: [sluaTypeEquals(l, r) ? mergeSourceOrigins(l, r) : slua.unknown()], expands: false };
		}
        
		return { values: [slua.unknown()], expands: false };
	}

	if (isFunctionNode(expr)) return { values: [functionSignature(expr, env, registry)], expands: false };

	if (isCallExpression(expr)) {
		const result = inferCallExpression(expr, env, registry);
		return expr.parenthesized ? { values: [adjustedValue(result)], expands: false } : result;
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
			const receiverType = adjustedValue(inferExpression(expr.object, env, registry));
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
	const sourceType = registry.expressionTypes.get(call);
	if (sourceType) return { values: [sourceType], expands: false };
	if (assertionCondition(call, (name) => env.get(name)) !== undefined) {
		// The pinned analyzer's assert contract returns one value even though
		// luaB_assert returns all arguments at runtime. Preserve static parity.
		const first = adjustedValue(inferExpression(call.arguments[0], env, registry));
		return { values: [truthyType(first, true)], expands: false };
	}
	// Calls can expand (multi-return) if the callee returns a tuple or is vararg-like.
	const known = resolveBuiltinExpression(call.callee, registry, (name) => env.get(name));
	let calleeSig: SluaType | null = (known && selectBuiltinCallSignature(known.type, call.arguments, registry, (name) => env.get(name))) ||
		(known?.type.kind === 'table' && known.type.module ? registry.getGlobal(known.type.module)?.signature ?? null : null);

	const callee = call.callee;
	if (!calleeSig && isIdentifier(callee)) {
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
	if (isClassOf(calleeSig) && call.arguments.length) {
		const result = classOfValue(adjustedValue(inferExpression(call.arguments[0], env, registry)));
		if (result) return { values: [result], expands: false };
	}

	const returns = calleeSig.returns;
	if (returns.kind === 'tuple') return { values: returns.items, expands: true, variadic: returns.variadic, minimum: returns.minimum };
	return { values: [returns], expands: false };
}

function inferReturnExpressionList(exprs: unknown[], env: InferEnv, registry: SluaRegistry): SluaType[] {
	if (exprs.length === 0) return [slua.nil()];

	const out: SluaType[] = [];
	for (let i = 0; i < exprs.length; i++) {
		const multi = inferExpression(exprs[i], env, registry);
		const isLast = i === exprs.length - 1;
		if (!isLast || !multi.expands) {
			out.push(adjustedValue(multi));
			continue;
		}
		// Last expression expands to all values.
		out.push(...multi.values);
		if (multi.variadic && multi.values.length === 0) out.push(multi.variadic);
	}
	return out.length > 0 ? out : [slua.nil()];
}

function functionEnvironment(fn: FunctionDeclarationNode | FunctionNode, outer: InferEnv, registry: SluaRegistry, context: SluaType[] = []) {
	const env = outer.borrow();
	env.pushScope();
	const self = isFunctionDeclaration(fn) && isMemberExpression(fn.identifier) && fn.identifier.indexer === ':' ? inferExpression(fn.identifier.object, outer, registry).values[0] : undefined;
	const params = fn.parameters.map((p, i) => isIdentifier(p) && p.typeAnnotation ? outer.annotation(p.typeAnnotation) : context[i] ?? slua.unknown());
	const declared = outer.annotation(fn.returnTypeAnnotation);
	if (isFunctionDeclaration(fn) && fn.isLocal && isIdentifier(fn.identifier)) env.set(fn.identifier.name, slua.fn(params, declared));
	for (const [i, parameter] of fn.parameters.entries()) if (isIdentifier(parameter)) env.set(parameter.name, i === 0 && self ? self : params[i]!);
	return { env, params, declared };
}

function functionSignature(fn: FunctionDeclarationNode | FunctionNode, outer: InferEnv, registry: SluaRegistry): SluaType {
	// A declared result and parameter annotations already determine this public
	// signature. Body diagnostics and local inference still run through their
	// normal visitors; constructing their environment here would discard it.
	if (fn.returnTypeAnnotation) return withSourceFunctionInfo(slua.fn(fn.parameters.map((p) => isIdentifier(p) && p.typeAnnotation ? outer.annotation(p.typeAnnotation) : slua.unknown()), outer.annotation(fn.returnTypeAnnotation)), fn);
	const { env, params } = functionEnvironment(fn, outer, registry);
	return withSourceFunctionInfo(slua.fn(params, inferFunctionReturns(fn.body, env, registry).type), fn);
}

/** Shared local function contract. Generic correlations and recursive fixed
 * points remain unknown; an anonymous initializer resolves outer names. */
export function inferFunctionSignature(fn: unknown, registry: SluaRegistry, locals: ReadonlyMap<string, SluaType>, classes: Iterable<ClassInfo> = []): SluaType {
	if (!isFunctionDeclaration(fn) && !isFunctionNode(fn)) return slua.unknown();
	const env = new InferEnv();
	const knownClasses = [...classes];
	if (fn.returnTypeAnnotation && !knownClasses.length) return functionSignature(fn, env, registry);
	for (const info of knownClasses) env.defineClass(info);
	for (const [name, type] of locals) env.set(name, type);
	return functionSignature(fn, env, registry);
}

/** Class methods use the same return-flow inference in locals and completion.
 * A method named `new` is an ordinary function, not an implicit constructor. */
export function inferClassDeclaration(stmt: unknown, registry: SluaRegistry, locals: ReadonlyMap<string, SluaType>, classes: Iterable<ClassInfo> = []): ClassInfo | null {
	if (!isClassDeclaration(stmt)) return null;
	const env = new InferEnv();
	for (const info of classes) env.defineClass(info);
	for (const [name, type] of locals) env.set(name, type);
	return classInfoFromDeclaration(stmt, env, registry);
}

export type FunctionReturnAnalysis = {
	type: SluaType;
	sites: Array<{ node: AstNode; values: SluaType[]; open: boolean; variadic?: SluaType; minimum?: number }>;
	fallsThrough: boolean;
};

export function analyzeFunctionReturns(fn: unknown, registry: SluaRegistry, locals: ReadonlyMap<string, SluaType>, context: SluaType[] = [], classes: Iterable<ClassInfo> = []): FunctionReturnAnalysis | undefined {
	if (!isFunctionDeclaration(fn) && !isFunctionNode(fn)) return undefined;
	const outer = new InferEnv();
	for (const info of classes) outer.defineClass(info);
	for (const [name, type] of locals) outer.set(name, type);
	return inferFunctionReturns(fn.body, functionEnvironment(fn, outer, registry, context).env, registry);
}

/** Final module export values retain their declaration identities after local
 * shadows. This is source analysis only: arbitrary calls/closures never execute. */
export function inferValueExports(ast: unknown, registry: SluaRegistry): SluaType | undefined {
	if (!isProgram(ast)) return undefined;
	const env = new InferEnv(true);
	visitProgram(ast, env, registry, []);
	return env.moduleExports();
}

function inferFunctionReturns(body: unknown[], outerEnv: InferEnv, registry: SluaRegistry): FunctionReturnAnalysis {
	const sites: FunctionReturnAnalysis['sites'] = [];
	const env = outerEnv.borrow();
	let merged: SluaType[] | undefined;
	function merge(types: SluaType[]): void {
		if (!merged) { merged = types; return; }
		merged = Array.from({ length: Math.max(merged.length, types.length) }, (_, i) => joinFlowTypes(merged![i] ?? slua.nil(), types[i] ?? slua.nil()));
	}
	function effects(value: unknown): void {
		if (Array.isArray(value)) { for (const child of value) effects(child); return; }
		if (!isAstNode(value) || isFunctionNode(value) || isFunctionDeclaration(value)) return;
		if (isBinaryExpression(value) && (value.operator === 'and' || value.operator === 'or')) {
			effects(value.left);
			const before = env.clone();
			env.refine(value.left, value.operator === 'and');
			effects(value.right);
			env.join(before, env.clone(), before);
			return;
		}
		if (isIfExpression(value)) {
			effects(value.test);
			const before = env.clone();
			env.refine(conditionalGuard(value), true);
			env.pushScope();
			applyConditionalBinding(value, env, registry, null);
			effects(value.consequent);
			env.popScope();
			const consequent = env.clone();
			env.restore(before);
			env.refine(conditionalGuard(value), false);
			effects(value.alternate);
			env.join(before, consequent, env.clone());
			return;
		}
		for (const [key, child] of Object.entries(value)) if (key !== 'location') effects(child);
		env.refine(assertionCondition(value, (name) => env.get(name)), true);
	}
	function walk(stmts: unknown[]): boolean {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;
			if (isLocalStatement(stmt)) { effects(stmt.init); applyLocalStatement(stmt, env, registry, null); continue; }
			if (isAssignmentStatement(stmt)) { effects(stmt.init); applyAssignmentStatement(stmt, env, registry); continue; }
			if (isFunctionDeclaration(stmt)) { applyFunctionDeclaration(stmt, env, registry, null); continue; }
			if (isClassDeclaration(stmt)) {
				const info = classInfoFromDeclaration(stmt, env, registry);
				if (info) env.defineClass(info);
				continue;
			}
			if (isReturnStatement(stmt)) {
				effects(stmt.arguments);
				const values = stmt.arguments.length ? inferReturnExpressionList(stmt.arguments, env, registry) : [];
				const last = stmt.arguments.at(-1);
				const tail = isCallExpression(last) ? inferExpression(last, env, registry) : undefined;
				const open = !!tail && (!!tail.variadic || tail.minimum !== undefined && tail.minimum < tail.values.length || tail.values.some((t) => t.kind === 'primitive' && t.name === 'unknown'));
				sites.push({ node: stmt, values, open, variadic: tail?.variadic, minimum: stmt.arguments.length - 1 + (tail?.minimum ?? tail?.values.length ?? 1) });
				merge(values.length ? values : [slua.nil()]);
				return true;
			}
			if (isIfStatement(stmt)) {
				effects(stmt.test);
				const before = env.clone();
				env.refine(conditionalGuard(stmt), true);
				env.pushScope();
				applyConditionalBinding(stmt, env, registry, null);
				const thenReturns = walk(stmt.consequent);
				env.popScope();
				const consequent = env.clone();
				env.restore(before);
				env.refine(conditionalGuard(stmt), false);
				env.pushScope();
				const alternate = Array.isArray(stmt.alternate) ? stmt.alternate : stmt.alternate ? [stmt.alternate] : [];
				const elseReturns = walk(alternate);
				env.popScope();
				if (thenReturns && elseReturns) return true;
				if (!thenReturns && elseReturns) env.restore(consequent);
				else if (!thenReturns) env.join(before, consequent, env.clone());
				continue;
			}
			if (isGenericForStatement(stmt) || stmt.type === 'WhileStatement' || stmt.type === 'ForStatement') {
				const loop = stmt as AstNode & { body: unknown[]; test?: unknown; variable?: unknown; start?: unknown; end?: unknown; step?: unknown };
				effects(isGenericForStatement(stmt) ? stmt.iterators : [loop.test, loop.start, loop.end, loop.step]);
				const before = env.clone();
				env.refine(loop.test, true);
				env.pushScope();
				if (isGenericForStatement(stmt)) {
					const context = arrayIterationContext(stmt.iterators, registry, (name) => env.get(name));
					for (const [i, variable] of stmt.variables.entries()) if (isIdentifier(variable)) env.set(variable.name, context[i] ?? slua.unknown());
				} else if (isIdentifier(loop.variable)) env.set(loop.variable.name, slua.number());
				walk(loop.body);
				env.popScope();
				env.join(before, env.clone(), before);
				if (stmt.type === 'WhileStatement' && isBooleanNode(loop.test) && loop.test.value === true) {
					function mayBreak(value: unknown): boolean {
						if (Array.isArray(value)) return value.some(mayBreak);
						if (!isAstNode(value)) return false;
						if (value.type === 'BreakStatement') return true;
						if (isFunctionNode(value) || isFunctionDeclaration(value) || ['WhileStatement', 'ForStatement', 'GenericForStatement', 'RepeatStatement'].includes(value.type)) return false;
						return Object.entries(value).some(([key, child]) => key !== 'location' && mayBreak(child));
					}
					if (!mayBreak(loop.body)) return true;
				}
				continue;
			}
			if (stmt.type === 'DoStatement' || stmt.type === 'RepeatStatement') {
				const block = stmt as AstNode & { body: unknown[]; test?: unknown };
				env.pushScope();
				const returns = walk(block.body);
				effects(block.test);
				env.popScope();
				if (returns) return true;
				continue;
			}
			effects(stmt);
		}
		return false;
	}
	const fallsThrough = !walk(body);
	if (fallsThrough) merge([slua.nil()]);
	const zeroOnly = (fallsThrough || sites.length > 0) && sites.every((site) => !site.open && site.values.length === 0);
	const bounded = sites.some((site) => site.minimum !== undefined && site.minimum < site.values.length);
	const type = sites.some((site) => site.variadic) ? slua.tuple(merged ?? [], slua.unknown(), fallsThrough ? 0 : Math.min(...sites.map((site) => site.minimum ?? site.values.length)))
		: bounded ? slua.tuple(merged ?? [], undefined, fallsThrough ? 0 : Math.min(...sites.map((site) => site.minimum ?? site.values.length)))
			: zeroOnly ? slua.tuple([]) : !merged || merged.length === 0 ? slua.nil() : merged.length === 1 ? merged[0]! : slua.tuple(merged);
	return { type, sites, fallsThrough };
}

function inferAssignmentValues(init: unknown[] | undefined, count: number, env: InferEnv, registry: SluaRegistry): SluaType[] {
	if (!init || init.length === 0) return new Array(count).fill(slua.nil());

	const rhs = init;
	const out: SluaType[] = [];
	for (let i = 0; i < count; i++) {
		if (i < rhs.length - 1) {
			out.push(adjustedValue(inferExpression(rhs[i], env, registry)));
			continue;
		}

		// i is within the expansion tail of the last expression.
		const tailIndex = i - (rhs.length - 1);
		const last = inferExpression(rhs[rhs.length - 1], env, registry);
		if (!last.expands) {
			const tail = rhs[rhs.length - 1];
			const unresolvedCall = isCallExpression(tail) && !tail.parenthesized && last.values[0]?.kind === 'primitive' && last.values[0].name === 'unknown';
			out.push(tailIndex === 0 ? (last.values[0] ?? slua.unknown()) : unresolvedCall ? slua.unknown() : slua.nil());
			continue;
		}
		out.push(adjustedValue(last, tailIndex));
	}
	return out;
}

export function inferAssignmentTypes(expressions: unknown[], count: number, registry: SluaRegistry, locals: ReadonlyMap<string, SluaType>, classes: Iterable<ClassInfo> = []): SluaType[] {
	const env = new InferEnv();
	for (const info of classes) env.defineClass(info);
	for (const [name, type] of locals) env.set(name, type);
	return inferAssignmentValues(expressions, count, env, registry);
}

/** Argument-list expansion differs from assignment padding: omitted values must
 * remain absent so native optional arguments can reject an explicit nil. */
export function inferCallArguments(expressions: unknown[], registry: SluaRegistry, locals: ReadonlyMap<string, SluaType>): { values: SluaType[]; sources: unknown[]; open: boolean; minimum: number } {
	const env = new InferEnv();
	for (const [name, type] of locals) env.set(name, type);
	const values: SluaType[] = [], sources: unknown[] = [];
	let open = false;
	let minimum: number | undefined;
	for (const [i, expression] of expressions.entries()) {
		const result = inferExpression(expression, env, registry);
		if (i !== expressions.length - 1) {
			values.push(adjustedValue(result)); sources.push(expression); continue;
		}
		if (result.variadic) {
			minimum = values.length + (result.minimum ?? result.values.length);
			values.push(...result.values, result.variadic); sources.push(...[...result.values, result.variadic].map(() => expression));
			open = true; continue;
		}
		if (result.expands && result.minimum !== undefined) minimum = values.length + result.minimum;
		open = isAstNode(expression) && ((expression.type === 'VarargLiteral' && !('parenthesized' in expression && expression.parenthesized)) ||
			(isCallExpression(expression) && !expression.parenthesized && !result.expands && result.values[0]?.kind === 'primitive' && result.values[0].name === 'unknown'));
		values.push(...result.values); sources.push(...result.values.map(() => expression));
	}
	return { values, sources, open, minimum: minimum ?? values.length - (open ? 1 : 0) };
}

function applyConditionalBinding(node: unknown, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[] | null): void {
	const binding = conditionalBinding(node);
	if (!binding) return;
	const initial = adjustedValue(inferExpression((node as Record<string, unknown>).test, env, registry));
	const type = conditionalBindingType(binding, initial);
	env.set(binding.name, type);
	if (sink && !binding.typeAnnotation && !(type.kind === 'primitive' && type.name === 'unknown')) sink.push({ name: binding.name, identifier: binding, type });
}

function applyLocalStatement(stmt: LocalStatementNode, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[] | null): void {
	const vars = stmt.variables.filter(isIdentifier);
	const inferred = inferAssignmentValues(stmt.init, vars.length, env, registry);
	for (let i = 0; i < vars.length; i++) {
		const v = vars[i]!;
		const annotated = env.annotation(v.typeAnnotation);
		const type = annotated.kind === 'primitive' && annotated.name === 'unknown' ? (inferred[i] ?? slua.unknown()) : annotated;
		env.set(v.name, type, v);
		if (sink && (!v.typeAnnotation || v.typeAnnotation.trim() === '') && !(type.kind === 'primitive' && type.name === 'unknown')) {
			sink.push({ name: v.name, identifier: v, type });
		}
	}
}

function applyFunctionDeclaration(stmt: FunctionDeclarationNode, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[] | null): void {
	if (!stmt.isLocal) {
		const type = functionSignature(stmt, env, registry);
		if (isIdentifier(stmt.identifier)) env.assign(stmt.identifier.name, type);
		else env.writeTable(stmt.identifier, type, registry);
		return;
	}
	if (!stmt.identifier || !isIdentifier(stmt.identifier)) return;
	const id = stmt.identifier;
	const fnType = functionSignature(stmt, env, registry);
	// Local function declarations are a form of local variable creation.
	if (!id.typeAnnotation && sink) {
		sink.push({ name: id.name, identifier: id, type: fnType });
	}
	env.set(id.name, fnType, id);
}

function applyAssignmentStatement(stmt: AssignmentStatementNode, env: InferEnv, registry: SluaRegistry): void {
	const targets = stmt.variables;
	const rhs = stmt.init;
	const writes = tableAssignments(targets, inferAssignmentValues(rhs, targets.length, env, registry), registry, (name) => env.get(name));
	env.rewriteTables(writes.update);
	const inferred = writes.values;
	for (let i = 0; i < targets.length; i++) {
		const t = targets[i];
		if (!isIdentifier(t)) continue;
		const type = inferred[i] ?? slua.unknown();
		env.assign(t.name, type);
	}
}

function visitProgram(program: ProgramNode, env: InferEnv, registry: SluaRegistry, sink: InferredLocal[]): void {
	function functionBody(parameters: unknown[], body: unknown[], context: SluaType[] = []): void {
		const parent = env;
		env = parent.borrow();
		try {
			env.pushScope();
			for (const [index, parameter] of parameters.entries()) if (isIdentifier(parameter)) {
				env.set(parameter.name, parameter.typeAnnotation ? env.annotation(parameter.typeAnnotation) : context[index] ?? slua.unknown());
			}
			visitStatementsInCurrentScope(body);
		} finally {
			env = parent;
		}
	}
	function expressions(value: unknown, context?: SluaType[]): void {
		if (Array.isArray(value)) { for (const child of value) expressions(child); return; }
		if (!isAstNode(value)) return;
		if (isFunctionNode(value)) { functionBody(value.parameters, value.body, context); return; }
		if (isBinaryExpression(value) && (value.operator === 'and' || value.operator === 'or')) {
			expressions(value.left);
			const before = env.clone();
			env.refine(value.left, value.operator === 'and');
			expressions(value.right);
			env.restore(before);
			return;
		}
		if (isIfExpression(value)) {
			expressions(value.test);
			const before = env.clone();
			env.refine(conditionalGuard(value), true);
			env.pushScope();
			applyConditionalBinding(value, env, registry, sink);
			expressions(value.consequent);
			env.popScope();
			env.restore(before);
			env.refine(conditionalGuard(value), false);
			expressions(value.alternate);
			env.restore(before);
			return;
		}
		if (isCallExpression(value)) {
			const contexts = callbackContext(value, registry, (name) => env.get(name));
			expressions(value.callee);
			for (const argument of value.arguments) expressions(argument, contexts.get(argument));
			env.refine(assertionCondition(value, (name) => env.get(name)), true);
			return;
		}
		for (const key of Object.keys(value)) if (key !== 'location') expressions((value as unknown as Record<string, unknown>)[key]);
	}

	function visitStatementsInCurrentScope(stmts: unknown[]): void {
		for (const stmt of stmts) {
			if (!isAstNode(stmt)) continue;

			if (isLocalStatement(stmt)) {
				expressions(stmt.init);
				applyLocalStatement(stmt, env, registry, sink);
				continue;
			}
			if (isAssignmentStatement(stmt)) {
				expressions(stmt.init);
				applyAssignmentStatement(stmt, env, registry);
				continue;
			}
			if (isFunctionDeclaration(stmt)) {
				applyFunctionDeclaration(stmt, env, registry, sink);
				const context = eventDeclarationContext(stmt.identifier, registry, (name) => env.get(name));
				if (isMemberExpression(stmt.identifier) && stmt.identifier.indexer === ':') context[0] = adjustedValue(inferExpression(stmt.identifier.object, env, registry));
				functionBody(stmt.parameters, stmt.body, context);
				continue;
			}
			if (isClassDeclaration(stmt)) {
				const info = classInfoFromDeclaration(stmt, env, registry);
				if (info) env.defineClass(info, isIdentifier(stmt.name) ? stmt.name : undefined);
				continue;
			}
			if (isIfStatement(stmt)) {
				expressions(stmt.test);
				const before = env.clone();
				env.refine(conditionalGuard(stmt), true);
				env.pushScope();
				applyConditionalBinding(stmt, env, registry, sink);
				visitStatementsInCurrentScope(stmt.consequent);
				env.popScope();
				const consequent = env.clone();
				env.restore(before);
				env.refine(conditionalGuard(stmt), false);
				env.pushScope();
				if (Array.isArray(stmt.alternate)) visitStatementsInCurrentScope(stmt.alternate);
				else if (isAstNode(stmt.alternate)) visitStatementsInCurrentScope([stmt.alternate]);
				env.popScope();
				if (blockReturns(stmt.consequent) && !blockReturns(stmt.alternate)) { /* Keep the false continuation. */ }
				else if (blockReturns(stmt.alternate) && !blockReturns(stmt.consequent)) env.restore(consequent);
				else env.join(before, consequent, env.clone());
				continue;
			}

			if (isGenericForStatement(stmt)) {
				for (const iterator of stmt.iterators) inferExpression(iterator, env, registry);
				const context = arrayIterationContext(stmt.iterators, registry, (name) => env.get(name));
				const before = env.clone();
				env.pushScope();
				for (const [index, variable] of stmt.variables.entries()) {
					if (isIdentifier(variable)) env.set(variable.name, context[index] ?? slua.unknown());
				}
				visitStatementsInCurrentScope(stmt.body);
				env.popScope();
				env.join(before, env.clone(), before);
				continue;
			}

			if (stmt.type === 'WhileStatement' || stmt.type === 'ForStatement') {
				const loop = stmt as AstNode & { test?: unknown; variable?: unknown; body: unknown[] };
				const before = env.clone();
				env.refine(loop.test, true);
				env.pushScope();
				if (isIdentifier(loop.variable)) env.set(loop.variable.name, slua.number());
				visitStatementsInCurrentScope(loop.body);
				env.popScope();
				env.join(before, env.clone(), before);
				continue;
			}

			// Expression statements can contain native registration callbacks.
			if (stmt.type === 'ExpressionStatement' || stmt.type === 'CallStatement' || stmt.type === 'ReturnStatement') expressions(stmt);

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
