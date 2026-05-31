import type { CoreDiagnostic } from '../types.js';

const LLEVENTS_METHODS = ['on', 'off', 'once', 'eventNames', 'listeners'] as const;
const LLTIMERS_METHODS = ['once', 'off', 'every'] as const;

function buildLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function positionFromOffset(lineStarts: number[], offset: number): { line: number; character: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const start = lineStarts[mid]!;
		const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1]! : Number.POSITIVE_INFINITY;
		if (offset < start) {
			hi = mid - 1;
		} else if (offset >= nextStart) {
			lo = mid + 1;
		} else {
			return { line: mid, character: offset - start };
		}
	}
	// Fallback
	return { line: 0, character: 0 };
}

export function ruleMethodCallStyle(text: string): CoreDiagnostic[] {
	// We want to flag dot-calls where SLua runtime expects `self` (method call).
	// Example (bad): LLEvents.on("listen", fn)
	// Example (good): LLEvents:on("listen", fn)
	//
	// This is intentionally string-based (not AST) so it still works even when we
	// preprocess Luau-ish syntax for parsing.
	const lleventsMethodPattern = LLEVENTS_METHODS.join('|');
	const lltimersMethodPattern = LLTIMERS_METHODS.join('|');
	const re = new RegExp(
		`\\b(LLEvents)\\s*\\.\\s*(${lleventsMethodPattern})\\b|\\b(LLTimers)\\s*\\.\\s*(${lltimersMethodPattern})\\b`,
		'g'
	);

	const diags: CoreDiagnostic[] = [];
	const lineStarts = buildLineStarts(text);

	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		const receiver = match[1] ?? match[3];
		const method = match[2] ?? match[4];
		const full = match[0]!;
		if (!receiver || !method) continue;

		const dotIndexInFull = full.indexOf('.') >= 0 ? full.indexOf('.') : receiver.length;
		const startOffset = match.index + dotIndexInFull;
		const endOffset = match.index + full.length;

		diags.push({
			code: 'use-colon-call',
			severity: 'error',
			message: `Use ':' when calling ${receiver}:${method}(...); dot-call loses 'self'.`,
			range: {
				start: positionFromOffset(lineStarts, startOffset),
				end: positionFromOffset(lineStarts, endOffset)
			}
		});
	}

	return diags;
}
