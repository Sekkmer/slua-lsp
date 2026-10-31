import {
	CodeActionKind,
	type CodeAction,
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import {
	SLUA_LSP_VERSION,
	getSourceModuleGraph,
	preprocessSource,
	normalizePreprocessorContext,
	withSourceContext,
	type PreprocessorContext,
	readSourceModuleFile,
	collectSourceRequires,
	sourceModuleRangeContains,
	sourceRequireCalls,
	analyzeSourceProject,
	parseSlua,
	type SourceProjectAnalysis,
	classifySemanticTokens,
	loadLslDefinitionsFromYamlFile,
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
	getHover,
	getDocumentSymbols,
	type SourceSymbol,
	getCodeActions,
	analyzeTextWithDirectives,
	isCallExpression,
	isFunctionNode,
	isIdentifier,
	isMemberExpression,
	isRecord,
	isStringNode,
	lspRangeFromLoc,
	posInLoc,
	type AstNode,
	type IdentifierNode,
	type SluaEventSignature,
	type CompletionItemKind
} from 'slua-lsp-core';

import { SERVER_NAME } from './constants.js';
import { computeDiagnosticsForText } from './diagnostics.js';
import { DocumentParseCache } from './documentParseCache.js';
import { SourceFileWatchers } from './sourceFileWatchers.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const parsedDocuments = new DocumentParseCache();

let supportsDocumentChanges = false;
let defsLoaded = false;
let semanticLegend: SemanticTokensLegend | null = null;
let registry: ReturnType<typeof buildSluaRegistryFromLslDefinitions> | null = null;
let activeDefinitionsPath: string | undefined;
let definitionReloadEpoch = 0;
let sourceEpoch = 0;
let preprocessorContext: PreprocessorContext | undefined;
const contextRegistries = new WeakMap<object, { epoch: number; base: ReturnType<typeof buildSluaRegistryFromLslDefinitions>; value: ReturnType<typeof buildSluaRegistryFromLslDefinitions> }>();
function contextRegistry(document: TextDocument) {
	if (!registry || preprocessorContext === undefined || !document.uri.startsWith('file:')) return registry;
	const ast = parsedDocuments.get(document).ast;
	if (!ast || typeof ast !== 'object') return registry;
	const previous = contextRegistries.get(ast);
	if (previous?.epoch === sourceEpoch && previous.base === registry) return previous.value;
	const value = withSourceContext(ast, fileURLToPath(document.uri), registry, preprocessorContext);
	contextRegistries.set(ast, { epoch: sourceEpoch, base: registry, value });
	return value;
}
const sourceRoots = new Set<string>();
const sourceReads = new Map<string, Set<string>>();
const sourceWatchers = new SourceFileWatchers(() => {
	invalidateSourceProjects(); validateDependentDocuments('');
}, (message) => connection.console.warn(message));
connection.onShutdown(() => sourceWatchers.close());
const sourceProjects = new Map<string, { version: number; epoch: number; base: ReturnType<typeof buildSluaRegistryFromLslDefinitions>; controller: AbortController;
	promise: Promise<SourceProjectAnalysis | null>; completed: boolean }>();

function invalidateSourceProjects(): void {
	sourceEpoch++;
	for (const entry of sourceProjects.values()) entry.controller.abort();
	sourceProjects.clear();
}

async function projectForDocument(document: TextDocument): Promise<SourceProjectAnalysis | null> {
	if (!registry || !document.uri.startsWith('file:') || !sourceRequireCalls(parsedDocuments.get(document).ast).length) return null;
	const previous = sourceProjects.get(document.uri);
	if (previous?.version === document.version && previous.epoch === sourceEpoch && previous.base === registry) return previous.promise;
	const controller = new AbortController();
	sourceWatchers.closeRoot(document.uri);
	const reads = new Set<string>();
	sourceReads.set(document.uri, reads);
	const entry = { version: document.version, epoch: sourceEpoch, base: registry, controller, completed: false,
		promise: Promise.resolve<SourceProjectAnalysis | null>(null) };
	entry.promise = analyzeSourceProject(fileURLToPath(document.uri), registry, { context: preprocessorContext, entryText: document.getText(), signal: controller.signal,
		onRead: (file) => { reads.add(file); sourceWatchers.observe(document.uri, file); },
		readFile: async (file) => documents.get(pathToFileURL(file).href)?.getText() ?? await readSourceModuleFile(file),
		parseFile: (file, text) => {
			const open = documents.get(pathToFileURL(file).href);
			return open?.getText() === text ? parsedDocuments.get(open) : parseSlua(text);
		} }).catch((error) => {
		if (!controller.signal.aborted) connection.console.error(`Source project analysis failed: ${String(error)}`);
		return null;
	}).finally(() => {
		entry.completed = true;
		for (const [uri, candidate] of sourceProjects) if (sourceProjects.size > 16 && candidate.completed && candidate !== entry) sourceProjects.delete(uri);
	});
	sourceProjects.set(document.uri, entry);
	return entry.promise;
}

async function registryForDocument(document: TextDocument) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const epoch = sourceEpoch;
		const project = await projectForDocument(document);
		if (documents.get(document.uri)?.version !== document.version) return registry;
		if (epoch === sourceEpoch) return project?.registry ?? contextRegistry(document);
	}
	return registry;
}

function validateDependentDocuments(except: string): void {
	for (const uri of sourceRoots) if (uri !== except) void validateTextDocument(uri);
}

type ServerInitializationOptions = {
	definitionsPath?: unknown;
	preprocessorContext?: unknown;
};

function setPreprocessorContext(value: unknown) {
	try {
		const next = value === null ? undefined : normalizePreprocessorContext(value);
		if (JSON.stringify(next) !== JSON.stringify(preprocessorContext)) {
			preprocessorContext = next;
			invalidateSourceProjects();
			for (const doc of documents.all()) void validateTextDocument(doc.uri);
		}
		return { accepted: true, enabled: next !== undefined, contextSha256: next === undefined ? null : createHash('sha256').update(JSON.stringify(next)).digest('hex') };
	} catch (error) {
		connection.console.warn(`Rejected preprocessor context; retaining current context: ${String(error)}`);
		return { accepted: false, error: (error as Error).message };
	}
}
connection.onRequest('slua/setPreprocessorContext', (params: { context?: unknown }) => {
	if (!params || typeof params !== 'object' || !Object.hasOwn(params, 'context')) return { accepted: false, error: 'An explicit context object or null is required' };
	return setPreprocessorContext(params.context);
});

function getDefinitionsPathFromSettings(settings: unknown): string | undefined {
	if (!settings || typeof settings !== 'object') return undefined;
	const root = settings as Record<string, unknown>;
	const slua = root.slua;
	const fromSlua = slua && typeof slua === 'object' ? (slua as Record<string, unknown>).definitionsPath : undefined;
	const direct = root.definitionsPath;
	const value = fromSlua ?? direct;
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function reloadDefinitions(definitionsPath?: string): Promise<boolean> {
	const epoch = ++definitionReloadEpoch;
	try {
		const candidate = await loadLslDefinitionsFromYamlFile(definitionsPath);
		const candidateRegistry = buildSluaRegistryFromLslDefinitions(candidate);
		if (epoch !== definitionReloadEpoch) return false;
		registry = candidateRegistry;
		invalidateSourceProjects();
		defsLoaded = true;
		activeDefinitionsPath = definitionsPath;
		return true;
	} catch (err) {
		if (epoch !== definitionReloadEpoch) return false;
		// A rejected configuration must not discard an already working registry.
		connection.console.error(`Failed to load LSL definitions YAML: ${String(err)}`);
		return false;
	}
}

connection.onRequest('slua/getDefinitions', () => ({ loaded: defsLoaded, definitionsPath: activeDefinitionsPath ?? null }));
connection.onRequest('slua/setDefinitions', async (params: { definitionsPath?: unknown }) => {
	if (typeof params?.definitionsPath !== 'string' || !params.definitionsPath.trim()) return { accepted: false };
	const accepted = await reloadDefinitions(params.definitionsPath);
	if (accepted) for (const doc of documents.all()) void validateTextDocument(doc.uri);
	return { accepted, definitionsPath: activeDefinitionsPath ?? null };
});

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
	supportsDocumentChanges = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
	const initializationOptions = params.initializationOptions as ServerInitializationOptions | undefined;
	setPreprocessorContext(initializationOptions?.preprocessorContext);
	const definitionsPath = getDefinitionsPathFromSettings(initializationOptions);
	await reloadDefinitions(definitionsPath);

	return {
		serverInfo: { name: SERVER_NAME, version: SLUA_LSP_VERSION },
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
			renameProvider: { prepareProvider: true },
			codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] }
		}
	};
});

function locationFromCoreDefinition(uri: string, definition: ReturnType<typeof findDefinitionAtPosition>) {
	if (!definition) return null;
	const loc = definition.identifier.location;
	if (!loc) return null;
	return {
		uri: definition.kind === 'field' && definition.file ? pathToFileURL(definition.file).href : uri,
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

connection.onSignatureHelp(async (params): Promise<SignatureHelp | null> => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return null;
	if (!registry) return null;
	const sourceRegistry = await registryForDocument(doc);
	if (!sourceRegistry) return null;

	const text = doc.getText();
	const parsed = parsedDocuments.get(doc);
	const help = getSignatureHelp(parsed.ast, params.position, sourceRegistry, text);
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

function documentSymbolFromCore(symbol: SourceSymbol): DocumentSymbol {
	const kinds = { variable: SymbolKind.Variable, function: SymbolKind.Function, method: SymbolKind.Method,
		class: SymbolKind.Class, field: SymbolKind.Field, type: SymbolKind.Interface };
	return { ...symbol, kind: kinds[symbol.kind], children: symbol.children?.map(documentSymbolFromCore) };
}

connection.onDocumentSymbol((params): DocumentSymbol[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	const parsed = parsedDocuments.get(doc);
	return getDocumentSymbols(parsed.ast).map(documentSymbolFromCore);
});

connection.onFoldingRanges((params): FoldingRange[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	const parsed = parsedDocuments.get(doc);
	return collectFoldingRangesFromAst(parsed.ast);
});

connection.onSelectionRanges((params): SelectionRange[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return params.positions.map((p) => ({ range: { start: p, end: p } }));
	const parsed = parsedDocuments.get(doc);
	return params.positions.map((p) => selectionRangeForPosition(parsed.ast, p) ?? { range: { start: p, end: p } });
});

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

connection.onDidChangeConfiguration((params) => {
	const settings = params.settings as { preprocessorContext?: unknown; definitionsPath?: unknown; slua?: { definitionsPath?: unknown; preprocessor?: { context?: unknown } } } | null;
	if (settings && Object.hasOwn(settings, 'preprocessorContext')) setPreprocessorContext(settings.preprocessorContext);
	else if (settings?.slua?.preprocessor && Object.hasOwn(settings.slua.preprocessor, 'context')) setPreprocessorContext(settings.slua.preprocessor.context);
	if (!settings || !Object.hasOwn(settings, 'definitionsPath') && !(settings.slua && Object.hasOwn(settings.slua, 'definitionsPath'))) return;
	const definitionsPath = getDefinitionsPathFromSettings(params.settings);
	if (definitionsPath === activeDefinitionsPath) return;
	void reloadDefinitions(definitionsPath).then(() => {
		for (const doc of documents.all()) void validateTextDocument(doc.uri);
	});
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

	const data = parsedDocuments.getSemanticData(doc, (parsed) => encodeSemanticTokens(classifySemanticTokens(doc.getText(), {
		ast: parsed.ast ?? undefined
	})));
	return { data };
});

async function validateTextDocument(uri: string): Promise<void> {
	const doc = documents.get(uri);
	if (!doc) return;
	const epoch = sourceEpoch;
	const version = doc.version;
	const text = doc?.getText() ?? '';
	const project = sourceRoots.has(uri) ? await projectForDocument(doc) : null;

	const diagnostics = computeDiagnosticsForText(text, {
		registry: project?.registry ?? contextRegistry(doc),
		defsLoaded,
		serverName: SERVER_NAME,
		parsed: doc ? parsedDocuments.get(doc) : undefined
	});
	if (project) {
		diagnostics.splice(0, diagnostics.length, ...project.diagnostics.filter((item) => item.file === project.graph.entry)
			.map((item) => ({ range: item.range, message: item.message, code: item.code, source: SERVER_NAME, tags: item.tags?.map(() => 2 as const),
				severity: item.severity === 'error' ? 1 as const : item.severity === 'warning' ? 2 as const : 3 as const })));
		for (const edge of project.graph.edges.filter((item) => item.from === project.graph.entry && item.target)) {
			const reachable = new Set<string>([edge.target!]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const next of project.graph.edges) if (reachable.has(next.from) && next.target && !reachable.has(next.target)) { reachable.add(next.target); changed = true; }
			}
			const imported = project.diagnostics.filter((item) => item.file !== project.graph.entry && reachable.has(item.file));
			if (imported.length) diagnostics.push({ range: edge.range, severity: imported.some((item) => item.severity === 'error') ? 1 : 2,
				code: 'module-dependency', source: SERVER_NAME, message: `Dependency '${edge.specifier}' has ${imported.length} diagnostic(s).`,
				relatedInformation: imported.slice(0, 20).map((item) => ({ location: { uri: pathToFileURL(item.file).href, range: item.range }, message: `${item.code}: ${item.message}` })) });
		}
	}

	if (sourceEpoch !== epoch || documents.get(uri)?.version !== version) return;
	connection.sendDiagnostics({ uri, version, diagnostics });
}

documents.onDidChangeContent((change) => {
	if (sourceRequireCalls(parsedDocuments.get(change.document).ast).length) sourceRoots.add(change.document.uri);
	else { sourceRoots.delete(change.document.uri); sourceReads.delete(change.document.uri); sourceWatchers.closeRoot(change.document.uri); }
	invalidateSourceProjects();
	void validateTextDocument(change.document.uri);
	validateDependentDocuments(change.document.uri);
});
documents.onDidClose((e) => {
	sourceRoots.delete(e.document.uri);
	sourceReads.delete(e.document.uri);
	sourceWatchers.closeRoot(e.document.uri);
	invalidateSourceProjects();
	parsedDocuments.close(e.document.uri);
	connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
	validateDependentDocuments(e.document.uri);
});
connection.onDidChangeWatchedFiles((params) => {
	const changed = params.changes.filter((item) => item.uri.startsWith('file:')).map((item) => fileURLToPath(item.uri));
	if (!changed.some((file) => [...sourceReads.values()].some((reads) => reads.has(file)))) return;
	invalidateSourceProjects();
	validateDependentDocuments('');
});

connection.onHover(async (params): Promise<Hover | null> => {
	const doc = documents.get(params.textDocument.uri);
	const sourceRegistry = doc ? await registryForDocument(doc) : null;
	if (!doc || !sourceRegistry) return null;
	const hover = getHover(parsedDocuments.get(doc).ast, params.position, sourceRegistry);
	return hover ? { range: hover.range, contents: { kind: 'markdown', value: hover.markdown } } : null;
});

connection.languages.inlayHint.on(async (params): Promise<InlayHint[]> => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	if (!registry) return [];
	const sourceRegistry = await registryForDocument(doc);
	if (!sourceRegistry) return [];

	const parsed = parsedDocuments.get(doc);
	const ast = parsed.ast;
	if (!ast) return [];

	return [
		...collectEventCallbackTypeInlayHints(ast, params.range, sourceRegistry.eventSignatures),
		...collectLocalVariableTypeInlayHints(ast, params.range, sourceRegistry)
	];
});

connection.onCompletion(async (params) => {
	if (!registry) return [];
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];
	const sourceRegistry = await registryForDocument(document);
	if (!sourceRegistry) return [];
	
	const text = document.getText();
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast) return [];

	const invoked = params.context?.triggerKind === 1;
	const triggerCharacter = params.context?.triggerCharacter;
	const completions = getCompletions(parsed.ast, params.position, sourceRegistry, {
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
			case 'keyword':
				return LspCompletionItemKind.Keyword;
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

connection.onCodeAction(async (params): Promise<CodeAction[]> => {
	if (params.context.only && !params.context.only.some((kind) => kind === '' || kind === CodeActionKind.QuickFix)) return [];
	const document = documents.get(params.textDocument.uri);
	if (!document || !registry) return [];
	const sourceRegistry = await registryForDocument(document);
	if (!sourceRegistry) return [];
	const text = document.getText();
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast) return [];
	// Revalidate against this document version; client diagnostics can be stale.
	const diagnostics = analyzeTextWithDirectives(text, { ast: parsed.ast, registry: sourceRegistry, eventSignatures: sourceRegistry.eventSignatures });
	return getCodeActions(text, parsed.ast, diagnostics, params.range).map((action) => ({
		title: action.title, kind: CodeActionKind.QuickFix, isPreferred: action.isPreferred,
		diagnostics: action.diagnostics.map((diagnostic) => ({ ...diagnostic, source: SERVER_NAME, tags: diagnostic.tags?.map(() => 2 as const),
			severity: diagnostic.severity === 'error' ? 1 : diagnostic.severity === 'warning' ? 2 : diagnostic.severity === 'info' ? 3 : 4 })),
		edit: supportsDocumentChanges
			? { documentChanges: [{ textDocument: { uri: document.uri, version: document.version }, edits: action.edits }] }
			: { changes: { [document.uri]: action.edits } }
	}));
});

connection.onRequest('slua/getSourceModules', async (params: { uri?: unknown; maxDepth?: unknown }) => {
	if (typeof params?.uri !== 'string' || !params.uri.startsWith('file:')) throw new Error('Source modules require a file URI');
	if (params.maxDepth !== undefined && typeof params.maxDepth !== 'number') throw new Error('Module depth must be numeric');
	return getSourceModuleGraph(fileURLToPath(params.uri), { maxDepth: params.maxDepth,
		readFile: async (file) => documents.get(pathToFileURL(file).href)?.getText() ?? await readSourceModuleFile(file) });
});

connection.onRequest('slua/preprocess', async (params: { uri?: unknown; maxDepth?: unknown; context?: PreprocessorContext | null }) => {
	if (typeof params?.uri !== 'string' || !params.uri.startsWith('file:')) throw new Error('Preprocessing requires a file URI');
	if (params.maxDepth !== undefined && typeof params.maxDepth !== 'number') throw new Error('Module depth must be numeric');
	return preprocessSource(fileURLToPath(params.uri), { maxDepth: params.maxDepth, context: params.context === null ? undefined : params.context ?? preprocessorContext,
		readFile: async (file) => documents.get(pathToFileURL(file).href)?.getText() ?? await readSourceModuleFile(file) });
});

connection.onDefinition(async (params) => {
	if (!registry) return null;
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	
	const version = document.version;
	const text = document.getText();
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast) return null;
	if (document.uri.startsWith('file:') && collectSourceRequires(parsed.ast).some((include) => include.specifier !== undefined && sourceModuleRangeContains(include.range, params.position))) {
		const graph = await getSourceModuleGraph(fileURLToPath(document.uri), { entryText: text,
			readFile: async (file) => documents.get(pathToFileURL(file).href)?.getText() ?? await readSourceModuleFile(file) });
		if (documents.get(document.uri)?.version !== version) return null;
		const edge = graph.edges.find((include) => include.from === graph.entry && sourceModuleRangeContains(include.range, params.position));
		return edge?.target ? { uri: pathToFileURL(edge.target).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } : null;
	}
	
	const sourceRegistry = await registryForDocument(document);
	if (!sourceRegistry || documents.get(document.uri)?.version !== version) return null;
	const definition = findDefinitionAtPosition(parsed.ast, params.position, sourceRegistry, text);
	return locationFromCoreDefinition(params.textDocument.uri, definition);
});

connection.onDeclaration(async (params) => {
	if (!registry) return null;

	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const version = document.version;
	const text = document.getText();
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast) return null;

	const sourceRegistry = await registryForDocument(document);
	if (!sourceRegistry || documents.get(document.uri)?.version !== version) return null;
	const definition = findDefinitionAtPosition(parsed.ast, params.position, sourceRegistry, text);
	return locationFromCoreDefinition(params.textDocument.uri, definition);
});

connection.onTypeDefinition(async (params) => {
	if (!registry) return null;

	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const version = document.version;
	const text = document.getText();
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast) return null;

	// We currently don't have source locations for modeled types (registry/YAML),
	// so fall back to declaration/definition locations when available.
	const sourceRegistry = await registryForDocument(document);
	if (!sourceRegistry || documents.get(document.uri)?.version !== version) return null;
	const definition = findDefinitionAtPosition(parsed.ast, params.position, sourceRegistry, text);
	return locationFromCoreDefinition(params.textDocument.uri, definition);
});

connection.onImplementation(async (params) => {
	if (!registry) return null;

	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const version = document.version;
	const text = document.getText();
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast) return null;

	// No separate interface/implementation model yet; return the best known target.
	const sourceRegistry = await registryForDocument(document);
	if (!sourceRegistry || documents.get(document.uri)?.version !== version) return null;
	const definition = findDefinitionAtPosition(parsed.ast, params.position, sourceRegistry, text);
	const loc = locationFromCoreDefinition(params.textDocument.uri, definition);
	return loc ? [loc] : null;
});

connection.onReferences((params) => {
	if (!registry) return [];
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];
	
	const parsed = parsedDocuments.get(document);
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
	
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast || parsed.diagnostics.length) return null;
	
	return prepareRename(parsed.ast, params.position, registry);
});

connection.onRenameRequest((params) => {
	if (!registry) return null;
	if (!isValidRenameIdentifier(params.newName)) return null;
	
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	
	const parsed = parsedDocuments.get(document);
	if (!parsed.ast || parsed.diagnostics.length) return null;
	
	const edits = getRenameEdits(parsed.ast, params.position, params.newName, registry);
	if (!edits.length) return null;
	
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
	
	return supportsDocumentChanges
		? { documentChanges: [{ textDocument: { uri: document.uri, version: document.version }, edits: changes[document.uri]! }] }
		: { changes };
});

documents.listen(connection);
connection.listen();
