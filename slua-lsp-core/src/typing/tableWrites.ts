import { copySourceFunctionInfo, preserveDeprecatedFunction } from '../slua/sourceFunction.js';
import { copySourceMemberOrigins, sourceMemberOrigins, setSourceMemberOrigins, sourceTableOrigin, setSourceTableOrigin, isFrozenSourceTable, type SourceMemberOrigin } from '../slua/sourceOrigins.js';
import { isAstNode, isIdentifier, isMemberExpression, isStringNode } from '../parser/ast.js';
import { resolveBuiltinExpression, type LocalTypeLookup } from '../slua/resolveBuiltin.js';
import type { SluaRegistry } from '../slua/registry.js';
import { slua, sluaTypeIsAssignable, type SluaType } from '../slua/types.js';

// Origins are weakly held, never added to caller-owned types. They identify
// persistent versions of a source table for branch-wide field constraints.
export const tableOrigin = sourceTableOrigin;

/** Shared identity lets environments skip all alias traversal for proven no-op writes. */
export function identityTableUpdate(type: SluaType): SluaType { return type; }

/** Persistent replacement preserves alias identity without mutating a branch,
 * a caller's registry or an imported project's cached export graph. */
function replacement(from: SluaType, to: SluaType): (type: SluaType) => SluaType {
	const memo = new Map<SluaType, SluaType>();
	let remaining = 4096;
	function visit(type: SluaType, depth = 0): SluaType {
		if (type === from) return to;
		const cached = memo.get(type);
		if (cached) return cached;
		if (--remaining < 0 || depth >= 32) return slua.unknown();
		memo.set(type, slua.unknown()); // Recursive contracts stay conservative.
		const next = (child: SluaType) => visit(child, depth + 1);
		let result = type;
		if (type.kind === 'table' && type.fields) {
			const fields: Record<string, SluaType> = Object.create(null);
			let changed = false;
			for (const [name, field] of Object.entries(type.fields)) { fields[name] = next(field); changed ||= fields[name] !== field; }
			if (changed) { result = { ...type, fields }; copySourceMemberOrigins(type, result); }
		} else if (type.kind === 'array') {
			const element = next(type.element); if (element !== type.element) result = { ...type, element };
		} else if (type.kind === 'tuple' || type.kind === 'union') {
			const items = type.items.map(next); if (items.some((item, index) => item !== type.items[index])) result = { ...type, items };
		} else if (type.kind === 'function') {
			const params = type.params.map(next); const returns = next(type.returns); const variadic = type.variadic && next(type.variadic);
			if (returns !== type.returns || variadic !== type.variadic || params.some((item, index) => item !== type.params[index])) result = { ...type, params, returns, ...(variadic ? { variadic } : {}) };
		}
		if (result !== type && type.kind === 'function') copySourceFunctionInfo(type, result);
		memo.set(type, result); return result;
	}
	return (type) => visit(type);
}

type Target = { receiver: SluaType; name?: string; origin?: SourceMemberOrigin };
function targetTable(target: unknown, registry: SluaRegistry, local: LocalTypeLookup): Target | undefined {
	let receiver: unknown; let name: string | undefined; let token: unknown;
	if (isMemberExpression(target) && isIdentifier(target.property)) { receiver = target.object; name = target.property.name; token = target.property; }
	else if (isAstNode(target) && target.type === 'IndexExpression') {
		const index = target as unknown as { object: unknown; index: unknown };
		receiver = index.object;
		if (isStringNode(index.index)) { name = index.index.value; token = index.index; }
		else if (isAstNode(index.index) && index.index.type === 'Number') return undefined;
	} else return undefined;
	const type = resolveBuiltinExpression(receiver, registry, local)?.type;
	return type ? { receiver: type, name, ...(name !== undefined && isAstNode(token) && token.location ? { origin: { name, node: token } } : {}) } : undefined;
}

function writeKnown(target: Target | undefined, value: SluaType): (type: SluaType) => SluaType {
	const old = target?.receiver;
	if (old?.kind !== 'table' || old.module || old.metatable || !old.fields || isFrozenSourceTable(old)) return identityTableUpdate;
	const name = target?.name;
	let updated = slua.table();
	if (name !== undefined && (Object.hasOwn(old.fields, name) || Object.keys(old.fields).length < 128)) {
		const fields: Record<string, SluaType> = Object.assign(Object.create(null), old.fields);
		// Self-containing exports need recursive type variables, not ever-growing
		// snapshots. Retain other fields and leave that edge unknown.
		const previous = Object.hasOwn(old.fields, name) ? old.fields[name] : undefined;
		const accepted = previous && !sluaTypeIsAssignable(previous, value) ? previous : value;
		fields[name] = replacement(old, slua.unknown())(preserveDeprecatedFunction(previous, accepted));
		updated = slua.table(fields);
		const origins = new Map(sourceMemberOrigins(old));
		if (target?.origin) origins.set(name, target.origin); else origins.delete(name);
		setSourceMemberOrigins(updated, origins);
	}
	setSourceTableOrigin(updated, tableOrigin(old));
	return replacement(old, updated);
}

/** Update a known source table, including aliases nested in other local types.
 * Unknown keys invalidate named facts; numeric keys cannot overwrite them.
 * No arbitrary call, metatable or native module mutation is modeled here. */
export function tableWrite(target: unknown, value: SluaType, registry: SluaRegistry, local: LocalTypeLookup): (type: SluaType) => SluaType {
	return writeKnown(targetTable(target, registry, local), value);
}

/** Lua evaluates receiver objects and RHS values before rebinding locals. Keep
 * those temporary aliases current while composing persistent field writes. */
export function tableAssignments(targets: unknown[], initial: SluaType[], registry: SluaRegistry, local: LocalTypeLookup): { update: (type: SluaType) => SluaType; values: SluaType[] } {
	const receivers = targets.map((target) => targetTable(target, registry, local));
	let values = initial;
	const updates: Array<(type: SluaType) => SluaType> = [];
	for (const [index, target] of receivers.entries()) {
		if (!target) continue;
		const update = writeKnown(target, values[index] ?? slua.unknown());
		if (update === identityTableUpdate) continue;
		updates.push(update);
		for (const receiver of receivers) if (receiver) receiver.receiver = update(receiver.receiver);
		values = values.map(update);
	}
	return { values, update: updates.length === 0 ? identityTableUpdate : updates.length === 1 ? updates[0]! : (type) => { for (const update of updates) type = update(type); return type; } };
}
