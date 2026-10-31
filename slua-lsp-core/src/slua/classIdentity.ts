import type { ClassInfo, ClassType } from '../typing/classMembers.js';
import type { SluaType } from './types.js';

// Weak metadata distinguishes native class values from ordinary tables and
// function signatures without changing serialized/display type shapes.
const classes = new WeakMap<SluaType, ClassType>();
const nativeTops = new WeakMap<SluaType, ClassType['kind']>();
const classOfFunctions = new WeakSet<SluaType>();

export function classType(type: SluaType): ClassType | undefined { return classes.get(type); }
export function registerClassIdentity(info: ClassInfo): void {
	classes.set(info.constructorType, { info, kind: 'constructor' });
	classes.set(info.instanceType, { info, kind: 'instance' });
}
export function nativeClassType(kind: ClassType['kind']): SluaType {
	const type: SluaType = { kind: 'custom', name: kind === 'constructor' ? 'class' : 'object' };
	nativeTops.set(type, kind);
	return type;
}
export function nativeClassKind(type: SluaType): ClassType['kind'] | undefined { return nativeTops.get(type); }
export function markClassOf(type: SluaType): void { classOfFunctions.add(type); }
export function isClassOf(type: SluaType): boolean { return classOfFunctions.has(type); }

/** Only specialize actual native function identities. Unknown values keep the
 * declared class-or-nil result; structural values never gain nominal identity. */
export function classOfValue(type: SluaType): SluaType | undefined {
	const concrete = classes.get(type);
	if (concrete) return concrete.kind === 'instance' ? concrete.info.constructorType : { kind: 'primitive', name: 'nil' };
	if (type.kind === 'union') {
		const items = type.items.map(classOfValue);
		return items.every((item): item is SluaType => item !== undefined) ? { kind: 'union', items } : undefined;
	}
	if (nativeTops.get(type) === 'instance') return nativeClassType('constructor');
	if (nativeTops.get(type) === 'constructor' || type.kind === 'table' || type.kind === 'array' || type.kind === 'function' || type.kind === 'literal' ||
		type.kind === 'primitive' && type.name !== 'unknown') return { kind: 'primitive', name: 'nil' };
	return undefined;
}
