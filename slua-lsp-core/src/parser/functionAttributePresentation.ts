import { Lexer, TokenType } from '../luau/vendor/clients/lexer.js';
import { SourceTextIndex } from './sourceTextIndex.js';
import type { LspPosition } from './ast.js';

export const FUNCTION_ATTRIBUTE_DOCS = {
	native: '**@native**\n\nRequests native compilation for this function. Parsing, bytecode compilation and local execution do not prove host native-code availability or use.',
	checked: '**@checked**\n\nChecked-function metadata. The pinned ordinary-function probes do not establish runtime argument guards. Ordinary static type diagnostics still apply.',
	deprecated: '**@deprecated**\n\nMarks a function as deprecated. A list may supply `deprecated{use="replacement",reason="explanation"}`. Known function values and aliases warn; recursive uses in their own function scope are suppressed.'
} as const;
/** Token context only: comments and literal contents never become attribute names. */
export function functionAttributeCompletions(text: string, position: LspPosition): Array<keyof typeof FUNCTION_ATTRIBUTE_DOCS> | undefined {
	if (!text.includes('@')) return undefined;
	const offset = new SourceTextIndex(text).offsetAt(position); if (offset === undefined) return undefined;
	let tokens;
	try { tokens = new Lexer(text.slice(0, offset)).tokenize(text.slice(0, offset)); } catch { return undefined; }
	const last = tokens[tokens.length - 2];
	if (last?.end === offset && [TokenType.COMMENT, TokenType.MULTILINE_COMMENT, TokenType.STRING].includes(last.type)) return undefined;
	const tail = tokens.filter((token) => ![TokenType.EOF, TokenType.NEWLINE, TokenType.WHITESPACE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(token.type));
	if (!tail.length || [TokenType.COMMENT, TokenType.MULTILINE_COMMENT, TokenType.STRING].includes(tail[tail.length - 1]!.type)) return undefined;
	let prefix = '';
	if (tail[tail.length - 1]!.type === TokenType.IDENTIFIER) prefix = tail.pop()!.value;
	const previous = tail[tail.length - 1]; if (!previous) return undefined;
	const all = Object.keys(FUNCTION_ATTRIBUTE_DOCS) as Array<keyof typeof FUNCTION_ATTRIBUTE_DOCS>;
	if (previous.type === TokenType.AT && previous.end + prefix.length === offset) return all.filter((name) => name.startsWith(prefix));
	if (previous.type !== TokenType.LEFT_BRACKET && previous.type !== TokenType.COMMA) return undefined;
	// Only a top-level list item can introduce a name, not table/argument commas.
	let depth = 0, open = -1;
	for (let i = tail.length - 1; i >= 0; i--) {
		const type = tail[i]!.type;
		if ([TokenType.RIGHT_BRACKET, TokenType.RIGHT_BRACE, TokenType.RIGHT_PAREN].includes(type)) depth++;
		else if ([TokenType.LEFT_BRACKET, TokenType.LEFT_BRACE, TokenType.LEFT_PAREN].includes(type)) {
			if (depth) { depth--; continue; }
			if (type === TokenType.LEFT_BRACKET && tail[i - 1]?.type === TokenType.AT && tail[i - 1]!.end === tail[i]!.start) open = i;
			break;
		}
	}
	if (open < 0) return undefined;
	const used = new Set<string>(); depth = 0;
	for (let i = open + 1; i < tail.length; i++) {
		const token = tail[i]!;
		if (depth === 0 && token.type === TokenType.IDENTIFIER && (i === open + 1 || tail[i - 1]!.type === TokenType.COMMA)) used.add(token.value);
		if ([TokenType.LEFT_BRACKET, TokenType.LEFT_BRACE, TokenType.LEFT_PAREN].includes(token.type)) depth++;
		if ([TokenType.RIGHT_BRACKET, TokenType.RIGHT_BRACE, TokenType.RIGHT_PAREN].includes(token.type)) depth--;
	}
	return all.filter((name) => name.startsWith(prefix) && !used.has(name));
}
