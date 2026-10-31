import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishDirectoryCandidate, publishFileCandidate, verifyDirectoryManifest, withArtifactLock } from '../artifact-publication.mjs';

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slua-artifact-publication-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	async function candidate(name, content) {
		const directory = path.join(root, name); await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, 'cli.mjs'), content);
		const sha = crypto.createHash('sha256').update(content).digest('hex');
		await fs.writeFile(path.join(directory, 'SHA256SUMS'), `${sha}  cli.mjs\n`);
		return directory;
	}
	return { root, candidate };
}

test('complete candidate replaces the old one and preserves the whole old directory', async (t) => {
	const { candidate } = await fixture(t);
	const destination = await candidate('cli', 'old'); const stage = await candidate('stage', 'new');
	const result = await publishDirectoryCandidate(stage, destination);
	assert.equal(await fs.readFile(path.join(destination, 'cli.mjs'), 'utf8'), 'new');
	assert.equal(await fs.readFile(path.join(result.previousCandidate, 'cli.mjs'), 'utf8'), 'old');
	await verifyDirectoryManifest(result.previousCandidate); await verifyDirectoryManifest(destination);
});
test('corrupt or incomplete stage cannot move or overwrite the current candidate', async (t) => {
	const { candidate } = await fixture(t);
	const destination = await candidate('cli', 'old'); const stage = await candidate('stage', 'new');
	await fs.writeFile(path.join(stage, 'cli.mjs'), 'corrupted');
	await assert.rejects(publishDirectoryCandidate(stage, destination), /hash mismatch/);
	assert.equal(await fs.readFile(path.join(destination, 'cli.mjs'), 'utf8'), 'old');
	await fs.writeFile(path.join(stage, 'cli.mjs'), 'new'); await fs.writeFile(path.join(stage, 'extra'), 'unlisted');
	await assert.rejects(publishDirectoryCandidate(stage, destination), /cover every file/);
});
test('failed activation restores the old candidate and retains the staged bytes', async (t) => {
	const { candidate } = await fixture(t);
	const destination = await candidate('cli', 'old'); const stage = await candidate('stage', 'new');
	await assert.rejects(publishDirectoryCandidate(stage, destination, { rename: async (from, to) => {
		if (from === stage) throw Object.assign(new Error('simulated activation error'), { code: 'EIO' });
		await fs.rename(from, to);
	} }), /simulated activation error/);
	assert.equal(await fs.readFile(path.join(destination, 'cli.mjs'), 'utf8'), 'old');
	assert.equal(await fs.readFile(path.join(stage, 'cli.mjs'), 'utf8'), 'new');
});
test('failed rollback identifies preserved history instead of deleting either candidate', async (t) => {
	const { root, candidate } = await fixture(t);
	const destination = await candidate('cli', 'old'); const stage = await candidate('stage', 'new');
	await assert.rejects(publishDirectoryCandidate(stage, destination, { rename: async (from, to) => {
		if (to === destination) throw new Error('simulated failure');
		await fs.rename(from, to);
	} }), /previous bytes remain at/);
	const [archived] = await fs.readdir(path.join(root, 'history'));
	assert.equal(await fs.readFile(path.join(root, 'history', archived, 'cli.mjs'), 'utf8'), 'old');
	assert.equal(await fs.readFile(path.join(stage, 'cli.mjs'), 'utf8'), 'new');
});
test('concurrent producer cannot acquire or remove the first producer lock', async (t) => {
	const { root } = await fixture(t); const lock = path.join(root, 'lock');
	await withArtifactLock(lock, async () => {
		const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8');
		await assert.rejects(withArtifactLock(lock, async () => assert.fail('entered twice')), { code: 'EEXIST' });
		assert.equal(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'), owner);
	});
	await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
	await assert.rejects(withArtifactLock(lock, async () => { throw new Error('failed build'); }), /failed build/);
	await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});
test('fresh publication works and unsafe, duplicate and symlink entries are rejected', async (t) => {
	const { root, candidate } = await fixture(t); const stage = await candidate('stage', 'new');
	const destination = path.join(root, 'cli');
	assert.equal((await publishDirectoryCandidate(stage, destination)).previousCandidate, null);
	const manifest = await fs.readFile(path.join(destination, 'SHA256SUMS'), 'utf8');
	await fs.writeFile(path.join(destination, 'SHA256SUMS'), manifest + manifest);
	await assert.rejects(verifyDirectoryManifest(destination), /duplicate/);
	await fs.writeFile(path.join(destination, 'SHA256SUMS'), 'a'.repeat(64) + '  ../outside\n');
	await assert.rejects(verifyDirectoryManifest(destination), /Invalid candidate hash entry/);
	await fs.writeFile(path.join(destination, 'SHA256SUMS'), manifest);
	await fs.symlink('cli.mjs', path.join(destination, 'linked'));
	await assert.rejects(verifyDirectoryManifest(destination), /regular files/);
});

test('file replacement preserves exact previous archive bytes and reuses verified history', async (t) => {
	const { root } = await fixture(t); const destination = path.join(root, 'candidate.vsix'); const stage = path.join(root, 'stage.vsix');
	await fs.writeFile(destination, 'old'); await fs.writeFile(stage, 'new');
	const result = await publishFileCandidate(stage, destination);
	assert.equal(await fs.readFile(destination, 'utf8'), 'new');
	assert.equal(await fs.readFile(result.previousCandidate, 'utf8'), 'old');
	await fs.writeFile(destination, 'old'); await fs.writeFile(stage, 'newer');
	assert.equal((await publishFileCandidate(stage, destination)).previousCandidate, result.previousCandidate);
	assert.equal(await fs.readFile(destination, 'utf8'), 'newer');
});
test('archive activation failure leaves the old slot and staged bytes intact', async (t) => {
	const { root } = await fixture(t); const destination = path.join(root, 'candidate.vsix'); const stage = path.join(root, 'stage.vsix');
	await fs.writeFile(destination, 'old'); await fs.writeFile(stage, 'new');
	await assert.rejects(publishFileCandidate(stage, destination, { rename: async () => { throw new Error('activation error'); } }), /activation error/);
	assert.equal(await fs.readFile(destination, 'utf8'), 'old'); assert.equal(await fs.readFile(stage, 'utf8'), 'new');
});
test('corrupt history and symbolic archive slots are refused before publication', async (t) => {
	const { root } = await fixture(t); const destination = path.join(root, 'candidate.vsix'); const stage = path.join(root, 'stage.vsix');
	await fs.writeFile(destination, 'old'); await fs.writeFile(stage, 'new');
	const result = await publishFileCandidate(stage, destination);
	await fs.writeFile(result.previousCandidate, 'corrupt'); await fs.writeFile(destination, 'old'); await fs.writeFile(stage, 'new');
	await assert.rejects(publishFileCandidate(stage, destination), /history is corrupt/);
	assert.equal(await fs.readFile(destination, 'utf8'), 'old');
	await fs.rm(destination); await fs.symlink(stage, destination);
	await assert.rejects(publishFileCandidate(stage, destination), /regular file/);
	assert.equal(await fs.readFile(stage, 'utf8'), 'new');
});
