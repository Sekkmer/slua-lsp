import type { CoreDiagnostic } from '../types.js';
import { isFunctionNode, isIdentifier, rangeFromNode, type CallExpressionNode } from '../../parser/ast.js';
import { slua, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable } from '../../slua/types.js';

/** Native timer callbacks may omit arguments; declared arguments consume number/nil. */
export function diagnoseTimerCallback(node: CallExpressionNode, method: 'once' | 'every', callbackIndex: number): CoreDiagnostic[] {
	const diagnostics: CoreDiagnostic[] = [];
	diagnose();
	function diagnose(): void {
		const callback = node.arguments[callbackIndex];
		if (!isFunctionNode(callback)) return;
		for (const [index, parameter] of callback.parameters.entries()) {
			if (!isIdentifier(parameter) || !parameter.typeAnnotation) continue;
			const declared = sluaTypeFromLuauAnnotationText(parameter.typeAnnotation);
			if (declared.kind === 'primitive' && declared.name === 'unknown') continue;
			const supplied = index === 0 || (index === 1 && method === 'every') ? slua.number() : slua.nil();
			if (!sluaTypeIsAssignable(declared, supplied)) diagnostics.push({ code: 'callback-param-type-mismatch', severity: 'error',
				message: `LLTimers:${method} callback parameter ${index + 1} receives ${supplied.kind === 'primitive' ? supplied.name : 'nil'}, incompatible with '${parameter.typeAnnotation}'.`,
				range: rangeFromNode(parameter) });
		}
	}
	return diagnostics;
}
