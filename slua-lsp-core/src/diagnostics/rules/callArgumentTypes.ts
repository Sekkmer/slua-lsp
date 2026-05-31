import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';
import { slua, sluaTypeIsAssignable, sluaTypeToString } from '../../slua/types.js';
import { inferLocalVariableTypes } from '../../typing/inferLocals.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string };

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

export function ruleCallArgumentTypes(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];

	const locals = new Map<string, SluaType>();
	for (const inferred of inferLocalVariableTypes(ast, registry)) {
		locals.set(inferred.name, inferred.type);
	}

	function visit(node: unknown): void {
		if (!isAstNode(node)) return;
		if (isCallExpression(node)) {
			const resolved = resolveCallSignature(node.callee, registry, locals);
			if (resolved && resolved.signature.kind === 'function') {
				const params = resolved.signature.params;
				const args = node.arguments;
				for (let i = 0; i < Math.min(params.length, args.length); i++) {
					const expected = params[i];
					if (!expected || (expected.kind === 'primitive' && expected.name === 'unknown')) continue;
					const actual = inferExpressionType(args[i], registry, locals);
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
			const value = (node as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
			} else if (isAstNode(value)) {
				visit(value);
			}
		}
	}

	visit(ast);
	return diags;
}
