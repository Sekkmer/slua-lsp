import fs from 'node:fs/promises';
import { accessSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';

export type LslDefinitions = unknown;

function findWorkspaceRoot(startDir: string): string {
	let current = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(current, 'pnpm-workspace.yaml');
		try {
			accessSync(candidate);
			return current;
		} catch {
			// keep walking
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return startDir;
		}
		current = parent;
	}
}

export function getBundledLslDefinitionsYamlPath(): string {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	return path.join(workspaceRoot, 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');
}

export async function loadLslDefinitionsFromYamlFile(
	filePath = process.env.SLUA_LSP_DEFS_PATH ?? getBundledLslDefinitionsYamlPath()
): Promise<LslDefinitions> {
	const text = await fs.readFile(filePath, 'utf8');
	return loadLslDefinitionsFromSource(text, filePath);
}

export function loadLslDefinitionsFromSource(source: string, sourceName = '<lsl_definitions.yaml>'): LslDefinitions {
	const defs = yaml.load(source) as LslDefinitions;
	if (!defs || typeof defs !== 'object') {
		throw new Error(`LSL definitions YAML did not parse to an object: ${sourceName}`);
	}
	return defs;
}
