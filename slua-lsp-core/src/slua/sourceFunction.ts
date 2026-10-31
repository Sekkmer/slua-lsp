import type { FunctionAttribute } from '../luau/vendor/types.js';
import type { SluaType } from './types.js';

export type SourceFunctionInfo = { owner: object; attributes: readonly FunctionAttribute[]; deprecated?: { use?: string; reason?: string } };
// Function provenance is analysis metadata, never a serialized field or nominal type.
const functions = new WeakMap<SluaType, SourceFunctionInfo>();
export function functionAttributeInfo(fn: unknown): SourceFunctionInfo | undefined {
	if (!fn || typeof fn !== 'object' || !('attributes' in fn) || !Array.isArray(fn.attributes) || !fn.attributes.length) return undefined;
	const attributes = fn.attributes as FunctionAttribute[];
	const deprecated = attributes.find((attribute) => attribute.name === 'deprecated');
	const result: SourceFunctionInfo = { owner: fn, attributes };
	if (deprecated) {
		result.deprecated = {};
		const record = deprecated.arguments[0];
		if (record && typeof record === 'object') for (const field of record.fields) {
			if ((field.key === 'use' || field.key === 'reason') && typeof field.value === 'string' && !Object.hasOwn(result.deprecated, field.key)) result.deprecated[field.key] = field.value;
		}
	}
	return result;
}
export function withSourceFunctionInfo(type: SluaType, fn: unknown): SluaType {
	const info = functionAttributeInfo(fn); if (info) functions.set(type, info); return type;
}
export function sourceFunctionInfo(type: SluaType | undefined): SourceFunctionInfo | undefined { return type && functions.get(type); }
export function copySourceFunctionInfo(from: SluaType, to: SluaType): SluaType {
	const info = functions.get(from); if (info) functions.set(to, info); return to;
}
/** Only the same source declaration establishes metadata across an equal-shape join. */
export function mergeSourceFunctionInfo(a: SluaType, b: SluaType, to: SluaType): void {
	const left = functions.get(a), right = functions.get(b);
	if (left && right && left.owner === right.owner) functions.set(to, left);
}
/** Native named table properties retain their deprecated function contract on writes. */
export function preserveDeprecatedFunction(previous: SluaType | undefined, next: SluaType): SluaType {
	const info = previous && functions.get(previous);
	if (next.kind !== 'function' || !info?.deprecated) return next;
	const result = { ...next }; functions.set(result, info); return result;
}
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&'); }
export function sourceFunctionMarkdown(type: SluaType | undefined): string {
	const info = sourceFunctionInfo(type); if (!info) return '';
	const lines: string[] = [];
	if (info.deprecated) {
		lines.push('**Deprecated**');
		if (info.deprecated.use !== undefined) lines.push('Use '+escapeMarkdown(info.deprecated.use)+' instead.');
		if (info.deprecated.reason !== undefined) lines.push(escapeMarkdown(info.deprecated.reason));
	}
	const other = info.attributes.filter((attribute) => attribute.name !== 'deprecated').map((attribute) => '@'+attribute.name);
	if (other.length) lines.push('Attributes: '+other.map((name) => '`'+name+'`').join(', ')+'. These do not establish native execution or runtime argument guards.');
	return lines.length ? '\n\n'+lines.join('\n\n') : '';
}
