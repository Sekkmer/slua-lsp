import type { CoreDiagnostic } from './types.js';
import { applyDirectives } from './directives.js';
import { parseSlua } from '../parser/parseSlua.js';
import type { SluaEventSignature } from '../slua/events.js';
import { createLLEventsCallChecker } from './rules/lleventsCalls.js';
import { buildSluaRegistryFromLslDefinitions, type SluaRegistry } from '../slua/registry.js';
import { ruleTypeGuardConditions } from './rules/typeGuardConditions.js';
import { ruleAssignmentReturnCountMismatch } from './rules/assignmentReturnCountMismatch.js';
import { ruleUndeclaredNames } from './rules/undeclaredNames.js';
import { ruleExpressionTypes } from './rules/callArgumentTypes.js';
import { createCallArgumentCountChecker } from './rules/callArgumentCountMismatch.js';
import { ruleReadonlyWrites } from './rules/readonlyWrites.js';
import { ruleLiteralTruthiness, createLiteralIpairsChecker } from './rules/gotchas.js';
import { ruleClassInitialization } from './rules/classInitialization.js';
import { ruleTypeDefinitions } from './rules/typeDefinitions.js';

export type AnalyzeContext = {
	ast?: unknown;
	eventSignatures?: Record<string, SluaEventSignature>;
	registry?: SluaRegistry;
};

export function analyzeText(text: string, ctx: AnalyzeContext = {}): CoreDiagnostic[] {
	const ast = ctx.ast ?? parseSlua(text).ast;
	const diags: CoreDiagnostic[] = [];
	if (ast && ctx.registry) diags.push(...ctx.registry.sourceMacroDiagnostics);
	if (ast) diags.push(...ruleUndeclaredNames(ast, ctx.registry));
	if (ast) diags.push(...ruleLiteralTruthiness(ast));
	if (ast && /\bclass\b/.test(text)) diags.push(...ruleClassInitialization(ast));
	if (ast && /\btype\b/.test(text)) diags.push(...ruleTypeDefinitions(ast));
	if (ast && ctx.registry) diags.push(...ruleTypeGuardConditions(ast, ctx.registry));
	if (ast && ctx.registry) diags.push(...ruleAssignmentReturnCountMismatch(ast, ctx.registry));
	if (ast) {
		const registry = ctx.registry ?? buildSluaRegistryFromLslDefinitions(null);
		const ipairs = createLiteralIpairsChecker(ast);
		const counts = ctx.registry ? createCallArgumentCountChecker(ast, registry) : undefined;
		const events = ctx.eventSignatures ? createLLEventsCallChecker(ctx.eventSignatures, registry) : undefined;
		diags.push(...ruleExpressionTypes(ast, registry, ctx.registry ? 'all' : 'methods', (call, locals) => {
			diags.push(...ipairs(call, locals));
			counts?.visit(call, locals);
			events?.visit(call, locals);
		}));
		if (counts) diags.push(...counts.diagnostics);
		if (events) diags.push(...events.diagnostics);
		diags.push(...ruleReadonlyWrites(ast, ctx.registry, text));
	}

	return diags;
}

export function analyzeTextWithDirectives(text: string, ctx: AnalyzeContext = {}): CoreDiagnostic[] {
	return applyDirectives(text, analyzeText(text, ctx));
}
