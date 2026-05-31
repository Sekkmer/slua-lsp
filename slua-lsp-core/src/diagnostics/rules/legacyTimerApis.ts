import type { CoreDiagnostic } from '../types.js';

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

type CallExpressionNode = AstNode & {
	type: 'CallExpression';
	callee: unknown;
	arguments: unknown[];
};

type FunctionDeclarationNode = AstNode & {
	type: 'FunctionDeclaration';
	identifier: unknown;
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

function isCallExpression(value: unknown): value is CallExpressionNode {
	return (
		isAstNode(value) &&
		value.type === 'CallExpression' &&
		Array.isArray((value as Record<string, unknown>).arguments) &&
		'callee' in value
	);
}

function isIndexExpression(value: unknown): value is IndexExpressionNode {
	return isAstNode(value) && value.type === 'IndexExpression' && 'object' in value && 'index' in value;
}

function isFunctionDeclaration(value: unknown): value is FunctionDeclarationNode {
	return isAstNode(value) && value.type === 'FunctionDeclaration' && 'identifier' in value;
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

const LEGACY_TIMER_HELP =
	'This SLua runtime doesn\'t support the legacy \'timer\' event / ll.SetTimerEvent(). Use LLTimers:every(seconds, callback) or LLTimers:once(seconds, callback) instead.';

function stringKeyFromIndexExpressionIndex(idx: unknown): string | null {
	if (!isAstNode(idx) || idx.type !== 'String') return null;
	const v = (idx as Record<string, unknown>).value;
	return typeof v === 'string' ? v : null;
}

export function ruleLegacyTimerApis(ast: unknown): CoreDiagnostic[] {
	const diags: CoreDiagnostic[] = [];
	const calleeMembers = new WeakSet<object>();

	visitAll(ast, (node) => {
		// Detect calls like ll.SetTimerEvent(...)
		if (isCallExpression(node) && isMemberExpression(node.callee)) {
			const member = node.callee;
			if (isIdentifier(member.object) && isIdentifier(member.property)) {
				if ((member.object.name === 'll' || member.object.name === 'llcompat') && member.property.name === 'SetTimerEvent') {
					calleeMembers.add(member as unknown as object);
					diags.push({
						code: 'legacy-timer-api',
						severity: 'error',
						message: `${member.object.name}.SetTimerEvent(...) is not available. ${LEGACY_TIMER_HELP}`,
						range: rangeFromNode(member.property)
					});
				}
			}
			return;
		}

		// Detect calls like ll['SetTimerEvent'](...)
		if (isCallExpression(node) && isIndexExpression(node.callee)) {
			const idx = node.callee;
			if (isIdentifier(idx.object) && (idx.object.name === 'll' || idx.object.name === 'llcompat')) {
				const key = stringKeyFromIndexExpressionIndex(idx.index);
				if (key === 'SetTimerEvent') {
					calleeMembers.add(idx as unknown as object);
					diags.push({
						code: 'legacy-timer-api',
						severity: 'error',
						message: `${idx.object.name}.SetTimerEvent(...) is not available. ${LEGACY_TIMER_HELP}`,
						range: rangeFromNode(idx.index as AstNode)
					});
				}
			}
			return;
		}

		// Detect references like ll.SetTimerEvent (used as a value)
		if (isMemberExpression(node)) {
			if (calleeMembers.has(node as unknown as object)) return;
			if (isIdentifier(node.object) && isIdentifier(node.property)) {
				if ((node.object.name === 'll' || node.object.name === 'llcompat') && node.property.name === 'SetTimerEvent') {
					diags.push({
						code: 'legacy-timer-api',
						severity: 'error',
						message: `${node.object.name}.SetTimerEvent is not available. ${LEGACY_TIMER_HELP}`,
						range: rangeFromNode(node.property)
					});
				}
			}
			return;
		}

		if (isIndexExpression(node)) {
			if (calleeMembers.has(node as unknown as object)) return;
			if (isIdentifier(node.object) && (node.object.name === 'll' || node.object.name === 'llcompat')) {
				const key = stringKeyFromIndexExpressionIndex(node.index);
				if (key === 'SetTimerEvent') {
					diags.push({
						code: 'legacy-timer-api',
						severity: 'error',
						message: `${node.object.name}.SetTimerEvent is not available. ${LEGACY_TIMER_HELP}`,
						range: rangeFromNode(node.index as AstNode)
					});
				}
			}
			return;
		}

		// Detect old LSL-style `function timer() ... end`
		if (isFunctionDeclaration(node)) {
			const id = node.identifier;
			if (isIdentifier(id) && id.name === 'timer') {
				diags.push({
					code: 'legacy-timer-api',
					severity: 'error',
					message: `Legacy event handler 'timer' is not fired in this SLua runtime. ${LEGACY_TIMER_HELP}`,
					range: rangeFromNode(id)
				});
			}
		}
	});

	return diags;
}
