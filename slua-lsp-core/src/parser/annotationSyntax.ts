import { TokenType, type Token } from '../luau/vendor/clients/lexer.js';
import type { IdentifierNode } from './ast.js';
import type { SourceTextIndex } from './sourceTextIndex.js';
import type { TypeRegion } from './typeRegions.js';

export type TypeUse = { identifier: IdentifierNode; generics: ReadonlyMap<string, IdentifierNode> };
export type ParsedRegion = { types: TypeUse[]; values: unknown[]; complete: boolean; names: string[] };
const trivia = new Set([TokenType.COMMENT, TokenType.MULTILINE_COMMENT, TokenType.NEWLINE, TokenType.WHITESPACE]);
const isName = (token?: Token) => token && [TokenType.IDENTIFIER, TokenType.CONTINUE, TokenType.TYPE, TokenType.EXPORT, TokenType.AS].includes(token.type);

/** Token roles for navigation, independent of best-effort type inference. A
 * region must be consumed completely; opaque syntax never supplies partial edits. */
export class AnnotationReader {
	private current = 0;
	private depth = 0;
	private readonly tokens: Token[];
	private readonly index: SourceTextIndex;
	private generics = new Map<string, IdentifierNode>();
	readonly types: TypeUse[] = [];
	readonly values: unknown[] = [];
	constructor(private region: TypeRegion, index: SourceTextIndex, private parseValue?: (tokens: Token[], current: number) => { expression: unknown; current: number }) {
		this.tokens = region.tokens.filter((token) => !trivia.has(token.type));
		this.index = index;
	}
	identifier(token: Token): IdentifierNode {
		const start = this.index.positionAt(token.start), end = this.index.positionAt(token.end);
		return { type: 'Identifier', name: token.value, location: { start: { line: start.line + 1, column: start.character + 1 }, end: { line: end.line + 1, column: end.character + 1 } } };
	}
	read(): ParsedRegion {
		let complete = false;
		try {
			if (!this.tokens.length || this.tokens.length > 65536) throw new Error('Unclassified annotation');
			this.type(); complete = this.current === this.tokens.length;
		} catch { /* Preserve opacity rather than invent a token's namespace. */ }
		return { types: complete ? this.types : [], values: complete ? this.values : [], complete, names: this.tokens.filter(isName).map((token) => token.value) };
	}
	/** A supported return type may be followed by a same-line body statement. */
	prefixEnd(): number | undefined {
		try { this.type(); return this.tokens[this.current - 1]?.end; } catch { return undefined; }
	}
	private at(value: string): boolean { return this.tokens[this.current]?.value === value; }
	private take(value: string): boolean { if (!this.at(value)) return false; this.current++; return true; }
	private need(value: string): void { if (!this.take(value)) throw new Error('Unclassified annotation'); }
	private type(): void {
		if (++this.depth > 128) throw new Error('Annotation navigation depth');
		this.primary();
		while (this.take('?')) { /* optional */ }
		while (this.take('|') || this.take('&')) { this.primary(); while (this.take('?')) { /* optional */ } }
		this.depth--;
	}
	private list(end: string): void {
		if (!this.at(end)) do {
			// A function parameter label is not a reference to a type or value.
			if (isName(this.tokens[this.current]) && this.tokens[this.current + 1]?.value === ':') this.current += 2;
			else if (this.at('...') && this.tokens[this.current + 1]?.value === ':') this.current += 2;
			this.type();
		} while (this.take(','));
		this.need(end);
	}
	private primary(): void {
		if (this.take('<')) {
			const outer = this.generics; this.generics = new Map(outer);
			do {
				const token = this.tokens[this.current++]; if (!isName(token)) throw new Error('Generic binder');
				this.generics.set(token!.value, this.identifier(token!)); this.take('...');
			} while (this.take(','));
			this.need('>'); this.type(); this.generics = outer; return;
		}
		if (this.take('(')) {
			this.list(')');
			if (this.take('-')) { this.need('>'); this.type(); }
			return;
		}
		if (this.take('{')) {
			while (!this.take('}')) {
				if (this.take('[')) { this.type(); this.need(']'); this.need(':'); this.type(); }
				else {
					if ((this.at('read') || this.at('write')) && isName(this.tokens[this.current + 1]) && this.tokens[this.current + 2]?.value === ':') this.current++;
					const next = this.tokens[this.current + 1]?.value;
					if ((isName(this.tokens[this.current]) || this.tokens[this.current]?.type === TokenType.STRING) && (next === ':' || next === '?' && this.tokens[this.current + 2]?.value === ':')) {
						this.current++; this.take('?'); this.need(':'); this.type();
					} else this.type();
				}
				if (!this.take(',') && !this.take(';') && !this.at('}')) throw new Error('Table type separator');
			}
			return;
		}
		if (this.take('...')) { this.type(); return; }
		const token = this.tokens[this.current++];
		if (!token) throw new Error('Missing type');
		if ([TokenType.STRING, TokenType.NIL, TokenType.TRUE, TokenType.FALSE].includes(token.type)) return;
		if (token.value === 'typeof') {
			this.need('(');
			if (this.parseValue) {
				const result = this.parseValue(this.tokens, this.current); this.current = result.current;
				this.need(')'); this.values.push(result.expression);
			} else {
				let depth = 1;
				while (depth) {
					const next = this.tokens[this.current++]; if (!next) throw new Error('Incomplete typeof');
					if (next.type === TokenType.LEFT_PAREN) depth++;
					if (next.type === TokenType.RIGHT_PAREN) depth--;
				}
			}
			return;
		}
		if (!isName(token)) throw new Error('Unclassified type token');
		const identifier = this.identifier(token);
		if (this.take('.')) {
			// Native qualified types retain their lexical value prefix identity.
			this.values.push(identifier);
			if (!isName(this.tokens[this.current++])) throw new Error('Qualified type');
		} else this.types.push({ identifier, generics: this.generics });
		this.take('...');
		if (this.take('<')) this.list('>');
	}
}
