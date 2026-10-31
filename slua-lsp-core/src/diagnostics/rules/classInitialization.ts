import { isAstNode, isIdentifier, isStringNode, rangeFromNode, visitAst, type AstNode, type IdentifierNode } from '../../parser/ast.js';
import { collectLexicalBindings } from '../../typing/lexicalBindings.js';
import { slua, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable } from '../../slua/types.js';
import type { CoreDiagnostic } from '../types.js';

type Node = AstNode & Record<string, unknown>;

/** Match the native experimental constructor visitor, including its deliberately
 * limited unconditional assignment handling. This is not definite assignment
 * across arbitrary control flow or an end-of-constructor completeness check. */
export function ruleClassInitialization(ast: unknown): CoreDiagnostic[] {
	const constructors: Array<{ owner: Node; method: Node; self: IdentifierNode }> = [];
	visitAst(ast, (value) => {
		if (value.type !== 'ClassDeclaration') return;
		const owner = value as Node;
		if (!Array.isArray(owner.methods)) return;
		for (const value of owner.methods) {
			if (!isAstNode(value)) continue;
			const method = value as Node;
			const self = Array.isArray(method.parameters) ? method.parameters[0] : undefined;
			if (isIdentifier(method.identifier) && method.identifier.name === '__init' && isIdentifier(self) && self.name === 'self') constructors.push({ owner, method, self });
		}
	});
	if (!constructors.length) return [];
	// Bind once for the document. A shadowed local/parameter named self is a
	// different value, even inside a captured closure or local initializer.
	const definitions = new WeakMap<IdentifierNode, IdentifierNode>();
	for (const item of collectLexicalBindings(ast)) if (item.definition) definitions.set(item.identifier, item.definition.identifier);
	const diagnostics: CoreDiagnostic[] = [];
	for (const { owner, method, self } of constructors) {
		const pending = new Set<string>();
		if (Array.isArray(owner.fields)) for (const field of owner.fields) {
			if (!isAstNode(field)) continue;
			const node = field as Node;
			if (!isIdentifier(node.name) || typeof node.typeAnnotation !== 'string') continue;
			// Opaque annotations stay conservative in the shared best-effort type
			// model. Known optional/any/unknown fields accept nil and need no write.
			const type = sluaTypeFromLuauAnnotationText(node.typeAnnotation);
			if (!sluaTypeIsAssignable(type, slua.nil())) pending.add(node.name.name);
		}
		if (!pending.size) continue;
		const methods = new Set<string>();
		if (Array.isArray(owner.methods)) for (const method of owner.methods) {
			if (isAstNode(method) && isIdentifier((method as Node).identifier)) methods.add(((method as Node).identifier as IdentifierNode).name);
		}
		const fields = new Map<string, AstNode>();
		let instance: AstNode | undefined;
		const directSelf = (value: unknown): boolean => isIdentifier(value) && !(value as Node).parenthesized && definitions.get(value) === self;
		function member(node: Node): string | undefined {
			if (!directSelf(node.object)) return undefined;
			if (node.type === 'MemberExpression' && isIdentifier(node.property)) return node.property.name;
			if (node.type === 'IndexExpression' && isStringNode(node.index)) return node.index.value;
			return undefined;
		}
		function visit(value: unknown): void {
			if (Array.isArray(value)) { for (const item of value) visit(item); return; }
			if (!isAstNode(value)) return;
			const node = value as Node;
			if (isIdentifier(node)) {
				if (definitions.get(node) === self && pending.size) instance = node;
				return;
			}
			if (node.type === 'TypeCastExpression' && directSelf(node.expression)) return;
			const key = member(node);
			if (key !== undefined) {
				if (pending.has(key) && !fields.has(key)) fields.set(key, node);
				else if (methods.has(key) && pending.size) instance = node;
				return; // Unknown members belong to separate member/type checks.
			}
			if (node.type === 'TypeAlias') return;
			if (node.type === 'MemberExpression') { visit(node.object); return; }
			if (node.type === 'TableField') { if (node.computed) visit(node.key); visit(node.value); return; }
			for (const key in node) if (key !== 'location') visit(node[key]);
		}
		if (Array.isArray(method.body)) for (const value of method.body) {
			if (!isAstNode(value)) continue;
			const statement = value as Node;
			// The parser lowers compound writes to a binary RHS sharing the LHS.
			// Native does not credit such a write as unconditional initialization.
			const variables = Array.isArray(statement.variables) ? statement.variables : [];
			const compound = statement.type === 'AssignmentStatement' && Array.isArray(statement.init) && statement.init.some((item) =>
				isAstNode(item) && item.type === 'BinaryExpression' && variables.includes((item as Node).left));
			if (statement.type === 'AssignmentStatement' && !compound) {
				visit(statement.init);
				if (Array.isArray(statement.variables)) for (const variable of statement.variables) {
					if (!isAstNode(variable)) continue;
					const key = member(variable as Node);
					if (key !== undefined) pending.delete(key);
				}
			} else visit(statement);
		}
		if (instance) diagnostics.push({ code: 'class-uninitialized-access', severity: 'warning',
			message: 'Cannot use self or its methods before required class fields are initialized.', range: rangeFromNode(instance) });
		for (const [field, node] of fields) diagnostics.push({ code: 'class-uninitialized-access', severity: 'warning',
			message: `Class field '${field}' is read before it is initialized.`, range: rangeFromNode(node) });
	}
	return diagnostics;
}
