import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The lock is never reclaimed automatically: a crashed owner needs inspection.
export async function withArtifactLock(filename, action) {
	await fs.mkdir(filename);
	try {
		await fs.writeFile(path.join(filename, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
		return await action();
	} finally { await fs.rm(filename, { recursive: true }); }
}

export async function verifyDirectoryManifest(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	assert.ok(entries.every((entry) => entry.isFile()), 'Candidate must contain only regular files');
	const manifest = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
	const names = new Set();
	for (const line of manifest.trimEnd().split('\n')) {
		const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
		assert.ok(match, 'Invalid candidate hash entry');
		const [, expected, name] = match;
		assert.ok(name !== '.' && name !== '..' && name !== 'SHA256SUMS' && !names.has(name), 'Invalid or duplicate candidate filename');
		names.add(name);
		assert.equal(digest(await fs.readFile(path.join(directory, name))), expected, `Candidate hash mismatch: ${name}`);
	}
	assert.deepEqual([...names].sort(), entries.filter((entry) => entry.name !== 'SHA256SUMS').map((entry) => entry.name).sort(), 'Candidate manifest must cover every file');
	return digest(manifest);
}

// Caller holds its artifact lock. Build/validate everything before moving the
// previous candidate; directory replacement has a short rename gap, with rollback.
export async function publishDirectoryCandidate(stage, destination, { rename = fs.rename } = {}) {
	const sha256 = await verifyDirectoryManifest(stage);
	const history = path.join(path.dirname(destination), 'history');
	let archived;
	let previous;
	try { previous = await fs.lstat(destination); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	if (previous) {
		assert.ok(previous.isDirectory(), 'Previous candidate must be a directory');
		await fs.mkdir(history, { recursive: true });
		archived = path.join(history, `${path.basename(destination)}-${crypto.randomUUID()}`);
		await rename(destination, archived);
	}
	try { await rename(stage, destination); }
	catch (error) {
		if (archived) {
			try { await rename(archived, destination); }
			catch (rollback) { throw new AggregateError([error, rollback], `Candidate publication and rollback failed; previous bytes remain at ${archived}`); }
		}
		throw error;
	}
	return { destination, manifestSha256: sha256, previousCandidate: archived ?? null };
}

// Caller validates the staged archive and holds its artifact lock. Preserve old
// bytes first, then replace one file with an atomic same-filesystem rename.
export async function publishFileCandidate(stage, destination, { rename = fs.rename } = {}) {
	assert.ok((await fs.lstat(stage)).isFile(), 'Staged candidate must be a regular file');
	const sha256 = digest(await fs.readFile(stage));
	let previous;
	try { previous = await fs.lstat(destination); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	let archived;
	if (previous) {
		assert.ok(previous.isFile(), 'Previous candidate must be a regular file');
		const bytes = await fs.readFile(destination); const oldSha256 = digest(bytes);
		const history = path.join(path.dirname(destination), 'history'); await fs.mkdir(history, { recursive: true });
		archived = path.join(history, `${oldSha256}${path.extname(destination)}`);
		try { await fs.writeFile(archived, bytes, { flag: 'wx' }); }
		catch (error) {
			if (error.code !== 'EEXIST') throw error;
			assert.equal(digest(await fs.readFile(archived)), oldSha256, `Existing artifact history is corrupt: ${archived}`);
		}
	}
	await rename(stage, destination);
	return { destination, sha256, previousCandidate: archived ?? null };
}
