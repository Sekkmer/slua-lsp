import { isAstNode, isIdentifier, type IdentifierNode } from '../parser/ast.js';
import { sluaTypeFromLuauAnnotationText, type SluaType } from '../slua/types.js';
import { truthyType } from './refinements.js';

export function conditionalBinding(value: unknown): IdentifierNode | undefined {
	if (!isAstNode(value) || (value.type !== 'IfStatement' && value.type !== 'IfExpression')) return undefined;
	const binding = (value as Record<string, unknown>).conditionLocal;
	return isIdentifier(binding) ? binding : undefined;
}

/** The initializer is a single-value expression, evaluated in the outer scope.
 * Keep annotation checking separate: even a falsy initializer must satisfy it.
 */
export function conditionalBindingType(binding: IdentifierNode, inferred: SluaType): SluaType {
	const annotated = sluaTypeFromLuauAnnotationText(binding.typeAnnotation);
	return truthyType(annotated.kind === 'primitive' && annotated.name === 'unknown' ? inferred : annotated, true);
}

/** A declaration's initializer is not an ordinary guard on outer names. */
export function conditionalGuard(value: unknown): unknown {
	return isAstNode(value) && !conditionalBinding(value) ? (value as Record<string, unknown>).test : undefined;
}
