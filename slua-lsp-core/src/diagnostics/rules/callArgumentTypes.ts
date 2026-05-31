import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';
import { slua, sluaTypeEquals, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable, sluaTypeToString } from '../../slua/types.js';

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
	if (t.kind === 'tuple') return t.items[0] ?? slua.nil();
	return t;
}

function mergeBranchTypes(a: SluaType, b: SluaType): SluaType {
	if (sluaTypeEquals(a, b)) return a;
	if ((a.kind === 'primitive' && a.name === 'unknown') || (b.kind === 'primitive' && b.name === 'unknown')) return slua.unknown();
	return slua.union([a, b]);
}

function resolveCallSignature(
	callee: unknown,
	registry: SluaRegistry,
	locals: Map<string, SluaType>
): { signature: SluaType; displayName: string } | null {
	const key = exprNameKey(callee) ?? 'function';
	if (isIdentifier(callee)) {
		const local = locals.get(callee.name);
		if (local?.kind === 'function') return { signature: local, displayName: key };
		const g = registry.getGlobal(callee.name);
		if (g) return { signature: g.signature, displayName: key };
	}

	if (isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
		const receiver = callee.object.name;
		const prop = callee.property.name;

		const mod = registry.getModule(receiver);
		if (mod) {
			const fn = mod.functions[prop];
			if (fn) return { signature: fn.signature, displayName: key };
		}

		const obj = registry.getObjectType(receiver);
		if (obj) {
			const method = obj.methods[prop];
			if (method) return { signature: method.signature, displayName: key };
		}
	}

	return null;
}

function inferExpressionType(expr: unknown, registry: SluaRegistry, locals: Map<string, SluaType>): SluaType | null {
	if (!isAstNode(expr)) return null;
	if (isStringNode(expr)) return slua.string();
	if (isNumberNode(expr)) return slua.number();
	if (isBooleanNode(expr)) return slua.boolean();
	if (isNilNode(expr)) return slua.nil();
	if (isTableNode(expr)) return slua.table();

	if (isIfExpression(expr)) {
		const localsForBranches = locals;
		const consequent = inferExpressionType(expr.consequent, registry, localsForBranches) ?? slua.unknown();
		const alternate = inferExpressionType(expr.alternate, registry, localsForBranches) ?? slua.unknown();
		return mergeBranchTypes(consequent, alternate);
	}

	if (isTypeCastExpression(expr)) {
		const annotated = sluaTypeFromLuauAnnotationText(expr.typeAnnotation);
		if (!(annotated.kind === 'primitive' && annotated.name === 'unknown')) return annotated;
		return inferExpressionType(expr.expression, registry, locals);
	}

	if (isFunctionNode(expr)) {
		const params = Array.isArray(expr.parameters) ? expr.parameters : [];
		const paramTypes = params.map((p) => (isIdentifier(p) ? sluaTypeFromLuauAnnotationText(p.typeAnnotation) : slua.unknown()));
		const returns = sluaTypeFromLuauAnnotationText(expr.returnTypeAnnotation);
		return slua.fn(paramTypes, returns);
	}

	if (isIdentifier(expr)) {
		const local = locals.get(expr.name);
		if (local) return local;
		const g = registry.getGlobal(expr.name);
		if (g) return g.signature;
		if (registry.getModule(expr.name)) return slua.table();
		if (registry.getObjectType(expr.name)) return slua.table();
		return null;
	}

	if (isMemberExpression(expr) && isIdentifier(expr.object) && isIdentifier(expr.property)) {
		const receiver = expr.object.name;
		const prop = expr.property.name;
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
		const resolved = resolveCallSignature(expr.callee, registry, locals);
		if (!resolved) return null;
		if (resolved.signature.kind !== 'function') return null;
		return getFirstReturn(resolved.signature.returns);
	}

	return null;
}

class LexicalLocals {
	private readonly scopes: Array<Map<string, SluaType>> = [new Map()];

	public snapshot(): Map<string, SluaType> {
		const merged = new Map<string, SluaType>();
		for (const scope of this.scopes) {
			for (const [name, type] of scope) merged.set(name, type);
		}
		return merged;
	}

	public push(): void {
		this.scopes.push(new Map());
	}

	public pop(): void {
		if (this.scopes.length > 1) this.scopes.pop();
	}

	public define(name: string, type: SluaType): void {
		this.scopes[this.scopes.length - 1]?.set(name, type);
	}

	public assign(name: string, type: SluaType): void {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const scope = this.scopes[i]!;
			if (scope.has(name)) {
				scope.set(name, type);
				return;
			}
		}
		this.define(name, type);
	}
}

export function ruleCallArgumentTypes(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];
	const locals = new LexicalLocals();

	function currentLocals(): Map<string, SluaType> {
		return locals.snapshot();
	}

	function inferLocalInitializer(expr: unknown): SluaType {
		return inferExpressionType(expr, registry, currentLocals()) ?? slua.unknown();
	}

	function typeFromAnnotationOrInitializer(id: IdentifierNode, init: unknown): SluaType {
		const annotated = sluaTypeFromLuauAnnotationText(id.typeAnnotation);
		if (!(annotated.kind === 'primitive' && annotated.name === 'unknown')) return annotated;
		return inferLocalInitializer(init);
	}

	function functionDeclarationType(stmt: FunctionDeclarationNode): SluaType {
		const params = Array.isArray(stmt.parameters) ? stmt.parameters : [];
		const paramTypes = params.map((p) => (isIdentifier(p) ? sluaTypeFromLuauAnnotationText(p.typeAnnotation) : slua.unknown()));
		return slua.fn(paramTypes, sluaTypeFromLuauAnnotationText(stmt.returnTypeAnnotation));
	}

	function visitExpression(node: unknown): void {
		if (!isAstNode(node)) return;
		if (isCallExpression(node)) {
			const resolved = resolveCallSignature(node.callee, registry, currentLocals());
			if (resolved && resolved.signature.kind === 'function') {
				const params = resolved.signature.params;
				const args = node.arguments;
				for (let i = 0; i < Math.min(params.length, args.length); i++) {
					const expected = params[i];
					if (!expected || (expected.kind === 'primitive' && expected.name === 'unknown')) continue;
					const actual = inferExpressionType(args[i], registry, currentLocals());
					if (!actual || (actual.kind === 'primitive' && actual.name === 'unknown')) continue;
					if (!sluaTypeIsAssignable(expected, actual)) {
						diags.push({
							code: 'call-argument-type-mismatch',
							severity: 'warning',
							message: `Argument #${i + 1} to ${resolved.displayName} expects '${sluaTypeToString(expected)}' but got '${sluaTypeToString(actual)}'.`,
							range: rangeFromNode(args[i] as AstNode)
						});
					}
				}
			}
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

	function visitFunctionBody(parameters: unknown[] | undefined, body: unknown[] | undefined): void {
		if (!Array.isArray(body)) return;
		locals.push();
		if (Array.isArray(parameters)) {
			for (const param of parameters) {
				if (isIdentifier(param)) locals.define(param.name, sluaTypeFromLuauAnnotationText(param.typeAnnotation));
			}
		}
		visitStatements(body);
		locals.pop();
	}

	function visitStatement(stmt: unknown): void {
		if (!isAstNode(stmt)) return;

		if (isLocalStatement(stmt)) {
			const init = Array.isArray(stmt.init) ? stmt.init : [];
			for (const expr of init) visitExpression(expr);
			const vars = stmt.variables.filter(isIdentifier);
			for (let i = 0; i < vars.length; i++) {
				locals.define(vars[i]!.name, typeFromAnnotationOrInitializer(vars[i]!, init[i]));
			}
			return;
		}

		if (isAssignmentStatement(stmt)) {
			for (const expr of stmt.init) visitExpression(expr);
			const vars = stmt.variables.filter(isIdentifier);
			for (let i = 0; i < vars.length; i++) {
				locals.assign(vars[i]!.name, inferLocalInitializer(stmt.init[i]));
			}
			return;
		}

		if (isFunctionDeclaration(stmt)) {
			if (stmt.isLocal && isIdentifier(stmt.identifier)) locals.define(stmt.identifier.name, functionDeclarationType(stmt));
			visitFunctionBody(stmt.parameters, stmt.body);
			return;
		}

		if (isIfStatement(stmt)) {
			visitExpression(stmt.test);
			locals.push();
			visitStatements(stmt.consequent);
			locals.pop();

			const alternate = stmt.alternate;
			if (Array.isArray(alternate)) {
				locals.push();
				visitStatements(alternate);
				locals.pop();
			} else if (isIfStatement(alternate)) {
				visitStatement(alternate);
			}
			return;
		}

		if (isGenericForStatement(stmt)) {
			for (const iterator of stmt.iterators) visitExpression(iterator);
			locals.push();
			for (const variable of stmt.variables) {
				if (isIdentifier(variable)) locals.define(variable.name, slua.unknown());
			}
			visitStatements(stmt.body);
			locals.pop();
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
			visitFunctionBody(stmt.parameters, stmt.body);
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
