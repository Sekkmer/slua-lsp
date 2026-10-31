import { isAstNode, isIdentifier, rangeFromNode, type AstNode } from '../parser/ast.js';
import { slua, sluaPackValue, sluaTypeIsAssignable, type SluaType } from '../slua/types.js';
import { classType, nativeClassKind } from '../slua/classIdentity.js';
import type { CoreDiagnostic } from '../diagnostics/types.js';
import type { ClassInfo } from './classMembers.js';

/** A finite signature check, not generic/structural compiler subtyping. Opaque
 * facts remain permissive, while known argument/return incompatibilities warn. */
function compatible(expected: SluaType, actual: SluaType): boolean {
	if (expected.kind === 'primitive' && expected.name === 'unknown' || actual.kind === 'primitive' && actual.name === 'unknown') return true;
	return sluaTypeIsAssignable(expected, actual);
}
function overrideCompatible(base: SluaType, child: SluaType, bothSelf: boolean): boolean {
	if (base.kind !== 'function' || child.kind !== 'function') return true;
	const skip = bothSelf ? 1 : 0;
	// Native explicit methods accept excess arguments. A child may ignore base
	// arguments, but cannot require an extra nonnil argument that a base call omits.
	const length = Math.max(base.params.length, child.params.length);
	for (let i = skip; i < length; i++) {
		const offered = base.params[i] ?? base.variadic ?? slua.nil();
		const accepted = child.params[i] ?? child.variadic;
		if (accepted && !compatible(accepted, offered)) return false;
	}
	if (base.variadic && child.variadic && !compatible(child.variadic, base.variadic)) return false;
	const expected = base.returns.kind === 'tuple' ? base.returns : { kind: 'tuple' as const, items: [base.returns] };
	const actual = child.returns.kind === 'tuple' ? child.returns : { kind: 'tuple' as const, items: [child.returns] };
	for (let i = 0; i < expected.items.length; i++) {
		if (!compatible(sluaPackValue(expected.items, i, expected.variadic, expected.minimum), sluaPackValue(actual.items, i, actual.variadic, actual.minimum))) return false;
	}
	return !expected.variadic || !actual.variadic || compatible(expected.variadic, actual.variadic);
}

export function diagnoseClassInheritance(stmt: AstNode, info: ClassInfo): CoreDiagnostic[] {
	const node = stmt as AstNode & { superClass?: unknown; fields?: unknown[]; methods?: unknown[] };
	if (!isAstNode(node.superClass)) return [];
	const diagnostics: CoreDiagnostic[] = [];
	function warn(code: string, message: string, source: AstNode): void { diagnostics.push({ code, severity: 'warning', message, range: rangeFromNode(source) }); }
	if (info.baseIsSelf) warn('class-inheritance-cycle', 'A class cannot inherit from itself.', node.superClass);
	else if (info.base && !info.base.open) warn('class-closed-base', `Class '${info.base.name}' is closed and cannot be extended. Declare it open before deriving another class.`, node.superClass);
	else if (info.baseType && !info.base && definitelyNonclass(info.baseType)) {
		warn('class-invalid-base', classType(info.baseType)?.kind === 'instance' ? 'A class must extend a class constructor, not an instance.' : 'A class must extend a class constructor.', node.superClass);
	}
	const parent = info.base;
	if (!parent) return diagnostics;
	for (const field of node.fields ?? []) {
		if (!isAstNode(field)) continue;
		const name = (field as AstNode & { name?: unknown }).name;
		if (isIdentifier(name) && (parent.fields.has(name.name) || parent.methods.has(name.name))) warn('class-field-override', `Property '${name.name}' replaces an inherited class member. Class properties cannot override inherited members.`, name);
	}
	for (const method of node.methods ?? []) {
		if (!isAstNode(method)) continue;
		const name = (method as AstNode & { identifier?: unknown }).identifier;
		if (!isIdentifier(name)) continue;
		if (parent.fields.has(name.name)) {
			warn('class-field-override', `Method '${name.name}' replaces an inherited property; native class construction rejects this override.`, name); continue;
		}
		const original = parent.methods.get(name.name), current = info.methods.get(name.name);
		if (!original || !current) continue;
		if (['__eq', '__lt', '__le'].includes(name.name)) warn('class-method-override', `Inherited comparison metamethod '${name.name}' cannot be overridden.`, name);
		else if (!overrideCompatible(original, current, parent.selfMethods.has(name.name) && info.selfMethods.has(name.name))) warn('class-method-override', `Method '${name.name}' is not a compatible override of its inherited signature.`, name);
	}
	return diagnostics;
}

function definitelyNonclass(type: SluaType): boolean {
	if (type.kind === 'union') return type.items.every(definitelyNonclass);
	if (classType(type)?.kind === 'constructor' || nativeClassKind(type) === 'constructor') return false;
	if (type.kind === 'primitive') return type.name !== 'unknown';
	if (type.kind === 'custom') return classType(type)?.kind === 'instance' || nativeClassKind(type) === 'instance' || ['vector', 'rotation', 'uuid', 'integer', 'buffer', 'thread'].includes(type.name);
	return true;
}
