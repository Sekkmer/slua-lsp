import { classType } from './classIdentity.js';
import { mergeSourceFunctionInfo } from './sourceFunction.js';
import type { AstNode } from '../parser/ast.js';
import type { SluaType } from './types.js';

export type SourceMemberOrigin = { name: string; node: AstNode };
// Source custody is separate from type equality/display and never serialized as
// part of a public type. Weak keys release imported ASTs with their project.
const members = new WeakMap<SluaType, ReadonlyMap<string, SourceMemberOrigin>>();
const identities = new WeakMap<SluaType, SluaType>();
const frozen = new WeakSet<SluaType>();
export function freezeSourceTable(type: SluaType): void { frozen.add(sourceTableOrigin(type)); }
export function isFrozenSourceTable(type: SluaType): boolean { return frozen.has(sourceTableOrigin(type)); }
const merges = new WeakMap<SluaType, WeakMap<SluaType, SluaType>>();
export function sourceTableOrigin(type: SluaType): SluaType { return identities.get(type) ?? type; }
export function setSourceTableOrigin(type: SluaType, origin: SluaType): void { identities.set(type, origin); }
export function sourceMemberOrigins(type: SluaType): ReadonlyMap<string, SourceMemberOrigin> | undefined { return members.get(type); }
export function setSourceMemberOrigins(type: SluaType, origins: ReadonlyMap<string, SourceMemberOrigin>): void { members.set(type, origins); }
export function copySourceMemberOrigins(from: SluaType, to: SluaType): void {
	const origins = members.get(from);
	if (origins) members.set(to, origins);
	identities.set(to, sourceTableOrigin(from));
}

/** Equal type shapes do not establish equal declaration origins. Intersect
 * source identity recursively, preserving type facts and stable alias versions.
 * On pathological graphs use the same conservative unknown/work-depth bounds
 * as persistent table writes, rather than retaining a falsely precise origin. */
export function mergeSourceOrigins(a: SluaType, b: SluaType): SluaType {
	let remaining = 4096;
	function merge(a: SluaType, b: SluaType, depth: number): SluaType {
		if (a === b) return a;
		const classA = classType(a), classB = classType(b);
		if (classA || classB) return classA && classB && classA.kind === classB.kind && classA.info.declaration === classB.info.declaration ? a : { kind: 'primitive', name: 'unknown' };
		if (a.kind === 'primitive' || a.kind === 'custom' || a.kind === 'literal') return a;
		if (--remaining < 0 || depth >= 32) return { kind: 'primitive', name: 'unknown' };
		const cached = merges.get(a)?.get(b);
		if (cached) return cached;
		if (a.kind !== b.kind) return { kind: 'primitive', name: 'unknown' };
		const result = { ...a } as SluaType;
		const byRight = merges.get(a) ?? new WeakMap<SluaType, SluaType>();
		byRight.set(b, result); merges.set(a, byRight);
		if (result.kind === 'table' && a.kind === 'table' && b.kind === 'table') {
			if (a.fields) {
				result.fields = Object.create(null) as Record<string, SluaType>;
				for (const [name, type] of Object.entries(a.fields)) result.fields[name] = b.fields?.[name] ? merge(type, b.fields[name]!, depth + 1) : { kind: 'primitive', name: 'unknown' };
			}
			const common = new Map<string, SourceMemberOrigin>();
			for (const [name, origin] of members.get(a) ?? []) if (members.get(b)?.get(name)?.node === origin.node) common.set(name, origin);
			members.set(result, common);
			if (sourceTableOrigin(a) === sourceTableOrigin(b)) identities.set(result, sourceTableOrigin(a));
		} else if (result.kind === 'array' && a.kind === 'array' && b.kind === 'array') result.element = merge(a.element, b.element, depth + 1);
		else if ((result.kind === 'tuple' || result.kind === 'union') && (a.kind === 'tuple' || a.kind === 'union') && (b.kind === 'tuple' || b.kind === 'union')) {
			result.items = a.items.map((item, i) => b.items[i] ? merge(item, b.items[i]!, depth + 1) : { kind: 'primitive', name: 'unknown' });
		} else if (result.kind === 'function' && a.kind === 'function' && b.kind === 'function') {
			mergeSourceFunctionInfo(a, b, result);
			result.params = a.params.map((item, i) => b.params[i] ? merge(item, b.params[i]!, depth + 1) : { kind: 'primitive', name: 'unknown' });
			result.returns = merge(a.returns, b.returns, depth + 1);
			if (a.variadic && b.variadic) result.variadic = merge(a.variadic, b.variadic, depth + 1);
		}
		return result;
	}
	return merge(a, b, 0);
}
