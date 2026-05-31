import path from 'node:path';
import fs from 'node:fs';

import * as vscode from 'vscode';
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from 'vscode-languageclient/node';
import {
	DEFAULT_DEFINITIONS_UPDATE_URL,
	definitionUpdatePaths,
	shouldCheckDefinitionUpdate,
	updateDefinitions
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

	function requireExists(file: string): boolean {
		try {
			fs.accessSync(file);
			return true;
		} catch {
			return false;
		}
	}

	function bundledDefinitionsPath(): string {
		return path.join(context.extensionPath, 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');
	}

	function cachedDefinitionsPathSync(): string | undefined {
		const file = definitionUpdatePaths(definitionsCacheDir).definitionsPath;
		return requireExists(file) ? file : undefined;
	}

	function resolveDefinitionsPath(input: unknown): string {
		const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let configured = typeof input === 'string' && input.trim().length > 0 ? input.trim() : '';
		if (configured && firstWorkspace) configured = configured.replace('${workspaceFolder}', firstWorkspace);
		if (configured && !path.isAbsolute(configured)) {
			configured = firstWorkspace ? path.join(firstWorkspace, configured) : path.join(context.extensionPath, configured);
		}
		return configured || cachedDefinitionsPathSync() || bundledDefinitionsPath();
	}

	function configuredDefinitionsPath(): string {
		return resolveDefinitionsPath(vscode.workspace.getConfiguration('slua').get<string>('definitionsPath'));
	}

	async function sendDefinitionsConfiguration(definitionsPath: string): Promise<void> {
		activeDefinitionsPath = definitionsPath;
		await client?.sendNotification('workspace/didChangeConfiguration', {
			settings: { slua: { definitionsPath } }
		});
	}

	async function runDefinitionUpdate(showResult: boolean): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('slua');
		const sourceUrl = cfg.get<string>('definitions.updateUrl', DEFAULT_DEFINITIONS_UPDATE_URL);
		try {
			const result = await updateDefinitions({ cacheDir: definitionsCacheDir, sourceUrl });
			await sendDefinitionsConfiguration(result.definitionsPath);
			if (showResult) {
				const suffix = result.notModified ? 'already current' : result.updated ? 'updated' : 'unchanged';
				vscode.window.showInformationMessage(`SLua definitions ${suffix}: ${result.metadata.version}`);
			}
		} catch (err) {
			vscode.window.showErrorMessage(`SLua definitions update failed: ${String(err)}`);
		}
	}

	async function maybeUpdateDefinitions(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('slua');
		if (!cfg.get<boolean>('definitions.autoUpdate', true)) return;
		const intervalHours = cfg.get<number>('definitions.updateIntervalHours', 24);
		const intervalMs = Math.max(0, intervalHours) * 60 * 60 * 1000;
		if (await shouldCheckDefinitionUpdate(definitionsCacheDir, intervalMs)) {
			await runDefinitionUpdate(false);
		}
	}

	activeDefinitionsPath = configuredDefinitionsPath();

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

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'luau' }],
		initializationOptions: { definitionsPath: activeDefinitionsPath }
	};

	client = new LanguageClient('slua-lsp', 'SLua LSP', serverOptions, clientOptions);
	context.subscriptions.push(
		vscode.commands.registerCommand('slua.updateDefinitions', () => {
			void runDefinitionUpdate(true);
		}),
		vscode.commands.registerCommand('slua.showActiveDefinitions', () => {
			vscode.window.showInformationMessage(`SLua definitions: ${activeDefinitionsPath}`);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('slua.definitionsPath')) return;
			void sendDefinitionsConfiguration(configuredDefinitionsPath());
		})
	);
	context.subscriptions.push({
		dispose: () => {
			void client?.stop();
		}
	});
	await client.start();
	void maybeUpdateDefinitions();
}

export async function deactivate(): Promise<void> {
	await client?.stop();
}
