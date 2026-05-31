import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
	type InitializeParams,
	type InitializeResult,
	type SemanticTokensLegend,
	type SemanticTokens,
	type Hover,
	type SignatureHelp,
	type SignatureInformation,
	type ParameterInformation,
	type DocumentSymbol,
	SymbolKind,
	type FoldingRange,
	type SelectionRange,
	type InlayHint,
	InlayHintKind,
	CompletionItemKind as LspCompletionItemKind
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import {
	classifySemanticTokens,
	loadLslDefinitionsFromYamlFile,
	parseSlua,
	SLUA_SEMANTIC_TOKEN_MODIFIERS,
	SLUA_SEMANTIC_TOKEN_TYPES,
	buildSluaRegistryFromLslDefinitions,
	sluaTypeToString,
	inferLocalVariableTypes,
	findDefinitionAtPosition,
	findAllReferences,
	prepareRename,
	getRenameEdits,
	isValidRenameIdentifier,
	getCompletions,
	getSignatureHelp,
	type SluaType,
	type SluaEventSignature,
	type CompletionItemKind
} from 'slua-lsp-core';

import { SERVER_NAME } from './constants.js';
import { computeDiagnosticsForText } from './diagnostics.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let defsLoaded = false;
let semanticLegend: SemanticTokensLegend | null = null;
let defs: unknown | null = null;
let registry: ReturnType<typeof buildSluaRegistryFromLslDefinitions> | null = null;

connection.onInitialize(async (_params: InitializeParams): Promise<InitializeResult> => {
	// Load the YAML once at startup as a smoke-check that the repo vendoring works.
	// Actual indexing/typechecking will live in slua-lsp-core.
	try {
		defs = await loadLslDefinitionsFromYamlFile();
		registry = buildSluaRegistryFromLslDefinitions(defs);
		defsLoaded = true;
	} catch (err) {
		defsLoaded = false;
		defs = null;
		registry = null;
		connection.console.error(`Failed to load LSL definitions YAML: ${String(err)}`);
	}

	return {
		serverInfo: { name: SERVER_NAME, version: '0.0.0' },
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: ['.', ':', '|', '&', '?', '(', ',', ')', '{', '"', '\'']
			},
			signatureHelpProvider: {
				triggerCharacters: ['(', ',']
			},
			foldingRangeProvider: true,
			selectionRangeProvider: true,
			documentSymbolProvider: true,
			hoverProvider: true,
			declarationProvider: true,
			typeDefinitionProvider: true,
			implementationProvider: true,
			definitionProvider: true,
			referencesProvider: true,
			semanticTokensProvider: {
				legend: {
					tokenTypes: [...SLUA_SEMANTIC_TOKEN_TYPES],
					tokenModifiers: [...SLUA_SEMANTIC_TOKEN_MODIFIERS]
				},
				full: true
			},
			inlayHintProvider: { resolveProvider: false },
			renameProvider: { prepareProvider: true }
		}
	};
});

function locationFromCoreDefinition(uri: string, definition: ReturnType<typeof findDefinitionAtPosition>) {
	if (!definition) return null;
	const loc = definition.identifier.location;
	if (!loc) return null;
	return {
		uri,
		range: {
			start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
			end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
		}
	};
}

function collectFoldingRangesFromAst(ast: unknown): FoldingRange[] {
	const ranges: FoldingRange[] = [];

	function addRange(loc: NonNullable<AstNode['location']>): void {
		const startLine = Math.max(0, loc.start.line - 1);
		const endLine = Math.max(0, loc.end.line - 1);
		if (endLine <= startLine) return;
		// Avoid extremely tiny folds that feel noisy.
		if (endLine - startLine < 1) return;
		ranges.push({ startLine, endLine });
	}

	function visit(value: unknown): void {
		if (!isRecord(value)) return;
		const node = value as AstNode;
		if (node.location) {
			// Fold a conservative subset of block-ish nodes.
			switch (node.type) {
				case 'FunctionDeclaration':
				case 'Function':
				case 'IfStatement':
				case 'WhileStatement':
				case 'RepeatStatement':
				case 'ForNumericStatement':
				case 'ForGenericStatement':
				case 'DoStatement':
					addRange(node.location);
					break;
				default:
					break;
			}
		}

		for (const child of Object.values(value)) {
			if (Array.isArray(child)) for (const item of child) visit(item);
			else if (isRecord(child)) visit(child);
		}
	}

	visit(ast);
	return ranges;
}

function selectionRangeForPosition(ast: unknown, pos: { line: number; character: number }): SelectionRange | null {
	type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };
	let bestPath: Loc[] = [];
	let hasBest = false;

	function lspRangeFromSelectionLoc(loc: Loc) {
		return {
			start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
			end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
		};
	}

	function locSpan(loc: Loc): number {
		return (loc.end.line - loc.start.line) * 10_000 + (loc.end.column - loc.start.column);
	}

	function visit(value: unknown, path: Loc[]): void {
		if (!isRecord(value)) return;
		const node = value as AstNode;
		if (!node.location) return;
		const loc = node.location as Loc;
		if (!posInLoc(pos, loc as NonNullable<AstNode['location']>)) return;

		const nextPath = [...path, loc];
		// Prefer the deepest path; tie-break by smallest innermost span.
		if (!hasBest) {
			bestPath = nextPath;
			hasBest = true;
		} else if (nextPath.length > bestPath.length) bestPath = nextPath;
		else if (nextPath.length === bestPath.length) {
			const curLeaf = bestPath[bestPath.length - 1]!;
			const nextLeaf = nextPath[nextPath.length - 1]!;
			if (locSpan(nextLeaf) < locSpan(curLeaf)) bestPath = nextPath;
		}

		for (const child of Object.values(value)) {
			if (Array.isArray(child)) for (const item of child) visit(item, nextPath);
			else if (isRecord(child)) visit(child, nextPath);
		}
	}

	visit(ast, []);
	if (!hasBest || bestPath.length === 0) return null;
	const path = bestPath;

	let out: SelectionRange | null = null;
	for (let i = path.length - 1; i >= 0; i--) {
		const range = lspRangeFromSelectionLoc(path[i]!);
		out = out ? { range, parent: out } : { range };
	}
	return out;
}

connection.onSignatureHelp((params): SignatureHelp | null => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return null;
	if (!registry) return null;

	const text = doc.getText();
	const parsed = parseSlua(text);
	const help = getSignatureHelp(parsed.ast, params.position, registry, text);
	if (!help || help.signatures.length === 0) return null;

	const signatures: SignatureInformation[] = help.signatures.map((s) => {
		const parameters: ParameterInformation[] = s.parameters.map((p) => ({
			label: p.label,
			documentation: p.documentation
		}));
		return {
			label: s.label,
			documentation: s.documentation,
			parameters
		};
	});

	return {
		signatures,
		activeSignature: help.activeSignature,
		activeParameter: help.activeParameter
	};
});

type AstNode = { type: string; location?: { start: { line: number; column: number }; end: { line: number; column: number } } };
type IdentifierNode = AstNode & { type: 'Identifier'; name: string; typeAnnotation?: string };
type MemberExpressionNode = AstNode & {
	type: 'MemberExpression';
	object: unknown;
	property: unknown;
	/** Luau parser uses '.' or ':' */
	indexer?: '.' | ':';
	/** Legacy/older shape (kept for safety) */
	colonCall?: boolean;
};
type CallExpressionNode = AstNode & { type: 'CallExpression'; callee: unknown; arguments: unknown[] };
type StringNode = AstNode & { type: 'String'; value: string };
type FunctionNode = AstNode & { type: 'Function'; parameters: unknown[] };
type FunctionDeclarationNode = AstNode & { type: 'FunctionDeclaration'; identifier?: unknown; isLocal?: boolean; body?: unknown[] };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

function posToOffset(sourceText: string, pos: { line: number; character: number }): number {
	let offset = 0;
	let line = 0;
	for (let i = 0; i < sourceText.length && line < pos.line; i++) {
		const ch = sourceText[i]!;
		offset++;
		if (ch === '\n') line++;
	}
	return Math.min(sourceText.length, offset + pos.character);
}

function offsetToPos(sourceText: string, offset: number): { line: number; character: number } {
	const clamped = Math.max(0, Math.min(sourceText.length, offset));
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < clamped; i++) {
		if (sourceText[i] === '\n') {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, character: clamped - lineStart };
}

function identifierAtPositionInText(
	sourceText: string,
	pos: { line: number; character: number }
): { name: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } | null {
	const offset = posToOffset(sourceText, pos);
	if (offset < 0 || offset > sourceText.length) return null;

	let start = offset;
	let end = offset;
	while (start > 0 && IDENT_PART.test(sourceText[start - 1] ?? '')) start--;
	while (end < sourceText.length && IDENT_PART.test(sourceText[end] ?? '')) end++;

	const name = sourceText.slice(start, end);
	if (!name || !IDENT_START.test(name[0] ?? '')) return null;

	return {
		name,
		range: {
			start: offsetToPos(sourceText, start),
			end: offsetToPos(sourceText, end)
		}
	};
}

function findPrevUnescapedChar(sourceText: string, fromExclusive: number, ch: string): number {
	for (let i = Math.min(fromExclusive - 1, sourceText.length - 1); i >= 0; i--) {
		if (sourceText[i] !== ch) continue;
		if (i > 0 && sourceText[i - 1] === '\\') continue;
		return i;
	}
	return -1;
}

function findNextUnescapedChar(sourceText: string, fromInclusive: number, ch: string): number {
	for (let i = Math.max(0, fromInclusive); i < sourceText.length; i++) {
		if (sourceText[i] !== ch) continue;
		if (i > 0 && sourceText[i - 1] === '\\') continue;
		return i;
	}
	return -1;
}

function isInTemplateInterpolation(sourceText: string, pos: { line: number; character: number }): boolean {
	const cursor = posToOffset(sourceText, pos);
	const tickStart = findPrevUnescapedChar(sourceText, cursor, '`');
	if (tickStart < 0) return false;
	const tickEnd = findNextUnescapedChar(sourceText, tickStart + 1, '`');
	if (tickEnd < 0) return false;
	if (cursor <= tickStart || cursor >= tickEnd) return false;

	let depth = 0;
	for (let i = tickStart + 1; i < cursor; i++) {
		const c = sourceText[i]!;
		if (c === '{' && sourceText[i - 1] !== '\\') depth++;
		else if (c === '}' && sourceText[i - 1] !== '\\') depth = Math.max(0, depth - 1);
	}
	return depth > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is IdentifierNode {
	return isRecord(value) && value.type === 'Identifier' && typeof value.name === 'string';
}

function isMemberExpression(value: unknown): value is MemberExpressionNode {
	return isRecord(value) && value.type === 'MemberExpression';
}

function isCallExpression(value: unknown): value is CallExpressionNode {
	return isRecord(value) && value.type === 'CallExpression' && Array.isArray(value.arguments);
}

function isStringNode(value: unknown): value is StringNode {
	return isRecord(value) && value.type === 'String' && typeof value.value === 'string';
}

function isFunctionNode(value: unknown): value is FunctionNode {
	return isRecord(value) && value.type === 'Function' && Array.isArray(value.parameters);
}

function isFunctionDeclarationNode(value: unknown): value is FunctionDeclarationNode {
	return isRecord(value) && value.type === 'FunctionDeclaration';
}

function posInLoc(pos: { line: number; character: number }, loc: NonNullable<AstNode['location']>): boolean {
	const line = pos.line + 1;
	const col = pos.character + 1;
	const afterStart = line > loc.start.line || (line === loc.start.line && col >= loc.start.column);
	const beforeEnd = line < loc.end.line || (line === loc.end.line && col <= loc.end.column);
	return afterStart && beforeEnd;
}

function lspRangeFromLoc(loc: NonNullable<AstNode['location']>) {
	return {
		start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
		end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
	};
}

function getFunctionNameFromIdentifier(id: unknown): { name: string; selectionLoc?: NonNullable<AstNode['location']> } | null {
	if (!isRecord(id)) return null;
	if (isIdentifier(id)) return { name: id.name, selectionLoc: id.location };
	if (isMemberExpression(id)) {
		const obj = id.object;
		const prop = id.property;
		if (!isIdentifier(obj) || !isIdentifier(prop)) return null;
		const indexer = id.indexer ?? (id.colonCall ? ':' : '.');
		return { name: `${obj.name}${indexer}${prop.name}`, selectionLoc: prop.location ?? id.location };
	}
	return null;
}

function collectDocumentSymbolsFromAst(ast: unknown): DocumentSymbol[] {
	if (!isRecord(ast) || ast.type !== 'Program' || !Array.isArray((ast as Record<string, unknown>).body)) return [];
	const program = ast as { body: unknown[] };

	function visitStatements(stmts: unknown[]): DocumentSymbol[] {
		const out: DocumentSymbol[] = [];
		for (const stmt of stmts) {
			if (!isRecord(stmt)) continue;
			if (!isFunctionDeclarationNode(stmt) || !stmt.location) {
				// Recurse into nested blocks defensively.
				for (const child of Object.values(stmt)) {
					if (Array.isArray(child)) out.push(...visitStatements(child));
				}
				continue;
			}

			const idInfo = getFunctionNameFromIdentifier(stmt.identifier);
			const name = idInfo?.name ?? '<anonymous>';
			const range = lspRangeFromLoc(stmt.location);
			const selectionRange = idInfo?.selectionLoc ? lspRangeFromLoc(idInfo.selectionLoc) : range;

			const children = Array.isArray(stmt.body) ? visitStatements(stmt.body) : [];
			out.push({
				name,
				kind: SymbolKind.Function,
				range,
				selectionRange,
				children: children.length ? children : undefined
			});
		}
		return out;
	}

	return visitStatements(program.body);
}

connection.onDocumentSymbol((params): DocumentSymbol[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	const text = doc.getText();
	const parsed = parseSlua(text);
	return collectDocumentSymbolsFromAst(parsed.ast);
});

connection.onFoldingRanges((params): FoldingRange[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	const text = doc.getText();
	const parsed = parseSlua(text);
	return collectFoldingRangesFromAst(parsed.ast);
});

connection.onSelectionRanges((params): SelectionRange[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return params.positions.map((p) => ({ range: { start: p, end: p } }));
	const text = doc.getText();
	const parsed = parseSlua(text);
	return params.positions.map((p) => selectionRangeForPosition(parsed.ast, p) ?? { range: { start: p, end: p } });
});

function valueToDisplayString(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (value === null) return 'nil';
	return JSON.stringify(value);
}

function formatModuleFunctionSignature(
	receiver: string,
	fn: { name: string; signature: SluaType; params?: Array<{ name: string; type: SluaType }> }
): string {
	const sig = fn.signature;
	const paramTypes: SluaType[] = sig.kind === 'function' ? sig.params : [];

	const paramsText = fn.params
		? fn.params.map((p) => `${p.name}: ${sluaTypeToString(p.type)}`).join(', ')
		: paramTypes.map((t, i) => `arg${i + 1}: ${sluaTypeToString(t)}`).join(', ');

	const retType = sig.kind === 'function' ? sluaTypeToString(sig.returns) : 'unknown';
	return `${receiver}.${fn.name}(${paramsText}): ${retType}`;
}

function findLlMemberAtPosition(ast: unknown, pos: { line: number; character: number }): { receiver: string; name: string; loc: NonNullable<AstNode['location']> } | null {
	let best: { receiver: string; name: string; loc: NonNullable<AstNode['location']> } | null = null;

	function visit(value: unknown): void {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isRecord(value)) return;

		const node = value as AstNode;
		if (isMemberExpression(node) && node.location && isIdentifier(node.object) && isIdentifier(node.property)) {
			const receiver = node.object.name;
			if ((receiver === 'll' || receiver === 'llcompat') && posInLoc(pos, node.property.location ?? node.location)) {
				const propLoc = node.property.location ?? node.location;
				if (!best) {
					best = { receiver, name: node.property.name, loc: propLoc };
				} else {
					// Prefer the smallest range (most specific).
					const cur = best.loc;
					const curSpan = (cur.end.line - cur.start.line) * 10_000 + (cur.end.column - cur.start.column);
					const nextSpan = (propLoc.end.line - propLoc.start.line) * 10_000 + (propLoc.end.column - propLoc.start.column);
					if (nextSpan <= curSpan) best = { receiver, name: node.property.name, loc: propLoc };
				}
			}
		}

		for (const child of Object.values(value)) visit(child);
	}

	visit(ast);
	return best;
}

function collectEventCallbackTypeInlayHints(
	ast: unknown,
	posRange: { start: { line: number; character: number }; end: { line: number; character: number } },
	sigs: Record<string, SluaEventSignature>
): InlayHint[] {
	const hints: InlayHint[] = [];

	function addHint(param: IdentifierNode, typeText: string): void {
		if (!param.location) return;
		const p = { line: Math.max(0, param.location.end.line - 1), character: Math.max(0, param.location.end.column - 1) };
		// Filter to requested range.
		const afterStart = p.line > posRange.start.line || (p.line === posRange.start.line && p.character >= posRange.start.character);
		const beforeEnd = p.line < posRange.end.line || (p.line === posRange.end.line && p.character <= posRange.end.character);
		if (!afterStart || !beforeEnd) return;

		hints.push({
			position: p,
			label: `: ${typeText}`,
			kind: InlayHintKind.Type
		});
	}

	function visit(value: unknown): void {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isRecord(value)) return;

		const node = value as AstNode;
		if (isCallExpression(node) && isMemberExpression(node.callee)) {
			const callee = node.callee;
			if (isIdentifier(callee.object) && callee.object.name === 'LLEvents' && isIdentifier(callee.property)) {
				const method = callee.property.name;
				if (method === 'on' || method === 'once' || method === 'off') {
					const args = node.arguments;
					const first = args[0];
					const second = args[1];
					if (isStringNode(first) && isFunctionNode(second)) {
						const sig = sigs[first.value];
						if (sig) {
							for (let i = 0; i < sig.params.length; i++) {
								const expected = sig.params[i];
								const actualParam = second.parameters[i];
								if (!isIdentifier(actualParam)) continue;
								if (actualParam.typeAnnotation) continue;
								addHint(actualParam, sluaTypeToString(expected.type));
							}
						}
					}
				}
			}
		}

		for (const child of Object.values(value)) visit(child);
	}

	visit(ast);
	return hints;
}

function collectLocalVariableTypeInlayHints(
	ast: unknown,
	posRange: { start: { line: number; character: number }; end: { line: number; character: number } },
	reg: NonNullable<typeof registry>
): InlayHint[] {
	const hints: InlayHint[] = [];
	const inferred = inferLocalVariableTypes(ast, reg);

	for (const item of inferred) {
		const loc = item.identifier.location;
		if (!loc) continue;
		const p = { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) };
		const afterStart = p.line > posRange.start.line || (p.line === posRange.start.line && p.character >= posRange.start.character);
		const beforeEnd = p.line < posRange.end.line || (p.line === posRange.end.line && p.character <= posRange.end.character);
		if (!afterStart || !beforeEnd) continue;
		const typeText = sluaTypeToString(item.type);
		// Skip noisy / non-actionable inlays.
		if (typeText === 'unknown' || typeText === 'nil') continue;

		hints.push({
			position: p,
			label: `: ${typeText}`,
			kind: InlayHintKind.Type
		});
	}

	return hints;
}

connection.onInitialized(() => {
	semanticLegend = {
		tokenTypes: [...SLUA_SEMANTIC_TOKEN_TYPES],
		tokenModifiers: [...SLUA_SEMANTIC_TOKEN_MODIFIERS]
	};
});

function encodeSemanticTokens(tokens: ReturnType<typeof classifySemanticTokens>): number[] {
	// LSP semantic tokens are encoded as:
	// [deltaLine, deltaStartChar, length, tokenTypeIndex, tokenModifiersBitset, ...]
	let lastLine = 0;
	let lastChar = 0;
	const data: number[] = [];

	const typeIndex = new Map<string, number>(SLUA_SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i]));
	const modIndex = new Map<string, number>(SLUA_SEMANTIC_TOKEN_MODIFIERS.map((m, i) => [m, i]));

	for (const tok of tokens) {
		const line = tok.line;
		const char = tok.character;
		const deltaLine = line - lastLine;
		const deltaChar = deltaLine === 0 ? char - lastChar : char;
		lastLine = line;
		lastChar = char;

		const tt = typeIndex.get(tok.tokenType) ?? 0;
		let mods = 0;
		for (const m of tok.modifiers) {
			const bit = modIndex.get(m);
			if (bit !== undefined) mods |= 1 << bit;
		}

		data.push(deltaLine, deltaChar, tok.length, tt, mods);
	}

	return data;
}

connection.languages.semanticTokens.on((params): SemanticTokens => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc || !semanticLegend) return { data: [] };

	// Best-effort parse; classification works even without AST, but AST helps.
	const parsed = parseSlua(doc.getText());
	const tokens = classifySemanticTokens(doc.getText(), {
		ast: parsed.ast ?? undefined
	});
	return { data: encodeSemanticTokens(tokens) };
});

async function validateTextDocument(uri: string): Promise<void> {
	const doc = documents.get(uri);
	const text = doc?.getText() ?? '';

	const diagnostics = computeDiagnosticsForText(text, {
		registry,
		defsLoaded,
		serverName: SERVER_NAME
	});

	connection.sendDiagnostics({ uri, diagnostics });
}

documents.onDidOpen((e) => {
	void validateTextDocument(e.document.uri);
});

documents.onDidChangeContent((change) => {
	void validateTextDocument(change.document.uri);
});
documents.onDidClose((e) => {
	connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onHover((params): Hover | null => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return null;
	if (!registry) return null;

	const text = doc.getText();
	const parsed = parseSlua(text);
	const ast = parsed.ast;
	if (!ast) return null;

	const found = findLlMemberAtPosition(ast, params.position);
	if (found) {
		const mod = registry.getModule(found.receiver);
		if (!mod) return null;

		const fn = mod.functions[found.name];
		if (fn) {
			const lines: string[] = [];
			lines.push('```luau');
			lines.push(formatModuleFunctionSignature(found.receiver, fn));
			lines.push('```');
			lines.push('');
			if (fn.deprecated) lines.push('**Deprecated**');
			if (fn.meta?.godMode) lines.push('**God mode required**');
			if (fn.meta?.sleepSeconds !== undefined && fn.meta.sleepSeconds !== null)
				lines.push(`**Sleep:** ${fn.meta.sleepSeconds}s`);
			if (fn.meta?.monoSleepSeconds !== undefined && fn.meta.monoSleepSeconds !== null)
				lines.push(`**Mono sleep:** ${fn.meta.monoSleepSeconds}s`);
			if (fn.docs) lines.push(fn.docs);
			lines.push('');
			if (fn.meta?.lslName) lines.push(`LSL: \`${fn.meta.lslName}\``);

			return {
				range: lspRangeFromLoc(found.loc),
				contents: { kind: 'markdown', value: lines.join('\n') }
			};
		}

		const c = mod.values[found.name];
		if (c) {
			const typeText = sluaTypeToString(c.type);
			const valueText = valueToDisplayString(c.value);
			const lines: string[] = [];
			lines.push('```luau');
			lines.push(`${found.receiver}.${c.name}: ${typeText} = ${valueText}`);
			lines.push('```');
			lines.push('');
			lines.push('Constant (compile-time; replaced by the parser; read-only).');
			if (c.docs) {
				lines.push('');
				lines.push(c.docs);
			}
			return {
				range: lspRangeFromLoc(found.loc),
				contents: { kind: 'markdown', value: lines.join('\n') }
			};
		}
	}

	// Template string interpolation hover (best-effort): resolve identifier + show inferred type.
	// Only activates inside `{...}` of a backtick string, and only when hovering an identifier.
	if (!isInTemplateInterpolation(text, params.position)) return null;
	const id = identifierAtPositionInText(text, params.position);
	if (!id) return null;

	const def = findDefinitionAtPosition(ast, params.position, registry, text);
	if (!def) return null;

	let typeText: string | null = null;
	if (def.identifier.typeAnnotation) {
		typeText = def.identifier.typeAnnotation;
	} else if (def.kind === 'local') {
		const inferred = inferLocalVariableTypes(ast, registry);
		const loc = def.identifier.location;
		if (loc) {
			const match = inferred.find((it) => {
				const l = it.identifier.location;
				return (
					l &&
					l.start.line === loc.start.line &&
					l.start.column === loc.start.column &&
					l.end.line === loc.end.line &&
					l.end.column === loc.end.column
				);
			});
			if (match) typeText = sluaTypeToString(match.type);
		}
	} else if (def.kind === 'parameter') {
		// No parameter inference (yet); fall back to unknown unless annotated.
		typeText = 'unknown';
	}

	const lines: string[] = [];
	lines.push('```luau');
	lines.push(`${def.name}${typeText ? `: ${typeText}` : ''}`);
	lines.push('```');
	lines.push('');
	lines.push(`(${def.kind})`);
	return { range: id.range, contents: { kind: 'markdown', value: lines.join('\n') } };
});

connection.languages.inlayHint.on((params): InlayHint[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	if (!registry) return [];

	const parsed = parseSlua(doc.getText());
	const ast = parsed.ast;
	if (!ast) return [];

	return [
		...collectEventCallbackTypeInlayHints(ast, params.range, registry.eventSignatures),
		...collectLocalVariableTypeInlayHints(ast, params.range, registry)
	];
});

connection.onCompletion((params) => {
	if (!registry) return [];
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];
	
	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return [];

	const invoked = params.context?.triggerKind === 1;
	const triggerCharacter = params.context?.triggerCharacter;
	const completions = getCompletions(parsed.ast, params.position, registry, {
		sourceText: text,
		invoked,
		triggerCharacter
	});
	
	// Map our completion kind to LSP completion kind
	function mapCompletionKind(kind: CompletionItemKind): LspCompletionItemKind {
		switch (kind) {
			case 'variable':
				return LspCompletionItemKind.Variable;
			case 'function':
				return LspCompletionItemKind.Function;
			case 'parameter':
				return LspCompletionItemKind.Variable;
			case 'property':
				return LspCompletionItemKind.Property;
			case 'method':
				return LspCompletionItemKind.Method;
			case 'module':
				return LspCompletionItemKind.Module;
			case 'type':
				return LspCompletionItemKind.Class;
			case 'constant':
				return LspCompletionItemKind.Constant;
			case 'event':
				return LspCompletionItemKind.Event;
			default:
				return LspCompletionItemKind.Text;
		}
	}
	
	return completions.map(item => ({
		label: item.label,
		kind: mapCompletionKind(item.kind),
		detail: item.detail,
		documentation: item.documentation,
		insertText: item.insertText,
		insertTextFormat: item.isSnippet ? 2 : undefined,
		sortText: (() => {
			const clamped = Math.max(0, Math.min(9999, item.priority));
			const rank = 9999 - clamped; // Higher priority = lower sortText
			return String(rank).padStart(4, '0');
		})(),
		deprecated: item.deprecated,
		tags: item.deprecated ? [1] : undefined // 1 = Deprecated tag
	}));
});

connection.onDefinition((params) => {
	if (!registry) return null;
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	
	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return null;
	
	const definition = findDefinitionAtPosition(parsed.ast, params.position, registry, text);
	return locationFromCoreDefinition(params.textDocument.uri, definition);
});

connection.onDeclaration((params) => {
	if (!registry) return null;

	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return null;

	const definition = findDefinitionAtPosition(parsed.ast, params.position, registry, text);
	return locationFromCoreDefinition(params.textDocument.uri, definition);
});

connection.onTypeDefinition((params) => {
	if (!registry) return null;

	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return null;

	// We currently don't have source locations for modeled types (registry/YAML),
	// so fall back to declaration/definition locations when available.
	const definition = findDefinitionAtPosition(parsed.ast, params.position, registry, text);
	return locationFromCoreDefinition(params.textDocument.uri, definition);
});

connection.onImplementation((params) => {
	if (!registry) return null;

	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return null;

	// No separate interface/implementation model yet; return the best known target.
	const definition = findDefinitionAtPosition(parsed.ast, params.position, registry, text);
	const loc = locationFromCoreDefinition(params.textDocument.uri, definition);
	return loc ? [loc] : null;
});

connection.onReferences((params) => {
	if (!registry) return [];
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];
	
	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return [];
	
	const references = findAllReferences(parsed.ast, params.position, registry, params.context.includeDeclaration);
	
	return references.map(ref => {
		const loc = ref.identifier.location;
		if (!loc) return null;
		return {
			uri: params.textDocument.uri,
			range: {
				start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
				end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
			}
		};
	}).filter((loc): loc is NonNullable<typeof loc> => loc !== null);
});

connection.onPrepareRename((params) => {
	if (!registry) return null;
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	
	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return null;
	
	return prepareRename(parsed.ast, params.position, registry);
});

connection.onRenameRequest((params) => {
	if (!registry) return null;
	if (!isValidRenameIdentifier(params.newName)) return null;
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	
	const text = document.getText();
	const parsed = parseSlua(text);
	if (!parsed.ast) return null;
	
	const edits = getRenameEdits(parsed.ast, params.position, params.newName, registry);
	
	const changes: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> = {};
	changes[params.textDocument.uri] = edits.map(edit => {
		const loc = edit.identifier.location;
		if (!loc) throw new Error('Location missing');
		return {
			range: {
				start: { line: Math.max(0, loc.start.line - 1), character: Math.max(0, loc.start.column - 1) },
				end: { line: Math.max(0, loc.end.line - 1), character: Math.max(0, loc.end.column - 1) }
			},
			newText: edit.newName
		};
	}).filter(edit => edit !== null);
	
	return { changes };
});

documents.listen(connection);
connection.listen();
