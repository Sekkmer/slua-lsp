import { conditionalBinding } from './conditionalBindings.js';
import { isAstNode, isFunctionDeclarationNode, isFunctionNode, isIdentifier, isMemberExpression, isProgramNode,
	isRecord, lspRangeFromLoc, type AstNode, type LspRange, type SourceLocation } from '../parser/ast.js';

export type SourceSymbolKind = 'variable' | 'function' | 'method' | 'class' | 'field' | 'type';
export type SourceSymbol = {
	name: string;
	kind: SourceSymbolKind;
	detail?: string;
	range: LspRange;
	selectionRange: LspRange;
	children?: SourceSymbol[];
};

function declaredName(value: unknown): { name: string; location?: SourceLocation } | null {
	if (isIdentifier(value)) return { name: value.name, location: value.location };
	if (isMemberExpression(value) && isIdentifier(value.property)) {
		const parent = declaredName(value.object);
		if (parent) return { name: parent.name + (value.indexer ?? (value.colonCall ? ':' : '.')) + value.property.name, location: value.property.location };
	}
	return null;
}

/** Hierarchical, document-local declarations. Fields/aliases have their own kind, not a value-binding claim. */
export function getDocumentSymbols(ast: unknown): SourceSymbol[] {
	if (!isProgramNode(ast)) return [];
	const seen = new WeakSet<object>();
	function make(node: AstNode, name: string, kind: SourceSymbolKind, selection: SourceLocation | undefined, children: SourceSymbol[], detail?: string): SourceSymbol[] {
		if (!node.location || !selection) return [];
		return [{ name, kind, range: lspRangeFromLoc(node.location), selectionRange: lspRangeFromLoc(selection),
			...(detail ? { detail } : {}), ...(children.length ? { children } : {}) }];
	}
	function visit(value: unknown): SourceSymbol[] {
		if (Array.isArray(value)) return value.flatMap(visit);
		if (!isAstNode(value) || seen.has(value)) return [];
		seen.add(value);
		const node = value as Record<string, unknown>;
		if (isFunctionDeclarationNode(value)) {
			const id = declaredName(value.identifier);
			return make(value, id?.name ?? '<anonymous>', 'function', id?.location ?? value.location, visit(node.body), node.isConst ? 'const' : undefined);
		}
		if (value.type === 'LocalStatement' && Array.isArray(node.variables)) {
			return node.variables.flatMap((variable, i) => {
				if (!isIdentifier(variable)) return [];
				const init = Array.isArray(node.init) ? node.init[i] : undefined;
				const children = isFunctionNode(init) ? visit(init.body) : visit(init);
				return make(value, variable.name, isFunctionNode(init) ? 'function' : 'variable', variable.location, children, node.isConst ? ['const', variable.typeAnnotation].filter(Boolean).join(' ') : variable.typeAnnotation);
			});
		}
		const conditional = conditionalBinding(value);
		if (conditional) return [...visit(node.test), ...make(value, conditional.name, 'variable', conditional.location, visit(node.consequent), [conditional.isConst ? 'const' : '', conditional.typeAnnotation].filter(Boolean).join(' ')), ...visit(node.alternate)];
		if (value.type === 'ClassDeclaration' && isIdentifier(node.name)) {
			const fields = Array.isArray(node.fields) ? node.fields.flatMap((field) => {
				if (!isAstNode(field) || !isRecord(field)) return [];
				const record = field as unknown as Record<string, unknown>;
				const name = record.name;
				return isIdentifier(name) ? make(field, name.name, 'field', name.location, [], typeof record.typeAnnotation === 'string' ? record.typeAnnotation : undefined) : [];
			}) : [];
			const methods = visit(node.methods).map((method) => ({ ...method, kind: 'method' as const }));
			return make(value, node.name.name, 'class', node.name.location, [...fields, ...methods]);
		}
		if (value.type === 'TypeAlias' && isIdentifier(node.name)) return make(value, node.name.name, 'type', node.name.location, []);
		if (isFunctionNode(value)) return make(value, '<anonymous>', 'function', value.location, visit(value.body));
		return Object.entries(node).filter(([key]) => key !== 'location').flatMap(([, child]) => visit(child));
	}
	return visit(ast.body);
}
