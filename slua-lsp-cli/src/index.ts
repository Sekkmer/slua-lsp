import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { SourceTextIndex } from 'slua-lsp-core';

import {
	SLUA_LSP_VERSION as VERSION, preprocessSource, normalizePreprocessorContext, withSourceContext, resolvePreprocessedPosition, readSourceModuleFile, analyzeSourceProject, sourceRequireCalls, getSourceModuleGraph, collectSourceRequires, sourceModuleRangeContains, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, cachedDefinitionPath,
	DEFAULT_DEFINITIONS_UPDATE_URL, getBundledLslDefinitionsYamlPath, loadLslDefinitionsFromYamlFile,
	parseSlua, getCodeActions, type CoreCodeAction, sluaTypeToString, readDefinitionUpdateMetadata, updateDefinitions, type CoreDiagnostic,
	findDefinitionAtPosition, findAllReferences, getRenameEdits, prepareRename, isValidRenameIdentifier, getHover, getDocumentSymbols
} from 'slua-lsp-core';

export const CLI_SCHEMA = 'slua-lsp.cli.v1';
const COMMANDS = ['check', 'modules', 'preprocess', 'definition', 'references', 'rename', 'hover', 'symbols', 'update-defs', 'dump-defs', 'lookup', 'capabilities', 'help', 'version'] as const;
const NAVIGATION_COMMANDS = new Set<Command>(['definition', 'references', 'rename', 'hover']);
type Command = typeof COMMANDS[number];
type Options = {
	command: Command; files: string[]; json: boolean; defsPath?: string; cacheDir: string;
	updateUrl: string; autoUpdate: boolean; includeActions: boolean; warningsAsErrors: boolean; stdinFilepath: string;
	position?: { line: number; character: number }; newName?: string; excludeDeclaration: boolean; maxModuleDepth?: number; preprocessorContext?: string;
	generatedPosition?: { line: number; character: number }; generatedSha256?: string;
};
type IO = {
	stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream;
	stdin?: AsyncIterable<string | Uint8Array>;
};
type FileDiagnostic = CoreDiagnostic & { file: string };
class CliError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

export async function run(argv: string[], io: IO): Promise<number> {
	let options: Options | undefined;
	const alwaysJson = ['modules', 'preprocess', 'capabilities'].includes(argv[2] ?? '');
	const wantsJson = alwaysJson || argv.slice(2).some((arg, i, args) => arg === '--json' || arg === '--format=json' || (arg === '--format' && args[i + 1] === 'json'));
	try {
		options = parseArgs(argv.slice(2));
		if (options.command === 'help') {
			io.stdout.write(options.json ? encode({ command: 'help', usage: usage() }) : usage());
			return 0;
		}
		if (options.command === 'version') {
			io.stdout.write(options.json ? encode({ command: 'version', version: VERSION }) : `slua-lsp ${VERSION}\n`);
			return 0;
		}
		if (options.command === 'capabilities') {
			io.stdout.write(encode({ command: 'capabilities', version: VERSION, commands: COMMANDS,
				formats: ['text', 'json'], stdin: true, maximumStdinBytes: 8388608, maximumSourceFileBytes: 8388608,
				sourceEncoding: 'strict UTF-8; BOM retained; binary NUL refused', positionEncoding: 'utf-16', positionBase: 0, sourceLineBreaks: ['CRLF', 'CR', 'LF'],
				exitCodes: { success: 0, diagnostics: 1, usageOrOperationalError: 2 },
				codeActions: { flag: '--include-actions', automaticApplication: false, sourceHash: 'sha256', kinds: ['quickfix'] },
				navigation: { commands: ['definition', 'references', 'rename'], scope: 'document-local lexical values and proven class type references, including typeof expressions; definitions additionally follow proven source table-member origins',
					modulePaths: 'literal require targets and proven exported field definitions carry exact source files; imported fields include target source hashes',
					positionFlag: '--position', positionFormat: 'zero-based-line:UTF-16-character', automaticApplication: false, sourceHash: 'sha256',
					unsupported: ['field references/rename', 'type aliases', 'dynamic globals', 'cross-file symbol index/references/rename'], renameRejectsBindingCapture: true, classTypeRename: true, opaqueAnnotationRename: 'refused when the selected or new name occurs in unclassified syntax' },
				inspection: { commands: ['hover', 'symbols'], scope: 'source AST and shared registry', symbolKinds: ['variable', 'function', 'method', 'class', 'field', 'type'],
					hoverFormat: 'markdown', sourceHash: 'sha256', automaticApplication: false },
				modules: { command: 'modules', scope: 'literal source require dependency graph', sourceHash: 'sha256', executesCode: false,
					defaultDepth: 5, maximumDepth: 50, maximumModules: 256, maximumFileBytes: 8388608, maximumTotalBytes: 33554432,
					aliases: 'nearest .luaurc JSONC config wins; case-insensitive names; chains use declaring-config scope', ordinaryCheckFollowsImports: true,
					exportTypes: ['scalar values', 'literal and incrementally assigned table fields', 'dot/colon function contracts', 'conditional return unions'],
					unsupported: ['generated-code execution', 'executable .config.luau', 'native @self contexts', 'cross-file symbol rename'] },
				preprocessing: { command: 'preprocess', profile: 'slua-sandbox-cache-v1', executesCode: false, writesFiles: false,
					format: 'json', mappings: 'zero-based UTF-16 ranges; generated helpers unmapped', maximumGeneratedBytes: 50331648,
					mapPositionFlag: '--generated-position', expectedOutputHashFlag: '--generated-sha256', mappingRequiresMatchingGeneratedAndSourceHashes: true,
					contextFlag: '--preprocessor-context', context: 'explicit JSON object with optional agentId, agentName, UTC ISO timestamp; missing values are never guessed' },
				sourceContext: { flag: '--preprocessor-context', commands: ['check', 'hover', 'symbols', 'definition', 'references', 'rename', 'preprocess'],
					default: 'disabled', emptyObject: 'enable file/line macros', missingValues: 'diagnosed at macro use', runtimeGlobals: false },
				network: 'offline by default; only update-defs or --auto-update-defs use the network' }));
			return 0;
		}
		let context: import('slua-lsp-core').PreprocessorContext | undefined;
		let contextSource: { file: string; sha256: string } | undefined;
		if (options.preprocessorContext) {
			try {
				const text = await readSourceModuleFile(options.preprocessorContext);
				if (text === undefined || Buffer.byteLength(text) > 65536) throw new CliError('preprocessor-context', 'Preprocessor context must be a regular JSON file of at most 65536 bytes');
				context = normalizePreprocessorContext(JSON.parse(text)); contextSource = { file: options.preprocessorContext, sha256: createHash('sha256').update(text).digest('hex') };
			} catch (error) { throw new CliError('preprocessor-context', (error as Error).message); }
		}
		if (options.command === 'preprocess') {
			const input = options.files[0]!, entry = input === '-' ? options.stdinFilepath : input;
			const entryText = input === '-' ? await readStdin(io.stdin ?? process.stdin) : undefined;
			const result = await preprocessSource(entry, { maxDepth: options.maxModuleDepth, context, entryText });
			let mappedSource: import('slua-lsp-core').PreprocessedSourceLocation | { status: 'generated-changed'; expectedSha256: string; actualSha256: string } | undefined;
			if (result.success && options.generatedPosition) {
				mappedSource = result.contentSha256 !== options.generatedSha256
					? { status: 'generated-changed', expectedSha256: options.generatedSha256!, actualSha256: result.contentSha256! }
					: await resolvePreprocessedPosition(result, options.generatedPosition, { readFile: async (file) => file === result.graph.entry && entryText !== undefined ? entryText : readSourceModuleFile(file) });
			}
			const exitCode = !result.success ? result.diagnostics.some((item) => item.code === 'module-input') ? 2 : 1
				: mappedSource?.status === 'unavailable' ? 2 : mappedSource && mappedSource.status !== 'mapped' ? 1 : 0;
			io.stdout.write(encode({ command: 'preprocess', ...result, ...(contextSource ? { contextSource } : {}), ...(mappedSource ? { mappedSource } : {}), exitCode }));
			return exitCode;
		}
		if (options.command === 'modules') {
			const input = options.files[0]!;
			const entry = input === '-' ? options.stdinFilepath : input;
			const graph = await getSourceModuleGraph(entry, { maxDepth: options.maxModuleDepth,
				...(input === '-' ? { entryText: await readStdin(io.stdin ?? process.stdin) } : {}) });
			const exitCode = graph.diagnostics.some((item) => item.code === 'module-input') ? 2 : graph.diagnostics.length ? 1 : 0;
			io.stdout.write(encode({ command: 'modules', ...graph, exitCode }));
			return exitCode;
		}
		if (options.command === 'update-defs') {
			if (options.defsPath) throw new CliError('usage', 'update-defs cannot replace an explicit --defs path');
			const result = await updateDefinitions({ cacheDir: options.cacheDir, sourceUrl: options.updateUrl });
			io.stdout.write(options.json ? encode({ command: 'update-defs', ...result }) : `Definitions ${result.updated ? 'updated' : 'current'}: ${result.definitionsPath} (${result.metadata.version})\n`);
			return 0;
		}
		if (options.command === 'check' && options.files.length === 0) throw new CliError('usage', 'No input files. Use check <files/directories...> or check - --stdin-filepath script.luau');
		if (options.autoUpdate) {
			if (options.defsPath || process.env.SLUA_LSP_DEFS_PATH) throw new CliError('usage', '--auto-update-defs cannot override --defs or SLUA_LSP_DEFS_PATH');
			await updateDefinitions({ cacheDir: options.cacheDir, sourceUrl: options.updateUrl });
		}
		const definitionsPath = options.defsPath ?? process.env.SLUA_LSP_DEFS_PATH ?? await cachedDefinitionPath(options.cacheDir) ?? getBundledLslDefinitionsYamlPath();
		const defs = await loadLslDefinitionsFromYamlFile(definitionsPath);
		let registry = buildSluaRegistryFromLslDefinitions(defs);
		if (NAVIGATION_COMMANDS.has(options.command) || options.command === 'symbols') {
			const file = options.files[0]!;
			const label = file === '-' ? options.stdinFilepath : file;
			const text = file === '-' ? await readStdin(io.stdin ?? process.stdin) : await readInputFile(file);
			const position = options.position;
			if (position && new SourceTextIndex(text).offsetAt(position) === undefined) throw new CliError('position', '--position is outside the source buffer');
			const parsed = parseSlua(text);
			if (!parsed.diagnostics.length && sourceRequireCalls(parsed.ast).length) {
				const entry = path.resolve(label);
				registry = (await analyzeSourceProject(entry, registry, { context, entryText: text, parseFile: (name, source) => name === entry ? parsed : parseSlua(source) })).registry;
			} else registry = withSourceContext(parsed.ast, path.resolve(label), registry, context);
			const sourceSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
			const range = (identifier: { location?: { start: { line: number; column: number }; end: { line: number; column: number } } }) => ({
				start: { line: identifier.location!.start.line - 1, character: identifier.location!.start.column - 1 },
				end: { line: identifier.location!.end.line - 1, character: identifier.location!.end.column - 1 }
			});
			let result: unknown = null;
			let status = 'not-found';
			if (parsed.diagnostics.length) status = 'parse-error';
			else if (options.command === 'symbols') { result = getDocumentSymbols(parsed.ast); status = 'found'; }
			else if (options.command === 'hover') { result = getHover(parsed.ast, position!, registry); if (result) status = 'found'; }
			else if (options.command === 'definition') {
				if (collectSourceRequires(parsed.ast).some((include) => include.specifier !== undefined && sourceModuleRangeContains(include.range, position!))) {
					const graph = await getSourceModuleGraph(label, { entryText: text });
					const edge = graph.edges.find((include) => include.from === graph.entry && sourceModuleRangeContains(include.range, position!));
					if (edge?.target) { result = { name: edge.specifier, kind: 'module', file: edge.target,
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }; status = 'found'; }
				} else {
					const definition = findDefinitionAtPosition(parsed.ast, position!, registry, text);
					if (definition) { result = { name: definition.name, kind: definition.kind, file: definition.kind === 'field' ? definition.file ?? label : label, range: range(definition.identifier), ...(definition.kind === 'field' && definition.sourceSha256 ? { sourceSha256: definition.sourceSha256 } : {}) }; status = 'found'; }
				}
			} else if (options.command === 'references') {
				result = findAllReferences(parsed.ast, position!, registry, !options.excludeDeclaration).map((ref) => ({ file: label, range: range(ref.identifier), kind: ref.kind }));
				if ((result as unknown[]).length) status = 'found';
			} else if (prepareRename(parsed.ast, position!, registry)) {
				const edits = getRenameEdits(parsed.ast, position!, options.newName!, registry);
				result = edits.map((edit) => ({ file: label, range: range(edit.identifier), newText: edit.newName }));
				status = edits.length ? 'found' : 'binding-conflict';
			}
			const exitCode = status === 'found' ? 0 : 1;
			io.stdout.write(encode({ command: options.command, file: label, sourceSha256, position, definitionsPath, ...(contextSource ? { contextSource } : {}),
				status, result, diagnostics: parsed.diagnostics, exitCode }));
			return exitCode;
		}
		if (options.command === 'lookup') {
			const query = options.files[0]!;
			const parts = query.split('.');
			const member = parts.length > 1 ? parts.pop() : undefined;
			const parent = parts.join('.');
			const namespace = registry.getModule(query);
			if (namespace && query.includes('.')) {
				io.stdout.write(encode({ command: 'lookup', query, definitionsPath, signature: 'table', kind: 'module', definition: namespace }));
				return 0;
			}
			const module = registry.getModule(parent!);
			const object = registry.getObjectType(parent!);
			const definition = member ? module?.functions[member] ?? module?.values[member] ?? object?.methods[member] ?? object?.properties[member] : registry.getGlobal(parent!) ?? registry.getGlobalValue(parent!);
			if (!member && !definition && (module || object)) {
				io.stdout.write(encode({ command: 'lookup', query, definitionsPath, signature: 'table',
					kind: module ? 'module' : 'object', definition: module ?? object }));
				return 0;
			}
			if (!definition) throw new CliError('unknown-symbol', `Unknown builtin: ${query}`);
			const type = 'signature' in definition ? definition.signature : definition.type;
			io.stdout.write(encode({ command: 'lookup', query, definitionsPath, signature: sluaTypeToString(type), definition }));
			return 0;
		}
		if (options.command === 'dump-defs') {
			const cache = await readDefinitionUpdateMetadata(options.cacheDir);
			io.stdout.write(encode({ command: 'dump-defs', definitionsPath, cache,
				modules: Object.fromEntries(registry.modules), globals: Object.fromEntries(registry.globals), globalValues: Object.fromEntries(registry.globalValues),
				objectTypes: Object.fromEntries(registry.objectTypes), events: registry.eventSignatures }));
			return 0;
		}
		const diagnostics: FileDiagnostic[] = [];
		const actions: Array<CoreCodeAction & { file: string; sourceSha256: string }> = [];
		const files = await expandInputs(options.files);
		const checked = new Set<string>();
		for (const file of files) {
			const label = file === '-' ? options.stdinFilepath : file;
			if (file !== '-' && checked.has(path.resolve(file))) continue;
			const text = file === '-' ? await readStdin(io.stdin ?? process.stdin) : await readInputFile(file);
			const parsed = parseSlua(text);
			if (!parsed.diagnostics.length && sourceRequireCalls(parsed.ast).length) {
				const entry = path.resolve(label);
				const project = await analyzeSourceProject(entry, registry, { context, entryText: text, maxDepth: options.maxModuleDepth,
					parseFile: (name, source) => name === entry ? parsed : parseSlua(source) });
				for (const diagnostic of project.diagnostics) if (!checked.has(diagnostic.file)) diagnostics.push({ ...diagnostic, file: diagnostic.file === entry ? label : diagnostic.file });
				for (const [name, document] of project.documents) {
					if (options.includeActions && document.parsed.ast && !checked.has(name)) {
						const sourceSha256 = createHash('sha256').update(document.text).digest('hex');
						actions.push(...getCodeActions(document.text, document.parsed.ast, project.diagnostics.filter((item) => item.file === name))
							.map((action) => ({ ...action, file: name === entry ? label : name, sourceSha256 })));
					}
					checked.add(name);
				}
				continue;
			}
			checked.add(path.resolve(label));
			diagnostics.push(...parsed.diagnostics.map((d) => ({ ...d, file: label })));
			if (parsed.ast) {
				const sourceRegistry = withSourceContext(parsed.ast, path.resolve(label), registry, context);
				const semantic = analyzeTextWithDirectives(text, { ast: parsed.ast, registry: sourceRegistry, eventSignatures: registry.eventSignatures });
				diagnostics.push(...semantic.map((d) => ({ ...d, file: label })));
				if (options.includeActions) {
					const sourceSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
					actions.push(...getCodeActions(text, parsed.ast, semantic).map((action) => ({ ...action, file: label, sourceSha256 })));
				}
			}
		}
		diagnostics.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.code.localeCompare(b.code, 'en'));
		const errors = diagnostics.filter((d) => d.severity === 'error').length;
		const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
		const exitCode = errors || (options.warningsAsErrors && warnings) ? 1 : 0;
		if (options.json) io.stdout.write(encode({ command: 'check', diagnostics, ...(contextSource ? { contextSource } : {}), ...(options.includeActions ? { actions } : {}), summary: { files: checked.size, errors, warnings }, exitCode }));
		else for (const d of diagnostics) io.stdout.write(`${d.file}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.severity} ${d.code}: ${d.message}\n`);
		return exitCode;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = err instanceof CliError ? err.code : 'operation-failed';
		if (alwaysJson || (options?.json ?? wantsJson)) io.stdout.write(encode({ command: options?.command ?? (alwaysJson ? argv[2] : null), diagnostics: [], error: { code, message }, exitCode: 2 }));
		else io.stderr.write(`slua-lsp: ${message}\n`);
		return 2;
	}
}

function encode(value: object): string {
	return `${JSON.stringify({ schema: CLI_SCHEMA, ...value }, null, 2)}\n`;
}

function parseArgs(args: string[]): Options {
	const options: Options = {
		command: 'check', files: [], json: false,
		cacheDir: path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'slua-lsp', 'definitions'),
		updateUrl: DEFAULT_DEFINITIONS_UPDATE_URL, autoUpdate: false, includeActions: false, warningsAsErrors: false, stdinFilepath: '<stdin>.luau', excludeDeclaration: false
	};
	if (COMMANDS.includes(args[0] as Command)) options.command = args.shift() as Command;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--') { options.files.push(...args.slice(i + 1)); break; }
		if (arg === '--help' || arg === '-h') { options.command = 'help'; continue; }
		if (arg === '--version' || arg === '-v') { options.command = 'version'; continue; }
		if (arg === '--json') { options.json = true; continue; }
		if (arg === '--auto-update-defs') { options.autoUpdate = true; continue; }
		if (arg === '--include-actions') { options.includeActions = true; continue; }
		if (arg === '--exclude-declaration') { options.excludeDeclaration = true; continue; }
		if (arg === '--warnings-as-errors') { options.warningsAsErrors = true; continue; }
		const [name, ...parts] = arg.split('=');
		if (['--defs', '--cache-dir', '--update-url', '--stdin-filepath', '--format', '--position', '--new-name', '--max-module-depth', '--preprocessor-context', '--generated-position', '--generated-sha256'].includes(name!)) {
			const value = parts.length ? parts.join('=') : args[++i];
			if (!value || value.startsWith('--')) throw new CliError('usage', `Missing value for ${name}`);
			switch (name) {
				case '--defs': options.defsPath = path.resolve(value); break;
				case '--cache-dir': options.cacheDir = path.resolve(value); break;
				case '--update-url': options.updateUrl = value; break;
				case '--stdin-filepath': options.stdinFilepath = value; break;
				case '--new-name': options.newName = value; break;
				case '--preprocessor-context': options.preprocessorContext = path.resolve(value); break;
				case '--generated-sha256':
					if (!/^[0-9a-f]{64}$/i.test(value)) throw new CliError('usage', '--generated-sha256 requires a SHA-256 hex digest');
					options.generatedSha256 = value.toLowerCase(); break;
				case '--max-module-depth':
					if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) throw new CliError('usage', '--max-module-depth must be an integer from 1 to 50');
					options.maxModuleDepth = Number(value); break;
				case '--position':
				case '--generated-position': {
					if (!/^\d+:\d+$/.test(value)) throw new CliError('usage', `${name} requires zero-based LINE:CHARACTER`);
					const [line, character] = value.split(':').map(Number);
					if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character)) throw new CliError('usage', `${name} must contain safe integers`);
					if (name === '--generated-position') options.generatedPosition = { line: line!, character: character! };
					else options.position = { line: line!, character: character! }; break;
				}
				case '--format':
					if (!['text', 'json'].includes(value)) throw new CliError('usage', `Unknown format: ${value}`);
					options.json = value === 'json'; break;
			}
		} else if (arg.startsWith('-') && arg !== '-') throw new CliError('usage', `Unknown option: ${arg}`);
		else options.files.push(arg);
	}
	if (options.includeActions && (options.command !== 'check' || !options.json)) throw new CliError('usage', '--include-actions requires check with --json or --format json');
	if (options.files.filter((f) => f === '-').length > 1) throw new CliError('usage', 'stdin can only be read once');
	if (options.command === 'lookup' && (options.files.length !== 1 || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(options.files[0]!))) throw new CliError('usage', 'lookup requires one builtin name, e.g. ll.Say or vector');
	if (NAVIGATION_COMMANDS.has(options.command) && (options.files.length !== 1 || !options.position)) throw new CliError('usage', `${options.command} requires exactly one file (or -) and --position LINE:CHARACTER`);
	if (options.command === 'symbols' && options.files.length !== 1) throw new CliError('usage', 'symbols requires exactly one file (or -)');
	if (['modules', 'preprocess'].includes(options.command) && options.files.length !== 1) throw new CliError('usage', `${options.command} requires exactly one entry file (or - with --stdin-filepath)`);
	if (options.maxModuleDepth !== undefined && !['modules', 'preprocess', 'check'].includes(options.command)) throw new CliError('usage', '--max-module-depth requires modules, preprocess or check');
	if (['modules', 'preprocess'].includes(options.command) && (options.defsPath || options.autoUpdate)) throw new CliError('usage', `${options.command} uses source files without definitions or automatic network refresh`);
	if (options.preprocessorContext !== undefined && !['preprocess', 'check', 'symbols'].includes(options.command) && !NAVIGATION_COMMANDS.has(options.command)) throw new CliError('usage', '--preprocessor-context requires preprocess, check or source inspection');
	if (options.generatedPosition !== undefined || options.generatedSha256 !== undefined) {
		if (options.command !== 'preprocess' || !options.generatedPosition || !options.generatedSha256) throw new CliError('usage', '--generated-position and --generated-sha256 must be supplied together with preprocess');
	}
	if (!NAVIGATION_COMMANDS.has(options.command) && options.position) throw new CliError('usage', '--position requires a navigation command');
	if (options.command === 'rename' ? !options.newName || !isValidRenameIdentifier(options.newName) : options.newName !== undefined) throw new CliError('usage', '--new-name requires rename and a valid Luau identifier');
	if (options.excludeDeclaration && options.command !== 'references') throw new CliError('usage', '--exclude-declaration requires references');
	if (!['check', 'modules', 'preprocess', 'lookup', 'symbols'].includes(options.command) && !NAVIGATION_COMMANDS.has(options.command) && options.files.length) throw new CliError('usage', `${options.command} does not take file arguments`);
	return options;
}

async function expandInputs(inputs: string[]): Promise<string[]> {
	const files = new Set<string>();
	async function add(input: string, fromDirectory = false): Promise<void> {
		if (input === '-') { files.add(input); return; }
		const info = await fs.lstat(input);
		if (info.isSymbolicLink() && fromDirectory) return;
		if (info.isDirectory()) {
			for (const entry of (await fs.readdir(input, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
				if (['node_modules', '.git', '.local', 'out', 'dist', 'target'].includes(entry.name)) continue;
				if (entry.isDirectory() || /\.(luau|slua|lua)$/i.test(entry.name)) await add(path.join(input, entry.name), true);
			}
		} else if (info.isFile() || (!fromDirectory && info.isSymbolicLink())) files.add(input);
		else throw new CliError('input', `Unsupported input: ${input}`);
	}
	for (const input of inputs) await add(input);
	if (!files.size) throw new CliError('input', 'No Luau source files found');
	return [...files].sort((a, b) => a.localeCompare(b, 'en'));
}

async function readInputFile(file: string): Promise<string> {
	const text = await readSourceModuleFile(file);
	if (text === undefined) throw new CliError('input', `Source file not found (ENOENT) or not a regular file: ${file}`);
	return text;
}

async function readStdin(input: AsyncIterable<string | Uint8Array>): Promise<string> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of input) {
		if (typeof chunk === 'string' && /[\ud800-\udfff]/u.test(chunk)) throw new CliError('input', 'Invalid Unicode stdin');
		const bytes = Buffer.from(chunk); length += bytes.length;
		if (length > 8 * 1024 * 1024) throw new CliError('input', 'stdin exceeds 8388608 bytes');
		chunks.push(bytes);
	}
	const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length));
	if (text.includes('\0')) throw new CliError('input', 'Binary stdin');
	return text;
}

function usage(): string {
	return [
		'Usage: slua-lsp check [options] <files/directories... | ->',
		'       slua-lsp definition|references|hover|rename <file | -> --position LINE:CHARACTER [--new-name NAME]',
		'       slua-lsp symbols <file | ->',
		'       slua-lsp modules <entry | -> [--stdin-filepath PATH] [--max-module-depth 1..50]',
		'       slua-lsp preprocess <entry | -> [--preprocessor-context JSON_FILE] [--max-module-depth 1..50]',
		'       slua-lsp lookup <builtin> | update-defs | dump-defs | capabilities | help | version', '',
		'  --json, --format json     Versioned JSON output (including operational errors)',
		'  --include-actions        Include proposed code edits in check JSON (never writes)',
		'  --position <line:char>   Navigation cursor, zero-based UTF-16 (JSON output)',
		'  --generated-position <line:char>  Map a preprocess output cursor to current source',
		'  --generated-sha256 <hex>  Required matching output hash for --generated-position',
		'  --new-name <name>        Rename edit proposal; refuses binding capture; never writes',
		'  --exclude-declaration    Return only usages with references',
		'  --max-module-depth <n>   Check/modules dependency depth (default 5); modules emits JSON',
		'  --preprocessor-context <file>  Explicit JSON macro context for check/inspection/preprocess',
		'  --defs <path>            Explicit definitions YAML (never auto-overwritten)',
		'  --cache-dir <path>       Definition cache location',
		'  --update-url <url>       Source for explicit definition refresh',
		'  --auto-update-defs       Opt into network refresh before the command',
		'  --stdin-filepath <name>  Diagnostic filename when checking stdin (-)',
		'  --warnings-as-errors    Exit 1 on warnings as well as errors',
		'  -h, --help               Show help',
		'  -v, --version            Show version', '',
		'Exit codes: 0 success, 1 diagnostics/not found/unsafe rename, 2 invalid usage or operational failure.',
		'JSON ranges use zero-based UTF-16 positions. Ordinary checks work offline.', ''
	].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	run(process.argv, process).then((code) => { process.exitCode = code; }, (err) => {
		process.stderr.write(`${String(err)}\n`); process.exitCode = 2;
	});
}
