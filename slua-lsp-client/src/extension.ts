import path from 'node:path';
import fs from 'node:fs';

import * as vscode from 'vscode';
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
	const serverModule = getServerModulePath(context);
	const defsPath = path.join(context.extensionPath, 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { env: { ...process.env, SLUA_LSP_DEFS_PATH: defsPath } }
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { env: { ...process.env, SLUA_LSP_DEFS_PATH: defsPath } }
		}
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'luau' }]
	};

	client = new LanguageClient('slua-lsp', 'SLua LSP', serverOptions, clientOptions);
	context.subscriptions.push({
		dispose: () => {
			void client?.stop();
		}
	});
	void client.start();
}

export async function deactivate(): Promise<void> {
	await client?.stop();
}
