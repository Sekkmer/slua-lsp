import { functionAttributeInfo, sourceFunctionInfo } from '../../slua/sourceFunction.js';
import { conditionalBinding, conditionalBindingType, conditionalGuard } from '../../typing/conditionalBindings.js';
import { isFrozenSourceTable } from '../../slua/sourceOrigins.js';
import { isIntegerLiteralExpression } from '../../parser/ast.js';
import { isVectorOrRotation, getVectorRotationOperationReturnType } from '../../slua/metatables.js';
import { identityTableUpdate, tableWrite, tableAssignments, tableOrigin } from '../../typing/tableWrites.js';
import { classConstructorInfo } from '../../typing/classConstructors.js';
import { diagnoseClassInheritance } from '../../typing/classInheritance.js';
import { classType, classMember, classAnnotationType } from '../../typing/classMembers.js';
import { diagnoseModuleAvailability } from './moduleAvailability.js';
import { diagnoseFunctionReturns } from './functionReturns.js';
import { inferFunctionSignature, inferAssignmentTypes, inferClassDeclaration, inferCallArguments } from '../../typing/inferLocals.js';
import { conditionRefinements, assertionCondition, joinFlowTypes, blockReturns } from '../../typing/refinements.js';
import { callbackContext, eventDeclarationContext, arrayIterationContext } from '../../slua/callbackContext.js';
import { diagnoseMethodCallStyle } from './methodCallStyle.js';
import { diagnoseTimerCallback } from './timerCallbacks.js';
import { arrayKeyCompatibility, arrayKeyType, resolveBuiltinExpression, selectBuiltinCallSignature, type BuiltinResolution } from '../../slua/resolveBuiltin.js';
import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';
import { slua, sluaPackValue, sluaTypeEquals, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable, sluaTypeToString } from '../../slua/types.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type LocalStatementNode = AstNode & { type: 'LocalStatement'; variables: unknown[]; init?: unknown[] };

type AssignmentStatementNode = AstNode & { type: 'AssignmentStatement'; variables: unknown[]; init: unknown[] };

type FunctionDeclarationNode = AstNode & {
	type: 'FunctionDeclaration';
	identifier?: unknown;
	isLocal?: boolean;
	parameters?: unknown[];
	body?: unknown[];
	returnTypeAnnotation?: string;
};

type FunctionNode = AstNode & { type: 'Function'; parameters?: unknown[]; body?: unknown[]; returnTypeAnnotation?: string };

type IfStatementNode = AstNode & { type: 'IfStatement'; test: unknown; consequent: unknown[]; alternate?: unknown[] | unknown };

type IfExpressionNode = AstNode & { type: 'IfExpression'; test: unknown; consequent: unknown; alternate: unknown };

type TypeCastExpressionNode = AstNode & { type: 'TypeCastExpression'; expression: unknown; typeAnnotation?: string };

type GenericForStatementNode = AstNode & { type: 'GenericForStatement'; variables: unknown[]; iterators: unknown[]; body: unknown[] };

type WhileStatementNode = AstNode & { type: 'WhileStatement'; test: unknown; body: unknown[] };

type ForStatementNode = AstNode & { type: 'ForStatement'; variable: unknown; start: unknown; end: unknown; step?: unknown; body: unknown[] };

type DoStatementNode = AstNode & { type: 'DoStatement'; body: unknown[] };

type RepeatStatementNode = AstNode & { type: 'RepeatStatement'; body: unknown[]; test: unknown };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown; indexer?: '.' | ':' };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type StringNode = AstNode & { type: 'String'; value: string };

type NumberNode = AstNode & { type: 'Number'; value: number };

type BooleanNode = AstNode & { type: 'Boolean'; value: boolean };

type NilNode = AstNode & { type: 'Nil' };

type TableNode = AstNode & { type: 'Table'; fields?: unknown[] };

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
	return isRecord(v) && typeof v.type === 'string';
}

function isProgram(v: unknown): v is ProgramNode {
	return isAstNode(v) && v.type === 'Program' && Array.isArray((v as Record<string, unknown>).body);
}

function isCallExpression(v: unknown): v is CallExpressionNode {
	return isAstNode(v) && v.type === 'CallExpression' && Array.isArray((v as Record<string, unknown>).arguments) && 'callee' in v;
}

function isLocalStatement(v: unknown): v is LocalStatementNode {
	return isAstNode(v) && v.type === 'LocalStatement' && Array.isArray((v as Record<string, unknown>).variables);
}

function isAssignmentStatement(v: unknown): v is AssignmentStatementNode {
	return isAstNode(v) && v.type === 'AssignmentStatement' && Array.isArray((v as Record<string, unknown>).variables) && Array.isArray((v as Record<string, unknown>).init);
}

function isFunctionDeclaration(v: unknown): v is FunctionDeclarationNode {
	return isAstNode(v) && v.type === 'FunctionDeclaration';
}

function isFunctionNode(v: unknown): v is FunctionNode {
	return isAstNode(v) && v.type === 'Function';
}

function isIfStatement(v: unknown): v is IfStatementNode {
	return isAstNode(v) && v.type === 'IfStatement' && Array.isArray((v as Record<string, unknown>).consequent);
}

function isIfExpression(v: unknown): v is IfExpressionNode {
	return isAstNode(v) && v.type === 'IfExpression' && 'consequent' in v && 'alternate' in v;
}

function isTypeCastExpression(v: unknown): v is TypeCastExpressionNode {
	return isAstNode(v) && v.type === 'TypeCastExpression' && 'expression' in v;
}

function isGenericForStatement(v: unknown): v is GenericForStatementNode {
	return isAstNode(v) && v.type === 'GenericForStatement' && Array.isArray((v as Record<string, unknown>).variables) && Array.isArray((v as Record<string, unknown>).iterators) && Array.isArray((v as Record<string, unknown>).body);
}

function isDoStatement(v: unknown): v is DoStatementNode {
	return isAstNode(v) && v.type === 'DoStatement' && Array.isArray((v as Record<string, unknown>).body);
}

function isWhileStatement(v: unknown): v is WhileStatementNode {
	return isAstNode(v) && v.type === 'WhileStatement' && Array.isArray((v as Record<string, unknown>).body);
}

function isForStatement(v: unknown): v is ForStatementNode {
	return isAstNode(v) && v.type === 'ForStatement' && Array.isArray((v as Record<string, unknown>).body);
}

function isRepeatStatement(v: unknown): v is RepeatStatementNode {
	return isAstNode(v) && v.type === 'RepeatStatement' && Array.isArray((v as Record<string, unknown>).body) && 'test' in v;
}

function isIdentifier(v: unknown): v is IdentifierNode {
	return isAstNode(v) && v.type === 'Identifier' && typeof (v as Record<string, unknown>).name === 'string';
}

function isMemberExpression(v: unknown): v is MemberExpressionNode {
	return isAstNode(v) && v.type === 'MemberExpression' && 'object' in v && 'property' in v;
}

function isIndexExpression(v: unknown): v is IndexExpressionNode {
	return isAstNode(v) && v.type === 'IndexExpression' && 'object' in v && 'index' in v;
}

function isStringNode(v: unknown): v is StringNode {
	return isAstNode(v) && v.type === 'String' && typeof (v as Record<string, unknown>).value === 'string';
}

function isNumberNode(v: unknown): v is NumberNode {
	return isAstNode(v) && v.type === 'Number' && typeof (v as Record<string, unknown>).value === 'number';
}

function isBooleanNode(v: unknown): v is BooleanNode {
	return isAstNode(v) && v.type === 'Boolean' && typeof (v as Record<string, unknown>).value === 'boolean';
}

function isNilNode(v: unknown): v is NilNode {
	return isAstNode(v) && v.type === 'Nil';
}

function isTableNode(v: unknown): v is TableNode {
	return isAstNode(v) && v.type === 'Table';
}

function exprNameKey(expr: unknown): string | null {
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

function getFirstReturn(t: SluaType): SluaType {
	if (t.kind === 'tuple') return sluaPackValue(t.items, 0, t.variadic, t.minimum);
	return t;
}

function mergeBranchTypes(a: SluaType, b: SluaType): SluaType {
	if (sluaTypeEquals(a, b)) return a;
	if ((a.kind === 'primitive' && a.name === 'unknown') || (b.kind === 'primitive' && b.name === 'unknown')) return slua.unknown();
	return slua.union([a, b]);
}

function signatureForCall(type: SluaType, args: unknown[], registry: SluaRegistry, locals: Map<string, SluaType>): SluaType | undefined {
	return type.kind === 'union' ? selectBuiltinCallSignature(type, args, registry, (name) => locals.get(name)) : type;
}

function resolveCallSignature(
	callee: unknown,
	registry: SluaRegistry,
	locals: Map<string, SluaType>,
	args: unknown[] = []
): { signature: SluaType; displayName: string; nativeHandlerIndex?: number; timerMethod?: 'once' | 'every'; access?: BuiltinResolution } | null {
	const key = exprNameKey(callee) ?? 'function';
	if (isIdentifier(callee)) {
		const local = locals.get(callee.name);
		if (local) {
			if (local.kind === 'union') {
				const selected = signatureForCall(local, args, registry, locals);
				return selected ? { signature: selected, displayName: key } : null;
			}
			if (local.kind === 'function') return { signature: local, displayName: key };
			if (local.kind === 'table' && local.module) {
				const constructor = registry.getGlobal(local.module);
				if (constructor) return { signature: constructor.signature, displayName: key };
			}
			return null;
		}
		const g = registry.getGlobal(callee.name);
		if (g) return { signature: g.signature, displayName: key };
	}

	if (isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
		const receiver = callee.object.name;
		const prop = callee.property.name;
		const target = resolveBuiltinExpression(callee.object, registry, (name) => locals.get(name))?.type;
		if (target?.kind === 'table' && target.metatable) {
			const bound = resolveBuiltinExpression(callee, registry, (name) => locals.get(name));
			if (bound?.type.kind !== 'function') return null;
			const offset = callee.indexer === ':' ? 0 : 1;
			return { signature: bound.type, displayName: bound.displayName ?? key,
				nativeHandlerIndex: target.metatable === 'LLEvents' && ['on', 'once', 'off'].includes(prop) ? 1 + offset
					: target.metatable === 'LLTimers' ? (prop === 'off' ? 0 : 1) + offset : undefined,
				timerMethod: target.metatable === 'LLTimers' && ['once', 'every'].includes(prop) ? prop as 'once' | 'every' : undefined };
		}

		if (locals.has(receiver)) {
			const bound = resolveBuiltinExpression(callee, registry, (name) => locals.get(name));
			const signature = bound && signatureForCall(bound.type, args, registry, locals);
			return signature?.kind === 'function' ? { signature, displayName: bound?.displayName ?? key, access: bound } : null;
		}

		const mod = registry.getModule(receiver);
		if (mod) {
			const fn = mod.functions[prop];
			if (fn) {
				const signature = signatureForCall(fn.signature, args, registry, locals);
				return signature ? { signature, displayName: key } : null;
			}
		}
	}
	const native = resolveBuiltinExpression(callee, registry, (name) => locals.get(name));
	const signature = native && signatureForCall(native.type, args, registry, locals);
	if (signature?.kind === 'function') return { signature, displayName: native?.displayName ?? key, access: native };

	return null;
}

function inferExpressionType(expr: unknown, registry: SluaRegistry, locals: Map<string, SluaType>): SluaType | null {
	if (!isAstNode(expr)) return null;
	const known = resolveBuiltinExpression(expr, registry, (name) => locals.get(name));
	if (known) return known.type;
	if (isStringNode(expr)) return slua.string();
	if (isNumberNode(expr)) return slua.number();
	if (isBooleanNode(expr)) return slua.boolean();
	if (isNilNode(expr)) return slua.nil();
	if (isTableNode(expr)) return slua.table();

	if (isIfExpression(expr)) {
		const thenLocals = new Map([...locals, ...conditionRefinements(conditionalGuard(expr), true, (name) => locals.get(name))]);
		const elseLocals = new Map([...locals, ...conditionRefinements(conditionalGuard(expr), false, (name) => locals.get(name))]);
		const binding = conditionalBinding(expr);
		if (binding) thenLocals.set(binding.name, conditionalBindingType(binding, inferAssignmentTypes([expr.test], 1, registry, locals)[0] ?? slua.unknown()));
		const consequent = inferExpressionType(expr.consequent, registry, thenLocals) ?? slua.unknown();
		const alternate = inferExpressionType(expr.alternate, registry, elseLocals) ?? slua.unknown();
		return mergeBranchTypes(consequent, alternate);
	}

	if (isTypeCastExpression(expr)) {
		const annotated = sluaTypeFromLuauAnnotationText(expr.typeAnnotation);
		if (!(annotated.kind === 'primitive' && annotated.name === 'unknown')) return annotated;
		return inferExpressionType(expr.expression, registry, locals);
	}

	if (isFunctionNode(expr)) return inferFunctionSignature(expr, registry, locals);

	if (isIdentifier(expr)) {
		const local = locals.get(expr.name);
		if (local) return local;
		const g = registry.getGlobal(expr.name);
		if (g) return g.signature;
		const constant = registry.getGlobalValue(expr.name);
		if (constant) return constant.type;
		if (registry.getModule(expr.name)) return slua.table();
		if (registry.getObjectType(expr.name)) return slua.table();
		return null;
	}

	if (isMemberExpression(expr) && isIdentifier(expr.object) && isIdentifier(expr.property)) {
		const receiver = expr.object.name;
		const prop = expr.property.name;
		if (locals.has(receiver)) return null;
		const mod = registry.getModule(receiver);
		if (mod) {
			const val = mod.values[prop];
			if (val) return val.type;
			const fn = mod.functions[prop];
			if (fn) return fn.signature;
		}
		const obj = registry.getObjectType(receiver);
		if (obj) {
			const val = obj.properties[prop];
			if (val) return val.type;
			const method = obj.methods[prop];
			if (method) return method.signature;
		}
	}

	if (isCallExpression(expr)) {
		const resolved = resolveCallSignature(expr.callee, registry, locals, expr.arguments);
		if (!resolved) return null;
		if (resolved.signature.kind !== 'function') return null;
		return getFirstReturn(resolved.signature.returns);
	}

	return null;
}

class LexicalLocals {
	private scopes: Array<Map<string, { type: SluaType; declared?: SluaType; writes: number }>> = [new Map()];
	private cachedSnapshot: Map<string, SluaType> | undefined;

	public lookup(name: string): SluaType | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) { const binding = this.scopes[i]!.get(name); if (binding) return binding.type; }
		return undefined;
	}

	public snapshot(): Map<string, SluaType> {
		if (this.cachedSnapshot) return this.cachedSnapshot;
		const merged = new Map<string, SluaType>();
		for (const scope of this.scopes) {
			for (const [name, binding] of scope) merged.set(name, binding.type);
		}
		this.cachedSnapshot = merged;
		return merged;
	}

	public push(): void {
		this.cachedSnapshot = undefined;
		this.scopes.push(new Map());
	}

	public pop(): void {
		this.cachedSnapshot = undefined;
		if (this.scopes.length > 1) this.scopes.pop();
	}

	public define(name: string, type: SluaType, declared?: SluaType): void {
		this.cachedSnapshot = undefined;
		this.scopes[this.scopes.length - 1]?.set(name, { type, declared, writes: 0 });
	}

	public declared(name: string): SluaType | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const binding = this.scopes[i]!.get(name);
			if (binding) return binding.declared;
		}
		return undefined;
	}


	public writeTable(target: unknown, value: SluaType, registry: SluaRegistry): void {
		this.rewriteTables(tableWrite(target, value, registry, (name) => this.snapshot().get(name)));
	}

	rewriteTables(update: (type: SluaType) => SluaType): void {
		if (update === identityTableUpdate) return;
		for (const scope of this.scopes) for (const [name, binding] of scope) {
			const type = update(binding.type);
			if (type !== binding.type) scope.set(name, { ...binding, type, writes: binding.writes + 1 });
		}
		this.cachedSnapshot = undefined;
	}

	public checkpoint(): LexicalLocals['scopes'] {
		return this.scopes.map((scope) => new Map([...scope].map(([name, binding]) => [name, { ...binding }])));
	}

	public restore(state: LexicalLocals['scopes']): void {
		this.scopes = state.map((scope) => new Map([...scope].map(([name, binding]) => [name, { ...binding }])));
		this.cachedSnapshot = undefined;
	}

	public refine(expression: unknown, truth: boolean): void {
		const refinements = conditionRefinements(expression, truth, (name) => this.snapshot().get(name));
		for (const [name, type] of refinements) for (let i = this.scopes.length - 1; i >= 0; i--) {
			const binding = this.scopes[i]!.get(name);
			if (binding) { this.scopes[i]!.set(name, { ...binding, type }); break; }
		}
		this.cachedSnapshot = undefined;
	}

	public join(base: LexicalLocals['scopes'], a: LexicalLocals['scopes'], b: LexicalLocals['scopes']): void {
		this.restore(base);
		for (const [i, scope] of base.entries()) for (const [name, binding] of scope) {
			const left = a[i]?.get(name) ?? binding;
			const right = b[i]?.get(name) ?? binding;
			if (left.writes === binding.writes && right.writes === binding.writes) continue;
			this.scopes[i]!.set(name, { ...binding, type: joinFlowTypes(left.type, right.type), writes: Math.max(left.writes, right.writes) });
		}
		this.cachedSnapshot = undefined;
	}

	public assign(name: string, type: SluaType): void {
		this.cachedSnapshot = undefined;
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const scope = this.scopes[i]!;
			if (scope.has(name)) {
				const declared = scope.get(name)?.declared;
				scope.set(name, { type: declared ?? type, declared, writes: scope.get(name)!.writes + 1 });
				return;
			}
		}
		this.define(name, type);
	}
}

export function ruleCallArgumentTypes(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	return ruleExpressionTypes(ast, registry, 'types').filter((d) => d.code !== 'assignment-type-mismatch');
}

/** Share one lexical/RHS walk for calls and annotated variable assignments. */
export type LexicalCallVisitor = (call: CallExpressionNode, locals: Map<string, SluaType>) => void;

export function ruleExpressionTypes(ast: unknown, registry: SluaRegistry, checks: 'all' | 'types' | 'methods' | 'calls' | 'returns' | 'availability' = 'all', onCall?: LexicalCallVisitor): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];
	const locals = new LexicalLocals();
	const deprecatedScope = new Set<object>();
	const tableFields = new Map<SluaType, Map<string, SluaType>>();
	const classes = new Map<string, NonNullable<ReturnType<typeof inferClassDeclaration>>>();
	// Only the actual host wrapper signatures get their documented numeric conversion.
	// Signature identity survives aliases and does not grant coercion to a same-shaped user function.
	const numericHostCalls = new Set(['ll', 'llcompat'].flatMap((name) => Object.values(registry.getModule(name)?.functions ?? {}).map((fn) => fn.signature)));
	function hostIntegerConversion(expected: SluaType, actual: SluaType): boolean {
		if (actual.kind === 'union') return actual.items.every((item) => hostIntegerConversion(expected, item));
		if (expected.kind === 'union') return expected.items.some((item) => hostIntegerConversion(item, actual));
		return sluaTypeIsAssignable(expected, actual) || expected.kind === 'primitive' && expected.name === 'number' && actual.kind === 'custom' && actual.name === 'integer';
	}

	function currentLocals(): Map<string, SluaType> {
		return locals.snapshot();
	}

	function inferLocalInitializer(expr: unknown): SluaType {
		const type = inferExpressionType(expr, registry, currentLocals());
		if (type && !(type.kind === 'primitive' && type.name === 'unknown')) return type;
		return classes.size ? inferAssignmentTypes([expr], 1, registry, currentLocals(), classes.values())[0]! : type ?? slua.unknown();
	}
	function isKnownInteger(value: unknown): boolean {
		const type = inferLocalInitializer(value);
		return type.kind === 'custom' && type.name === 'integer';
	}
	function invalidIntegerBinary(left: unknown, right: unknown): boolean {
		const a = inferLocalInitializer(left), b = inferLocalInitializer(right);
		const scalar = (type: SluaType) => type.kind === 'primitive' && type.name !== 'unknown' || type.kind === 'literal' || type.kind === 'custom' && type.name === 'integer';
		// A table on either side may supply a valid user-defined metamethod.
		return scalar(a) && scalar(b) && (a.kind === 'custom' && a.name === 'integer' || b.kind === 'custom' && b.name === 'integer');
	}
	function invalidNativeBinary(left: unknown, right: unknown, operator: string): boolean {
		const a = inferLocalInitializer(left), b = inferLocalInitializer(right);
		// Unknowns and tables may supply a user metamethod. Only proven native
		// scalar combinations are diagnosed; this is not a general operator solver.
		const scalar = (type: SluaType) => type.kind === 'primitive' && type.name !== 'unknown' || type.kind === 'literal' || type.kind === 'custom' && ['vector', 'rotation', 'uuid', 'integer'].includes(type.name);
		return scalar(a) && scalar(b) && (isVectorOrRotation(a) || isVectorOrRotation(b)) && !getVectorRotationOperationReturnType(a, b, operator);
	}

	function functionDeclarationType(stmt: FunctionDeclarationNode): SluaType {
		return inferFunctionSignature(stmt, registry, currentLocals(), classes.values());
	}

	function compatible(target: SluaType, value: SluaType, source: unknown, deferFunctions: boolean): boolean {
		if (value.kind === 'primitive' && value.name === 'unknown') return true;
		if (value.kind === 'union') return value.items.every((item) => compatible(target, item, source, deferFunctions));
		if (target.kind === 'union') return target.items.some((item) => compatible(item, value, source, deferFunctions));
		if (target.kind === 'literal') {
			if (isStringNode(source)) return source.value === target.value;
			if (value.kind === 'primitive' && value.name === 'string') return true; // Unknown string may be the sentinel.
		}
		if (deferFunctions && target.kind === 'function' && value.kind === 'function' && !classType(target) && !classType(value)) return true;
		if (target.kind === 'array' && value.kind === 'table') {
			// Check a literal in its expected context, without inventing a general
			// table-to-array conversion for inference. Record fields do not determine
			// the numeric indexer, and unresolved expressions remain conservative.
			if (!isTableNode(source) || !Array.isArray(source.fields)) return true;
			return source.fields.every((field) => {
				if (!isRecord(field) || !isAstNode(field.value)) return true;
				if (field.key && !isNumberNode(field.key)) return true;
				return compatible(target.element, inferLocalInitializer(field.value), field.value, deferFunctions);
			});
		}
		return sluaTypeIsAssignable(target, value);
	}

	function checkAssignment(id: IdentifierNode, expected: SluaType | undefined, actual: SluaType, source: unknown): void {
		if ((checks !== 'all' && checks !== 'types') || !expected ||
			(expected.kind === 'primitive' && expected.name === 'unknown') ||
			(actual.kind === 'primitive' && actual.name === 'unknown')) return;
		// Function variance and contextual parameter inference are not modeled here.
		// Defer function-to-function comparisons, while still rejecting a function
		// assigned to a scalar/table or a scalar assigned to a function.
		if (!compatible(expected, actual, source, true)) diags.push({ code: 'assignment-type-mismatch', severity: 'warning',
			message: `Variable '${id.name}' expects '${sluaTypeToString(expected)}' but is assigned '${sluaTypeToString(actual)}'.`,
			range: rangeFromNode(isAstNode(source) ? source : id) });
	}

	function constructorFieldsCompatible(signature: SluaType, index: number, source: unknown): boolean {
		const fields = index === 0 ? classConstructorInfo(signature)?.defaultFields : undefined;
		if (!fields) return true;
		// Dynamic computed keys may overwrite a known field. Do not infer a
		// closed shape or a missing property through such a literal.
		if (isTableNode(source) && source.fields?.some((field) => isRecord(field) && field.computed && !isStringNode(field.key) && !isNumberNode(field.key))) return true;
		const actual = inferAssignmentTypes([source], 1, registry, currentLocals(), classes.values())[0];
		if (actual?.kind !== 'table') return true;
		for (const [name, expected] of fields) {
			const value = actual.fields && Object.hasOwn(actual.fields, name) ? actual.fields[name] : undefined;
			if (value && !compatible(expected, value, undefined, true)) return false;
			if (!value && isTableNode(source) && !sluaTypeIsAssignable(expected, slua.nil())) return false;
		}
		return true;
	}

	function assignmentValues(expressions: unknown[], count: number): SluaType[] {
		return inferAssignmentTypes(expressions, count, registry, currentLocals(), classes.values());
	}

	function defineConditional(node: unknown): void {
		const binding = conditionalBinding(node);
		if (!binding) return;
		const test = (node as Record<string, unknown>).test;
		const value = assignmentValues([test], 1)[0] ?? slua.unknown();
		const annotated = binding.typeAnnotation ? sluaTypeFromLuauAnnotationText(binding.typeAnnotation) : undefined;
		checkAssignment(binding, annotated, value, test);
		locals.define(binding.name, conditionalBindingType(binding, value), annotated);
	}

	function visitExpression(node: unknown, context?: SluaType[], writing = false): void {
		if (!isAstNode(node)) return;
		if ((checks === 'all' || checks === 'types' || checks === 'methods') && ((!writing && isIdentifier(node)) || isMemberExpression(node))) {
			const info = sourceFunctionInfo(resolveBuiltinExpression(node, registry, (name) => locals.lookup(name))?.type);
			if (info?.deprecated && !deprecatedScope.has(info.owner)) {
				const label = isIdentifier(node) ? node.name : isMemberExpression(node) && isIdentifier(node.property) ? node.property.name : '?';
				const use = info.deprecated.use !== undefined ? `, use '${info.deprecated.use}' instead` : '';
				const reason = info.deprecated.reason !== undefined ? `. ${info.deprecated.reason}` : '';
				diags.push({ code: 'deprecated-function', severity: 'warning', tags: ['deprecated'], range: rangeFromNode(node), message: `${isIdentifier(node) ? 'Function' : 'Member'} '${label}' is deprecated${use}${reason}` });
			}
		}
		if ((checks === 'all' || checks === 'types') && (isMemberExpression(node) || isIndexExpression(node))) {
			const key = isMemberExpression(node) && isIdentifier(node.property) ? node.property.name : isIndexExpression(node) && isStringNode(node.index) ? node.index.value : undefined;
			const receiver = key !== undefined ? resolveBuiltinExpression(node.object, registry, (name) => currentLocals().get(name))?.type : undefined;
			const member = receiver && key !== undefined ? classMember(receiver, key) : undefined;
			if (member && (writing ? member.readonly : !member.type)) diags.push({
				code: writing ? 'class-readonly-member' : 'class-unknown-member', severity: 'warning', range: rangeFromNode(node),
				message: writing ? `Cannot write class member '${member.name}' on this ${member.kind}.` : `Class ${member.kind} '${member.info.name}' has no readable member '${member.name}'.`
			});
		}
		if (checks === 'all' || checks === 'types') {
			const expression = node as unknown as Record<string, unknown>;
			if (node.type === 'BinaryExpression' && ['+', '-', '*', '/', '//', '%', '^'].includes(String(expression.operator)) && invalidNativeBinary(expression.left, expression.right, String(expression.operator))) {
				diags.push({ code: 'native-operator', severity: 'warning', range: rangeFromNode(node),
					message: `This vector/rotation operand combination does not support operator '${String(expression.operator)}' in SLua.` });
			}
			if ((node.type === 'UnaryExpression' && ['-', '#'].includes(String(expression.operator)) && isKnownInteger(expression.argument) && !isIntegerLiteralExpression(node)) ||
				(node.type === 'BinaryExpression' && ['+', '-', '*', '/', '//', '%', '^', '..', '<', '>', '<=', '>='].includes(String(expression.operator)) && invalidIntegerBinary(expression.left, expression.right))) {
				diags.push({ code: 'integer-operator', severity: 'warning', range: rangeFromNode(node),
					message: `Tagged integers do not support operator '${String(expression.operator)}'. Use the integer library or an explicit conversion; unary minus is supported only directly on an integer literal.` });
			}
		}
		if (checks === 'all' || checks === 'methods' || checks === 'availability') diags.push(...diagnoseModuleAvailability(node, registry, (name) => currentLocals().get(name)));
		if (isFunctionNode(node)) { visitFunctionBody(node, context); return; }
		if (isAstNode(node) && node.type === 'BinaryExpression') {
			const binary = node as AstNode & { operator?: string; left: unknown; right: unknown };
			if (binary.operator === 'and' || binary.operator === 'or') {
				visitExpression(binary.left);
				const before = locals.checkpoint();
				locals.refine(binary.left, binary.operator === 'and');
				visitExpression(binary.right);
				locals.restore(before);
				return;
			}
		}
		if (isIfExpression(node)) {
			visitExpression(node.test);
			const before = locals.checkpoint();
			locals.refine(conditionalGuard(node), true);
			locals.push();
			defineConditional(node);
			visitExpression(node.consequent);
			locals.restore(before);
			locals.refine(conditionalGuard(node), false);
			visitExpression(node.alternate);
			locals.restore(before);
			return;
		}
		if (isIndexExpression(node) && (checks === 'all' || checks === 'types')) {
			const container = resolveBuiltinExpression(node.object, registry, (name) => currentLocals().get(name))?.type;
			if (container?.kind === 'array') {
				const key = arrayKeyType(node.index, registry, (name) => currentLocals().get(name));
				if (arrayKeyCompatibility(key) === 'invalid') diags.push({ code: 'array-index-type-mismatch', severity: 'warning',
					message: `Array index expects 'number' but got '${sluaTypeToString(key)}'.`, range: rangeFromNode(isAstNode(node.index) ? node.index : node) });
			}
		}
		if (isCallExpression(node)) {
			onCall?.(node, currentLocals());
			if (checks === 'all' || checks === 'methods') diags.push(...diagnoseMethodCallStyle(node, registry, (name) => currentLocals().get(name)));
			if (checks === 'all' || checks === 'types') {
				const resolved = resolveCallSignature(node.callee, registry, currentLocals(), node.arguments);
				const access = resolved?.access;
				const member = access?.classMember;
				if (member?.type?.kind === 'function' && isMemberExpression(node.callee) && node.callee.indexer === ':') {
					const expected = member.type.params[0], actual = resolveBuiltinExpression(node.callee.object, registry, (name) => currentLocals().get(name))?.type;
					if (expected && actual && !compatible(expected, actual, node.callee.object, false)) diags.push({
						code: 'call-argument-type-mismatch', severity: 'warning', range: rangeFromNode(node.callee),
						message: `Implicit receiver to ${access?.displayName ?? member.name} expects '${sluaTypeToString(expected)}' but got '${sluaTypeToString(actual)}'.`
					});
				}
				const calleeType = !resolved ? resolveBuiltinExpression(node.callee, registry, (name) => currentLocals().get(name))?.type : undefined;
				if (calleeType?.kind === 'table' && calleeType.module && !registry.getGlobal(calleeType.module)) {
					diags.push({ code: 'call-non-callable', severity: 'warning', range: rangeFromNode(isAstNode(node.callee) ? node.callee : node),
						message: `Module '${calleeType.module}' is not callable.${calleeType.module === 'integer' ? ' Use integer.create(number) or integer.fromstring(text) for 64-bit values; use tonumber for ordinary numbers.' : ''}` });
				}
				if (resolved && resolved.signature.kind === 'function') {
					const constructor = classConstructorInfo(resolved.signature);
					if (constructor?.requiresInitializer) diags.push({ code: 'class-constructor-required', severity: 'warning', range: rangeFromNode(node),
						message: `Class '${constructor.name}' needs its own __init because an ancestor defines a user initializer. Its default constructor fails at runtime.` });
					if (resolved.timerMethod && resolved.nativeHandlerIndex !== undefined) diags.push(...diagnoseTimerCallback(node, resolved.timerMethod, resolved.nativeHandlerIndex));
					const params = resolved.signature.params;
					const args = node.arguments;
					const expanded = resolved.signature.arity || classConstructorInfo(resolved.signature) ? inferCallArguments(args, registry, currentLocals()) : undefined;
					const sources = expanded?.sources ?? args;

					for (let i = 0; i < (expanded?.values.length ?? args.length); i++) {
						const expected = params[i] ?? resolved.signature.variadic;
						if (!expected || (expected.kind === 'primitive' && expected.name === 'unknown')) continue;
						const actual = expanded?.values[i] ?? inferLocalInitializer(args[i]);
						if (!actual || (actual.kind === 'primitive' && actual.name === 'unknown')) continue;
						// Native callback returns are ignored and callable tables are supported.
						// Detailed literal parameter annotations are checked by callback rules.
						const handler = resolved.nativeHandlerIndex === i;
						const isHandler = (type: SluaType): boolean => type.kind === 'function' || type.kind === 'table' ||
							(type.kind === 'union' && type.items.every(isHandler));
						if (handler && isHandler(actual)) continue;
						if ((!compatible(expected, actual, sources[i], false) || !constructorFieldsCompatible(resolved.signature, i, sources[i])) && !(numericHostCalls.has(resolved.signature) && hostIntegerConversion(expected, actual))) {
							diags.push({
								code: 'call-argument-type-mismatch',
								severity: 'warning',
								message: `Argument #${i + 1} to ${resolved.displayName} expects '${sluaTypeToString(expected)}' but got '${sluaTypeToString(actual)}'.`,
								range: rangeFromNode(sources[i] as AstNode)
							});
						}
					}
				}
			}
		}

		if (isCallExpression(node)) {
			const contexts = callbackContext(node, registry, (name) => currentLocals().get(name));
			visitExpression(node.callee);
			for (const argument of node.arguments) visitExpression(argument, contexts.get(argument));
			locals.refine(assertionCondition(node, (name) => currentLocals().get(name)), true);
			return;
		}

		if (isMemberExpression(node)) { visitExpression(node.object); return; }
		if (isIndexExpression(node)) { visitExpression(node.object); visitExpression(node.index); return; }
		if (node.type === 'TableField') {
			const field = node as AstNode & { computed?: boolean; key?: unknown; value?: unknown };
			if (field.computed) visitExpression(field.key);
			visitExpression(field.value); return;
		}
		for (const key of Object.keys(node)) {
			if (key === 'body' && (isFunctionNode(node) || isFunctionDeclaration(node))) continue;
			const value = (node as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				for (const item of value) visitExpression(item);
			} else if (isAstNode(value)) {
				visitExpression(value);
			}
		}
	}

	function visitFunctionBody(fn: FunctionNode | FunctionDeclarationNode, context: SluaType[] = []): void {
		const { parameters, body } = fn;
		if (!Array.isArray(body)) return;
		if (checks === 'all' || checks === 'types' || checks === 'returns') diags.push(...diagnoseFunctionReturns(fn, registry, currentLocals(), context, classes.values()));
		const outer = locals.checkpoint();
		locals.push();
		const self = isFunctionDeclaration(fn) && isMemberExpression(fn.identifier) && fn.identifier.indexer === ':' ? resolveBuiltinExpression(fn.identifier.object, registry, (name) => currentLocals().get(name))?.type : undefined;
		if (Array.isArray(parameters)) {
			for (const [index, param] of parameters.entries()) {
				if (isIdentifier(param)) {
					const annotated = param.typeAnnotation ? classAnnotationType(param.typeAnnotation, (name) => classes.get(name)) : index === 0 && self ? self : context[index] ?? slua.unknown();
					locals.define(param.name, annotated, param.typeAnnotation ? annotated : undefined);
				}
			}
		}
		const ownInfo = functionAttributeInfo(fn);
		if (ownInfo?.deprecated) deprecatedScope.add(fn);
		try { visitStatements(body); }
		finally { if (ownInfo?.deprecated) deprecatedScope.delete(fn); locals.restore(outer); }
	}

	function checkTableField(target: unknown, value: SluaType, source: unknown): void {
		let object: unknown; let name: string | undefined;
		if (isMemberExpression(target) && isIdentifier(target.property)) { object = target.object; name = target.property.name; }
		else if (isIndexExpression(target)) { object = target.object; if (isStringNode(target.index)) name = target.index.value; }
		if (!object) return;
		const receiver = resolveBuiltinExpression(object, registry, (key) => currentLocals().get(key))?.type;
		if (receiver && isFrozenSourceTable(receiver)) {
			if ((checks === 'all' || checks === 'types') && isAstNode(target)) diags.push({ code: 'readonly-write', severity: 'error', message: 'Cannot write to the frozen value-export table of an imported module.', range: rangeFromNode(target) });
			return;
		}
		if (name === undefined) return;
		const sourceClass = receiver && classType(receiver);
		if (sourceClass) {
			const expected = sourceClass.kind === 'instance' ? sourceClass.info.fields.get(name) : undefined;
			if (expected && (checks === 'all' || checks === 'types') && !compatible(expected, value, source, true)) {
				diags.push({ code: 'assignment-type-mismatch', severity: 'warning',
					message: `Class field '${name}' expects '${sluaTypeToString(expected)}' but is assigned '${sluaTypeToString(value)}'.`,
					range: rangeFromNode(isAstNode(source) ? source : isAstNode(target) ? target : { type: 'Unknown' }) });
			}
			return;
		}
		if (receiver?.kind !== 'table' || receiver.module || receiver.metatable || !receiver.fields) return;
		const origin = tableOrigin(receiver);
		let fields = tableFields.get(origin);
		if (!fields) { fields = new Map(Object.entries(receiver.fields)); tableFields.set(origin, fields); }
		const expected = fields.get(name) ?? (Object.hasOwn(receiver.fields, name) ? receiver.fields[name] : undefined);
		if (!expected || (expected.kind === 'primitive' && expected.name === 'unknown')) {
			if (fields.size < 128) fields.set(name, value);
			return;
		}
		if ((checks === 'all' || checks === 'types') && !compatible(expected, value, source, true)) {
			diags.push({ code: 'assignment-type-mismatch', severity: 'warning',
				message: `Table field '${name}' expects '${sluaTypeToString(expected)}' but is assigned '${sluaTypeToString(value)}'.`,
				range: rangeFromNode(isAstNode(source) ? source : isAstNode(target) ? target : { type: 'Unknown' }) });
		}
	}

	function visitStatement(stmt: unknown): void {
		if (!isAstNode(stmt)) return;

		if (stmt.type === 'ClassDeclaration') {
			const info = inferClassDeclaration(stmt, registry, currentLocals(), classes.values());
			if (info) {
				classes.set(info.name, info);
				locals.define(info.name, info.constructorType);
				const base = (stmt as AstNode & { superClass?: unknown }).superClass;
				visitExpression(base);
				if (checks === 'all' || checks === 'types') diags.push(...diagnoseClassInheritance(stmt, info));
				const methods = (stmt as AstNode & { methods?: unknown[] }).methods ?? [];
				for (const method of methods) {
					if (!isFunctionDeclaration(method)) continue;
					if ((checks === 'all' || checks === 'types') && isIdentifier(method.identifier) && method.identifier.name === '__init') {
						const first = method.parameters?.[0];
						if (!isIdentifier(first) || first.name !== 'self') diags.push({ code: 'class-constructor-signature', severity: 'warning',
							message: 'A class __init method must have a first parameter named self.', range: rangeFromNode(method) });
						if (method.returnTypeAnnotation !== undefined) diags.push({ code: 'class-constructor-return-annotation', severity: 'warning',
							message: 'Class __init methods must not declare a return annotation. A class call returns its new instance.', range: rangeFromNode(method) });
					}
					// Class method names are not local function bindings. Only a first
					// parameter literally named self receives the implicit class type.
					const first = method.parameters?.[0];
					visitFunctionBody(method, isIdentifier(first) && first.name === 'self' ? [info.instanceType] : []);
				}
			}
			return;
		}

		if (isLocalStatement(stmt)) {
			const init = Array.isArray(stmt.init) ? stmt.init : [];
			for (const expr of init) visitExpression(expr);
			const values = assignmentValues(init, stmt.variables.length);
			for (const [i, variable] of stmt.variables.entries()) {
				if (!isIdentifier(variable)) continue;
				const annotated = variable.typeAnnotation ? classAnnotationType(variable.typeAnnotation, (name) => classes.get(name), (name) => currentLocals().get(name)) : undefined;
				if (init.length) checkAssignment(variable, annotated, values[i]!, init[i]);
				locals.define(variable.name, annotated ?? values[i]!, annotated);
			}
			return;
		}

		if (isAssignmentStatement(stmt)) {
			for (const expr of stmt.init) visitExpression(expr);
			for (const variable of stmt.variables) visitExpression(variable, undefined, true);
			const values = assignmentValues(stmt.init, stmt.variables.length);
			for (const [i, variable] of stmt.variables.entries()) {
				checkTableField(variable, values[i]!, stmt.init[i]);
				if (isMemberExpression(variable) || (isAstNode(variable) && variable.type === 'IndexExpression')) {
					const expression = variable as unknown as Record<string, unknown>;
					const receiver = resolveBuiltinExpression(expression.object, registry, (name) => currentLocals().get(name))?.type;
					const resolved = resolveBuiltinExpression(variable, registry, (name) => currentLocals().get(name));
					if ((checks === 'all' || checks === 'types') && receiver?.kind === 'custom' && resolved?.definition &&
						'readonly' in resolved.definition && resolved.definition.readonly) {
						diags.push({ code: 'readonly-write', severity: 'error', message: `Cannot assign to read-only property '${resolved.definition.name}'.`, range: rangeFromNode(variable) });
					}
					if ((checks === 'all' || checks === 'types') && receiver?.kind === 'array' && isIndexExpression(variable) &&
						arrayKeyCompatibility(arrayKeyType(variable.index, registry, (name) => currentLocals().get(name))) === 'number' &&
						!compatible(slua.union([receiver.element, slua.nil()]), values[i]!, stmt.init[i], true)) {
						diags.push({ code: 'assignment-type-mismatch', severity: 'warning',
							message: `Array element write expects '${sluaTypeToString(slua.union([receiver.element, slua.nil()]))}' but is assigned '${sluaTypeToString(values[i]!)}'.`,
							range: rangeFromNode(isAstNode(stmt.init[i]) ? stmt.init[i] : variable) });
					}
				}
				if (!isIdentifier(variable)) continue;
				checkAssignment(variable, locals.declared(variable.name), values[i]!, stmt.init[i]);
			}
			const writes = tableAssignments(stmt.variables, values, registry, (name) => currentLocals().get(name));
			locals.rewriteTables(writes.update);
			for (const [index, variable] of stmt.variables.entries()) if (isIdentifier(variable)) locals.assign(variable.name, writes.values[index]!);
			return;
		}

		if (isFunctionDeclaration(stmt)) {
			if (stmt.isLocal && isIdentifier(stmt.identifier)) locals.define(stmt.identifier.name, functionDeclarationType(stmt));
			else {
				visitExpression(stmt.identifier, undefined, true);
				const type = functionDeclarationType(stmt); checkTableField(stmt.identifier, type, stmt);
				if (isIdentifier(stmt.identifier)) locals.assign(stmt.identifier.name, type);
				else locals.writeTable(stmt.identifier, type, registry);
			}
			visitFunctionBody(stmt, eventDeclarationContext(stmt.identifier, registry, (name) => currentLocals().get(name)));
			return;
		}

		if (isIfStatement(stmt)) {
			visitExpression(stmt.test);
			const before = locals.checkpoint();
			locals.refine(conditionalGuard(stmt), true);
			locals.push();
			defineConditional(stmt);
			visitStatements(stmt.consequent);
			locals.pop();
			const consequent = locals.checkpoint();
			locals.restore(before);
			locals.refine(conditionalGuard(stmt), false);
			locals.push();
			const alternate = stmt.alternate;
			if (Array.isArray(alternate)) visitStatements(alternate);
			else if (isIfStatement(alternate)) visitStatement(alternate);
			locals.pop();
			if (blockReturns(stmt.consequent) && !blockReturns(alternate)) { /* The false path is the only continuation. */ }
			else if (blockReturns(alternate) && !blockReturns(stmt.consequent)) locals.restore(consequent);
			else locals.join(before, consequent, locals.checkpoint());
			return;
		}

		if (isGenericForStatement(stmt)) {
			for (const iterator of stmt.iterators) visitExpression(iterator);
			const context = arrayIterationContext(stmt.iterators, registry, (name) => currentLocals().get(name));
			const before = locals.checkpoint();
			locals.push();
			for (const [index, variable] of stmt.variables.entries()) {
				if (isIdentifier(variable)) locals.define(variable.name, context[index] ?? slua.unknown());
			}
			visitStatements(stmt.body);
			locals.pop();
			locals.join(before, locals.checkpoint(), before);
			return;
		}

		if (isWhileStatement(stmt)) {
			visitExpression(stmt.test);
			const before = locals.checkpoint();
			locals.refine(conditionalGuard(stmt), true);
			locals.push();
			defineConditional(stmt);
			visitStatements(stmt.body);
			locals.pop();
			locals.join(before, locals.checkpoint(), before);
			return;
		}

		if (isForStatement(stmt)) {
			// Bounds use the outer scope; the numeric control variable exists only
			// inside the loop, even when it shadows an outer local.
			visitExpression(stmt.start);
			visitExpression(stmt.end);
			visitExpression(stmt.step);
			const before = locals.checkpoint();
			locals.push();
			if (isIdentifier(stmt.variable)) locals.define(stmt.variable.name, slua.number());
			visitStatements(stmt.body);
			locals.pop();
			locals.join(before, locals.checkpoint(), before);
			return;
		}

		if (isDoStatement(stmt)) {
			locals.push();
			visitStatements(stmt.body);
			locals.pop();
			return;
		}

		if (isRepeatStatement(stmt)) {
			locals.push();
			visitStatements(stmt.body);
			visitExpression(stmt.test);
			locals.pop();
			return;
		}

		if (isFunctionNode(stmt)) {
			visitFunctionBody(stmt);
			return;
		}

		visitExpression(stmt);
	}

	function visitStatements(statements: unknown[]): void {
		for (const statement of statements) visitStatement(statement);
	}

	visitStatements(ast.body);
	return diags;
}

/** Visit calls with exactly the binding snapshot used by type diagnostics. */
export function visitLexicalCalls(ast: unknown, registry: SluaRegistry, visit: LexicalCallVisitor): void {
	ruleExpressionTypes(ast, registry, 'calls', visit);
}
