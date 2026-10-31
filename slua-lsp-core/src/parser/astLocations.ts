import { isRecord, type AstPosition as Position, type SourceLocation } from './ast.js';
import type { SourceTextIndex } from './sourceTextIndex.js';

type NodeLike = { type: unknown; location?: unknown } & Record<string, unknown>;

function isPosition(value: unknown): value is Position {
	if (!isRecord(value)) return false;
	return typeof value.line === 'number' && typeof value.column === 'number';
}

function isLocation(value: unknown): value is SourceLocation {
	if (!isRecord(value)) return false;
	return isPosition(value.start) && isPosition(value.end);
}

function comparePos(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.column - b.column;
}

function minPos(a: Position, b: Position): Position {
	return comparePos(a, b) <= 0 ? a : b;
}

function maxPos(a: Position, b: Position): Position {
	return comparePos(a, b) >= 0 ? a : b;
}

function isAstNodeLike(value: unknown): value is NodeLike {
	if (!isRecord(value)) return false;
	return typeof value.type === 'string';
}

/**
 * Best-effort pass to compute a stable `location` for all nodes.
 *
 * The vendored Luau parser currently sets many node locations to the last token;
 * this pass promotes locations by spanning children so features like hover/
 * go-to-definition can rely on a sane range.
 */
export function normalizeAstLocations(root: unknown, index?: SourceTextIndex): void {
	const seen = new WeakSet<object>();
	const translated = new WeakSet<object>();
	function translate(position: Position): void {
		if (!index || translated.has(position)) return;
		translated.add(position);
		const point = index.positionAt(index.lfOffsetAt({ line: position.line - 1, character: position.column - 1 }));
		position.line = point.line + 1; position.column = point.character + 1;
	}

	function visit(value: unknown): SourceLocation | undefined {
		if (Array.isArray(value)) {
			let start: Position | undefined, end: Position | undefined;
			for (const item of value) {
				const loc = visit(item);
				if (!loc) continue;
				start = start ? minPos(start, loc.start) : loc.start;
				end = end ? maxPos(end, loc.end) : loc.end;
			}
			return start && end ? { start, end } : undefined;
		}
		if (!isAstNodeLike(value)) return undefined;
		if (seen.has(value)) return isLocation(value.location) ? value.location : undefined;
		seen.add(value);
		for (const key in value) if (isLocation(value[key])) {
			const location = value[key] as SourceLocation; translate(location.start); translate(location.end);
		}
		const original = isLocation(value.location) ? value.location : undefined;
		let start = original?.start, end = original?.end;
		for (const key in value) {
			if (key === 'location') continue;
			const loc = visit(value[key]);
			if (!loc) continue;
			start = start ? minPos(start, loc.start) : loc.start;
			end = end ? maxPos(end, loc.end) : loc.end;
		}
		if (!start || !end) return original;
		// One merged location per node, rather than one allocation per child.
		const merged = original?.start === start && original.end === end ? original : { start, end };
		value.location = merged;
		return merged;
	}

	visit(root);
}
