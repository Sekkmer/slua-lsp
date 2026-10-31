import type { CoreDiagnostic } from '../types.js';
import { isAstNode, isIdentifier, isMemberExpression, isStringNode, rangeFromNode } from '../../parser/ast.js';
import { resolveBuiltinExpression, type LocalTypeLookup } from '../../slua/resolveBuiltin.js';
import type { SluaRegistry } from '../../slua/registry.js';
import { REMOVED_LL_APIS } from '../../slua/removedApis.js';

/** Availability follows the actual module binding, including local aliases. */
export function diagnoseModuleAvailability(node: unknown, registry: SluaRegistry, local: LocalTypeLookup): CoreDiagnostic[] {
	if (!isAstNode(node)) return [];
	let receiver: unknown, property: unknown, name: string | undefined;
	if (isMemberExpression(node) && isIdentifier(node.property)) {
		receiver = node.object; property = node.property; name = node.property.name;
	} else if (node.type === 'IndexExpression') {
		const index = node as unknown as Record<string, unknown>;
		if (isStringNode(index.index)) { receiver = index.object; property = index.index; name = index.index.value; }
	}
	if (!name || !isAstNode(property)) return [];
	const resolved = resolveBuiltinExpression(receiver, registry, local);
	const module = resolved?.type.kind === 'table' ? resolved.type.module :
		isIdentifier(receiver) && receiver.name === 'll' && !local('ll') ? 'll' : undefined;
	if ((module === 'll' || module === 'llcompat') && (name === 'TRUE' || name === 'FALSE')) {
		return [{ code: 'removed-ll-constant', severity: 'error',
			message: `${module}.${name} is removed in SLua. Use the boolean literal ${name.toLowerCase()}.`, range: rangeFromNode(property) }];
	}
	if (module !== 'll') return [];
	const info = REMOVED_LL_APIS[name];
	if (!info) return [];
	return [{ code: name === 'SetTimerEvent' ? 'legacy-timer-api' : 'removed-ll-api', severity: 'error',
		message: `ll.${name} is not available in the ordinary SLua module. ${info.message}`, range: rangeFromNode(property) }];
}
