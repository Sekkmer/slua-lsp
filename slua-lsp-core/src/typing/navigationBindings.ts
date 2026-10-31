import { typeProgram } from '../parser/typeRegions.js';
import { isAstNode, isIdentifier, isProgramNode, type IdentifierNode } from '../parser/ast.js';
import { annotationReferences } from '../parser/annotationReferences.js';
import { collectLexicalBindings, type LexicalDefinition, type LexicalOccurrence } from './lexicalBindings.js';

type TypeOccurrence = { identifier: IdentifierNode; definition?: IdentifierNode };
type Model = { generics: WeakMap<object, Map<string, IdentifierNode>> };
const models = new WeakMap<object, Model>();
const builtinNames = ['any', 'unknown', 'never', 'number', 'integer', 'string', 'boolean', 'thread', 'buffer', 'object', 'class'];
const builtins = new Map(builtinNames.map((name) => [name, { type: 'Identifier', name } as IdentifierNode]));

export type NavigationBindings = {
	occurrences: LexicalOccurrence[];
	types: TypeOccurrence[];
	conflicts: Array<readonly [IdentifierNode, IdentifierNode]>;
	opaqueNames: Set<string>;
	unavailable: boolean;
};

/** Class type uses share the class declaration identity with its value binding.
 * Aliases/generics/builtins remain separate types used to prove safe rebinding. */
export function collectNavigationBindings(ast: unknown, renamed?: ReadonlySet<IdentifierNode>, newName?: string): NavigationBindings {
	const empty: NavigationBindings = { occurrences: [], types: [], conflicts: [], opaqueNames: new Set(), unavailable: false };
	if (!isProgramNode(ast)) return empty;
	const source = typeProgram(ast);
	// Plain annotations cannot affect a value rename. These flags come from
	// parsed class declarations and annotation token roles, not source spelling.
	if (source && !source.hasClasses && !source.hasTypeValues) {
		empty.occurrences = collectLexicalBindings(ast, renamed, newName); return empty;
	}
	let model = models.get(ast);
	if (!model) { model = { generics: new WeakMap() }; models.set(ast, model); }
	const result = empty, embedded = new WeakMap<object, unknown[]>();
	let hasEmbeddedValues = false;
	const scopes: Map<string, IdentifierNode>[] = [builtins];
	const nameOf = (identifier: IdentifierNode) => renamed?.has(identifier) ? newName! : identifier.name;
	function lookup(name: string): IdentifierNode | undefined {
		for (let i = scopes.length - 1; i >= 0; i--) { const found = scopes[i]!.get(name); if (found) return found; }
		return undefined;
	}
	function withGenerics(node: Record<string, unknown>, work: () => void): void {
		let generics = model!.generics.get(node);
		if (!generics) {
			generics = new Map();
			if (Array.isArray(node.typeParameters)) for (const name of node.typeParameters) if (typeof name === 'string') {
				const key = name.replace(/\.\.\.$/, ''); generics.set(key, { type: 'Identifier', name: key });
			}
			model!.generics.set(node, generics);
		}
		scopes.push(generics); work(); scopes.pop();
	}
	function annotations(node: Record<string, unknown>): void {
		const parsed = annotationReferences(node);
		if (!parsed.length && (typeof node.typeAnnotation === 'string' && node.typeAnnotation || typeof node.returnTypeAnnotation === 'string' && node.returnTypeAnnotation)) result.unavailable = true;
		const values: unknown[] = [];
		for (const region of parsed) {
			if (!region.complete) for (const name of region.names) result.opaqueNames.add(name);
			for (const use of region.types) {
				const name = nameOf(use.identifier);
				result.types.push({ identifier: use.identifier, definition: use.generics.get(name) ?? lookup(name) });
			}
			values.push(...region.values);
			for (const value of region.values) visit(value);
		}
		if (values.length) { embedded.set(node, values); hasEmbeddedValues = true; }
	}
	function block(body: unknown): void {
		if (!Array.isArray(body)) { visit(body); return; }
		const definitions = new Map<string, IdentifierNode>(); scopes.push(definitions);
		for (const value of body) if (isAstNode(value) && (value.type === 'TypeAlias' || value.type === 'ClassDeclaration')) {
			const name = (value as Record<string, unknown>).name;
			if (isIdentifier(name)) {
				const key = nameOf(name), previous = definitions.get(key);
				if (previous) result.conflicts.push([previous, name]); else definitions.set(key, name);
			}
		}
		for (const value of body) visit(value);
		scopes.pop();
	}
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (Array.isArray(value)) { for (const item of value) visit(item); return; }
		if (!isAstNode(value) || seen.has(value)) return;
		seen.add(value);
		const node = value as Record<string, unknown>;
		if (value.type === 'TypeAlias') { withGenerics(node, () => annotations(node)); return; }
		if (value.type === 'Function' || value.type === 'FunctionDeclaration') {
			withGenerics(node, () => { annotations(node); visit(node.parameters); block(node.body); }); return;
		}
		annotations(node);
		for (const key in node) {
			if (key === 'location') continue;
			if (key === 'body' || key === 'consequent' || key === 'alternate') block(node[key]); else visit(node[key]);
		}
	}
	block(ast.body);
	const values = collectLexicalBindings(ast, renamed, newName, hasEmbeddedValues ? embedded : undefined);
	const classes = new Map<IdentifierNode, LexicalDefinition>();
	for (const occurrence of values) if (occurrence.kind === 'definition' && occurrence.definition?.kind === 'class') classes.set(occurrence.identifier, occurrence.definition);
	result.occurrences = [...values, ...result.types.flatMap((use): LexicalOccurrence[] => {
		const definition = use.definition && classes.get(use.definition);
		return definition ? [{ identifier: use.identifier, definition, kind: 'usage' }] : [];
	})];
	return result;
}

export function navigationRenamePreservesBindings(ast: unknown, before: NavigationBindings, selected: LexicalDefinition, newName: string): boolean {
	if (selected.identifier.exported && before.occurrences.some((entry) => entry.kind === 'definition' && entry.identifier !== selected.identifier && entry.identifier.exported && entry.identifier.name === newName)) return false;
	if (before.unavailable || before.opaqueNames.has(selected.name) || before.opaqueNames.has(newName)) return false;
	// Native typeof is a type-query introducer, while remaining a legal value
	// name. Only plain class type references would change syntactic role.
	if (newName === 'typeof' && before.types.some((use) => use.definition === selected.identifier)) return false;
	const renamed = new Set(before.occurrences.filter((entry) => entry.definition?.identifier === selected.identifier).map((entry) => entry.identifier));
	const after = collectNavigationBindings(ast, renamed, newName);
	return after.occurrences.length === before.occurrences.length && after.occurrences.every((entry, i) => entry.identifier === before.occurrences[i]!.identifier && entry.definition?.identifier === before.occurrences[i]!.definition?.identifier)
		&& after.types.length === before.types.length && after.types.every((entry, i) => entry.identifier === before.types[i]!.identifier && entry.definition === before.types[i]!.definition)
		&& after.conflicts.length === before.conflicts.length && after.conflicts.every((pair, i) => pair[0] === before.conflicts[i]![0] && pair[1] === before.conflicts[i]![1]);
}
