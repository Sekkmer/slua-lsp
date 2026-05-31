import { isRecord, type AstPosition as Position, type SourceLocation } from './ast.js';

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
export function normalizeAstLocations(root: unknown): void {
	const seen = new WeakSet<object>();

	function visit(value: unknown): SourceLocation | undefined {
		if (Array.isArray(value)) {
			let merged: SourceLocation | undefined;
			for (const item of value) {
				const childLoc = visit(item);
				if (!childLoc) continue;
				if (!merged) merged = childLoc;
				else {
					merged = {
						start: minPos(merged.start, childLoc.start),
						end: maxPos(merged.end, childLoc.end)
					};
				}
			}
			return merged;
		}

		if (!isAstNodeLike(value)) return undefined;
		if (seen.has(value)) return isLocation(value.location) ? value.location : undefined;
		seen.add(value);

		let merged: SourceLocation | undefined = isLocation(value.location) ? value.location : undefined;

		for (const v of Object.values(value)) {
			if (v === value.location) continue;
			const childLoc = visit(v);
			if (!childLoc) continue;
			if (!merged) merged = childLoc;
			else {
				merged = {
					start: minPos(merged.start, childLoc.start),
					end: maxPos(merged.end, childLoc.end)
				};
			}
		}

		if (merged) {
			value.location = merged;
			return merged;
		}

		return isLocation(value.location) ? value.location : undefined;
	}

	visit(root);
}
