import type { SluaRegistry } from '../../slua/registry.js';
import type { CoreDiagnostic } from '../types.js';
import { ruleExpressionTypes } from './callArgumentTypes.js';

/** Compatibility entry point; the ordinary engine checks returns during its
 * shared lexical walk, including nested callbacks and parameter refinements. */
export function ruleDeclaredReturnMismatch(ast: unknown, registry: SluaRegistry): CoreDiagnostic[] {
	return ruleExpressionTypes(ast, registry, 'returns').filter((item) => item.code.startsWith('declared-return-'));
}
