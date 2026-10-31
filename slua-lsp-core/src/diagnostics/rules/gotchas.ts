import { isAstNode, isIdentifier, isRecord, isStringNode, rangeFromNode, visitAst } from '../../parser/ast.js';
import type { SluaType } from '../../slua/types.js';
import type { CoreDiagnostic } from '../types.js';

/** Opinionated advice for literal zero/empty text, not numeric/string variables.
 * Unlike LSL, both literals are truthy in Luau. Never execute or fold user code. */
export function ruleLiteralTruthiness(ast: unknown): CoreDiagnostic[] {
	const diagnostics: CoreDiagnostic[] = [], checked = new WeakSet<object>();
	function condition(value: unknown): void {
		if (!isAstNode(value)) return;
		if (checked.has(value)) return;
		checked.add(value);
		const node = value as unknown as Record<string, unknown>;
		const zeroValue = (value: Record<string, unknown>) => value.type === 'Number' && value.value === 0 || value.type === 'Integer' && value.value === '0';
		const zero = zeroValue(node) || value.type === 'UnaryExpression' && node.operator === '-' && isRecord(node.argument) && zeroValue(node.argument);
		if (zero || isStringNode(value) && value.value === '') {
			diagnostics.push({ code: 'truthy-literal', severity: 'warning', range: rangeFromNode(value),
				message: `Luau treats ${zero ? 'zero' : 'an empty string'} as true. Use an explicit comparison if you intended a zero or empty-value check.` });
		} else if (value.type === 'BinaryExpression' && (node.operator === 'and' || node.operator === 'or')) {
			condition(node.left); condition(node.right);
		} else if (value.type === 'UnaryExpression' && node.operator === 'not') condition(node.argument);
	}
	visitAst(ast, (value) => {
		const node = value as unknown as Record<string, unknown>;
		if (['IfStatement', 'IfExpression', 'WhileStatement', 'RepeatStatement'].includes(value.type)) condition(node.test);
		else if (value.type === 'UnaryExpression' && node.operator === 'not') condition(node.argument);
		else if (value.type === 'BinaryExpression' && (node.operator === 'and' || node.operator === 'or')) condition(node.left);
	});
	return diagnostics;
}

/** Only a direct unshadowed builtin and a fully known literal key layout.
 * pairs/generalized iteration, table variables and ambiguous keys are valid.
 * Skip duplicate keys and final open call packs instead of guessing VM order. */
export function diagnoseLiteralIpairs(call: { callee: unknown; arguments: unknown[] }, locals: ReadonlyMap<string, SluaType>): CoreDiagnostic[] {
	if (!isIdentifier(call.callee) || call.callee.name !== 'ipairs' || locals.has('ipairs')) return [];
	const table = call.arguments[0];
	if (!isAstNode(table) || table.type !== 'Table') return [];
	const fields = (table as unknown as { fields?: unknown[] }).fields;
	if (!fields?.length || fields.length > 4096) return [];
	const entries = new Map<string, unknown>(), numeric = new Map<number, unknown>();
	let implicit = 0;
	for (const [index, field] of fields.entries()) {
		if (!isRecord(field)) return [];
		let key: string;
		let number: number | undefined;
		if (!field.key) {
			if (index === fields.length - 1 && isAstNode(field.value) && field.value.type === 'CallExpression' && !(field.value as unknown as { parenthesized?: boolean }).parenthesized) return [];
			number = ++implicit; key = `number:${number}`;
		} else if (isRecord(field.key) && field.key.type === 'Number' && typeof field.key.value === 'number' && Number.isFinite(field.key.value)) {
			number = field.key.value; key = `number:${number}`;
		} else if (isIdentifier(field.key) && !field.computed) key = `string:${field.key.name}`;
		else if (isStringNode(field.key)) key = `string:${field.key.value}`;
		else return [];
		if (entries.has(key)) return [];
		entries.set(key, field.value);
		if (number !== undefined && Number.isSafeInteger(number) && number > 0) numeric.set(number, field.value);
	}
	const isNil = (value: unknown) => isAstNode(value) && value.type === 'Nil';
	let hole = 1;
	for (const key of [...numeric.keys()].sort((a, b) => a - b)) {
		if (key !== hole || isNil(numeric.get(key))) break;
		hole++;
	}
	const skipped = [...numeric].some(([key, value]) => key > hole && !isNil(value));
	const empty = hole === 1 && [...entries.values()].some((value) => !isNil(value));
	if (!empty && !skipped) return [];
	return [{ code: 'ipairs-literal-hole', severity: 'warning', range: rangeFromNode(table),
		message: `ipairs stops at the first missing or nil integer key (here ${hole}) and does not traverse named fields. This literal ${empty ? 'will not iterate' : 'has entries it cannot reach'}; use pairs or generalized iteration if you intended to visit all fields.` }];
}

/** Explicit writes can replace the builtin, including from a later closure.
 * Conservatively omit this optional advice for the whole file in that case. */
export function createLiteralIpairsChecker(ast: unknown): typeof diagnoseLiteralIpairs {
	let written = false;
	function target(value: unknown): boolean {
		if (isIdentifier(value)) return value.name === 'ipairs';
		if (!isRecord(value) || !isIdentifier(value.object) || value.object.name !== '_G') return false;
		return value.type === 'MemberExpression' && isIdentifier(value.property) && value.property.name === 'ipairs' || value.type === 'IndexExpression' && isStringNode(value.index) && value.index.value === 'ipairs';
	}
	visitAst(ast, (value) => {
		const node = value as unknown as Record<string, unknown>;
		if (value.type === 'AssignmentStatement' && Array.isArray(node.variables) && node.variables.some(target)) written = true;
		if (value.type === 'FunctionDeclaration' && !node.isLocal && target(node.identifier)) written = true;
	});
	return written ? () => [] : diagnoseLiteralIpairs;
}
