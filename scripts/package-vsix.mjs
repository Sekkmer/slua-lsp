import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withArtifactLock, publishFileCandidate } from './artifact-publication.mjs';
import { readReleaseMetadata } from './release-metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = await readReleaseMetadata();
const artifacts = path.join(root, '.local/artifacts');
const filename = `${release.name}-${release.version}.vsix`;
await fs.mkdir(artifacts, { recursive: true });
await withArtifactLock(path.join(artifacts, '.vsix-candidate.lock'), async () => {
	const directory = await fs.mkdtemp(path.join(artifacts, '.vsix-stage-'));
	const stage = path.join(directory, filename);
	try {
		const result = spawnSync('pnpm', ['-C', 'slua-lsp-client', 'exec', 'vsce', 'package', '--no-dependencies', '--out', stage], { cwd: root, stdio: 'inherit' });
		if (result.error) throw result.error;
		assert.equal(result.status, 0, 'VSIX packager failed; previous candidate is unchanged');
		const verified = spawnSync('python3', ['scripts/vsix_artifact.py', stage, '--version', release.version], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
		if (verified.error) throw verified.error;
		assert.equal(verified.status, 0, `VSIX validation failed: ${verified.stderr}`);
		const inventory = JSON.parse(verified.stdout); assert.equal(inventory.preRelease, false);
		const published = await publishFileCandidate(stage, path.join(artifacts, filename));
		assert.equal(published.sha256, inventory.sha256);
		await fs.rmdir(directory);
		process.stdout.write(JSON.stringify({ ...published, release, files: inventory.files.length }) + '\n');
	} catch (error) {
		process.stderr.write(`Failed VSIX stage retained at ${directory}\n`);
		throw error;
	}
});
