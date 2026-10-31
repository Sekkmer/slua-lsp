import { conditionalBinding } from './conditionalBindings.js';
import { isAstNode, isIdentifier, isProgramNode, type IdentifierNode, type LspPosition, posInLoc } from '../parser/ast.js';

export type LexicalDefinition = {
	name: string;
	identifier: IdentifierNode;
	kind: 'local' | 'parameter' | 'function' | 'class';
	isConst?: boolean;
};
export type LexicalOccurrence = {
	identifier: IdentifierNode;
	definition?: LexicalDefinition;
	kind: 'definition' | 'usage';
};

// Colon functions can have an implicit self without a source token. Keep its identity stable
// across virtual rename passes without retaining an AST after its document closes.
const implicitSelfBindings = new WeakMap<object, IdentifierNode>();

/** Value bindings only. Fields, types and dynamically supplied globals are separate namespaces. */
export function collectLexicalBindings(ast: unknown, renamed?: ReadonlySet<IdentifierNode>, newName?: string, embedded?: WeakMap<object, unknown[]>): LexicalOccurrence[] {
	if (!isProgramNode(ast)) return [];
	const scopes: Array<Map<string, LexicalDefinition>> = [new Map()];
	const occurrences: LexicalOccurrence[] = [];
	// Compound assignments share the same identifier node on their LHS and lowered RHS.
	const seen = new WeakSet<object>();
	const nameOf = (identifier: IdentifierNode) => renamed?.has(identifier) ? newName! : identifier.name;
	function lookup(name: string): LexicalDefinition | undefined {
		for (let i = scopes.length - 1; i >= 0; i--) {
			const definition = scopes[i]!.get(name);
			if (definition) return definition;
		}
		return undefined;
	}
	function define(value: unknown, kind: LexicalDefinition['kind']): void {
		if (!isIdentifier(value)) return;
		const name = nameOf(value);
		const definition = { name, identifier: value, kind, ...(value.isConst || kind === 'class' ? { isConst: true } : {}) };
		scopes.at(-1)!.set(name, definition);
		if (value.location) occurrences.push({ identifier: value, definition, kind: 'definition' });
	}
	function scoped(body: () => void): void {
		scopes.push(new Map());
		body();
		scopes.pop();
	}
	const embeddedSeen = new WeakSet<object>();
	function visitEmbedded(value: unknown): void {
		if (!embedded || !value || typeof value !== 'object') return;
		const expressions = embedded.get(value);
		if (!expressions?.length || embeddedSeen.has(value)) return;
		embeddedSeen.add(value); visit(expressions);
	}
	function signature(node: Record<string, unknown>): void {
		if (!embedded) return;
		visitEmbedded(node);
		if (Array.isArray(node.parameters)) for (const parameter of node.parameters) visitEmbedded(parameter);
	}
	function functionBody(node: Record<string, unknown>, implicitSelf = false): void {
		signature(node);
		scoped(() => {
			if (implicitSelf) {
				let self = implicitSelfBindings.get(node);
				if (!self) { self = { type: 'Identifier', name: 'self' }; implicitSelfBindings.set(node, self); }
				define(self, 'parameter');
			}
			if (Array.isArray(node.parameters)) for (const parameter of node.parameters) define(parameter, 'parameter');
			visit(node.body);
		});
	}
	function visit(value: unknown): void {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isAstNode(value) || seen.has(value)) return;
		seen.add(value);
		if (embedded && value.type !== 'Function' && value.type !== 'FunctionDeclaration') visitEmbedded(value);
		if (isIdentifier(value)) {
			if (value.location) occurrences.push({ identifier: value, definition: lookup(nameOf(value)), kind: 'usage' });
			return;
		}
		const node = value as Record<string, unknown>;
		switch (value.type) {
			case 'TypeAlias':
				return; // Type names never refer to a same-named value binding.
			case 'LocalStatement':
				if (embedded && Array.isArray(node.variables)) for (const variable of node.variables) visitEmbedded(variable);
				// All initializers see the previous bindings, including multi-local declarations.
				visit(node.init);
				if (Array.isArray(node.variables)) for (const variable of node.variables) define(variable, 'local');
				return;
			case 'FunctionDeclaration': {
				// Native parses signatures before introducing this function or its parameters.
				signature(node);
				if (node.isLocal) define(node.identifier, 'function');
				else visit(node.identifier); // `function localName()` assigns an existing local.
				const identifier = node.identifier as Record<string, unknown> | undefined;
				functionBody(node, identifier?.type === 'MemberExpression' && identifier.indexer === ':');
				return;
			}
			case 'Function':
				functionBody(node);
				return;
			case 'ClassDeclaration':
				define(node.name, 'class');
				visit(node.superClass);
				if (embedded && Array.isArray(node.fields)) for (const field of node.fields) visitEmbedded(field);
				if (Array.isArray(node.methods)) for (const method of node.methods) {
					if (isAstNode(method)) functionBody(method as Record<string, unknown>);
				}
				return;
			case 'MemberExpression':
				visit(node.object);
				return;
			case 'TableField':
				if (node.computed) visit(node.key);
				visit(node.value);
				return;
			case 'AssignmentStatement':
				visit(node.variables);
				visit(node.init);
				return;
			case 'WhileStatement':
				visit(node.test);
				scoped(() => visit(node.body));
				return;
			case 'RepeatStatement':
				scoped(() => { visit(node.body); visit(node.test); });
				return;
			case 'DoStatement':
				scoped(() => visit(node.body));
				return;
			case 'ForStatement':
				if (embedded) visitEmbedded(node.variable);
				visit(node.start);
				visit(node.end);
				visit(node.step);
				scoped(() => { define(node.variable, 'local'); visit(node.body); });
				return;
			case 'GenericForStatement':
				if (embedded && Array.isArray(node.variables)) for (const variable of node.variables) visitEmbedded(variable);
				visit(node.iterators);
				scoped(() => {
					if (Array.isArray(node.variables)) for (const variable of node.variables) define(variable, 'local');
					visit(node.body);
				});
				return;
			case 'IfStatement':
			case 'IfExpression':
				if (embedded) visitEmbedded(conditionalBinding(value));
				visit(node.test);
				scoped(() => { define(conditionalBinding(value), 'local'); visit(node.consequent); });
				scoped(() => visit(node.alternate));
				return;
		}
		for (const key in node) {
			if (key !== 'location') visit(node[key]);
		}
	}
	visit(ast.body);
	return occurrences;
}

export function lexicalOccurrenceAt(occurrences: LexicalOccurrence[], position: LspPosition): LexicalOccurrence | undefined {
	// Prefer a token starting at this cursor over the previous token's inclusive end.
	return occurrences.find(({ identifier }) => identifier.location &&
		identifier.location.start.line === position.line + 1 && identifier.location.start.column === position.character + 1)
		?? occurrences.find(({ identifier }) => identifier.location && posInLoc(position, identifier.location));
}

/** Rebind virtually renamed tokens and verify that every value use keeps its original declaration. */
export function renamePreservesBindings(ast: unknown, occurrences: LexicalOccurrence[], selected: LexicalDefinition, newName: string): boolean {
	const renamed = new Set(occurrences.filter((entry) => entry.definition?.identifier === selected.identifier).map((entry) => entry.identifier));
	const rebound = collectLexicalBindings(ast, renamed, newName);
	return rebound.length === occurrences.length && rebound.every((entry, i) =>
		entry.identifier === occurrences[i]!.identifier && entry.definition?.identifier === occurrences[i]!.definition?.identifier);
}
