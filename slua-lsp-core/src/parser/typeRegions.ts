import { SourceTextIndex } from './sourceTextIndex.js';
import { TokenType, type Token } from '../luau/vendor/clients/lexer.js';

export type TypeSource = { input: string; index?: SourceTextIndex; hasClasses?: boolean; hasTypeValues?: boolean; hasFunctionAttributes?: boolean };
export type TypeRegion = { input: string; source: TypeSource; tokens: readonly Token[] };
// Annotation names are not value AST children. Weak ownership lets documents and
// their original input/token regions disappear together when their AST is released.
const regions = new WeakMap<object, TypeRegion[]>();
const programs = new WeakMap<object, TypeSource>();
export function recordTypeProgram(ast: object, source: TypeSource): void { programs.set(ast, source); }
export function typeProgram(ast: object): TypeSource | undefined { return programs.get(ast); }
export function recordTypeRegion(owner: object, input: string, tokens: readonly Token[], source: TypeSource): void {
	if (tokens.some((token) => token.type === TokenType.DOT || token.value === 'typeof' && (token.type === TokenType.IDENTIFIER || token.type === TokenType.TYPEOF))) source.hasTypeValues = true;
	const entries = regions.get(owner) ?? [];
	entries.push({ input, source, tokens }); regions.set(owner, entries);
}
export function copyTypeRegions(from: object, to: object): void {
	const entries = regions.get(from);
	if (entries) regions.set(to, entries);
}
export function typeRegions(owner: object): readonly TypeRegion[] { return regions.get(owner) ?? []; }

export function typeRegionIndex(region: TypeRegion): SourceTextIndex { return region.source.index ??= new SourceTextIndex(region.input); }
