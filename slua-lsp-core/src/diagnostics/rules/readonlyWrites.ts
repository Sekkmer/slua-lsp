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

function sliceFromLoc(text: string, loc: Loc): string {
	const lineStarts = computeLineStarts(text);
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
	if (!sourceText) return map;
	const text = sourceText;

	const seen = new WeakSet<object>();
	function visit(value: unknown): void {
		if (!value || typeof value !== 'object') return;
		if (seen.has(value as object)) return;
		seen.add(value as object);

		if (isTypeAlias(value) && value.location) {
			const raw = sliceFromLoc(text, value.location);
			const fields = parseReadonlyFieldsFromText(raw);
			if (fields.size > 0) map.set(value.name.name, fields);
		}

		for (const child of Object.values(value as Record<string, unknown>)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	}

	visit(ast);
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

export function ruleReadonlyWrites(ast: unknown, registry?: SluaRegistry, sourceText?: string): CoreDiagnostic[] {
	const diags: CoreDiagnostic[] = [];
	if (!ast) return diags;

	const aliasReadonly = collectAliasReadonlyFields(ast, sourceText);

	const scopes: Array<Map<string, Set<string>>> = [new Map()];
	const pushScope = (): void => {
		scopes.push(new Map());
	};
	const popScope = (): void => void scopes.pop();
	const setReadonly = (name: string, fields: Set<string>): void => {
		if (fields.size === 0) return;
		scopes[scopes.length - 1]!.set(name, fields);
	};
	const getReadonly = (name: string): Set<string> | undefined => {
		for (let i = scopes.length - 1; i >= 0; i -= 1) {
			const entry = scopes[i]!.get(name);
			if (entry) return entry;
		}
		return undefined;
	};

	function recordAnnotation(id: IdentifierNode): void {
		if (!id.typeAnnotation) return;
		const fields = resolveReadonlyFields(id.typeAnnotation, aliasReadonly);
		setReadonly(id.name, fields);
	}

	function reportReadonlyWrite(node: AstNode, name: string): void {
		diags.push({
			code: 'readonly-write',
			message: `Cannot assign to read-only property '${name}'.`,
			severity: 'error',
			range: rangeFromNode(node)
		});
	}

	function reportReadonlyBuiltin(node: AstNode, fullName: string): void {
		diags.push({
			code: 'readonly-write',
			message: `Cannot assign to read-only builtin value '${fullName}'.`,
			severity: 'error',
			range: rangeFromNode(node)
		});
	}

	function propertyNameFromMember(expr: MemberExpressionNode): string | null {
		return isIdentifier(expr.property) ? expr.property.name : null;
	}

	function propertyNameFromIndex(expr: IndexExpressionNode): string | null {
		if (isStringNode(expr.index)) return expr.index.value;
		return null;
	}

	function checkAssignmentTarget(target: unknown): void {
		if (isMemberExpression(target)) {
			const prop = propertyNameFromMember(target);
			if (!prop) return;
			if (isIdentifier(target.object)) {
				const readonlyFields = getReadonly(target.object.name);
				if (readonlyFields && readonlyFields.has(prop)) {
					reportReadonlyWrite(target.property as AstNode, prop);
					return;
				}

				if (registry) {
					const mod = registry.getModule(target.object.name);
					const val = mod?.values[prop];
					if (val?.readonly) {
						reportReadonlyBuiltin(target.property as AstNode, `${target.object.name}.${prop}`);
					}
				}
			}
		}

		if (isIndexExpression(target)) {
			const prop = propertyNameFromIndex(target);
			if (!prop) return;
			if (isIdentifier(target.object)) {
				const readonlyFields = getReadonly(target.object.name);
				if (readonlyFields && readonlyFields.has(prop)) {
					reportReadonlyWrite(target.index as AstNode, prop);
					return;
				}

				if (registry) {
					const mod = registry.getModule(target.object.name);
					const val = mod?.values[prop];
					if (val?.readonly) {
						reportReadonlyBuiltin(target.index as AstNode, `${target.object.name}.${prop}`);
					}
				}
			}
		}
	}

	function visitStatement(stmt: unknown): void {
		if (isLocalStatement(stmt)) {
			for (const v of stmt.variables) {
				if (isIdentifier(v)) recordAnnotation(v);
			}
			return;
		}

		if (isAssignmentStatement(stmt)) {
			for (const target of stmt.variables) {
				checkAssignmentTarget(target);
			}
			return;
		}

		if (isFunctionDeclaration(stmt)) {
			pushScope();
			for (const p of stmt.parameters) {
				if (isIdentifier(p)) recordAnnotation(p);
			}
			for (const s of stmt.body) visitStatement(s);
			popScope();
			return;
		}

		if (isFunctionNode(stmt)) {
			pushScope();
			for (const p of stmt.parameters) {
				if (isIdentifier(p)) recordAnnotation(p);
			}
			for (const s of stmt.body) visitStatement(s);
			popScope();
			return;
		}

		if (!isAstNode(stmt)) return;
		for (const child of Object.values(stmt as Record<string, unknown>)) {
			if (Array.isArray(child)) child.forEach(visitStatement);
			else visitStatement(child);
		}
	}

	if (isAstNode(ast) && Array.isArray((ast as Record<string, unknown>).body)) {
		for (const stmt of (ast as Record<string, unknown>).body as unknown[]) {
			visitStatement(stmt);
		}
	}

	return diags;
}
