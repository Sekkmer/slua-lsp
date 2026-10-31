import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readReleaseMetadata } from './release-metadata.mjs';

const release = await readReleaseMetadata();
assert.equal(process.argv[2], `v${release.version}`, 'Release tag must match every package version');
const changelog = await fs.readFile(new URL('../slua-lsp-client/CHANGELOG.md', import.meta.url), 'utf8');
const marker = `## ${release.version}\n`;
const start = changelog.indexOf(marker);
assert.ok(start >= 0, 'Release version is missing from the changelog');
const rest = changelog.slice(start + marker.length);
const end = rest.search(/^## /m);
const notes = (end < 0 ? rest : rest.slice(0, end)).trim();
assert.ok(notes, 'Release notes are empty');
console.log(notes);
