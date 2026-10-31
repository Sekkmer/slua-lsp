import { ClassMemberMap, ClassMemberSet, classOriginView } from './classMemberMap.js';
import { setSourceMemberOrigins, type SourceMemberOrigin } from '../slua/sourceOrigins.js';
import { slua, sluaTypeFromLuauAnnotationText, type SluaType } from '../slua/types.js';
import { classType, registerClassIdentity } from '../slua/classIdentity.js';
import type { IdentifierNode } from '../parser/ast.js';
export { classType } from '../slua/classIdentity.js';

export type ClassInfo = {
	name: string;
	declaration: IdentifierNode;
	open: boolean;
	base?: ClassInfo;
	baseType?: SluaType;
	baseIsSelf: boolean;
	hasUnresolvedBase: boolean;
	hasOwnInitializer: boolean;
	hasUserInitializerInChain: boolean;
	fieldOrigins: ClassMemberMap<SourceMemberOrigin>;
	methodOrigins: ClassMemberMap<SourceMemberOrigin>;
	selfMethods: ClassMemberSet;
	fields: ClassMemberMap<SluaType>;
	methods: ClassMemberMap<SluaType>;
	staticMethods: ClassMemberSet;
	instanceType: SluaType;
	constructorType: SluaType;
};
export type ClassType = { info: ClassInfo; kind: 'constructor' | 'instance' };
export type ClassMember = ClassType & { name: string; type?: SluaType; readonly: boolean };

// Nominal source identity is not established by spelling or structural type
// equality. Aliases keep these weak identities; opaque type clones do not.
export function registerClassMembers(info: ClassInfo, fields: ReadonlyMap<string, SourceMemberOrigin>, methods: ReadonlyMap<string, SourceMemberOrigin>): void {
	registerClassIdentity(info);
	setSourceMemberOrigins(info.constructorType, classOriginView(new Map(), methods, info.staticMethods));
	setSourceMemberOrigins(info.instanceType, classOriginView(fields, methods));
}

export function classMember(type: SluaType, name: string): ClassMember | undefined {
	const owner = classType(type);
	if (!owner) return undefined;
	const field = owner.kind === 'instance' ? owner.info.fields.get(name) : undefined;
	const method = owner.kind === 'constructor' ? owner.info.staticMethods.has(name) ? owner.info.methods.get(name) : undefined
		: owner.info.methods.get(name);
	if (!field && !method && owner.info.hasUnresolvedBase) return { ...owner, name, type: slua.unknown(), readonly: owner.kind === 'constructor' };
	return { ...owner, name, type: field ?? method, readonly: owner.kind === 'constructor' || !owner.info.fields.has(name) };
}

export function classMemberSignature(member: ClassMember, colon: boolean): SluaType {
	const type = member.type ?? slua.unknown();
	return colon && type.kind === 'function' ? slua.fn(type.params.slice(1), type.returns, type.variadic,
		type.arity ? { min: Math.max(0, type.arity.min - 1), max: Math.max(0, type.arity.max - 1) } : undefined) : type;
}

/** Resolve exact local nominal annotations without guessing through aliases,
 * generic instantiation, structural casts or other unresolved type expressions. */
export function classAnnotationType(text: string | undefined, lookup: (name: string) => ClassInfo | undefined, value?: (name: string) => SluaType | undefined): SluaType {
	const query = text && /^\s*typeof\s*\(\s*([A-Za-z_]\w*)\s*\)\s*(\?)?\s*$/.exec(text);
	const queried = query && value?.(query[1]!);
	// Only a proven class value/instance is projected here. General typeof,
	// including signatures shadowed by the function being declared, stays opaque.
	if (queried && classType(queried)) return query[2] ? slua.union([queried, slua.nil()]) : queried;
	const match = text && /^\s*([A-Za-z_]\w*)(\?)?\s*$/.exec(text);
	const type = match && lookup(match[1]!)?.instanceType;
	return type ? match[2] ? slua.union([type, slua.nil()]) : type : sluaTypeFromLuauAnnotationText(text);
}
