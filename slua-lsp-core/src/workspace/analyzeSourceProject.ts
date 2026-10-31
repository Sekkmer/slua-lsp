import { analyzeTextWithDirectives } from '../diagnostics/engine.js';
import { isIdentifier, isProgramNode, visitAst } from '../parser/ast.js';
import { SluaRegistry } from '../slua/registry.js';
import { slua, type SluaType } from '../slua/types.js';
import { analyzeFunctionReturns, inferValueExports } from '../typing/inferLocals.js';
import { getSourceModuleSnapshot, sourceRequireCalls, type SourceModuleOptions, type SourceModuleDiagnostic, type SourceModuleSnapshot } from './sourceModules.js';
import { normalizePreprocessorContext, withSourceContext } from './sourceContext.js';

export type SourceProjectAnalysis = SourceModuleSnapshot & {
	registry: SluaRegistry;
	diagnostics: SourceModuleDiagnostic[];
	exports: Map<string, SluaType>;
};

/** No module execution or global runtime require declaration. Facts belong to
 * these exact AST nodes and this request; the caller's registry is never mutated. */
export async function analyzeSourceProject(entry: string, base: SluaRegistry, options: SourceModuleOptions & { context?: unknown } = {}): Promise<SourceProjectAnalysis> {
	const context = normalizePreprocessorContext(options.context);
	base = base.sourceContextBase ?? base;
	const snapshot = await getSourceModuleSnapshot(entry, options);
	options.signal?.throwIfAborted();
	const registry = Object.assign(new SluaRegistry(), base, { expressionTypes: new WeakMap<object, SluaType>(), sourceRequireCallees: new WeakSet<object>(), sourceNodeFiles: new WeakMap<object, string>(), sourceFileHashes: new Map(snapshot.graph.modules.map((item) => [item.file, item.sourceSha256])) });
	for (const [file, document] of snapshot.documents) visitAst(document.parsed.ast, (node) => registry.sourceNodeFiles.set(node, file));
	const exports = new Map<string, SluaType>();
	const active = new Set<string>();
	const diagnostics = [...snapshot.graph.diagnostics];
	function infer(file: string): SluaType {
		const cached = exports.get(file);
		if (cached) return cached;
		if (active.has(file)) return slua.unknown();
		active.add(file);
		const document = snapshot.documents.get(file);
		if (!document || document.parsed.diagnostics.length || !isProgramNode(document.parsed.ast)) {
			active.delete(file); exports.set(file, slua.unknown()); return slua.unknown();
		}
		const calls = sourceRequireCalls(document.parsed.ast);
		const documentRegistry = withSourceContext(document.parsed.ast, file, registry, context);
		const edges = snapshot.graph.edges.filter((edge) => edge.from === file);
		for (const [index, call] of calls.entries()) {
			const edge = edges[index];
			const type = edge?.target ? infer(edge.target) : slua.unknown();
			if (isIdentifier(call.callee)) {
				registry.sourceRequireCallees.add(call.callee);
				registry.expressionTypes.set(call.callee, slua.fn([slua.string()], type));
			}
			registry.expressionTypes.set(call, type);
		}
		const named = document.parsed.ast.body.some((node) => !!node && typeof node === 'object' && 'exported' in node && node.exported && 'type' in node && node.type !== 'TypeAlias') ? inferValueExports(document.parsed.ast, documentRegistry) : undefined;
		const returns = named ? undefined : analyzeFunctionReturns({ type: 'Function', parameters: [], body: document.parsed.ast.body }, documentRegistry, new Map());
		const type = named ?? (returns?.type.kind === 'tuple' ? returns.type.items[0] ?? slua.nil() : returns?.type ?? slua.unknown());
		exports.set(file, type);
		diagnostics.push(...analyzeTextWithDirectives(document.text, { ast: document.parsed.ast, registry: documentRegistry, eventSignatures: registry.eventSignatures }).map((item) => ({ ...item, file })));
		active.delete(file);
		return type;
	}
	infer(snapshot.graph.entry);
	const document = snapshot.documents.get(snapshot.graph.entry);
	return { ...snapshot, registry: withSourceContext(document?.parsed.ast, snapshot.graph.entry, registry, context), diagnostics, exports };
}
