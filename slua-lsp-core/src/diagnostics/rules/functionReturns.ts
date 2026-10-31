import { analyzeFunctionReturns, type ClassInfo } from '../../typing/inferLocals.js';
import { classAnnotationType } from '../../typing/classMembers.js';
import { classType } from '../../slua/classIdentity.js';
import { slua, sluaTypeIsAssignable, sluaTypeToString, type SluaType } from '../../slua/types.js';
import type { SluaRegistry } from '../../slua/registry.js';
import type { CoreDiagnostic, Range } from '../types.js';

type FunctionNode = { type: string; returnTypeAnnotation?: string; location?: { start: { line: number; column: number }; end: { line: number; column: number } } };
function range(node: FunctionNode): Range {
	return node.location ? { start: { line: node.location.start.line - 1, character: node.location.start.column - 1 },
		end: { line: node.location.end.line - 1, character: node.location.end.column - 1 } } : { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}
function known(type: SluaType): boolean {
	const opaque = (slot: SluaType) => slot.kind === 'primitive' && slot.name === 'unknown';
	// Raw function annotations can contain opaque named/generic positions. Do
	// not turn better nominal inference into a false full-variance diagnostic.
	if (type.kind === 'function' && !classType(type)) return !type.params.some(opaque) && !opaque(type.returns);
	return !opaque(type);
}

/** Return sites use the same parameter scopes, guards and inferred callees as
 * function-value inference. Explicit and inferred contracts retain distinct codes.
 */
export function diagnoseFunctionReturns(fn: FunctionNode, registry: SluaRegistry, locals: ReadonlyMap<string, SluaType>, context: SluaType[] = [], classes: Iterable<ClassInfo> = []): CoreDiagnostic[] {
	const knownClasses = [...classes];
	const report = analyzeFunctionReturns(fn, registry, locals, context, knownClasses);
	if (!report) return [];
	const declared = fn.returnTypeAnnotation ? classAnnotationType(fn.returnTypeAnnotation, (name) => knownClasses.find((info) => info.name === name), (name) => locals.get(name)) : undefined;
	let expected = declared ? (declared.kind === 'tuple' ? declared.items : [declared]) : undefined;
	const prefix = declared ? 'declared' : 'inferred';
	const result: CoreDiagnostic[] = [];
	for (const site of report.sites) {
		if (!expected) { if (!site.open) expected = site.values; continue; }
		if (!site.open && site.values.length !== expected.length) result.push({ code: `${prefix}-return-count-mismatch`, severity: 'warning',
			message: `Function ${declared ? 'declares' : 'previously inferred'} ${expected.length} return value(s) but returns ${site.values.length} here.`, range: range(site.node) });
		for (let i = 0; i < Math.min(expected.length, site.values.length); i++) {
			const actual = site.values[i]!;
			if (known(expected[i]!) && known(actual) && !sluaTypeIsAssignable(expected[i]!, actual)) result.push({ code: `${prefix}-return-type-mismatch`, severity: 'warning',
				message: `Return #${i + 1} expects '${sluaTypeToString(expected[i]!)}' but got '${sluaTypeToString(actual)}'.${declared ? '' : ' Add an explicit union return annotation when alternatives are intentional.'}`, range: range(site.node) });
		}
	}
	if (report.fallsThrough && report.sites.some((site) => site.values.length > 0)) result.push({ code: 'missing-return', severity: 'warning',
		message: 'Not all paths in this function return a value.', range: range(fn) });
	if (declared && report.sites.length === 0 && report.fallsThrough) {
		const slots = declared.kind === 'tuple' ? declared.items : [declared];
		if (slots.length !== 1) result.push({ code: 'declared-return-count-mismatch', severity: 'warning', message: `Function declares ${slots.length} return value(s) but falls through with no value.`, range: range(fn) });
		if (slots[0] && known(slots[0]) && !sluaTypeIsAssignable(slots[0], slua.nil())) result.push({ code: 'declared-return-type-mismatch', severity: 'warning',
			message: `Function declares '${sluaTypeToString(slots[0])}' but falls through with no value.`, range: range(fn) });
	}
	return result;
}
