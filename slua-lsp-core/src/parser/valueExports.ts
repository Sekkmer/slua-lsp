import { isAstNode, isIdentifier, isProgramNode, lspRangeFromLoc, type AstNode, type IdentifierNode } from './ast.js';
import type { CoreDiagnostic } from '../diagnostics/types.js';

/** Export keys follow declaration identity, independently of later local shadows. */
export function valueExportIdentifiers(node: unknown): IdentifierNode[] {
	if (!isAstNode(node)) return [];
	const record = node as Record<string, unknown>;
	if (!record.exported) return [];
	if (node.type === 'LocalStatement') return Array.isArray(record.variables) ? record.variables.filter(isIdentifier) : [];
	const name = node.type === 'ClassDeclaration' ? record.name : node.type === 'FunctionDeclaration' ? record.identifier : undefined;
	return isIdentifier(name) ? [name] : [];
}

/** Native parse errors cannot be suppressed as semantic lint. Function returns
 * are legal; returns inside module-level blocks still conflict with exports. */
export function valueExportDiagnostics(ast: unknown): CoreDiagnostic[] {
	if (!isProgramNode(ast)) return [];
	const diagnostics: CoreDiagnostic[] = [], exports = new Map<string, IdentifierNode>();
	let hasModuleReturn = false;
	function report(node: AstNode, message: string): void {
		if (node.location) diagnostics.push({ code: 'parse-error', severity: 'error', message, range: lspRangeFromLoc(node.location) });
	}
	const seen = new WeakSet<object>();
	function visit(value: unknown, top = false, inFunction = false): void {
		if (Array.isArray(value)) { for (const child of value) visit(child, top, inFunction); return; }
		if (!isAstNode(value) || seen.has(value)) return;
		seen.add(value);
		const node = value as Record<string, unknown> & AstNode;
		const identifiers = valueExportIdentifiers(node);
		if (identifiers.length) {
			if (!top) report(node, '\'export\' may only be applied to top-level statements');
			if (hasModuleReturn) report(node, 'Exporting values is not compatible with top-level return (export/return conflict)');
			for (const id of identifiers) {
				if (exports.has(id.name)) report(id, `Duplicate exported identifier '${id.name}'`);
				else exports.set(id.name, id);
			}
		}
		if (node.type === 'ReturnStatement' && !inFunction) {
			if (exports.size) report(node, 'Exporting values is not compatible with top-level return (export/return conflict)');
			hasModuleReturn = true;
		}
		const childInFunction = inFunction || node.type === 'FunctionDeclaration' || node.type === 'Function';
		for (const key in node) if (!['location', 'comments', 'exportKeywordLocation'].includes(key)) visit(node[key], false, childInFunction);
	}
	visit(ast.body, true);
	return diagnostics;
}
