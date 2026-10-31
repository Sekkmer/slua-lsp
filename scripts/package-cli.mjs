import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { writeNotices } from './license-notices.mjs';
import { withArtifactLock, publishDirectoryCandidate } from './artifact-publication.mjs';
import { readReleaseMetadata } from './release-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../slua-lsp-client/package.json', import.meta.url));
const { build } = require('esbuild');
await readReleaseMetadata();
const artifacts = path.join(root, '.local/artifacts');
await fs.mkdir(artifacts, { recursive: true });
await withArtifactLock(path.join(artifacts, '.cli-package.lock'), async () => {
	const dest = await fs.mkdtemp(path.join(artifacts, '.cli-stage-'));
	try {
		await build({
			entryPoints: [path.join(root, 'slua-lsp-cli/src/index.ts')],
			bundle: true, platform: 'node', target: 'node22', format: 'esm', mainFields: ['module', 'main'],
			outfile: path.join(dest, 'slua-lsp.mjs'), sourcemap: true,
			banner: { js: "import { createRequire as bundleCreateRequire } from 'node:module'; import { fileURLToPath as bundleFileURLToPath } from 'node:url'; import { dirname as bundleDirname } from 'node:path'; const require = bundleCreateRequire(import.meta.url); const __dirname = bundleDirname(bundleFileURLToPath(import.meta.url));" }
		});
		for (const [source, name] of [
			['third_party/lsl-definitions/lsl_definitions.yaml', 'lsl_definitions.yaml'],
			['slua-lsp-core/src/slua/builtins.yaml', 'builtins.yaml'],
			['third_party/lsl-definitions/LICENSE', 'lsl-definitions.LICENSE'],
			['LICENSE', 'LICENSE'],
			['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt']
		]) await fs.copyFile(path.join(root, source), path.join(dest, name));
		await writeNotices('cli', { directory: dest });
		const hashes = [];
		for (const name of (await fs.readdir(dest)).sort()) {
			if (name === 'SHA256SUMS') continue;
			hashes.push(`${crypto.createHash('sha256').update(await fs.readFile(path.join(dest, name))).digest('hex')}  ${name}`);
		}
		await fs.writeFile(path.join(dest, 'SHA256SUMS'), hashes.join('\n') + '\n');
		const result = await publishDirectoryCandidate(dest, path.join(artifacts, 'cli'));
		process.stdout.write(JSON.stringify(result) + '\n');
	} catch (error) {
		process.stderr.write(`Failed CLI stage preserved at ${dest}\n`);
		throw error;
	}
});
