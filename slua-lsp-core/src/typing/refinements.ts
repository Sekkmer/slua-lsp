import { mergeSourceOrigins } from '../slua/sourceOrigins.js';
import { slua, sluaTypeEquals, sluaTypeToString, type SluaType } from '../slua/types.js';

type Lookup = (name: string) => SluaType | undefined;
type Node = Record<string, unknown> & { type: string };
function node(value: unknown): value is Node {
	return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

export function joinFlowTypes(a: SluaType, b: SluaType): SluaType {
	if (sluaTypeEquals(a, b)) return mergeSourceOrigins(a, b);
	if ([a, b].some((t) => t.kind === 'primitive' && t.name === 'unknown')) return slua.unknown();
	const items = new Map<string, SluaType>();
	for (const t of [a, b]) for (const item of t.kind === 'union' ? t.items : [t]) {
		const key = sluaTypeToString(item), previous = items.get(key);
		items.set(key, previous && sluaTypeEquals(previous, item) ? mergeSourceOrigins(previous, item) : item);
	}
	return items.size === 1 ? [...items.values()][0]! : slua.union([...items.values()]);
}


function filter(type: SluaType, predicate: (item: SluaType) => boolean): SluaType {
	const items = (type.kind === 'union' ? type.items : [type]).filter(predicate);
	// There is no bottom/unreachable type in the current model. Retain the
	// original contract rather than inventing a type for an impossible path.
	return items.length === 0 ? type : items.length === 1 ? items[0]! : slua.union(items);
}

export function truthyType(type: SluaType, expected: boolean): SluaType {
	return filter(type, (t) => {
		if (t.kind === 'primitive' && t.name === 'unknown') return true;
		if (t.kind === 'primitive' && t.name === 'boolean') return true; // No boolean singleton types yet.
		return expected !== (t.kind === 'primitive' && t.name === 'nil');
	});
}

function runtimeType(name: string, extended: boolean): SluaType | undefined {
	const types: Record<string, SluaType> = { number: slua.number(), string: slua.string(), boolean: slua.boolean(),
		nil: slua.nil(), table: slua.table(), function: slua.anyFunction(), thread: slua.thread(), buffer: slua.buffer() };
	if (extended) Object.assign(types, { uuid: slua.uuid(), vector: slua.vector(), quaternion: slua.rotation(), rotation: slua.rotation(), integer: slua.integer() });
	return types[name];
}

function matches(item: SluaType, asserted: SluaType): boolean {
	if (sluaTypeEquals(item, asserted)) return true;
	if (asserted.kind === 'table') return item.kind === 'table' || item.kind === 'array';
	if (asserted.kind === 'function') return item.kind === 'function';
	if (asserted.kind === 'primitive' && asserted.name === 'string') return item.kind === 'literal';
	return false;
}

/** Local identifier guards shared by diagnostics, inlays and cursor inference.
 * Property paths, boolean singleton subtraction and unreachable paths are not
 * represented; local type/typeof/assert shadows never acquire builtin powers.
 */
export function conditionRefinements(expression: unknown, expected: boolean, lookup: Lookup): Map<string, SluaType> {
	let remaining = 2048;
	function visit(expr: unknown, truth: boolean, get: Lookup, depth: number): Map<string, SluaType> {
		const result = new Map<string, SluaType>();
		// Alternating and/or paths can otherwise revisit a nested left operand
		// exponentially. Budget exhaustion retains incoming types conservatively.
		if (!node(expr) || depth > 64 || --remaining < 0) return result;
		if (expr.type === 'Identifier' && typeof expr.name === 'string') {
			const current = get(expr.name);
			if (current) result.set(expr.name, truthyType(current, truth));
			return result;
		}
		if (expr.type === 'UnaryExpression' && expr.operator === 'not') return visit(expr.argument, !truth, get, depth + 1);
		if (expr.type !== 'BinaryExpression') return result;
		if (expr.operator === 'and' || expr.operator === 'or') {
			const leftTruth = expr.operator === 'and';
			const left = visit(expr.left, leftTruth, get, depth + 1);
			const narrowed: Lookup = (name) => left.get(name) ?? get(name);
			const right = visit(expr.right, truth, narrowed, depth + 1);
			const sequence = new Map([...left, ...right]);
			if (truth === leftTruth) return sequence;
			// Falsy and / truthy or each have two possible paths. Keep the union,
			// including the original type on paths that do not constrain a name.
			const short = visit(expr.left, !leftTruth, get, depth + 1);
			for (const name of new Set([...short.keys(), ...sequence.keys()])) {
				const a = short.get(name) ?? get(name);
				const b = sequence.get(name) ?? get(name);
				if (a && b) result.set(name, joinFlowTypes(a, b));
			}
			return result;
		}
		if (expr.operator !== '==' && expr.operator !== '~=') return result;
		const equal = truth === (expr.operator === '==');
		function compare(value: unknown, other: unknown): void {
			if (!node(value) || !node(other)) return;
			if (value.type === 'Identifier' && typeof value.name === 'string') {
				const current = get(value.name);
				if (!current) return;
				if (other.type === 'Nil') result.set(value.name, equal ? slua.nil() : filter(current, (t) => !(t.kind === 'primitive' && t.name === 'nil')));
				if (other.type === 'Boolean' && typeof other.value === 'boolean') {
					if (equal) result.set(value.name, slua.boolean());
					// x ~= false can still be nil; subtraction of a boolean singleton
					// must not accidentally turn that comparison into a truthiness test.
				}
				if (other.type === 'String' && typeof other.value === 'string') result.set(value.name, equal ? slua.literal(other.value) :
					filter(current, (t) => !(t.kind === 'literal' && t.value === other.value)));
			}
			if (value.type !== 'CallExpression' || !node(value.callee) || value.callee.type !== 'Identifier' ||
				!['type', 'typeof'].includes(String(value.callee.name)) || get(String(value.callee.name)) ||
				!Array.isArray(value.arguments) || value.arguments.length !== 1 || other.type !== 'String') return;
			const argument = value.arguments[0];
			if (!node(argument) || argument.type !== 'Identifier' || typeof argument.name !== 'string') return;
			const current = get(argument.name);
			const asserted = runtimeType(String(other.value), value.callee.name === 'typeof');
			if (!current || !asserted) return;
			if (equal) {
				const candidates = current.kind === 'union' ? current.items : [current];
				const kept = candidates.filter((t) => matches(t, asserted));
				result.set(argument.name, kept.length ? (kept.length === 1 ? kept[0]! : slua.union(kept)) : asserted);
			} else result.set(argument.name, filter(current, (t) => !matches(t, asserted)));
		}
		compare(expr.left, expr.right);
		compare(expr.right, expr.left);
		return result;
	}
	return visit(expression, expected, lookup, 0);
}

/** A successful unshadowed assert call refines its first argument. */
export function assertionCondition(expression: unknown, lookup: Lookup): unknown {
	if (!node(expression) || expression.type !== 'CallExpression' || !node(expression.callee) ||
		expression.callee.type !== 'Identifier' || expression.callee.name !== 'assert' || lookup('assert') || !Array.isArray(expression.arguments)) return undefined;
	return expression.arguments[0];
}

/** Definite return through ordinary blocks, without guessing about loops,
 * arbitrary calls or unmodeled exception/yield behavior. */
export function blockReturns(value: unknown): boolean {
	const body = Array.isArray(value) ? value : [value];
	return body.some((statement) => node(statement) && (statement.type === 'ReturnStatement' ||
		(statement.type === 'DoStatement' && blockReturns(statement.body)) ||
		(statement.type === 'IfStatement' && !!statement.alternate && blockReturns(statement.consequent) && blockReturns(statement.alternate))));
}
