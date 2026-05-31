import type { CoreDiagnostic } from './types.js';
import { applyDirectives } from './directives.js';
import { parseSlua } from '../parser/parseSlua.js';
import type { SluaEventSignature } from '../slua/events.js';
import { ruleLLEventsCalls } from './rules/lleventsCalls.js';
import { ruleIntrinsicMethodCalls } from './rules/intrinsicMethodCalls.js';
import { ruleLegacyTimerApis } from './rules/legacyTimerApis.js';
import { ruleRemovedLlApis } from './rules/removedLlApis.js';
import type { SluaRegistry } from '../slua/registry.js';
import { ruleTypeGuardConditions } from './rules/typeGuardConditions.js';
import { ruleAssignmentReturnCountMismatch } from './rules/assignmentReturnCountMismatch.js';
import { ruleDeclaredReturnMismatch } from './rules/declaredReturnMismatch.js';
import { ruleUndeclaredNames } from './rules/undeclaredNames.js';
import { ruleCallArgumentTypes } from './rules/callArgumentTypes.js';
import { ruleCallArgumentCountMismatch } from './rules/callArgumentCountMismatch.js';
import { ruleReadonlyWrites } from './rules/readonlyWrites.js';

export type AnalyzeContext = {
	ast?: unknown;
	eventSignatures?: Record<string, SluaEventSignature>;
	registry?: SluaRegistry;
};

export function analyzeText(text: string, ctx: AnalyzeContext = {}): CoreDiagnostic[] {
	const ast = ctx.ast ?? parseSlua(text).ast;
	const diags: CoreDiagnostic[] = [];
	if (ast) diags.push(...ruleIntrinsicMethodCalls(ast, ctx.registry));
	if (ast) diags.push(...ruleLegacyTimerApis(ast));
	if (ast) diags.push(...ruleRemovedLlApis(ast));
	if (ast) diags.push(...ruleUndeclaredNames(ast, ctx.registry));
	if (ast && ctx.registry) diags.push(...ruleTypeGuardConditions(ast, ctx.registry));
	if (ast && ctx.registry) diags.push(...ruleAssignmentReturnCountMismatch(ast, ctx.registry));
	if (ast && ctx.registry) diags.push(...ruleDeclaredReturnMismatch(ast, ctx.registry));
	if (ast && ctx.registry) diags.push(...ruleCallArgumentTypes(ast, ctx.registry));
	if (ast && ctx.registry) diags.push(...ruleCallArgumentCountMismatch(ast, ctx.registry));
	if (ast) diags.push(...ruleReadonlyWrites(ast, ctx.registry, text));

	if (ctx.eventSignatures) {
		if (ast) diags.push(...ruleLLEventsCalls(ast, ctx.eventSignatures));
	}

	return diags;
}

export function analyzeTextWithDirectives(text: string, ctx: AnalyzeContext = {}): CoreDiagnostic[] {
	return applyDirectives(text, analyzeText(text, ctx));
}
