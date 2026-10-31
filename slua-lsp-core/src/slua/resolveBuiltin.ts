import { copySourceFunctionInfo } from './sourceFunction.js';
import { isAstNode, isCallExpression, isIdentifier, isMemberExpression, isStringNode, isIntegerLiteralExpression } from '../parser/ast.js';
import { truthyType } from '../typing/refinements.js';
import { classMember, classMemberSignature, type ClassMember } from '../typing/classMembers.js';
import { isClassOf, classOfValue } from './classIdentity.js';
import { defaultMetatableRegistry } from './metatables.js';
import type { SluaFunctionDef, SluaMethodDef, SluaRegistry, SluaValueDef } from './registry.js';
import { slua, sluaPackValue, sluaTypeFromLuauAnnotationText, sluaTypeIsAssignable, type SluaType } from './types.js';

export type BuiltinResolution = {
	type: SluaType;
	definition?: SluaFunctionDef | SluaMethodDef | SluaValueDef;
	displayName?: string;
	classMember?: ClassMember;
};
export type LocalTypeLookup = (name: string) => SluaType | undefined;

/** Choose among declared builtin overloads using supplied value categories and
 * argument count. Unknown arguments stay permissive; value/format evaluation is
 * deliberately outside this bounded selection. A nearest candidate is retained
 * on invalid calls so the ordinary argument diagnostics can explain the error. */
export function selectBuiltinCallSignature(type: SluaType, args: unknown[], registry: SluaRegistry, local: LocalTypeLookup = () => undefined): Extract<SluaType, { kind: 'function' }> | undefined {
	if (type.kind === 'function') return type;
	if (type.kind !== 'union') return undefined;
	const candidates = type.items.filter((item): item is Extract<SluaType, { kind: 'function' }> => item.kind === 'function');
	const actual = args.map((arg) => arrayKeyType(arg, registry, local));
	const compatible = (expected: SluaType, value: SluaType): boolean => value.kind === 'primitive' && value.name === 'unknown' ||
		(value.kind === 'union' ? value.items.every((item) => compatible(expected, item)) : sluaTypeIsAssignable(expected, value));
	let best: typeof candidates[number] | undefined, bestTypes = Infinity, bestCount = Infinity;
	for (const candidate of candidates) {
		const minimum = candidate.arity?.min ?? candidate.params.filter((param) => !(param.kind === 'primitive' && param.name === 'nil') && !(param.kind === 'union' && param.items.some((item) => item.kind === 'primitive' && item.name === 'nil'))).length;
		const maximum = candidate.arity?.max ?? Infinity;
		const count = Math.max(0, minimum - args.length, args.length - maximum);
		const mismatches = actual.filter((value, i) => {
			const expected = candidate.params[i] ?? candidate.variadic;
			return expected && !compatible(expected, value);
		}).length;
		if (mismatches < bestTypes || mismatches === bestTypes && count < bestCount) {
			best = candidate; bestTypes = mismatches; bestCount = count;
		}
	}
	return best;
}

/** A numeric indexer is not a general Lua table key (not even a 64-bit integer). */
export function arrayKeyCompatibility(type: SluaType): 'number' | 'invalid' | 'unknown' {
	if (type.kind === 'primitive' && type.name === 'unknown') return 'unknown';
	if (type.kind === 'union') {
		const members = type.items.map(arrayKeyCompatibility);
		return members.includes('unknown') ? 'unknown' : members.every((member) => member === 'number') ? 'number' : 'invalid';
	}
	return type.kind === 'primitive' && type.name === 'number' ? 'number' : 'invalid';
}

/** Small scalar subset used only for keys; preserve metatable inference elsewhere. */
export function arrayKeyType(expression: unknown, registry: SluaRegistry, local: LocalTypeLookup): SluaType {
	if (!isAstNode(expression)) return slua.unknown();
	if (isIntegerLiteralExpression(expression)) return slua.integer();
	const node = expression as unknown as Record<string, unknown>;
	if (expression.type === 'Number') return slua.number();
	if (expression.type === 'String') return slua.string();
	if (expression.type === 'Boolean') return slua.boolean();
	if (expression.type === 'Nil') return slua.nil();
	if (expression.type === 'Table') return slua.table();
	if (expression.type === 'Function') return slua.anyFunction();
	if (expression.type === 'TypeCastExpression') return sluaTypeFromLuauAnnotationText(typeof node.typeAnnotation === 'string' ? node.typeAnnotation : undefined);
	if (expression.type === 'UnaryExpression') {
		if (node.operator === 'not') return slua.boolean();
		const argument = arrayKeyType(node.argument, registry, local);
		if (node.operator === '-' && arrayKeyCompatibility(argument) === 'number') return slua.number();
		if ((node.operator === '#' || node.operator === 'len') && (argument.kind === 'array' || argument.kind === 'table' || (argument.kind === 'primitive' && argument.name === 'string'))) return slua.number();
	}
	if (expression.type === 'BinaryExpression') {
		const operator = String(node.operator);
		if (['==', '~=', '<', '>', '<=', '>='].includes(operator)) return slua.boolean();
		if (operator === '..') return slua.string();
		if (['+', '-', '*', '/', '//', '%', '^'].includes(operator) &&
			arrayKeyCompatibility(arrayKeyType(node.left, registry, local)) === 'number' &&
			arrayKeyCompatibility(arrayKeyType(node.right, registry, local)) === 'number') return slua.number();
	}
	return resolveBuiltinExpression(expression, registry, local)?.type ?? slua.unknown();
}

export function builtinPathExpression(path: string): unknown {
	const parts = path.split('.');
	let node: unknown = { type: 'Identifier', name: parts[0] };
	for (const name of parts.slice(1)) node = { type: 'MemberExpression', object: node, property: { type: 'Identifier', name }, indexer: '.' };
	return node;
}

/** Resolve registry-backed modules, aliases and known metatable instances. */
export function resolveBuiltinExpression(expression: unknown, registry: SluaRegistry, local: LocalTypeLookup = () => undefined): BuiltinResolution | undefined {
	if (!isAstNode(expression)) return undefined;
	if (registry.sourceMacroInvalidUses.has(expression)) return { type: slua.unknown() };
	if (isIntegerLiteralExpression(expression)) return { type: slua.integer() };
	if (expression.type === 'InterpolatedString') return { type: slua.string() };
	const sourceType = registry.expressionTypes.get(expression);
	if (sourceType) return { type: sourceType };
	if (isIdentifier(expression)) {
		const binding = local(expression.name);
		if (binding) return { type: binding, displayName: expression.name };
		if (registry.getModule(expression.name)) return { type: slua.module(expression.name), displayName: expression.name };
		const global = registry.getGlobal(expression.name);
		if (global) return { type: global.signature, definition: global, displayName: expression.name };
		const value = registry.getGlobalValue(expression.name);
		if (value) return { type: value.type, definition: value, displayName: expression.name };
		if (registry.getObjectType(expression.name) && !registry.getObjectType(expression.name)?.instanceOnly) return { type: slua.withMetatable(expression.name), displayName: expression.name };
		return undefined;
	}
	if (isCallExpression(expression)) {
		if (isIdentifier(expression.callee) && expression.callee.name === 'assert' && !local('assert') && expression.arguments.length) {
			return { type: truthyType(arrayKeyType(expression.arguments[0], registry, local), true) };
		}
		// setmetatable({}, KnownBuilder) is the native constructor's documented form.
		if (isIdentifier(expression.callee) && expression.callee.name === 'setmetatable' && !local('setmetatable')) {
			const meta = resolveBuiltinExpression(expression.arguments[1], registry, local)?.type;
			if (meta?.kind === 'table' && meta.module && defaultMetatableRegistry.get(meta.module)) return { type: slua.withMetatable(meta.module) };
		}
		const callee = resolveBuiltinExpression(expression.callee, registry, local);
		let signature = callee?.type;
		if (signature?.kind === 'table' && signature.module) signature = registry.getGlobal(signature.module)?.signature;
		const selected = signature && selectBuiltinCallSignature(signature, expression.arguments, registry, local);
		if (!selected) return undefined;
		if (isClassOf(selected) && expression.arguments.length) {
			const result = classOfValue(arrayKeyType(expression.arguments[0], registry, local));
			if (result) return { type: result };
		}
		return { type: selected.returns.kind === 'tuple' ? sluaPackValue(selected.returns.items, 0, selected.returns.variadic, selected.returns.minimum) : selected.returns };
	}
	if (expression.type === 'IndexExpression') {
		const index = expression as unknown as Record<string, unknown>;
		const container = resolveBuiltinExpression(index.object, registry, local)?.type;
		if (container?.kind === 'array') return { type: arrayKeyCompatibility(arrayKeyType(index.index, registry, local)) === 'number' ? container.element : slua.unknown() };
	}
	let receiver: unknown, member: string | undefined, colon = false;
	if (isMemberExpression(expression) && isIdentifier(expression.property)) {
		receiver = expression.object; member = expression.property.name; colon = expression.indexer === ':';
	} else if (expression.type === 'IndexExpression') {
		const indexed = expression as unknown as Record<string, unknown>;
		if (isStringNode(indexed.index)) { receiver = indexed.object; member = indexed.index.value; }
	}
	if (!member) return undefined;
	const object = resolveBuiltinExpression(receiver, registry, local);
	if (!object) return undefined;
	const type = object.type;
	const module = type.kind === 'table' ? type.module : undefined;
	const metatable = type.kind === 'table' ? type.metatable : type.kind === 'custom' ? type.name : undefined;
	const displayName = `${object.displayName ?? module ?? metatable ?? 'value'}${colon ? ':' : '.'}${member}`;
	const sourceClass = classMember(type, member);
	if (sourceClass) return { type: classMemberSignature(sourceClass, colon), classMember: sourceClass, displayName };
	if (type.kind === 'table' && type.fields && Object.hasOwn(type.fields, member)) {
		const field = type.fields[member]!;
		return { type: colon && field.kind === 'function' ? copySourceFunctionInfo(field, slua.fn(field.params.slice(1), field.returns, field.variadic, field.arity ? { min: Math.max(0, field.arity.min - 1), max: Math.max(0, field.arity.max - 1) } : undefined)) : field, displayName };
	}
	if (module) {
		const mod = registry.getModule(module);
		const fn = mod?.functions[member];
		if (fn) return { type: fn.signature, definition: fn, displayName };
		const value = mod?.values[member];
		if (value) return { type: value.type, definition: value, displayName };
	}
	if (metatable) {
		const object = registry.getObjectType(metatable);
		const method = object?.methods[member];
		const property = object?.properties[member];
		const native = defaultMetatableRegistry.getMembers(metatable)?.[member];
		if (property) return { type: property.type, definition: property, displayName };
		if (native?.kind === 'property') return { type: native.type, displayName, definition: { name: member, type: native.type, readonly: true, docs: native.docs ?? '', deprecated: false, source: 'default' } };
		const signature = method?.signature ?? native?.type;
		if (!signature) return undefined;
		const requiresSelf = method?.requiresColonCall ?? native?.requiresColonCall ?? native?.kind === 'method';
		const namespaceMethod = registry.getModule(metatable)?.functions[member]?.signature;
		const selfType = namespaceMethod?.kind === 'function' ? namespaceMethod.params[0] ?? type : type;
		const adjusted = !colon && requiresSelf && signature.kind === 'function'
			? slua.fn([selfType, ...signature.params], signature.returns, signature.variadic, signature.arity ? { min: signature.arity.min + 1, max: signature.arity.max + 1 } : undefined) : signature;
		return { type: adjusted, definition: method ?? { name: member, signature: adjusted, docs: native?.docs ?? '', deprecated: false, source: 'default' }, displayName };
	}
	return undefined;
}
