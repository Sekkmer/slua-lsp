import { collectNavigationBindings } from './navigationBindings.js';
import type { SluaRegistry } from '../slua/registry.js';
import type { IdentifierNode, LspPosition } from '../parser/ast.js';
import { lexicalOccurrenceAt } from './lexicalBindings.js';

export type ReferenceLocation = {
	identifier: IdentifierNode;
	kind: 'definition' | 'usage';
};

export function findAllReferences(
	ast: unknown,
	position: LspPosition,
	_registry: SluaRegistry,
	includeDeclaration = true
): ReferenceLocation[] {
	const occurrences = collectNavigationBindings(ast).occurrences;
	const selected = lexicalOccurrenceAt(occurrences, position)?.definition;
	if (!selected?.identifier.location) return [];
	return occurrences.filter((entry) => entry.definition?.identifier === selected.identifier &&
		(includeDeclaration || entry.kind !== 'definition'));
}
