import type { SluaRegistry, SluaFunctionDef, SluaMethodDef } from '../slua/registry.js';
import type { SluaType } from '../slua/types.js';
import { sluaTypeToString } from '../slua/types.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

type AstNode = { type: string; location?: Loc };

type ProgramNode = AstNode & { type: 'Program'; body: unknown[] };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string };

type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	/** Luau parser uses '.' or ':' */
	indexer?: '.' | ':';
	/** Legacy/older shape (kept for safety) */
	colonCall?: boolean;
};

type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };

export type SignatureHelpParameter = {
	label: string;
	documentation?: string;
};

export type SignatureHelpSignature = {
	label: string;
	documentation?: string;
	parameters: SignatureHelpParameter[];
};

export type SignatureHelpResult = {
	signatures: SignatureHelpSignature[];
	activeSignature: number;
	activeParameter: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof value.type === 'string';
}

function isProgram(value: unknown): value is ProgramNode {
	return isAstNode(value) && value.type === 'Program' && Array.isArray((value as Record<string, unknown>).body);
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression';
}

function isCallExpression(value: unknown): value is CallExpressionNode {
	return (
		isAstNode(value) &&
		value.type === 'CallExpression' &&
		Array.isArray((value as Record<string, unknown>).arguments) &&
		'callee' in (value as Record<string, unknown>)
	);
}

function posInLoc(pos: { line: number; character: number }, loc: Loc): boolean {
	const line = pos.line + 1;
	const col = pos.character + 1;
	const afterStart = line > loc.start.line || (line === loc.start.line && col >= loc.start.column);
	const beforeEnd = line < loc.end.line || (line === loc.end.line && col <= loc.end.column);
	return afterStart && beforeEnd;
}

function comparePos(a: { line: number; character: number }, b: { line: number; character: number }): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.character - b.character;
}

function locEndPos(loc: Loc): { line: number; character: number } {
	return { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) };
}

function findInnermostCallAtPosition(program: ProgramNode, pos: { line: number; character: number }): CallExpressionNode | null {
	let best: CallExpressionNode | null = null;
	function visit(value: unknown): void {
		if (!isAstNode(value) || !value.location) return;
		if (!posInLoc(pos, value.location)) return;
		if (isCallExpression(value)) {
			if (!best) best = value;
			else {
				const cur = best.location;
				const next = value.location;
				if (cur && next) {
					const curSpan = (cur.end.line - cur.start.line) * 10_000 + (cur.end.column - cur.start.column);
					const nextSpan = (next.end.line - next.start.line) * 10_000 + (next.end.column - next.start.column);
					if (nextSpan <= curSpan) best = value;
				}
			}
		}
		for (const child of Object.values(value as Record<string, unknown>)) {
			if (child === (value as Record<string, unknown>).location) continue;
			if (Array.isArray(child)) for (const item of child) visit(item);
			else if (isRecord(child)) visit(child);
		}
	}
	for (const stmt of program.body) visit(stmt);
	return best;
}

function prevNonWhitespaceChar(sourceText: string, pos: { line: number; character: number }): string | null {
	const lines = sourceText.split(/\r?\n/);
	if (pos.line < 0 || pos.line >= lines.length) return null;
	const lineText = lines[pos.line] ?? '';
	let i = Math.min(pos.character - 1, lineText.length - 1);
	while (i >= 0) {
		const ch = lineText[i] ?? '';
		if (!/\s/.test(ch)) return ch;
		i--;
	}
	return null;
}

function resolveCallSignature(
	call: CallExpressionNode,
	registry: SluaRegistry
): { displayName: string; signature: SluaType; docs?: string; paramDocs?: { name: string; type: SluaType; docs?: string }[] } | null {
	// 1) foo(...)
	if (isIdentifier(call.callee)) {
		const def = registry.getGlobal(call.callee.name);
		if (!def) return null;
		return {
			displayName: def.name,
			signature: def.signature,
			docs: def.docs,
			paramDocs: def.params?.map((p) => ({ name: p.name, type: p.type, docs: p.docs }))
		};
	}

	// 2) receiver.method(...)
	if (isMemberExpression(call.callee)) {
		const { object, property } = call.callee;
		if (!isIdentifier(object) || !isIdentifier(property)) return null;
		const receiver = object.name;
		const method = property.name;
		const indexer = call.callee.indexer ?? (call.callee.colonCall ? ':' : '.');

		// Prefer intrinsic object methods when receiver matches an objectType.
		const objMethod: SluaMethodDef | undefined = registry.getObjectMethod(receiver, method);
		if (objMethod) {
			return {
				displayName: `${receiver}${indexer}${method}`,
				signature: objMethod.signature,
				docs: objMethod.docs
			};
		}

		const mod = registry.getModule(receiver);
		const fn: SluaFunctionDef | undefined = mod?.functions?.[method];
		if (!fn) return null;
		return {
			displayName: `${receiver}${indexer}${method}`,
			signature: fn.signature,
			docs: fn.docs,
			paramDocs: fn.params?.map((p) => ({ name: p.name, type: p.type, docs: p.docs }))
		};
	}

	return null;
}

function buildSignatureInformation(resolved: {
	displayName: string;
	signature: SluaType;
	docs?: string;
	paramDocs?: { name: string; type: SluaType; docs?: string }[];
}): SignatureHelpSignature | null {
	if (resolved.signature.kind !== 'function') return null;

	const params = resolved.signature.params;
	const paramInfos: SignatureHelpParameter[] = params.map((t, i) => {
		const meta = resolved.paramDocs?.[i];
		const name = meta?.name ?? `arg${i + 1}`;
		return {
			label: `${name}: ${sluaTypeToString(t)}`,
			documentation: meta?.docs
		};
	});

	const label = `${resolved.displayName}(${paramInfos.map((p) => p.label).join(', ')}) -> ${sluaTypeToString(
		resolved.signature.returns
	)}`;

	return {
		label,
		documentation: resolved.docs,
		parameters: paramInfos
	};
}

function computeActiveParameter(
	call: CallExpressionNode,
	pos: { line: number; character: number },
	sourceText: string | undefined,
	parameterCount: number
): number {
	const args = call.arguments;

	// If we're directly inside a parsed argument, that's definitive.
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (isAstNode(arg) && arg.location && posInLoc(pos, arg.location)) {
			return clampParamIndex(i, parameterCount);
		}
	}

	if (args.length === 0) return 0;

	// Otherwise approximate based on which arguments end before the cursor.
	let countEndedBeforeCursor = 0;
	for (const arg of args) {
		if (!isAstNode(arg) || !arg.location) continue;
		const end = locEndPos(arg.location);
		if (comparePos(end, pos) <= 0) countEndedBeforeCursor++;
	}

	if (!sourceText) {
		return clampParamIndex(Math.max(0, countEndedBeforeCursor - 1), parameterCount);
	}

	const prev = prevNonWhitespaceChar(sourceText, pos);
	const active = prev === ',' ? countEndedBeforeCursor : Math.max(0, countEndedBeforeCursor - 1);
	return clampParamIndex(active, parameterCount);
}

function clampParamIndex(active: number, parameterCount: number): number {
	if (parameterCount <= 0) return 0;
	return Math.max(0, Math.min(active, parameterCount - 1));
}

/**
 * Best-effort signature help: currently supports registry-backed globals, modules, and intrinsic object methods.
 */
export function getSignatureHelp(
	ast: unknown,
	pos: { line: number; character: number },
	registry: SluaRegistry,
	sourceText?: string
): SignatureHelpResult | null {
	if (!isProgram(ast)) return null;
	const call = findInnermostCallAtPosition(ast, pos);
	if (!call) return null;

	const resolved = resolveCallSignature(call, registry);
	if (!resolved) return null;

	const sig = buildSignatureInformation(resolved);
	if (!sig) return null;

	const paramCount = sig.parameters.length;
	const activeParameter = computeActiveParameter(call, pos, sourceText, paramCount);

	return {
		signatures: [sig],
		activeSignature: 0,
		activeParameter
	};
}
