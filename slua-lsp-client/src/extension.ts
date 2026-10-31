import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import * as vscode from 'vscode';
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from 'vscode-languageclient/node';
import {
	DEFAULT_DEFINITIONS_UPDATE_URL,
	cachedDefinitionPath,
	shouldCheckDefinitionUpdate,
	updateDefinitions,
	readSourceModuleFile,
	resolvePreprocessedPosition,
	type PreprocessedSource,
	type PreprocessedSourceLocation
} from 'slua-lsp-core';

let client: LanguageClient | undefined;
let activeDefinitionsPath = '';

function getServerModulePath(context: vscode.ExtensionContext): string {
	// Preferred: a copy bundled into the extension (for packaging later)
	const bundled = path.join(context.extensionPath, 'server', 'out', 'index.js');
	// Dev fallback: run directly from the workspace checkout
	const workspace = path.join(context.extensionPath, '..', 'slua-lsp-server', 'out', 'index.js');

	if (fs.existsSync(bundled)) {
		return bundled;
	}

	return workspace;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const serverModule = getServerModulePath(context);
	const definitionsCacheDir = path.join(context.globalStorageUri.fsPath, 'definitions');
	const output = vscode.window.createOutputChannel('SLua LSP');
	context.subscriptions.push(output);
	const previewUri = vscode.Uri.parse('slua-generated:/SLua%20Generated%20Source.txt');
	let generatedPreview: PreprocessedSource | undefined;
	let renderedPreview: { document: vscode.TextDocument; version: number; snapshot: PreprocessedSource } | undefined;
	let previewRevision = 0;
	const previewChanged = new vscode.EventEmitter<vscode.Uri>();
	const previewRequestChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(previewChanged, previewRequestChanged,
		vscode.workspace.registerTextDocumentContentProvider('slua-generated', {
			onDidChange: previewChanged.event, provideTextDocumentContent: () => generatedPreview?.content ?? ''
		}),
		vscode.workspace.onDidCloseTextDocument((document) => { if (document.uri.toString() === previewUri.toString()) { generatedPreview = undefined; renderedPreview = undefined; previewRevision++; previewRequestChanged.fire(); } }));

	async function showGeneratedPreview(snapshot: PreprocessedSource, revision: number): Promise<void> {
		generatedPreview = snapshot;
		renderedPreview = undefined;
		const document = await vscode.workspace.openTextDocument(previewUri);
		const current = () => revision === previewRevision && generatedPreview === snapshot && !document.isClosed;
		// VS Code normalizes CRLF/CR/LF text in its model; editor line/UTF-16 columns remain identical.
		const renderedText = snapshot.content!.replace(/\r\n|\r/g, '\n');
		const ready = () => document.getText().replace(/\r\n|\r/g, '\n') === renderedText;
		if (!current()) return;
		if (!ready()) {
			// Content-provider refresh is asynchronous even when the URI is already open.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => finish(new Error(`Generated preview did not update (model ${document.getText().length}, source ${snapshot.content!.length} UTF-16 units)`)), 10000);
				const changed = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document) check(); });
				const superseded = previewRequestChanged.event(check);
				function finish(error?: Error) { clearTimeout(timer); changed.dispose(); superseded.dispose(); if (error) reject(error); else resolve(); }
				function check() { if (!current() || ready()) finish(); }
				previewChanged.fire(previewUri); check();
			});
		}
		if (current()) {
			renderedPreview = { document, version: document.version, snapshot };
			await vscode.window.showTextDocument(document, { preview: false });
		}
	}

	async function originalSource(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<PreprocessedSourceLocation> {
		const snapshot = generatedPreview, version = document.version;
		if (!snapshot || document.uri.toString() !== previewUri.toString() || renderedPreview?.document !== document || renderedPreview.version !== version || renderedPreview.snapshot !== snapshot || token?.isCancellationRequested) return { status: 'unmapped' };
		const controller = new AbortController();
		const cancellation = token?.onCancellationRequested(() => controller.abort());
		try {
			const result = await resolvePreprocessedPosition(snapshot, position, { signal: controller.signal, readFile: async (file) => {
				const uri = vscode.Uri.file(file).toString();
				const open = vscode.workspace.textDocuments.find((item) => !item.isClosed && item.uri.toString() === uri);
				if (!open) return readSourceModuleFile(file);
				const text = open.getText(), expected = snapshot.graph.modules.find((item) => item.file === file)?.sourceSha256;
				if (open.isDirty || createHash('sha256').update(text).digest('hex') === expected) return text;
				const disk = await readSourceModuleFile(file);
				// A newly opened clean model may normalize raw CR bytes. Require the exact disk
				// snapshot hash in the resolver and equivalent editor text before allowing that case.
				return disk !== undefined && disk.replace(/\r\n|\r/g, '\n') === text.replace(/\r\n|\r/g, '\n') ? disk : text;
			} });
			return token?.isCancellationRequested || generatedPreview !== snapshot || document.isClosed || document.version !== version ? { status: 'unmapped' } : result;
		} catch (error) {
			if (controller.signal.aborted) return { status: 'unmapped' };
			throw error;
		} finally { cancellation?.dispose(); }
	}
	context.subscriptions.push(vscode.languages.registerDefinitionProvider({ scheme: 'slua-generated' }, {
		provideDefinition: async (document, position, token) => {
			const result = await originalSource(document, position, token);
			return result.status === 'mapped' ? new vscode.Location(vscode.Uri.file(result.file), new vscode.Position(result.position.line, result.position.character)) : null;
		}
	}));

	function bundledDefinitionsPath(): string {
		return path.join(context.extensionPath, 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');
	}

	async function resolveDefinitionsPath(input: unknown): Promise<string> {
		const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let configured = typeof input === 'string' && input.trim().length > 0 ? input.trim() : '';
		if (configured && firstWorkspace) configured = configured.replace('${workspaceFolder}', firstWorkspace);
		if (configured && !path.isAbsolute(configured)) {
			configured = firstWorkspace ? path.join(firstWorkspace, configured) : path.join(context.extensionPath, configured);
		}
		return configured || await cachedDefinitionPath(definitionsCacheDir, (err) => output.appendLine(`Definitions cache unavailable; using bundled definitions: ${String(err)}`)) || bundledDefinitionsPath();
	}

	let configurationRevision = 0;

	function configuredDefinitionsPath(): Promise<string> {
		return resolveDefinitionsPath(vscode.workspace.getConfiguration('slua').get<string>('definitionsPath'));
	}

	async function sendDefinitionsConfiguration(definitionsPath: string): Promise<void> {
		const result = await client!.sendRequest<{ accepted: boolean; definitionsPath: string | null }>('slua/setDefinitions', { definitionsPath });
		if (!result.accepted) throw new Error(`Server did not activate definitions: ${definitionsPath}`);
		activeDefinitionsPath = result.definitionsPath ?? '';
	}

	async function applyConfiguredDefinitions(): Promise<void> {
		const revision = ++configurationRevision;
		const selected = await configuredDefinitionsPath();
		// Cache reads can finish after a newer explicit-path change. Only the
		// newest selection may reach the server's independently ordered reload.
		if (revision !== configurationRevision) return;
		await sendDefinitionsConfiguration(selected);
	}

	async function runDefinitionUpdate(showResult: boolean): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('slua');
		const sourceUrl = cfg.get<string>('definitions.updateUrl', DEFAULT_DEFINITIONS_UPDATE_URL).trim() || DEFAULT_DEFINITIONS_UPDATE_URL;
		try {
			if (cfg.get<string>('definitionsPath', '').trim()) {
				await applyConfiguredDefinitions();
				if (showResult) void vscode.window.showInformationMessage('SLua: custom definitionsPath is configured; remove it to use automatic definitions.');
				return;
			}
			const result = await updateDefinitions({ cacheDir: definitionsCacheDir, sourceUrl });
			await applyConfiguredDefinitions();
			if (showResult) {
				const suffix = result.notModified ? 'already current' : result.updated ? 'updated' : 'unchanged';
				vscode.window.showInformationMessage(`SLua definitions ${suffix}: ${result.metadata.version}`);
			}
		} catch (err) {
			output.appendLine(`Definitions update failed; retaining current definitions: ${String(err)}`);
			if (showResult) void vscode.window.showErrorMessage(`SLua definitions update failed: ${String(err)}`);
		}
	}

	async function maybeUpdateDefinitions(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('slua');
		if (!cfg.get<boolean>('definitions.autoUpdate', true) || cfg.get<string>('definitionsPath', '').trim()) return;
		const intervalHours = cfg.get<number>('definitions.updateIntervalHours', 24);
		const intervalMs = Math.max(0, intervalHours) * 60 * 60 * 1000;
		if (await shouldCheckDefinitionUpdate(definitionsCacheDir, intervalMs, new Date(), cfg.get<string>('definitions.updateUrl', DEFAULT_DEFINITIONS_UPDATE_URL).trim() || DEFAULT_DEFINITIONS_UPDATE_URL)) {
			await runDefinitionUpdate(false);
		}
	}

	activeDefinitionsPath = await configuredDefinitionsPath();

	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { env: { ...process.env, SLUA_LSP_DEFS_PATH: activeDefinitionsPath } }
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { env: { ...process.env, SLUA_LSP_DEFS_PATH: activeDefinitionsPath } }
		}
	};

	const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{luau,lua,slua}');
	const aliasWatcher = vscode.workspace.createFileSystemWatcher('**/.luaurc');
	context.subscriptions.push(sourceWatcher, aliasWatcher);
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'luau' }],
		synchronize: { fileEvents: [sourceWatcher, aliasWatcher] },
		initializationOptions: { definitionsPath: activeDefinitionsPath, preprocessorContext: vscode.workspace.getConfiguration('slua').get('preprocessor.context', null) }
	};

	client = new LanguageClient('slua-lsp', 'SLua LSP', serverOptions, clientOptions);
	context.subscriptions.push(
		vscode.commands.registerCommand('slua.updateDefinitions', () => runDefinitionUpdate(true)),
		vscode.commands.registerCommand('slua.preprocess', async (uri?: vscode.Uri, options?: { preview?: boolean; maxDepth?: number; context?: import('slua-lsp-core').PreprocessorContext }) => {
			const source = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!source || source.scheme !== 'file') throw new Error('Preprocessing requires a source file');
			const revision = options?.preview === false ? undefined : ++previewRevision;
			if (revision !== undefined) previewRequestChanged.fire();
			const result = await client!.sendRequest<import('slua-lsp-core').PreprocessedSource>('slua/preprocess', { uri: source.toString(), maxDepth: options?.maxDepth, context: options?.context });
			if (revision !== undefined && revision === previewRevision) {
				if (result.success && result.content !== null) {
					await showGeneratedPreview(result, revision);
				} else void vscode.window.showErrorMessage(`SLua preprocessing failed: ${result.diagnostics[0]?.message ?? 'no generated source'}`);
			}
			return result;
		}),
		vscode.commands.registerCommand('slua.openGeneratedSource', async (uri?: vscode.Uri, position?: vscode.Position) => {
			const editor = vscode.window.activeTextEditor, source = uri ?? editor?.document.uri;
			const point = position ?? (editor?.document.uri.toString() === source?.toString() ? editor?.selection.active : undefined);
			if (!source || source.toString() !== previewUri.toString() || !point) return null;
			const preview = vscode.workspace.textDocuments.find((item) => !item.isClosed && item.uri.toString() === source.toString());
			if (!preview) return null;
			let result = await originalSource(preview, point);
			if (result.status === 'mapped') {
				const version = preview.version;
				const target = await vscode.workspace.openTextDocument(vscode.Uri.file(result.file));
				// Verify the editor's actual buffer after opening, before applying a selection.
				result = await originalSource(preview, point);
				if (result.status === 'mapped' && result.file === target.uri.fsPath && preview.version === version) {
					const selected = new vscode.Position(result.position.line, result.position.character);
					await vscode.window.showTextDocument(target, { selection: new vscode.Range(selected, selected), preview: false });
					return new vscode.Location(target.uri, selected);
				}
				if (result.status === 'mapped') return null;
			}
			if (result.status === 'stale') void vscode.window.showInformationMessage('Original source changed since this preview. Generate a fresh preview before navigating.');
			if (result.status === 'unavailable') { output.appendLine(result.message); void vscode.window.showInformationMessage('Original source is unavailable. Generate a fresh preview before navigating.'); }
			return null;
		}),
		vscode.commands.registerCommand('slua.showActiveDefinitions', async () => {
			const state = await client!.sendRequest<{ loaded: boolean; definitionsPath: string | null }>('slua/getDefinitions');
			activeDefinitionsPath = state.loaded ? state.definitionsPath ?? '' : '';
			void vscode.window.showInformationMessage(`SLua definitions: ${activeDefinitionsPath || 'none loaded'}`);
			return activeDefinitionsPath;
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('slua.preprocessor.context')) {
				void client!.sendRequest<{ accepted: boolean; error?: string }>('slua/setPreprocessorContext', { context: vscode.workspace.getConfiguration('slua').get('preprocessor.context', null) })
					.then((result) => { if (!result.accepted) output.appendLine(`Preprocessor context rejected: ${result.error ?? 'invalid context'}`); }, (error) => output.appendLine(String(error)));
			}
			if (event.affectsConfiguration('slua.definitionsPath')) {
				void applyConfiguredDefinitions().catch((err) => output.appendLine(String(err)));
			}
			if (event.affectsConfiguration('slua.definitions')) {
				void maybeUpdateDefinitions().catch((err) => output.appendLine(String(err)));
			}
		})
	);
	context.subscriptions.push({
		dispose: () => {
			void client?.stop();
		}
	});
	await client.start();
	void maybeUpdateDefinitions().catch((err) => output.appendLine(String(err)));
}

export async function deactivate(): Promise<void> {
	await client?.stop();
}
