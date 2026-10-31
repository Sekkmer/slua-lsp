import { isCallExpression, isIdentifier, isMemberExpression, isStringNode } from '../parser/ast.js';
import { resolveBuiltinExpression, type LocalTypeLookup } from './resolveBuiltin.js';
import type { SluaRegistry } from './registry.js';
import { slua, type SluaType } from './types.js';

/** Parameters supplied by a known native registration, without executing code. */
export function callbackContext(call: unknown, registry: SluaRegistry, local: LocalTypeLookup): Map<unknown, SluaType[]> {
	const result = new Map<unknown, SluaType[]>();
	if (!isCallExpression(call) || !isMemberExpression(call.callee) || !isIdentifier(call.callee.property)) return result;
	const member = call.callee;
	const receiver = resolveBuiltinExpression(member.object, registry, local)?.type;
	if (receiver?.kind !== 'table' || !receiver.metatable) return result;
	const offset = member.indexer === ':' ? 0 : 1;
	const name = call.callee.property.name;
	if (receiver.metatable === 'LLEvents' && ['on', 'once'].includes(name)) {
		const event = call.arguments[offset];
		if (isStringNode(event)) {
			const signature = registry.eventSignatures[event.value];
			if (signature) result.set(call.arguments[offset + 1], signature.params.map((p) => p.type));
		}
	} else if (receiver.metatable === 'LLTimers' && ['once', 'every'].includes(name)) {
		result.set(call.arguments[offset + 1], [slua.number(), name === 'once' ? slua.nil() : slua.number()]);
	}
	return result;
}

export function eventDeclarationContext(identifier: unknown, registry: SluaRegistry, local: LocalTypeLookup): SluaType[] {
	if (!isMemberExpression(identifier) || !isIdentifier(identifier.property) || identifier.indexer === ':') return [];
	const receiver = resolveBuiltinExpression(identifier.object, registry, local)?.type;
	return receiver?.kind === 'table' && receiver.metatable === 'LLEvents'
		? registry.eventSignatures[identifier.property.name]?.params.map((p) => p.type) ?? [] : [];
}

/** Generalized array iteration and unshadowed ipairs retain the element type. */
export function arrayIterationContext(iterators: unknown[], registry: SluaRegistry, local: LocalTypeLookup): SluaType[] {
	if (iterators.length !== 1) return [];
	let expression = iterators[0];
	if (isCallExpression(expression) && isIdentifier(expression.callee) && expression.callee.name === 'ipairs' && !local('ipairs')) expression = expression.arguments[0];
	const type = resolveBuiltinExpression(expression, registry, local)?.type;
	return type?.kind === 'array' ? [slua.number(), type.element] : [];
}
