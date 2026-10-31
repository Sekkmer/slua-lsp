import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function readReleaseMetadata(directory = root) {
	const packages = {};
	for (const name of ['', 'slua-lsp-core', 'slua-lsp-server', 'slua-lsp-cli', 'slua-lsp-client']) {
		packages[name || 'workspace'] = JSON.parse(await fs.readFile(path.join(directory, name, 'package.json'), 'utf8'));
	}
	const version = packages['slua-lsp-core'].version;
	assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'VSIX requires a numeric major.minor.patch version');
	for (const name of ['slua-lsp-core', 'slua-lsp-server', 'slua-lsp-cli', 'slua-lsp-client']) assert.equal(packages[name].version, version, `${name} version drift`);
	const source = await fs.readFile(path.join(directory, 'slua-lsp-core/src/version.ts'), 'utf8');
	assert.ok(source.includes(`export const SLUA_LSP_VERSION = '${version}';`), 'Shared runtime version does not match package metadata');
	const node = '^22.0.0 || ^24.0.0';
	for (const name of ['workspace', 'slua-lsp-cli', 'slua-lsp-server']) assert.equal(packages[name].engines?.node, node, `${name} must match the qualified standalone Node matrix`);
	assert.equal(packages['slua-lsp-client'].engines.vscode, '^1.90.0');
	return { version, node, vscode: packages['slua-lsp-client'].engines.vscode, publisher: packages['slua-lsp-client'].publisher, name: packages['slua-lsp-client'].name, channel: 'local-candidate' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await readReleaseMetadata()));
