import { collectNavigationBindings } from './navigationBindings.js';
import type { SluaRegistry } from '../slua/registry.js';
import { sourceMemberOrigins } from '../slua/sourceOrigins.js';
import { resolveBuiltinExpression } from '../slua/resolveBuiltin.js';
import { isAstNode, isIdentifier, isMemberExpression, isStringNode, posInLoc, visitAst, type AstNode, type LspPosition } from '../parser/ast.js';
import { getVisibleLocalTypes } from './completion.js';
import { lexicalOccurrenceAt, type LexicalDefinition } from './lexicalBindings.js';

export type DefinitionLocation = LexicalDefinition | { name: string; identifier: AstNode; kind: 'field'; file?: string; sourceSha256?: string };

/** Lexical values and proven source table fields. Member origins never enter
 * lexical references/rename, and builtin/type shapes cannot invent a target. */
export function findDefinitionAtPosition(
	ast: unknown,
	position: LspPosition,
	registry: SluaRegistry,
	_sourceText?: string
): DefinitionLocation | null {
	const definition = lexicalOccurrenceAt(collectNavigationBindings(ast).occurrences, position)?.definition;
	if (definition?.identifier.location) return definition;
	let selected: { name: string; node: AstNode; receiver?: unknown } | undefined;
	visitAst(ast, (node) => {
		let token: unknown, receiver: unknown, name: string | undefined;
		if (isMemberExpression(node) && isIdentifier(node.property)) { token = node.property; name = node.property.name; receiver = node.object; }
		else if (node.type === 'IndexExpression') {
			const index = node as AstNode & { object: unknown; index: unknown };
			if (isStringNode(index.index)) { token = index.index; name = index.index.value; receiver = index.object; }
		} else if (node.type === 'TableField') {
			const field = node as AstNode & { key?: unknown; computed?: boolean };
			if (isIdentifier(field.key) && !field.computed) { token = field.key; name = field.key.name; }
			else if (isStringNode(field.key)) { token = field.key; name = field.key.value; }
		}
		if (name !== undefined && isAstNode(token) && token.location && posInLoc(position, token.location)) selected = { name, node: token, receiver };
	});
	if (!selected) return null;
	let origin = { name: selected.name, node: selected.node };
	if (selected.receiver) {
		const locals = getVisibleLocalTypes(ast, position, registry);
		const type = resolveBuiltinExpression(selected.receiver, registry, (name) => locals.get(name))?.type;
		const found = type && sourceMemberOrigins(type)?.get(selected.name);
		if (!found?.node.location) return null;
		origin = found;
	}
	const file = registry.sourceNodeFiles.get(origin.node);
	return { name: origin.name, identifier: origin.node, kind: 'field', ...(file ? { file, sourceSha256: registry.sourceFileHashes.get(file) } : {}) };
}
