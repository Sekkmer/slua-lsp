import type { CoreDiagnostic } from '../types.js';

import { REMOVED_LL_APIS } from '../../slua/removedApis.js';

type AstNode = { type: string; location?: { start: { line: number; column: number }; end: { line: number; column: number } } };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string };

type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	indexer?: '.' | ':';
};

type IndexExpressionNode = AstNode & {
	type: 'IndexExpression';
	object: unknown;
	index: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof (value as Record<string, unknown>).type === 'string';
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression' && 'object' in value && 'property' in value;
}

function isIndexExpression(value: unknown): value is IndexExpressionNode {
	return isAstNode(value) && value.type === 'IndexExpression' && 'object' in value && 'index' in value;
}

function stringKeyFromIndexExpressionIndex(idx: unknown): string | null {
	if (!isAstNode(idx) || idx.type !== 'String') return null;
	const v = (idx as Record<string, unknown>).value;
	return typeof v === 'string' ? v : null;
}

function rangeFromNode(node: AstNode): CoreDiagnostic['range'] {
	const loc = node.location;
	if (!loc) {
		return {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 }
		};
	}
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
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
			if (child === (value as Record<string, unknown>).location) continue;
			visit(child);
		}
	}
	visit(root);
}

function isLlReceiver(name: string): boolean {
	return name === 'll' || name === 'llcompat';
}

export function ruleRemovedLlApis(ast: unknown): CoreDiagnostic[] {
	const diags: CoreDiagnostic[] = [];

	visitAll(ast, (node) => {
		if (isMemberExpression(node)) {
			const receiver = node.object;
			const prop = node.property;
			if (!isIdentifier(receiver) || !isIdentifier(prop)) return;
			if (!isLlReceiver(receiver.name)) return;

			// Keep legacy timer messaging in the dedicated rule.
			if (prop.name === 'SetTimerEvent') return;

			const info = REMOVED_LL_APIS[prop.name];
			if (!info) return;

			diags.push({
				code: 'removed-ll-api',
				severity: 'error',
				message: `${receiver.name}.${prop.name} is not available. ${info.message}`,
				range: rangeFromNode(prop)
			});
			return;
		}

		if (isIndexExpression(node)) {
			const receiver = node.object;
			if (!isIdentifier(receiver)) return;
			if (!isLlReceiver(receiver.name)) return;
			const key = stringKeyFromIndexExpressionIndex(node.index);
			if (!key) return;
			if (key === 'SetTimerEvent') return;

			const info = REMOVED_LL_APIS[key];
			if (!info) return;

			diags.push({
				code: 'removed-ll-api',
				severity: 'error',
				message: `${receiver.name}.${key} is not available. ${info.message}`,
				range: rangeFromNode(node.index as AstNode)
			});
		}
	});

	return diags;
}
