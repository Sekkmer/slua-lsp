import type { CoreDiagnostic } from '../types.js';

import type { SluaEventSignature } from '../../slua/events.js';
import type { SluaType } from '../../slua/types.js';

type AstNode = { type: string; location?: { start: { line: number; column: number }; end: { line: number; column: number } } };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };

type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
};

type CallExpressionNode = AstNode & {
	type: 'CallExpression';
	callee: unknown;
	arguments: unknown[];
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

function isCallExpression(value: unknown): value is CallExpressionNode {
	return isAstNode(value) && value.type === 'CallExpression' && Array.isArray((value as Record<string, unknown>).arguments) && 'callee' in value;
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
	// SLua runtime differs from LSL: some legacy events are not exposed via LLEvents.
	if (eventName === 'state_entry') return false;
	if (eventName === 'timer') return false;
	return Boolean(eventSigs[eventName]);
}

function normalizeAnnotationText(text: string): string {
	// Keep this conservative: trim and collapse whitespace.
	return text.trim().replace(/\s+/g, ' ');
}

function acceptedTypeAnnotations(expected: SluaType): string[] {
	// Best-effort mapping from our modeled types to common Luau annotation spellings.
	if (expected.kind === 'primitive') return [expected.name];
	if (expected.kind === 'custom') {
		switch (expected.name) {
			case 'integer':
				// Some runtimes treat integer as number in Luau types.
				return ['integer', 'number'];
			case 'uuid':
				// LSL calls this 'key' but the runtime exposes uuid().
				return ['uuid', 'key'];
			case 'vector':
				return ['vector'];
			case 'rotation':
				return ['rotation', 'quaternion'];
			default:
				return [];
		}
	}
	if (expected.kind === 'table') return ['table'];
	if (expected.kind === 'array') return []; // could be T[] etc; skip for now
	if (expected.kind === 'function') return []; // skip
	return [];
}

function getCallTarget(call: CallExpressionNode): { receiver: string; method: string } | null {
	if (!isMemberExpression(call.callee)) return null;
	const { object, property } = call.callee;
	if (!isIdentifier(object) || !isIdentifier(property)) return null;
	return { receiver: object.name, method: property.name };
}

function visitAll(root: unknown, fn: (node: AstNode) => void): void {
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isAstNode(value)) return;
		if (seen.has(value as object)) return;
		seen.add(value as object);
		fn(value);
		for (const child of Object.values(value as Record<string, unknown>)) {
			if (child === value.location) continue;
			visit(child);
		}
	}
	visit(root);
}

export function ruleLLEventsCalls(ast: unknown, eventSigs: Record<string, SluaEventSignature>): CoreDiagnostic[] {
	const diags: CoreDiagnostic[] = [];

	visitAll(ast, (node) => {
		if (!isCallExpression(node)) return;
		const target = getCallTarget(node);
		if (!target) return;
		if (target.receiver !== 'LLEvents') return;
		if (target.method !== 'on' && target.method !== 'once' && target.method !== 'off') return;

		const args = node.arguments;
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
		const expectedCount = expectedParams.length;
		const actualCount = callback.parameters.length;

		// For now, be strict: stable events like listen should match exactly.
		if (actualCount !== expectedCount) {
			diags.push({
				code: 'callback-arity-mismatch',
				severity: 'error',
				message: `Callback for event '${eventName}' must declare exactly ${expectedCount} params, but declares ${actualCount}.`,
				range: rangeFromNode(callback)
			});
			return;
		}

		for (let i = 0; i < expectedParams.length; i++) {
			const expected = expectedParams[i];
			const actualParam = callback.parameters[i];
			if (!isIdentifier(actualParam)) continue;
			const written = actualParam.typeAnnotation;
			if (!written) continue; // only validate when written

			const norm = normalizeAnnotationText(written);
			const accepted = acceptedTypeAnnotations(expected.type).map(normalizeAnnotationText);
			if (accepted.length === 0) continue;
			if (!accepted.includes(norm)) {
				diags.push({
					code: 'callback-param-type-mismatch',
					severity: 'error',
					message: `Param ${i + 1} for event '${eventName}' should be ${accepted.join(' | ')}, but is '${norm}'.`,
					range: rangeFromNode(actualParam)
				});
			}
		}
	});

	return diags;
}
