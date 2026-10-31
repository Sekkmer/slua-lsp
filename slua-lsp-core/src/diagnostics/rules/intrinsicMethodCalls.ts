import type { CoreDiagnostic } from '../types.js';
import { buildSluaRegistryFromLslDefinitions, type SluaRegistry } from '../../slua/registry.js';
import { ruleExpressionTypes } from './callArgumentTypes.js';

/** Standalone entry point sharing the same lexical walk as normal analysis. */
export function ruleIntrinsicMethodCalls(ast: unknown, registry?: SluaRegistry): CoreDiagnostic[] {
	return ruleExpressionTypes(ast, registry ?? buildSluaRegistryFromLslDefinitions(null), 'methods');
}
