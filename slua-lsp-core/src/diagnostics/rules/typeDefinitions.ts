import { isIdentifier, isAstNode, visitAst, rangeFromNode, type AstNode } from '../../parser/ast.js';
import type { CoreDiagnostic } from '../types.js';

// Native GlobalTypes.cpp, with LuauIntegerType2 enabled in the qualified SLua
// profile. Host definition names and user values are not builtin type names.
const builtinTypes = new Set(['any', 'unknown', 'never', 'number', 'integer', 'string', 'boolean', 'thread', 'buffer']);

/** A lexical block's aliases and classes share its type namespace. This checks
 * declarations, not generic/type-function evaluation or type alias subtyping. */
export function ruleTypeDefinitions(ast: unknown): CoreDiagnostic[] {
	const blocks: unknown[][] = [];
	let hasClass = false;
	visitAst(ast, (value) => {
		if (value.type === 'ClassDeclaration') hasClass = true;
		const node = value as AstNode & Record<string, unknown>;
		for (const key of ['body', 'consequent', 'alternate']) if (Array.isArray(node[key])) blocks.push(node[key]);
	});
	const diagnostics: CoreDiagnostic[] = [];
	for (const block of blocks) {
		const definitions = new Map<string, string>();
		for (const value of block) {
			if (!isAstNode(value) || value.type !== 'TypeAlias' && value.type !== 'ClassDeclaration') continue;
			const node = value as AstNode & { name?: unknown };
			if (!isIdentifier(node.name)) continue;
			const name = node.name.name;
			const builtin = value.type === 'TypeAlias' && (builtinTypes.has(name) || hasClass && (name === 'class' || name === 'object'));
			const previous = definitions.get(name);
			// Repeated classes already receive their native parser restriction.
			if (builtin || previous && !(previous === 'ClassDeclaration' && value.type === 'ClassDeclaration')) diagnostics.push({
				code: 'duplicate-type-definition', severity: 'warning', range: rangeFromNode(node.name),
				message: builtin ? `Cannot redefine builtin type '${name}'.` : `Type '${name}' is already defined in this block.`
			});
			if (!builtin && !previous) definitions.set(name, value.type);
		}
	}
	return diagnostics;
}
