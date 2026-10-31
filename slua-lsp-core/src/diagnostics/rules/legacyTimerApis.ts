import type { CoreDiagnostic } from '../types.js';
import { buildSluaRegistryFromLslDefinitions, type SluaRegistry } from '../../slua/registry.js';
import { ruleExpressionTypes } from './callArgumentTypes.js';

/** Compatibility entry point; use the shared lexical availability walk. */
export function ruleLegacyTimerApis(ast: unknown, registry: SluaRegistry = buildSluaRegistryFromLslDefinitions(null)): CoreDiagnostic[] {
	return ruleExpressionTypes(ast, registry, 'availability').filter((diagnostic) => diagnostic.code === 'legacy-timer-api');
}
