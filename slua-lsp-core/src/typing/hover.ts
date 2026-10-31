import { typeProgram } from '../parser/typeRegions.js';
import { sourceFunctionMarkdown } from '../slua/sourceFunction.js';
import { FUNCTION_ATTRIBUTE_DOCS } from '../parser/functionAttributePresentation.js';
import type { SluaType } from '../slua/types.js';
import { collectNavigationBindings } from './navigationBindings.js';
import { isMemberExpression, isIdentifier, posInLoc, visitAst, lspRangeFromLoc, type LspPosition } from '../parser/ast.js';
import { resolveBuiltinExpression } from '../slua/resolveBuiltin.js';
import type { SluaRegistry } from '../slua/registry.js';
import { sluaTypeToString } from '../slua/types.js';
import { getBuiltinMemberHover, type BuiltinHover } from './builtinHover.js';
import { getVisibleLocalTypes } from './completion.js';
import { inferLocalVariableTypes } from './inferLocals.js';
import { lexicalOccurrenceAt } from './lexicalBindings.js';

export type SourceHover = BuiltinHover & { kind: 'builtin' | 'local' | 'parameter' | 'function' | 'class' | 'field' | 'attribute'; readonly?: true };

/** AST-selected source hover; text inside comments/strings cannot masquerade as a value use. */
export function getHover(ast: unknown, position: LspPosition, registry: SluaRegistry): SourceHover | null {
	let attribute: SourceHover | null = null;
	// Parsed source knows whether an attribute scan can find anything. Unknown
	// caller-owned ASTs retain the full walk; imported metadata resolves below.
	if (!ast || typeof ast !== 'object' || typeProgram(ast)?.hasFunctionAttributes !== false) visitAst(ast, (node) => {
		if (node.type !== 'FunctionAttribute' || !node.location) return;
		const name = (node as unknown as { name: keyof typeof FUNCTION_ATTRIBUTE_DOCS }).name;
		if (!Object.hasOwn(FUNCTION_ATTRIBUTE_DOCS, name)) return;
		const start = node.location.start, location = { start, end: { line: start.line, column: start.column + name.length } };
		if (posInLoc(position, location)) attribute = { kind: 'attribute', range: lspRangeFromLoc(location), markdown: FUNCTION_ATTRIBUTE_DOCS[name] };
	});
	if (attribute) return attribute;
	const builtin = getBuiltinMemberHover(ast, position, registry);
	if (builtin) return { ...builtin, kind: 'builtin' };
	let member: SourceHover | null = null;
	const locals = getVisibleLocalTypes(ast, position, registry);
	visitAst(ast, (node) => {
		if (!isMemberExpression(node) || !isIdentifier(node.property) || !node.property.location || !posInLoc(position, node.property.location)) return;
		const resolved = resolveBuiltinExpression(node, registry, (name) => locals.get(name));
		if (resolved && !resolved.definition) member = { kind: 'field', range: lspRangeFromLoc(node.property.location),
			markdown: ['```luau', `${resolved.displayName ?? node.property.name}: ${sluaTypeToString(resolved.type)}`, '```'].join('\n') + sourceFunctionMarkdown(resolved.type) };
	});
	if (member) return member;
	const occurrence = lexicalOccurrenceAt(collectNavigationBindings(ast).occurrences, position);
	const definition = occurrence?.definition;
	if (!occurrence?.identifier.location) return null;
	if (!definition) {
		// The cursor environment also records explicit non-local function statements.
		// This is read-only type display, not a claim of safe global rename/reference indexing.
		const type = getVisibleLocalTypes(ast, position, registry).get(occurrence.identifier.name);
		return type?.kind === 'function' ? { kind: 'function', range: lspRangeFromLoc(occurrence.identifier.location),
			markdown: ['```luau', `${occurrence.identifier.name}: ${sluaTypeToString(type)}`, '```', '', '(function)'].join('\n') + sourceFunctionMarkdown(type) } : null;
	}
	const declaration = definition.identifier;
	let typeText: string;
	let sourceType: SluaType | undefined;
	if (definition.kind === 'class') typeText = definition.name;
	else if (occurrence.kind === 'definition' && definition.kind !== 'parameter') {
		const inferred = declaration.typeAnnotation ? undefined : inferLocalVariableTypes(ast, registry).find((item) => item.identifier === declaration)?.type;
		sourceType = inferred;
		typeText = declaration.typeAnnotation ?? (inferred ? sluaTypeToString(inferred) : 'unknown');
	} else {
		const type = getVisibleLocalTypes(ast, position, registry).get(definition.name);
		sourceType = type;
		typeText = type ? sluaTypeToString(type) : declaration.typeAnnotation ?? 'unknown';
	}
	return { kind: definition.kind, ...(definition.isConst ? { readonly: true as const } : {}), range: lspRangeFromLoc(occurrence.identifier.location),
		markdown: ['```luau', `${definition.isConst ? 'const ' : ''}${definition.name}: ${typeText}`, '```', '', `(${definition.kind})`].join('\n') + sourceFunctionMarkdown(sourceType) };
}
