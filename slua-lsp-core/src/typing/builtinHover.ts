import { isAstNode, isIdentifier, isMemberExpression, lspRangeFromLoc, posInLoc, visitAst, type LspPosition, type LspRange } from '../parser/ast.js';
import type { SluaFunctionDef, SluaRegistry } from '../slua/registry.js';
import { sluaTypeToString } from '../slua/types.js';
import { getVisibleLocalTypes } from './completion.js';
import { resolveBuiltinExpression } from '../slua/resolveBuiltin.js';

type FunctionInfo = Pick<SluaFunctionDef, 'signature' | 'docs'> & Partial<Pick<SluaFunctionDef, 'params' | 'deprecated' | 'private' | 'meta'>>;
export type BuiltinHover = { range: LspRange; markdown: string };

function functionMarkdown(name: string, definition: FunctionInfo): string {
	const signature = definition.signature;
	let display = `${name}: ${sluaTypeToString(signature)}`;
	if (signature.kind === 'function') {
		const params = signature.params.map((type, i) => `${definition.params?.[i]?.name ?? `arg${i + 1}`}: ${sluaTypeToString(type)}`);
		if (signature.variadic) params.push(`...: ${sluaTypeToString(signature.variadic)}`);
		display = `${name}(${params.join(', ')}): ${sluaTypeToString(signature.returns)}`;
	}
	const lines = ['```luau', display, '```', ''];
	if (definition.deprecated) lines.push('**Deprecated**');
	if (definition.private) lines.push('**Private upstream definition.** Omitted from public API documentation; runtime availability depends on the host.');
	if (definition.meta?.godMode) lines.push('**God mode required**');
	if (definition.meta?.sleepSeconds != null) lines.push(`**Sleep:** ${definition.meta.sleepSeconds}s`);
	if (definition.meta?.monoSleepSeconds != null) lines.push(`**Mono sleep:** ${definition.meta.monoSleepSeconds}s`);
	if (definition.docs) lines.push(definition.docs);
	if (definition.meta?.lslName) lines.push('', `LSL: \`${definition.meta.lslName}\``);
	return lines.join('\n');
}

/** Registered module/object members only; user member inference is separate. */
export function getBuiltinMemberHover(ast: unknown, position: LspPosition, registry: SluaRegistry): BuiltinHover | null {
	let hover: BuiltinHover | null = null;
	const locals = getVisibleLocalTypes(ast, position, registry);
	const names = new WeakSet<object>();
	visitAst(ast, (node) => {
		const record = node as unknown as Record<string, unknown>;
		if (isMemberExpression(node) && isAstNode(node.property)) names.add(node.property);
		if (node.type === 'TableField' && !record.computed && isIdentifier(record.key)) names.add(record.key);
		if (node.type === 'FunctionDeclaration' && isIdentifier(record.identifier)) names.add(record.identifier);
		if (['TypeAlias', 'ClassDeclaration', 'ClassField'].includes(node.type) && isAstNode(record.name)) names.add(record.name);
		for (const key of ['variables', 'parameters']) if (Array.isArray(record[key])) {
			for (const binding of record[key]) if (isAstNode(binding)) names.add(binding);
		}
		const member = isMemberExpression(node) && isIdentifier(node.property) ? node.property : undefined;
		const bare = isIdentifier(node) && !names.has(node) && !locals.has(node.name) && (registry.getGlobal(node.name) || registry.getGlobalValue(node.name)) ? node : undefined;
		const location = member?.location ?? (member ? node.location : bare?.location);
		if (!location || !posInLoc(position, location)) return;
		const resolved = resolveBuiltinExpression(node, registry, (name) => locals.get(name));
		const definition = resolved?.definition;
		if (!definition) return;
		const name = resolved.displayName ?? (member ?? bare)!.name;
		const fn = 'signature' in definition ? definition : undefined;
		if (fn) {
			hover = { range: lspRangeFromLoc(location), markdown: functionMarkdown(name, fn) };
			return;
		}
		const value = 'type' in definition ? definition : undefined;
		if (!value) return;
		const literal = value.value === undefined ? '' : ` = ${typeof value.value === 'string' ? value.value : JSON.stringify(value.value)}`;
		const lines = ['```luau', `${name}: ${sluaTypeToString(value.type)}${literal}`, '```', ''];
		if (value.readonly) lines.push('Read-only value.');
		if (value.deprecated) lines.push('**Deprecated**');
		if (value.private) lines.push('**Private upstream definition.** Omitted from public API documentation; runtime availability depends on the host.');
		if (value.docs) lines.push(value.docs);
		hover = { range: lspRangeFromLoc(location), markdown: lines.join('\n') };
	});
	return hover;
}
