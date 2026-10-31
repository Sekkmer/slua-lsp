import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function writeNotices(target, { directory } = {}) {
	assert.ok(['vscode', 'cli'].includes(target));
	const destination = directory ?? (target === 'vscode' ? path.join(root, 'slua-lsp-client') : path.join(root, '.local/artifacts/cli'));
	const maps = target === 'vscode'
		? ['slua-lsp-client/out/extension.js.map', 'slua-lsp-client/server/out/index.js.map']
		: [path.relative(root, path.join(destination, 'slua-lsp.mjs.map'))];
	const packages = new Map();
	for (const map of maps) {
		const sourceMap = JSON.parse(await fs.readFile(path.join(root, map), 'utf8'));
		for (const source of sourceMap.sources) {
			const file = path.resolve(root, path.dirname(map), sourceMap.sourceRoot || '', source);
			if (!file.startsWith(path.join(root, 'node_modules') + path.sep)) continue;
			const directory = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
			assert.ok(directory, `Cannot locate package for bundled source: ${source}`);
			const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
			if (packages.has(`${pkg.name}@${pkg.version}`)) continue;
			const licenseFiles = (await fs.readdir(directory)).filter((name) => /^(licen[cs]e|notice)(\..+)?$/i.test(name)).sort();
			assert.ok(licenseFiles.some((name) => /^licen[cs]e/i.test(name)), `Missing bundled license: ${pkg.name}`);
			const licenses = await Promise.all(licenseFiles.map(async (name) => ({ name, text: await fs.readFile(path.join(directory, name), 'utf8') })));
			packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license, licenses });
		}
	}
	assert.ok([...packages.values()].some((pkg) => pkg.name === 'js-yaml'), 'Expected bundled YAML dependency was not found in the source map');
	const sections = [];
	for (const [name, file] of [['slua-lsp', 'LICENSE'], ['LuaTS parser (vendored)', 'third_party/luats-LICENSE'], ['Second Life definitions', 'third_party/lsl-definitions/LICENSE']]) {
		sections.push(`${name}\n${'='.repeat(name.length)}\n\n${await fs.readFile(path.join(root, file), 'utf8')}`);
	}
	const inventory = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
	for (const pkg of inventory) for (const license of pkg.licenses) {
		const label = `${pkg.name}@${pkg.version} (${license.name})`;
		sections.push(`${label}\n${'='.repeat(label.length)}\n\n${license.text}`);
	}
	const text = sections.map((section) => section.trimEnd()).join('\n\n\n') + '\n';
	const manifest = { target, sourceMaps: target === 'cli' ? ['.local/artifacts/cli/slua-lsp.mjs.map'] : maps, packages: inventory.map(({ licenses, ...pkg }) => ({ ...pkg,
		licenses: licenses.map(({ name, text }) => ({ name, sha256: crypto.createHash('sha256').update(text).digest('hex') })) })) };
	await fs.writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), text);
	await fs.writeFile(path.join(destination, 'bundled-licenses.json'), JSON.stringify(manifest, null, 2) + '\n');
	if (target === 'vscode') await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), text);
	return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	console.log(JSON.stringify(await writeNotices(process.argv[2])));
}
