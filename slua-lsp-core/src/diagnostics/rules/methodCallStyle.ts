import type { CoreDiagnostic } from '../types.js';
import { isAstNode, isMemberExpression, isIdentifier, rangeFromNode, type CallExpressionNode } from '../../parser/ast.js';
import { resolveBuiltinExpression, type LocalTypeLookup } from '../../slua/resolveBuiltin.js';
import type { SluaRegistry } from '../../slua/registry.js';
import { defaultMetatableRegistry } from '../../slua/metatables.js';
import { sluaTypeIsAssignable } from '../../slua/types.js';

/** Check actual calls after lexical binding resolution; member reads are legal. */
export function diagnoseMethodCallStyle(call: CallExpressionNode, registry: SluaRegistry, local: LocalTypeLookup): CoreDiagnostic[] {
	if (!isMemberExpression(call.callee) || !isIdentifier(call.callee.property)) return [];
	const member = call.callee;
	const name = call.callee.property.name;
	const receiver = resolveBuiltinExpression(member.object, registry, local);
	if (!receiver || (receiver.type.kind !== 'table' && receiver.type.kind !== 'custom')) return [];
	const type = receiver.type.kind === 'custom' ? { kind: 'table' as const, metatable: receiver.type.name } : receiver.type;
	const display = receiver.displayName ?? type.metatable ?? type.module ?? 'value';
	const range = rangeFromNode(call.callee.property);
	if (type.metatable) {
		const object = registry.getObjectType(type.metatable);
		const method = object?.methods[name] ?? defaultMetatableRegistry.getMembers(type.metatable)?.[name];
		if (!method) return object ? [{ code: 'unknown-intrinsic-method', severity: 'error',
			message: `Unknown method ${display}:${name}(...).`, range }] : [];
		if (method.requiresColonCall && member.indexer !== ':') {
			const explicitSelf = resolveBuiltinExpression(call.arguments[0], registry, local)?.type;
			const signature = registry.getModule(type.metatable)?.functions[name]?.signature;
			const expectedSelf = receiver.type.kind === 'custom' ? receiver.type : signature?.kind === 'function' ? signature.params[0] ?? type : type;
			// Dot syntax is valid when the caller supplies self explicitly. Unknown
			// values remain conservative; argument diagnostics may know more later.
			if (expectedSelf.kind === 'table' && !expectedSelf.metatable && !expectedSelf.module &&
				isAstNode(call.arguments[0]) && call.arguments[0].type === 'Table') return [];
			if (explicitSelf && (sluaTypeIsAssignable(expectedSelf, explicitSelf) ||
				(explicitSelf.kind === 'primitive' && explicitSelf.name === 'unknown'))) return [];
			return [{ code: 'use-colon-call', severity: 'error',
				message: `Use ':' when calling ${display}:${name}(...), or pass self explicitly as the first argument.`, range }];
		}
		return [];
	}
	if (type.module && member.indexer === ':') {
		const fn = registry.getModule(type.module)?.functions[name];
		// Only diagnose known plain functions, not missing exports or a native
		// table builder whose signature already expects an explicit self table.
		if (fn?.signature.kind === 'function' && fn.signature.params[0]?.kind !== 'table') {
			return [{ code: 'use-dot-call', severity: 'error',
				message: `Use '.' when calling ${display}.${name}(...); colon-call passes 'self'.`, range }];
		}
	}
	return [];
}
