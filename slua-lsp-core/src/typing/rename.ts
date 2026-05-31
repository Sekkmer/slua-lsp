import type { SluaRegistry } from '../slua/registry.js';
import { findAllReferences, type ReferenceLocation } from './findReferences.js';

export type RenameEdit = {
	identifier: ReferenceLocation['identifier'];
	newName: string;
};

const LUA_RESERVED_WORDS = new Set([
	'and',
	'break',
	'do',
	'else',
	'elseif',
	'end',
	'false',
	'for',
	'function',
	'goto',
	'if',
	'in',
	'local',
	'nil',
	'not',
	'or',
	'repeat',
	'return',
	'then',
	'true',
	'until',
	'while'
]);

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

function posInLoc(pos: { line: number; character: number }, loc: Loc): boolean {
	const line = pos.line + 1;
	const col = pos.character + 1;
	const afterStart = line > loc.start.line || (line === loc.start.line && col >= loc.start.column);
	const beforeEnd = line < loc.end.line || (line === loc.end.line && col <= loc.end.column);
	return afterStart && beforeEnd;
}

export function isValidRenameIdentifier(name: string): boolean {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
	return !LUA_RESERVED_WORDS.has(name);
}

/**
 * Prepare a rename operation by finding all references that need to be renamed.
 * Returns null if the symbol cannot be renamed (e.g., it's not defined in the file).
 */
export function prepareRename(
	ast: unknown,
	position: { line: number; character: number },
	registry: SluaRegistry
): { range: { start: { line: number; character: number }; end: { line: number; character: number } }; placeholder: string } | null {
	const references = findAllReferences(ast, position, registry, true);
	if (references.length === 0) return null;

	const selected = references.find((ref) => {
		const loc = ref.identifier.location as Loc | undefined;
		if (!loc) return false;
		return posInLoc(position, loc);
	}) ?? references[0]!;

	if (!selected.identifier.location) return null;

	const loc = selected.identifier.location;
	return {
		range: {
			start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
			end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
		},
		placeholder: selected.identifier.name
	};
}

/**
 * Get all edits needed to rename a symbol.
 * Returns an array of RenameEdit objects with location and new name.
 */
export function getRenameEdits(
	ast: unknown,
	position: { line: number; character: number },
	newName: string,
	registry: SluaRegistry
): RenameEdit[] {
	if (!isValidRenameIdentifier(newName)) return [];
	const references = findAllReferences(ast, position, registry, true);
	return references.map(ref => ({ identifier: ref.identifier, newName }));
}
