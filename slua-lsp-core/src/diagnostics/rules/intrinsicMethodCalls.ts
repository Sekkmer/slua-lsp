import type { CoreDiagnostic } from '../types.js';

import {
	isCallExpression,
	isIdentifier,
	isMemberExpression,
	rangeFromNode,
	type CallExpressionNode,
	type IdentifierNode,
	type MemberExpressionNode,
	visitAst
} from '../../parser/ast.js';
import { buildSluaRegistryFromLslDefinitions } from '../../slua/registry.js';
import type { SluaRegistry } from '../../slua/registry.js';

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

	visitAst(ast, (node) => {
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
