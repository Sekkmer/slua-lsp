import type { CoreDiagnostic, Position, Range } from '../diagnostics/types.js';
import { parseDirectives } from '../diagnostics/directives.js';
import { isCallExpression, isMemberExpression, rangeFromNode, visitAst } from '../parser/ast.js';
import { scanSourceComments } from '../parser/sourceComments.js';
import { Lexer, TokenType, type Token } from '../luau/vendor.js';
import { SourceTextIndex } from '../parser/sourceTextIndex.js';

export type CoreTextEdit = { range: Range; newText: string };
export type CoreCodeAction = {
	title: string;
	kind: 'quickfix';
	isPreferred: boolean;
	diagnostics: CoreDiagnostic[];
	edits: CoreTextEdit[];
};

const compare = (a: Position, b: Position): number => a.line - b.line || a.character - b.character;
const sameRange = (a: Range, b: Range): boolean => compare(a.start, b.start) === 0 && compare(a.end, b.end) === 0;

/** Diagnostic inputs must describe this exact source snapshot. Server and CLI
 * supply their own current analysis, never edits based on client-supplied text.
 * Positions and edit text are independent of VS Code or protocol types.
 */
export function getCodeActions(text: string, ast: unknown, diagnostics: readonly CoreDiagnostic[], requestedRange?: Range): CoreCodeAction[] {
	const actions: CoreCodeAction[] = [];
	const index = new SourceTextIndex(text), starts = index.starts;
	const offset = (position: Position) => index.offsetAt(position);
	const position = (at: number) => index.positionAt(at);
	const selected = diagnostics.filter((d) => !requestedRange ||
		(compare(d.range.start, requestedRange.end) <= 0 && compare(requestedRange.start, d.range.end) <= 0));
	if (!selected.length) return actions;
	const scan = scanSourceComments(text);
	const directives = parseDirectives(text);
	let tokens: Token[] = [];
	if (selected.some((d) => d.code === 'use-colon-call' || d.code === 'use-dot-call')) {
		try { tokens = new Lexer(text).tokenize(text); } catch { /* Keep suppression available on incomplete source. */ }
	}
	const members: Array<{ range: Range; objectEnd: number; separator: '.' | ':' }> = [];
	visitAst(ast, (node) => {
		if (!isCallExpression(node) || !isMemberExpression(node.callee)) return;
		const member = node.callee;
		const object = member.object as { location?: { end: { line: number; column: number } } } | undefined;
		if (!object?.location || !member.property || typeof member.property !== 'object' || !('type' in member.property)) return;
		const propertyRange = rangeFromNode(member.property as Parameters<typeof rangeFromNode>[0]);
		const end = object.location.end;
		const objectEnd = offset({ line: end.line - 1, character: end.column - 1 });
		if (objectEnd !== undefined) members.push({ range: propertyRange, objectEnd, separator: member.indexer ?? '.' });
	});
	const seen = new Set<string>();
	function add(action: CoreCodeAction): void {
		const key = JSON.stringify([action.title, action.edits]);
		if (!seen.has(key)) { seen.add(key); actions.push(action); }
	}
	for (const diagnostic of selected) {
		if (diagnostic.code === 'use-colon-call' || diagnostic.code === 'use-dot-call') {
			const before = diagnostic.code === 'use-colon-call' ? '.' : ':';
			const after = before === '.' ? ':' : '.';
			const member = members.find((m) => sameRange(m.range, diagnostic.range) && m.separator === before);
			const propertyStart = offset(diagnostic.range.start);
			if (member && propertyStart !== undefined) {
				const separators = tokens.filter((t) => t.type === (before === '.' ? TokenType.DOT : TokenType.COLON) && t.start >= member.objectEnd && t.end <= propertyStart);
				if (separators.length === 1) {
					const token = separators[0]!;
					if (text.slice(token.start, token.end) === before) add({ title: `Use '${after}' for this call`, kind: 'quickfix', isPreferred: true,
						diagnostics: [diagnostic], edits: [{ range: { start: position(token.start), end: position(token.end) }, newText: after }] });
				}
			}
		}
		const line = diagnostic.range.start.line;
		if (diagnostic.code === 'parse-error' || !/^[a-z][a-z0-9-]*$/i.test(diagnostic.code) || !scan.commentSafeLines.has(line) || starts[line] === undefined) continue;
		const previous = directives.find((d) => d.kind === 'disable-next-line' && d.line === line - 1);
		let edit: CoreTextEdit;
		if (previous) {
			if (previous.codes === 'all' || previous.codes.some((c) => c.toLowerCase() === diagnostic.code.toLowerCase())) continue;
			const comment = scan.comments.find((c) => c.line === line - 1 && c.kind === 'line');
			if (!comment) continue;
			const end = text[comment.end - 1] === '\r' ? comment.end - 1 : comment.end;
			edit = { range: { start: position(end), end: position(end) }, newText: `, ${diagnostic.code}` };
		} else {
			const start = starts[line]!;
			const end = starts[line + 1] ?? text.length;
			const indent = /^[\t ]*/.exec(text.slice(start, end))![0];
			const newline = index.eol(line) || /\r\n|\r|\n/.exec(text)?.[0] || '\n';
			edit = { range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: `${indent}-- slua-lsp:disable-next-line ${diagnostic.code}${newline}` };
		}
		add({ title: `Suppress '${diagnostic.code}' on this line`, kind: 'quickfix', isPreferred: false, diagnostics: [diagnostic], edits: [edit] });
	}
	return actions;
}
