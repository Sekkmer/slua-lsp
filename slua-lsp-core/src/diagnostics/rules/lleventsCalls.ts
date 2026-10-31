import { visitLexicalCalls, type LexicalCallVisitor } from './callArgumentTypes.js';
import { resolveBuiltinExpression } from '../../slua/resolveBuiltin.js';
import { buildSluaRegistryFromLslDefinitions, type SluaRegistry } from '../../slua/registry.js';
import type { CoreDiagnostic } from '../types.js';

import type { SluaEventSignature } from '../../slua/events.js';
import { slua, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable, sluaTypeToString } from '../../slua/types.js';

type AstNode = { type: string; location?: { start: { line: number; column: number }; end: { line: number; column: number } } };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };

type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	indexer?: '.' | ':';
};

type FunctionNode = AstNode & {
	type: 'Function';
	parameters: unknown[];
};

type StringNode = AstNode & { type: 'String'; value: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof value.type === 'string';
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression' && 'object' in value && 'property' in value;
}

function isFunctionNode(value: unknown): value is FunctionNode {
	return isAstNode(value) && value.type === 'Function' && Array.isArray((value as Record<string, unknown>).parameters);
}

function isStringNode(value: unknown): value is StringNode {
	return isAstNode(value) && value.type === 'String' && typeof (value as Record<string, unknown>).value === 'string';
}

function rangeFromNode(node: AstNode): CoreDiagnostic['range'] {
	const loc = node.location;
	if (!loc) {
		return {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 }
		};
	}
	// Parser locations are 1-based (line/column), LSP is 0-based.
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

function isValidSluaEventName(eventName: string, eventSigs: Record<string, SluaEventSignature>): boolean {
	return Boolean(eventSigs[eventName]);
}

export function ruleLLEventsCalls(ast: unknown, eventSigs: Record<string, SluaEventSignature>, registry: SluaRegistry = buildSluaRegistryFromLslDefinitions(null)): CoreDiagnostic[] {
	const checker = createLLEventsCallChecker(eventSigs, registry);
	visitLexicalCalls(ast, registry, checker.visit);
	return checker.diagnostics;
}

/** Pure call checks can join the engine's existing lexical walk. */
export function createLLEventsCallChecker(eventSigs: Record<string, SluaEventSignature>, registry: SluaRegistry): { diagnostics: CoreDiagnostic[]; visit: LexicalCallVisitor } {
	const diags: CoreDiagnostic[] = [];
	const checkCall: LexicalCallVisitor = (node, locals) => {
		if (!isMemberExpression(node.callee) || !isIdentifier(node.callee.property)) return;
		const receiver = resolveBuiltinExpression(node.callee.object, registry, (name) => locals.get(name))?.type;
		if (receiver?.kind !== 'table' || receiver.metatable !== 'LLEvents') return;
		const target = { method: node.callee.property.name };
		if (!['on', 'once', 'off'].includes(target.method)) return;
		const args = node.callee.indexer === ':' ? node.arguments : node.arguments.slice(1);
		const first = args[0];
		if (!isStringNode(first)) return; // best-effort only
		const eventName = first.value;

		if (!isValidSluaEventName(eventName, eventSigs)) {
			diags.push({
				code: 'unknown-event',
				severity: 'error',
				message: `Unknown SLua event '${eventName}' for LLEvents:${target.method}(...).`,
				range: rangeFromNode(first)
			});
			return;
		}

		if (target.method === 'off') {
			// For now, only validate the event name. (Callback removal semantics vary by runtime.)
			return;
		}

		const callback = args[1];
		if (!callback) {
			diags.push({
				code: 'missing-callback',
				severity: 'error',
				message: `Missing callback for LLEvents:${target.method}("${eventName}", callback).`,
				range: rangeFromNode(node)
			});
			return;
		}
		if (!isFunctionNode(callback)) return; // best-effort only

		const sig = eventSigs[eventName];
		const expectedParams = sig?.params ?? [];

		for (let i = 0; i < callback.parameters.length; i++) {
			const expected = expectedParams[i] ?? { type: slua.nil() };
			const actualParam = callback.parameters[i];
			if (!isIdentifier(actualParam)) continue;
			const written = actualParam.typeAnnotation;
			if (!written) continue; // only validate when written

			const declared = sluaTypeFromLuauAnnotationText(written);
			if (declared.kind === 'primitive' && declared.name === 'unknown') continue;
			if (declared.kind === 'table' && expected.type.kind === 'array') continue;
			if (!sluaTypeIsAssignable(declared, expected.type)) {
				diags.push({
					code: 'callback-param-type-mismatch',
					severity: 'error',
					message: `Param ${i + 1} for event '${eventName}' should be ${sluaTypeToString(expected.type)}, but is '${written}'.`,
					range: rangeFromNode(actualParam)
				});
			}
		}
	};

	return { diagnostics: diags, visit: checkCall };
}
