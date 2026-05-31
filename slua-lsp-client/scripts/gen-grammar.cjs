/*
 * Generates the built-in SLua lists in the TextMate grammar from SluaRegistry.
 *
 * Keeps the fallback TextMate highlighting aligned with the registry-driven
 * semantic tokens without hand-editing regex alternations.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function escapeForRegexAlternation(value) {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function sortedAlternation(values) {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b)).map(escapeForRegexAlternation).join('|');
}

function main() {
	const repoRoot = path.resolve(__dirname, '..', '..');
	const coreRegistryPath = path.resolve(repoRoot, 'slua-lsp-core', 'out', 'slua', 'registry.js');
	if (!fs.existsSync(coreRegistryPath)) {
		throw new Error(`Missing core build output at ${coreRegistryPath}. Run: pnpm -C ../slua-lsp-core build`);
	}

	// Load from the built core output (CommonJS).
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { buildSluaRegistryFromLslDefinitions } = require(coreRegistryPath);
	const registry = buildSluaRegistryFromLslDefinitions(null);

	const objectTypeNames = [...registry.objectTypes.keys()];
	const moduleNames = [...registry.modules.keys()];
	const globalFunctionNames = [...registry.globals.keys()];

	const methodNames = [];
	for (const obj of registry.objectTypes.values()) {
		for (const methodName of Object.keys(obj.methods ?? {})) methodNames.push(methodName);
	}

	const typeAlt = sortedAlternation(objectTypeNames);
	const moduleAlt = sortedAlternation(moduleNames);
	const globalAlt = sortedAlternation(globalFunctionNames);
	const methodAlt = sortedAlternation(methodNames);

	if (!typeAlt) throw new Error('No object types found in registry; cannot generate grammar.');
	if (!moduleAlt) throw new Error('No modules found in registry; cannot generate grammar.');
	if (!globalAlt) throw new Error('No globals found in registry; cannot generate grammar.');
	if (!methodAlt) throw new Error('No intrinsic methods found in registry; cannot generate grammar.');

	const grammarPath = path.resolve(__dirname, '..', 'syntaxes', 'luau.tmLanguage.json');
	const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));

	const patterns = grammar?.repository?.slua?.patterns;
	if (!Array.isArray(patterns)) throw new Error('Unexpected grammar shape: repository.slua.patterns not found.');

	for (const entry of patterns) {
		if (!entry || typeof entry !== 'object') continue;

		if (entry.name === 'support.type.luau') {
			entry.match = `\\b(${typeAlt})\\b`;
		}
		if (entry.name === 'support.module.luau') {
			entry.match = `\\b(${moduleAlt})\\b`;
		}
		if (entry.name === 'support.function.luau') {
			entry.match = `\\b(${globalAlt})\\b`;
		}

		// Intrinsic member access: <Type>[:.]<method>
		if (entry.name === 'meta.member.luau' && typeof entry.match === 'string' && entry.match.includes('([:.])')) {
			// Heuristic: this rule is the intrinsic methods one.
			if (entry.match.includes('LLEvents') || entry.match.includes('LLTimers')) {
				entry.match = `\\b(${typeAlt})\\s*([:.])\\s*(${methodAlt})\\b`;
			}
		}

		// Module/table member access: <Module>.<ident>
		if (entry.name === 'meta.member.luau' && typeof entry.match === 'string' && entry.match.includes('\\s*\\.\\s*')) {
			if (entry.match.includes('ll') || entry.match.includes('llcompat')) {
				entry.match = `\\b(${moduleAlt})\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\b`;
			}
		}
	}

	fs.writeFileSync(grammarPath, JSON.stringify(grammar, null, '\t') + '\n');
}

main();
