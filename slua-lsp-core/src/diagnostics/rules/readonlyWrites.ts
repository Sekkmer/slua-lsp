import { conditionalBinding } from '../../typing/conditionalBindings.js';
import { visitAst } from '../../parser/ast.js';
import type { CoreDiagnostic } from '../types.js';
import type { SluaRegistry } from '../../slua/registry.js';

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };
type AstNode = { type: string; location?: Loc };

type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };
type StringNode = AstNode & { type: 'String'; value: string };

type LocalStatementNode = AstNode & { type: 'LocalStatement'; variables: unknown[]; init?: unknown[] };
type AssignmentStatementNode = AstNode & { type: 'AssignmentStatement'; variables: unknown[]; init: unknown[] };

type FunctionDeclarationNode = AstNode & {
	type: 'FunctionDeclaration';
	identifier?: unknown;
	parameters: unknown[];
	body: unknown[];
};

type FunctionNode = AstNode & { type: 'Function'; parameters: unknown[]; body: unknown[] };

type MemberExpressionNode = AstNode & { type: 'MemberExpression'; object: unknown; property: unknown };
type IndexExpressionNode = AstNode & { type: 'IndexExpression'; object: unknown; index: unknown };

type TypeAliasNode = AstNode & { type: 'TypeAlias'; name: IdentifierNode };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isAstNode(value: unknown): value is AstNode {
	return isRecord(value) && typeof (value as Record<string, unknown>).type === 'string';
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isAstNode(value) && value.type === 'Identifier' && typeof (value as Record<string, unknown>).name === 'string';
}

function isStringNode(value: unknown): value is StringNode {
	return isAstNode(value) && value.type === 'String' && typeof (value as Record<string, unknown>).value === 'string';
}

function isLocalStatement(value: unknown): value is LocalStatementNode {
	return isAstNode(value) && value.type === 'LocalStatement' && Array.isArray((value as Record<string, unknown>).variables);
}

function isAssignmentStatement(value: unknown): value is AssignmentStatementNode {
	return (
		isAstNode(value) &&
		value.type === 'AssignmentStatement' &&
		Array.isArray((value as Record<string, unknown>).variables) &&
		Array.isArray((value as Record<string, unknown>).init)
	);
}

function isFunctionDeclaration(value: unknown): value is FunctionDeclarationNode {
	return (
		isAstNode(value) &&
		value.type === 'FunctionDeclaration' &&
		Array.isArray((value as Record<string, unknown>).parameters) &&
		Array.isArray((value as Record<string, unknown>).body)
	);
}

function isFunctionNode(value: unknown): value is FunctionNode {
	return isAstNode(value) && value.type === 'Function' && Array.isArray((value as Record<string, unknown>).parameters);
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isAstNode(value) && value.type === 'MemberExpression' && 'object' in value && 'property' in value;
}

function isIndexExpression(value: unknown): value is IndexExpressionNode {
	return isAstNode(value) && value.type === 'IndexExpression' && 'object' in value && 'index' in value;
}

function isTypeAlias(value: unknown): value is TypeAliasNode {
	return isAstNode(value) && value.type === 'TypeAlias' && 'name' in value && isIdentifier((value as Record<string, unknown>).name);
}

function rangeFromNode(node: AstNode): CoreDiagnostic['range'] {
	const loc = node.location;
	if (!loc) {
		return {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 }
		};
	}
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '\n') starts.push(i + 1);
	}
	return starts;
}

function offsetFromPosition(lineStarts: number[], pos: { line: number; column: number }): number {
	const lineIndex = Math.max(0, pos.line - 1);
	const lineStart = lineStarts[lineIndex] ?? 0;
	return lineStart + Math.max(0, pos.column - 1);
}

function sliceFromLoc(text: string, loc: Loc, lineStarts: number[]): string {
	const start = offsetFromPosition(lineStarts, loc.start);
	const end = offsetFromPosition(lineStarts, loc.end);
	return text.slice(Math.max(0, start), Math.max(start, end));
}

function parseReadonlyFieldsFromText(text: string | undefined | null): Set<string> {
	const fields = new Set<string>();
	if (!text) return fields;

	const identRegex = /\b(?:read|readonly)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
	for (const match of text.matchAll(identRegex)) {
		const name = match[1];
		if (name) fields.add(name);
	}

	const stringIndexRegex = /\b(?:read|readonly)\s+\[\s*(['"])(.*?)\1\s*\]\s*:/g;
	for (const match of text.matchAll(stringIndexRegex)) {
		const name = match[2];
		if (name) fields.add(name);
	}

	return fields;
}

function parseAliasNames(typeText: string): string[] {
	const names: string[] = [];
	const identRegex = /[A-Za-z_][A-Za-z0-9_]*/g;
	const stop = new Set([
		'read',
		'readonly',
		'write',
		'and',
		'or',
		'not',
		'function',
		'table',
		'number',
		'string',
		'boolean',
		'nil',
		'any',
		'unknown',
		'true',
		'false'
	]);
	for (const match of typeText.matchAll(identRegex)) {
		const name = match[0];
		if (!stop.has(name)) names.push(name);
	}
	return names;
}

function collectAliasReadonlyFields(ast: unknown, sourceText?: string): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	if (!sourceText || !/\b(?:read|readonly)\b/.test(sourceText)) return map;
	const text = sourceText;

	let lineStarts: number[] | undefined;
	visitAst(ast, (node) => {
		if (isTypeAlias(node) && node.location) {
			lineStarts ??= computeLineStarts(text);
			const fields = parseReadonlyFieldsFromText(sliceFromLoc(text, node.location, lineStarts));
			if (fields.size > 0) map.set(node.name.name, fields);
		}
	});
	return map;
}

function mergeReadonlySets(target: Set<string>, source: Set<string>): void {
	for (const name of source) target.add(name);
}

function resolveReadonlyFields(typeText: string | undefined, aliasReadonly: Map<string, Set<string>>): Set<string> {
	const fields = parseReadonlyFieldsFromText(typeText);
	if (!typeText) return fields;
	for (const alias of parseAliasNames(typeText)) {
		const aliasFields = aliasReadonly.get(alias);
		if (aliasFields) mergeReadonlySets(fields, aliasFields);
	}
	return fields;
}


/** Readonly checks visit syntax nodes only; source locations are metadata, not children. */
export function ruleReadonlyWrites(ast: unknown, registry?: SluaRegistry, sourceText?: string): CoreDiagnostic[] {
	const diags: CoreDiagnostic[] = [];
	if (!ast) return diags;
	const aliasReadonly = collectAliasReadonlyFields(ast, sourceText);
	type Binding = { fields: Set<string>; module?: string; declared?: boolean };
	const empty = new Set<string>();
	const scopes: Array<Map<string, Binding>> = [new Map()];
	function binding(name: string): Binding | undefined {
		for (let i = scopes.length - 1; i >= 0; i--) {
			const entry = scopes[i]!.get(name);
			if (entry) return entry;
		}
		return registry?.getModule(name) ? { fields: empty, module: name } : undefined;
	}
	function fromExpression(expr: unknown): Binding {
		return isIdentifier(expr) ? binding(expr.name) ?? { fields: empty } : { fields: empty };
	}
	function define(id: IdentifierNode, value: Binding = { fields: empty }): void {
		const fields = id.typeAnnotation ? resolveReadonlyFields(id.typeAnnotation, aliasReadonly) : value.fields;
		scopes.at(-1)!.set(id.name, { fields, module: value.module, declared: Boolean(id.typeAnnotation) });
	}
	function assign(id: IdentifierNode, value: Binding): void {
		for (let i = scopes.length - 1; i >= 0; i--) {
			const previous = scopes[i]!.get(id.name);
			if (!previous) continue;
			scopes[i]!.set(id.name, { ...value, fields: previous.declared ? previous.fields : value.fields, declared: previous.declared });
			return;
		}
		scopes[0]!.set(id.name, value);
	}
	function checkTarget(target: unknown): void {
		if (!isMemberExpression(target) && !isIndexExpression(target)) return;
		const object = target.object;
		const property = isMemberExpression(target) ? target.property : target.index;
		const name = isMemberExpression(target) && isIdentifier(property) ? property.name : isStringNode(property) ? property.value : undefined;
		if (!name || !isIdentifier(object) || !isAstNode(property)) return;
		const owner = binding(object.name);
		if (owner?.fields.has(name)) diags.push({ code: 'readonly-write', severity: 'error',
			message: `Cannot assign to read-only property '${name}'.`, range: rangeFromNode(property) });
		else if (owner?.module && registry?.getModule(owner.module)?.values[name]?.readonly) {
			diags.push({ code: 'readonly-write', severity: 'error',
				message: `Cannot assign to read-only builtin value '${owner.module}.${name}'.`, range: rangeFromNode(property) });
		}
	}
	function scoped(body: unknown, parameters: unknown[] = [], after?: unknown): void {
		scopes.push(new Map());
		for (const parameter of parameters) if (isIdentifier(parameter)) define(parameter);
		statements(body);
		if (after) expression(after);
		scopes.pop();
	}
	function expression(value: unknown): void {
		if (Array.isArray(value)) { for (const child of value) expression(child); return; }
		if (!isAstNode(value)) return;
		if (isFunctionNode(value)) { scoped(value.body, value.parameters); return; }
		if (value.type === 'IfExpression') {
			const node = value as Record<string, unknown>;
			expression(node.test);
			const binding = conditionalBinding(value), initial = fromExpression(node.test);
			scopes.push(new Map());
			if (binding) define(binding, initial);
			expression(node.consequent);
			scopes.pop();
			expression(node.alternate);
			return;
		}
		for (const key of Object.keys(value)) {
			if (key !== 'location') expression((value as Record<string, unknown>)[key]);
		}
	}
	function statement(value: unknown): void {
		if (!isAstNode(value)) return;
		if (isLocalStatement(value)) {
			const initializers = value.init ?? [];
			for (const expr of initializers) expression(expr);
			const values = initializers.map(fromExpression);
			for (const [index, id] of value.variables.entries()) if (isIdentifier(id)) define(id, values[index]);
			return;
		}
		if (isAssignmentStatement(value)) {
			for (const expr of value.init) expression(expr);
			const values = value.init.map(fromExpression);
			for (const target of value.variables) { checkTarget(target); expression(target); }
			for (const [index, id] of value.variables.entries()) if (isIdentifier(id)) assign(id, values[index] ?? { fields: empty });
			return;
		}
		if (isFunctionDeclaration(value)) {
			if (isIdentifier(value.identifier)) {
				if ((value as unknown as { isLocal?: boolean }).isLocal) define(value.identifier);
				else assign(value.identifier, { fields: empty });
			}
			scoped(value.body, value.parameters);
			return;
		}
		const node = value as unknown as Record<string, unknown>;
		if (value.type === 'IfStatement') {
			expression(node.test);
			const binding = conditionalBinding(value), initial = fromExpression(node.test);
			scopes.push(new Map());
			if (binding) define(binding, initial);
			statements(node.consequent);
			scopes.pop();
			if (Array.isArray(node.alternate)) scoped(node.alternate); else statement(node.alternate);
			return;
		}
		if (value.type === 'GenericForStatement') {
			expression(node.iterators); scoped(node.body, Array.isArray(node.variables) ? node.variables : []); return;
		}
		if (value.type === 'ForStatement') {
			expression(node.start); expression(node.end); expression(node.step); scoped(node.body, [node.variable]); return;
		}
		if (value.type === 'DoStatement') { scoped(node.body); return; }
		if (value.type === 'WhileStatement') { expression(node.test); scoped(node.body); return; }
		if (value.type === 'RepeatStatement') { scoped(node.body, [], node.test); return; }
		expression(value);
	}
	function statements(body: unknown): void {
		if (Array.isArray(body)) for (const value of body) statement(value);
	}
	if (isAstNode(ast)) statements((ast as Record<string, unknown>).body);
	return diags;
}
