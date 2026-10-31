import { isAstNode, isIdentifier, lspRangeFromLoc, type AstNode, type IdentifierNode } from './ast.js';
import type { CoreDiagnostic } from '../diagnostics/types.js';
import { collectLexicalBindings } from '../typing/lexicalBindings.js';

/** Native parser restrictions, kept separate from suppressible semantic lint. */
export function constBindingDiagnostics(ast: unknown): CoreDiagnostic[] {
	const declarations: Array<Record<string, unknown> & AstNode> = [];
	const targets = new Set<IdentifierNode>();
	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (Array.isArray(value)) { for (const child of value) visit(child); return; }
		if (!isAstNode(value) || seen.has(value)) return;
		seen.add(value);
		const node = value as Record<string, unknown> & AstNode;
		if (node.type === 'LocalStatement' && node.isConst) declarations.push(node);
		if (node.type === 'AssignmentStatement' && Array.isArray(node.variables)) {
			for (const target of node.variables) if (isIdentifier(target)) targets.add(target);
		}
		if (node.type === 'FunctionDeclaration' && !node.isLocal && isIdentifier(node.identifier)) targets.add(node.identifier);
		for (const key in node) if (key !== 'location' && key !== 'comments') visit(node[key]);
	}
	visit(ast);
	const diagnostics: CoreDiagnostic[] = [];
	for (const declaration of declarations) {
		const values = Array.isArray(declaration.init) ? declaration.init : [];
		const variables = Array.isArray(declaration.variables) ? declaration.variables : [];
		const last = values.at(-1) as Record<string, unknown> | undefined;
		const expands = last && !last.parenthesized && (last.type === 'CallExpression' || last.type === 'VarargLiteral');
		// The pinned native parser requires equal arity for a closed expression
		// list (including excess values); an ungrouped final call/vararg is open.
		if (!expands && values.length !== variables.length && declaration.location) diagnostics.push({ code: 'parse-error', severity: 'error',
			message: 'Missing initializer in const declaration', range: lspRangeFromLoc(declaration.location) });
	}
	if (targets.size) for (const occurrence of collectLexicalBindings(ast)) {
		if (occurrence.kind !== 'usage' || !targets.has(occurrence.identifier) || !occurrence.definition?.isConst || !occurrence.identifier.location) continue;
		diagnostics.push({ code: 'parse-error', severity: 'error', message: `Variable '${occurrence.definition.name}' is constant and may not be reassigned`, range: lspRangeFromLoc(occurrence.identifier.location) });
	}
	return diagnostics;
}
