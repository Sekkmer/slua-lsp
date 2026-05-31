import type { CoreDiagnostic, Range } from '../types.js';

import type { SluaRegistry } from '../../slua/registry.js';
import type { SluaType } from '../../slua/types.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown; indexer?: '.' | ':' };

type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type StringNode = AstNode & { type: 'String'; value: string };

type FunctionDeclarationNode = AstNode & {
	type: 'FunctionDeclaration';
	identifier?: unknown;
	isLocal: boolean;
	parameters: unknown[];
	body: unknown[];
};

type LocalStatementNode = AstNode & { type: 'LocalStatement'; variables: unknown[]; init?: unknown[] };

type FunctionNode = AstNode & { type: 'Function'; parameters: unknown[]; body: unknown[] };

type ReturnStatementNode = AstNode & { type: 'ReturnStatement'; arguments: unknown[] };

type AssignmentStatementNode = AstNode & { type: 'AssignmentStatement'; variables: unknown[]; init: unknown[] };

type NilNode = AstNode & { type: 'Nil' };

type NumberNode = AstNode & { type: 'Number'; value: number };

type BooleanNode = AstNode & { type: 'Boolean'; value: boolean };

type TableNode = AstNode & { type: 'Table'; fields?: unknown[] };

type TableFieldNode = AstNode & { type: 'TableField'; key?: unknown; value?: unknown };

type StringLiteralNode = AstNode & { type: 'String'; value: string };

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

function isFunctionDeclaration(v: unknown): v is FunctionDeclarationNode {
	return (
		isAstNode(v) &&
		v.type === 'FunctionDeclaration' &&
		Array.isArray((v as Record<string, unknown>).body)
	);
}

function isLocalStatement(v: unknown): v is LocalStatementNode {
	return isAstNode(v) && v.type === 'LocalStatement' && Array.isArray((v as Record<string, unknown>).variables);
}

function isFunctionNode(v: unknown): v is FunctionNode {
	return isAstNode(v) && v.type === 'Function' && Array.isArray((v as Record<string, unknown>).body);
}

function isReturnStatement(v: unknown): v is ReturnStatementNode {
	return isAstNode(v) && v.type === 'ReturnStatement' && Array.isArray((v as Record<string, unknown>).arguments);
}

function isAssignmentStatement(v: unknown): v is AssignmentStatementNode {
	return (
		isAstNode(v) &&
		v.type === 'AssignmentStatement' &&
		Array.isArray((v as Record<string, unknown>).variables) &&
		Array.isArray((v as Record<string, unknown>).init)
	);
}

function isNilNode(v: unknown): v is NilNode {
	return isAstNode(v) && v.type === 'Nil';
}

function isNumberNode(v: unknown): v is NumberNode {
	return isAstNode(v) && v.type === 'Number' && typeof (v as Record<string, unknown>).value === 'number';
}

function isBooleanNode(v: unknown): v is BooleanNode {
	return isAstNode(v) && v.type === 'Boolean' && typeof (v as Record<string, unknown>).value === 'boolean';
}

function isTableNode(v: unknown): v is TableNode {
	return isAstNode(v) && v.type === 'Table';
}

function isTableFieldNode(v: unknown): v is TableFieldNode {
	return isAstNode(v) && v.type === 'TableField';
}

function isStringLiteralNode(v: unknown): v is StringLiteralNode {
	return isAstNode(v) && v.type === 'String' && typeof (v as Record<string, unknown>).value === 'string';
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

function extractFunctionSignatures(sig: SluaType): SluaType[] {
	if (sig.kind === 'function') return [sig];
	if (sig.kind === 'union') return sig.items.filter((t) => t.kind === 'function') as SluaType[];
	return [];
}

function resolveCallSignature(
	callee: unknown,
	registry: SluaRegistry
): { signatures: SluaType[]; displayName: string } | null {
	const key = exprNameKey(callee) ?? 'function';
	if (isIdentifier(callee)) {
		const g = registry.getGlobal(callee.name);
		if (g) return { signatures: extractFunctionSignatures(g.signature), displayName: key };
	}

	if (isMemberExpression(callee) && isIdentifier(callee.object) && isIdentifier(callee.property)) {
		const receiver = callee.object.name;
		const prop = callee.property.name;

		const mod = registry.getModule(receiver);
		if (mod) {
			const fn = mod.functions[prop];
			if (fn) return { signatures: extractFunctionSignatures(fn.signature), displayName: key };
		}

		const obj = registry.getObjectType(receiver);
		if (obj) {
			const method = obj.methods[prop];
			if (method) return { signatures: extractFunctionSignatures(method.signature), displayName: key };
		}
	}

	return null;
}

function inferSimpleReturnCount(fn: FunctionDeclarationNode | FunctionNode): number | null {
	let sawReturn = false;
	let count: number | null = null;
	let mixed = false;

	function record(n: number) {
		sawReturn = true;
		if (count === null) count = n;
		else if (count !== n) mixed = true;
	}

	function visit(node: unknown): void {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isAstNode(node)) return;
		if (isReturnStatement(node)) {
			const args = node.arguments;
			if (args.length === 0) record(0);
			else record(args.length);
			return;
		}

		// Nested functions should not influence the enclosing function's return shape.
		if (isFunctionDeclaration(node) || isFunctionNode(node)) return;

		for (const key of Object.keys(node)) {
			const value = (node as Record<string, unknown>)[key];
			visit(value);
		}
	}

	visit(fn.body);
	if (!sawReturn) return 0;
	if (mixed) return null;
	return count;
}

function collectLocalFunctionReturnCounts(ast: ProgramNode): Map<string, number | null> {
	const map = new Map<string, number | null>();

	function visit(node: unknown): void {
		if (!isAstNode(node)) return;
		if (isFunctionDeclaration(node) && node.identifier && isIdentifier(node.identifier)) {
			const name = node.identifier.name;
			map.set(name, inferSimpleReturnCount(node));
		}
		if (isLocalStatement(node)) {
			const vars = node.variables.filter(isIdentifier);
			const init = node.init ?? [];
			for (let i = 0; i < Math.min(vars.length, init.length); i++) {
				const v = vars[i]!;
				const rhs = init[i];
				if (isFunctionNode(rhs)) map.set(v.name, inferSimpleReturnCount(rhs));
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
	return map;
}

function inferExpressionValueCount(expr: unknown, fnReturns: Map<string, number | null>): number | null {
	if (!isAstNode(expr)) return 1;
	if (isNumberNode(expr) || isBooleanNode(expr) || isStringLiteralNode(expr) || isTableNode(expr) || isNilNode(expr)) return 1;
	if (isIdentifier(expr)) return 1;
	if (isCallExpression(expr)) {
		if (isIdentifier(expr.callee)) {
			const name = expr.callee.name;
			const count = fnReturns.get(name);
			return count ?? null;
		}
		return null;
	}
	return null;
}

export function ruleCallArgumentCountMismatch(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	if (!isProgram(ast)) return [];
	const diags: CoreDiagnostic[] = [];
	const fnReturns = collectLocalFunctionReturnCounts(ast);

	function visit(node: unknown): void {
		if (!isAstNode(node)) return;
		if (isCallExpression(node)) {
			const resolved = resolveCallSignature(node.callee, registry);
			if (resolved && resolved.signatures.length > 0) {
				const argExprs = node.arguments;
				let produced = argExprs.length;
				let lastCount: number | null = null;
				if (argExprs.length > 0) {
					const last = argExprs[argExprs.length - 1];
					const count = inferExpressionValueCount(last, fnReturns);
					lastCount = count;
					if (typeof count === 'number') produced = (argExprs.length - 1) + count;
				}

				const minRequired = Math.min(...resolved.signatures.map((s) => (s.kind === 'function' ? s.params.length : 0)));
				if (produced < minRequired) {
					const display = resolved.displayName;
					diags.push({
						code: 'call-argument-count-mismatch',
						severity: 'warning',
						message:
							lastCount === 0
								? `Last argument to ${display} expands to 0 values, but the call requires at least ${minRequired} argument(s).`
								: `Call to ${display} supplies ${produced} argument(s), but at least ${minRequired} are required.`,
						range: rangeFromNode(node)
					});
				}
			}
		}

		if (isTableNode(node) && Array.isArray(node.fields)) {
			for (const field of node.fields) {
				if (!isTableFieldNode(field) || !field.value) continue;
				const count = inferExpressionValueCount(field.value, fnReturns);
				if (count === 0) {
					diags.push({
						code: 'value-from-zero-return',
						severity: 'warning',
						message: 'Value expression expands to 0 values; this table field will be omitted.',
						range: rangeFromNode(field as AstNode)
					});
				}
			}
		}

		if (isAssignmentStatement(node)) {
			const init = node.init;
			if (init.length > 0) {
				const last = init[init.length - 1];
				const count = inferExpressionValueCount(last, fnReturns);
				if (count === 0) {
					diags.push({
						code: 'value-from-zero-return',
						severity: 'warning',
						message: 'Value expression expands to 0 values; assignment will receive nil.',
						range: rangeFromNode(node)
					});
				}
			}
		}

		if (isReturnStatement(node)) {
			const args = node.arguments;
			if (args.length > 0) {
				const last = args[args.length - 1];
				const count = inferExpressionValueCount(last, fnReturns);
				if (count === 0) {
					diags.push({
						code: 'value-from-zero-return',
						severity: 'warning',
						message: 'Value expression expands to 0 values; return will omit this value.',
						range: rangeFromNode(node)
					});
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
