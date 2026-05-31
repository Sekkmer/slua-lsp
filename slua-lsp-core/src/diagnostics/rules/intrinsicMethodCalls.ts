import type { CoreDiagnostic } from '../types.js';

import { buildSluaRegistryFromLslDefinitions } from '../../slua/registry.js';
import type { SluaRegistry } from '../../slua/registry.js';

type AstNode = { type: string; location?: { start: { line: number; column: number }; end: { line: number; column: number } } };
type IdentifierNode = AstNode & { type: 'Identifier'; name: string };

type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	indexer?: '.' | ':';
};

type CallExpressionNode = AstNode & {
	type: 'CallExpression';
	callee: unknown;
	arguments: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof value.type === 'string';
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression' && 'object' in value && 'property' in value;
}

function isCallExpression(value: unknown): value is CallExpressionNode {
	return isAstNode(value) && value.type === 'CallExpression' && Array.isArray((value as Record<string, unknown>).arguments) && 'callee' in value;
}

function rangeFromNode(node: AstNode): CoreDiagnostic['range'] {
	const loc = node.location;
	if (!loc) {
		return {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 }
		};
	}
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

function visitAll(root: unknown, fn: (node: AstNode) => void): void {
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== 'object') return;
		if (seen.has(value as object)) return;
		seen.add(value as object);

		if (isAstNode(value)) fn(value);
		const record = value as Record<string, unknown>;
		const loc = record.location;
		for (const child of Object.values(record)) {
			if (child === loc) continue;
			visit(child);
		}
	}
	visit(root);
}

function getCallMemberTarget(call: CallExpressionNode): {
	receiver: string;
	method: string;
	indexer?: '.' | ':';
	member: MemberExpressionNode;
	property: IdentifierNode;
} | null {
	if (!isMemberExpression(call.callee)) return null;
	const member = call.callee;
	if (!isIdentifier(member.object) || !isIdentifier(member.property)) return null;
	return { receiver: member.object.name, method: member.property.name, indexer: member.indexer, member, property: member.property };
}

export function ruleIntrinsicMethodCalls(ast: unknown, registry?: SluaRegistry): CoreDiagnostic[] {
	const diags: CoreDiagnostic[] = [];
	const reg = registry ?? buildSluaRegistryFromLslDefinitions(null);

	visitAll(ast, (node) => {
		if (!isCallExpression(node)) return;
		const target = getCallMemberTarget(node);
		if (!target) return;

		// 1) Object-type intrinsic methods (LLEvents/LLTimers): enforce ':' call style.
		const receiverType = reg.getObjectType(target.receiver);
		if (receiverType) {
			const methodDef = receiverType.methods[target.method];
			if (!methodDef) {
				diags.push({
					code: 'unknown-intrinsic-method',
					severity: 'error',
					message: `Unknown method ${target.receiver}:${target.method}(...).`,
					range: rangeFromNode(target.property)
				});
				return;
			}

			// If indexer is missing (older AST), treat it as '.' and warn.
			const indexer = target.indexer ?? '.';
			if (methodDef.requiresColonCall && indexer === '.') {
				diags.push({
					code: 'use-colon-call',
					severity: 'error',
					message: `Use ':' when calling ${target.receiver}:${target.method}(...); dot-call loses 'self'.`,
					range: rangeFromNode(target.member)
				});
			}
			return;
		}

		// 2) Module functions (lljson/llbase64/vector/etc): enforce '.' call style.
		// In SLua these are plain functions; colon-call injects 'self' and often changes arity.
		const mod = reg.getModule(target.receiver);
		if (!mod) return;
		// Don't require the function to be declared in the registry.
		// Even when we don't have full module member coverage yet, `module:fn(...)`
		// is almost always a bug in SLua because it injects `self`.

		const indexer = target.indexer ?? '.';
		if (indexer === ':') {
			diags.push({
				code: 'use-dot-call',
				severity: 'error',
				message: `Use '.' when calling ${target.receiver}.${target.method}(...); colon-call passes 'self'.`,
				range: rangeFromNode(target.member)
			});
		}
	});

	return diags;
}
