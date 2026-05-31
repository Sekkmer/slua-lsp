#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	analyzeTextWithDirectives,
	buildSluaRegistryFromLslDefinitions,
	loadLslDefinitionsFromYamlFile,
	parseSlua,
	type CoreDiagnostic
} from 'slua-lsp-core';

type OutputFormat = 'text' | 'json';

type CliOptions = {
	command: 'check' | 'help' | 'version';
	files: string[];
	defsPath?: string;
	format: OutputFormat;
};

type FileDiagnostic = CoreDiagnostic & {
	file: string;
};

export async function run(argv: string[], io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }): Promise<number> {
	const options = parseArgs(argv);
	if (options.command === 'help') {
		io.stdout.write(usage());
		return 0;
	}
	if (options.command === 'version') {
		io.stdout.write('slua-lsp 0.0.0\n');
		return 0;
	}
	if (options.files.length === 0) {
		io.stderr.write(`${usage()}error: no input files\n`);
		return 2;
	}

	const defs = await loadLslDefinitionsFromYamlFile(options.defsPath);
	const registry = buildSluaRegistryFromLslDefinitions(defs);
	const diagnostics: FileDiagnostic[] = [];

	for (const file of options.files) {
		const absolute = path.resolve(file);
		const text = await fs.readFile(absolute, 'utf8');
		const parsed = parseSlua(text);
		diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, file })));
		if (parsed.ast) {
			const coreDiagnostics = analyzeTextWithDirectives(text, {
				ast: parsed.ast,
				registry,
				eventSignatures: registry.eventSignatures
			});
			diagnostics.push(...coreDiagnostics.map((diagnostic) => ({ ...diagnostic, file })));
		}
	}

	writeDiagnostics(options.format, diagnostics, io.stdout);
	return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;
}

function parseArgs(argv: string[]): CliOptions {
	const args = argv.slice(2);
	const command: CliOptions['command'] = 'check';
	let format: OutputFormat = 'text';
	let defsPath: string | undefined;
	const files: string[] = [];

	if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return { command: 'help', files, format };
	if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') return { command: 'version', files, format };
	if (args[0] === 'check') args.shift();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--') {
			files.push(...args.slice(i + 1));
			break;
		}
		if (arg === '--defs') {
			defsPath = requireValue(args, ++i, '--defs');
			continue;
		}
		if (arg.startsWith('--defs=')) {
			defsPath = arg.slice('--defs='.length);
			continue;
		}
		if (arg === '--format') {
			format = parseFormat(requireValue(args, ++i, '--format'));
			continue;
		}
		if (arg.startsWith('--format=')) {
			format = parseFormat(arg.slice('--format='.length));
			continue;
		}
		if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
		files.push(arg);
	}

	return { command, files, defsPath, format };
}

function requireValue(args: string[], index: number, option: string): string {
	const value = args[index];
	if (!value) throw new Error(`missing value for ${option}`);
	return value;
}

function parseFormat(value: string): OutputFormat {
	if (value === 'text' || value === 'json') return value;
	throw new Error(`unknown format: ${value}`);
}

function writeDiagnostics(format: OutputFormat, diagnostics: FileDiagnostic[], stdout: NodeJS.WritableStream): void {
	if (format === 'json') {
		stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
		return;
	}

	for (const diagnostic of diagnostics) {
		const line = diagnostic.range.start.line + 1;
		const column = diagnostic.range.start.character + 1;
		stdout.write(`${diagnostic.file}:${line}:${column}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
	}
}

function usage(): string {
	return [
		'Usage: slua-lsp check [options] <files...>',
		'',
		'Options:',
		'  --defs <path>       Use a specific lsl_definitions.yaml file',
		'  --format <format>   text or json',
		'  -h, --help          Show help',
		'  -v, --version       Show version',
		''
	].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	run(process.argv, process).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
			process.exitCode = 2;
		}
	);
}
