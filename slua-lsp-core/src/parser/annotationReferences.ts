import { LuaParser } from '../luau/vendor/parsers/lua.js';
import { TokenType } from '../luau/vendor/clients/lexer.js';
import { isAstNode } from './ast.js';
import { normalizeAstLocations } from './astLocations.js';
import { AnnotationReader, type ParsedRegion } from './annotationSyntax.js';
import { typeRegions, typeRegionIndex } from './typeRegions.js';

const parsedRegions = new WeakMap<object, ParsedRegion[]>();
export function annotationReferences(owner: object): readonly ParsedRegion[] {
	let parsed = parsedRegions.get(owner);
	if (!parsed) { parsed = typeRegions(owner).map((region) => new AnnotationReader(region, typeRegionIndex(region), (tokens, current) => {
		const parser = new LuaParser(region.input, region.source), last = tokens.at(-1)!;
		parser.setTokens([...tokens, { ...last, type: TokenType.EOF, value: '', start: last.end, end: last.end }], current);
		const expression = parser.parseNavigationExpression();
		if (parser.getErrors().length) throw new Error('Recovered typeof expression');
		normalizeAstLocations(expression, typeRegionIndex(region));
		return { expression, current: parser.getCurrentPosition() };
	}).read()); parsedRegions.set(owner, parsed); }
	return parsed;
}

/** Only syntactically classified type names, excluding labels and typeof value
 * expressions. Nested function annotations retain their own generic scopes. */
export function annotationTypeNames(owner: object): string[] | undefined {
	if (!typeRegions(owner).length) return undefined;
	const names: string[] = [], seen = new WeakSet<object>(); let complete = true;
	function visit(value: unknown, generics: ReadonlySet<string>): void {
		if (Array.isArray(value)) { for (const item of value) visit(item, generics); return; }
		if (!value || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const node = value as Record<string, unknown>;
		const local = new Set(generics);
		if (Array.isArray(node.typeParameters)) for (const name of node.typeParameters) if (typeof name === 'string') local.add(name.replace(/\.\.\.$/, ''));
		for (const region of annotationReferences(node)) {
			complete &&= region.complete;
			for (const use of region.types) if (!local.has(use.identifier.name) && !use.generics.has(use.identifier.name)) names.push(use.identifier.name);
			for (const expression of region.values) visit(expression, local);
		}
		// The owner's ordinary value children are outside this annotation. Only
		// typeof expression ASTs reached above introduce nested annotated nodes.
		if (value !== owner && isAstNode(value)) for (const key in node) if (key !== 'location') visit(node[key], local);
	}
	visit(owner, new Set()); return complete ? names : undefined;
}
