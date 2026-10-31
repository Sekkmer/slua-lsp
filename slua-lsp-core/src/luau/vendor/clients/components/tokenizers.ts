import { Token, TokenType, LexerError } from './types';
import { stringLiteralValue } from './stringLiteral.js';

export interface TokenizerContext {
  input: string;
  position: number;
  line: number;
  column: number;
  
  // Helper methods
  advance(): string;
  peek(offset?: number): string;
  isAtEnd(): boolean;
  createToken(type: TokenType, value: string): Token;

	/**
	 * Enqueue additional tokens to be returned before continuing lexing the input.
	 * Useful for lexing constructs that expand into multiple tokens (e.g. template strings).
	 */
	enqueueTokens(tokens: Token[]): void;

	/**
	 * Tokenize a standalone fragment of source text, returning tokens with their
	 * line/column/start/end adjusted so they match the original document.
	 */
	tokenizeFragment(fragment: string, base: { line: number; column: number; offset: number }): Token[];
	/** Consume actual source tokens through the unmatched interpolation brace. */
	tokenizeInterpolation(): { tokens: Token[]; closing: Token };
}

export abstract class BaseTokenizer {
	protected context: TokenizerContext;

	constructor(context: TokenizerContext) {
		this.context = context;
	}

  abstract canHandle(char: string): boolean;
  abstract tokenize(): Token;
}

export class NumberTokenizer extends BaseTokenizer {
	canHandle(char: string): boolean {
		return /\d/.test(char) || (char === '.' && /\d/.test(this.context.peek()));
	}

	tokenize(): Token {
		const start = this.context.position - 1;

		if (this.context.input[start] === '.' && /\d/.test(this.context.peek())) {
			while (/[\d_]/.test(this.context.peek())) {
				this.context.advance();
			}
			this.consumeIntegerSuffix();
			return this.context.createToken(TokenType.NUMBER, this.context.input.slice(start, this.context.position));
		}

		if (this.context.input[start] === '0' && (this.context.peek() === 'x' || this.context.peek() === 'X')) {
			this.context.advance();
			while (/[0-9a-fA-F_]/.test(this.context.peek())) {
				this.context.advance();
			}
			this.consumeIntegerSuffix();
			return this.context.createToken(TokenType.NUMBER, this.context.input.slice(start, this.context.position));
		}

		if (this.context.input[start] === '0' && (this.context.peek() === 'b' || this.context.peek() === 'B')) {
			this.context.advance();
			while (/[01_]/.test(this.context.peek())) {
				this.context.advance();
			}
			this.consumeIntegerSuffix();
			return this.context.createToken(TokenType.NUMBER, this.context.input.slice(start, this.context.position));
		}

		// Integer part
		while (/[\d_]/.test(this.context.peek())) {
			this.context.advance();
		}

		// Decimal part
		if (this.context.peek() === '.' && this.context.peek(1) !== '.') {
			this.context.advance(); // consume '.'
			while (/[\d_]/.test(this.context.peek())) {
				this.context.advance();
			}
		}
    
		// Scientific notation
		if (this.context.peek() === 'e' || this.context.peek() === 'E') {
			this.context.advance();
			if (this.context.peek() === '+' || this.context.peek() === '-') {
				this.context.advance();
			}
			while (/[\d_]/.test(this.context.peek())) {
				this.context.advance();
			}
		}

		this.consumeIntegerSuffix();
		return this.context.createToken(TokenType.NUMBER, this.context.input.slice(start, this.context.position));
	}

	private consumeIntegerSuffix(): void {
		if (this.context.peek() === 'i') {
			this.context.advance();
		}
	}
}

export class StringTokenizer extends BaseTokenizer {
	canHandle(char: string): boolean {
		return char === '"' || char === '\'' || char === '`' || (char === '[' && this.isLongBracketStart());
	}

	tokenize(): Token {
		const quote = this.context.input[this.context.position - 1];
		const start = this.context.position - 1;

		if (quote === '[') {
			return this.tokenizeLongBracketString(start);
		}

		if (quote === '`') {
			return this.tokenizeTemplateString(start);
		}
    
		return this.tokenizeRegularString(quote, start);
	}

	private tokenizeRegularString(quote: string, start: number): Token {
		while (!this.context.isAtEnd() && this.context.peek() !== quote) {
			if (this.context.peek() === '\\') {
				this.context.advance(); // Skip escape sequence
				if (!this.context.isAtEnd()) {
					const escaped = this.context.advance();
					if (escaped === '\r' && this.context.peek() === '\n') this.context.advance();
					if (escaped === 'z') while (/[ \t\r\n\v\f]/.test(this.context.peek())) this.context.advance();
				}
			} else {
				if (this.context.peek() === '\n' || this.context.peek() === '\r') throw new LexerError('Unescaped newline in quoted string', this.context.position);
				this.context.advance();
			}
		}
    
		if (this.context.isAtEnd()) {
			throw new LexerError('Unterminated string', start);
		}
    
		this.context.advance(); // Closing quote
		const token = this.context.createToken(TokenType.STRING, this.context.input.slice(start, this.context.position));
		token.stringValue = stringLiteralValue(token.value, start);
		return token;
	}

	private isLongBracketStart(): boolean {
		let offset = 0;
		while (this.context.peek(offset) === '=') {
			offset++;
		}
		return this.context.peek(offset) === '[';
	}

	private tokenizeLongBracketString(start: number): Token {
		let level = 0;
		while (this.context.peek() === '=') {
			this.context.advance();
			level++;
		}

		if (this.context.peek() !== '[') {
			throw new LexerError('Malformed long bracket string', start);
		}
		this.context.advance();

		const endPattern = ']' + '='.repeat(level) + ']';
		while (!this.context.isAtEnd()) {
			if (this.context.input.slice(this.context.position, this.context.position + endPattern.length) === endPattern) {
				for (let i = 0; i < endPattern.length; i++) this.context.advance();
				const token = this.context.createToken(TokenType.STRING, this.context.input.slice(start, this.context.position));
				token.stringValue = stringLiteralValue(token.value, start);
				return token;
			}
			this.context.advance();
		}

		throw new LexerError('Unterminated long bracket string', start);
	}

	private tokenizeTemplateString(start: number): Token {
		const input = this.context.input;
		const tokens: Token[] = [{ type: TokenType.TEMPLATE_START, value: '`', start, end: start + 1,
			line: this.context.line, column: this.context.column - 1 }];
		let segmentStart = this.context.position;
		let segmentLine = this.context.line, segmentColumn = this.context.column;
		const flush = () => {
			const raw = input.slice(segmentStart, this.context.position);
			tokens.push({ type: TokenType.STRING, value: '`' + raw + '`',
				stringValue: stringLiteralValue('`' + raw + '`', segmentStart - 1),
				start: segmentStart, end: this.context.position, line: segmentLine, column: segmentColumn });
		};
		while (!this.context.isAtEnd() && this.context.peek() !== '`') {
			if (this.context.peek() === '\\') {
				this.context.advance();
				if (!this.context.isAtEnd()) {
					const escaped = this.context.advance();
					if (escaped === '\r' && this.context.peek() === '\n') this.context.advance();
					if (escaped === 'z') while (/[ \t\r\n\v\f]/.test(this.context.peek())) this.context.advance();
					if (escaped === 'u' && this.context.peek() === '{') {
						this.context.advance();
						while (/[0-9a-fA-F]/.test(this.context.peek())) this.context.advance();
						if (this.context.peek() === '}') this.context.advance();
					}
				}
				continue;
			}
			if (this.context.peek() === '\r' || this.context.peek() === '\n') throw new LexerError('Unescaped newline in template string', this.context.position);
			if (this.context.peek() === '{') {
				if (this.context.peek(1) === '{') throw new LexerError('Double braces are not permitted in interpolated strings; escape a literal brace', this.context.position);
				flush();
				this.context.advance();
				tokens.push(this.context.createToken(TokenType.INTERPOLATION_START, '{'));
				// Tokenize in this source context. Strings, long brackets, comments
				// and nested templates consume their own braces, with exact offsets.
				const { tokens: expression, closing } = this.context.tokenizeInterpolation();
				for (const token of expression) tokens.push(token);
				tokens.push(closing);
				segmentStart = this.context.position;
				segmentLine = this.context.line; segmentColumn = this.context.column;
				continue;
			}
			this.context.advance();
		}
		if (this.context.isAtEnd()) throw new LexerError('Unterminated template string', start);
		flush();
		this.context.advance();
		tokens.push(this.context.createToken(TokenType.TEMPLATE_END, '`'));
		this.context.enqueueTokens(tokens.slice(1));
		return tokens[0]!;
	}
}

export class IdentifierTokenizer extends BaseTokenizer {
	private keywords: Map<string, TokenType>;

	constructor(context: TokenizerContext, keywords: Map<string, TokenType>) {
		super(context);
		this.keywords = keywords;
	}

	canHandle(char: string): boolean {
		return /[a-zA-Z_]/.test(char);
	}

	tokenize(): Token {
		const start = this.context.position - 1;
    
		while (/[a-zA-Z0-9_]/.test(this.context.peek())) {
			this.context.advance();
		}
    
		const value = this.context.input.slice(start, this.context.position);
    
		// Handle contextual keywords (can be used as identifiers in certain contexts)
		if (this.isContextualKeywordAsIdentifier(value)) {
			return this.context.createToken(TokenType.IDENTIFIER, value);
		}
    
		const tokenType = this.keywords.get(value) || TokenType.IDENTIFIER;
		return this.context.createToken(tokenType, value);
	}

	private isContextualKeywordAsIdentifier(word: string): boolean {
		const nextToken = this.context.peek();
		const isVariableContext = nextToken === '=' || nextToken === '.' || nextToken === '[' || nextToken === ':';
    
		const contextualKeywords = ['continue', 'type', 'export'];
		return contextualKeywords.includes(word) && isVariableContext;
	}
}

export class CommentTokenizer extends BaseTokenizer {
	canHandle(char: string): boolean {
		return char === '-' && this.context.peek() === '-';
	}

	tokenize(): Token {
		const start = this.context.position - 1;


		this.context.advance(); // Skip second '-'

		// Check for multiline comment
		if (this.isMultilineCommentStart()) {
			return this.tokenizeMultilineComment(start);
		}
    
		// Single line comment
		while (!this.context.isAtEnd() && this.context.peek() !== '\n' && this.context.peek() !== '\r') {
			this.context.advance();
		}
    
		return this.context.createToken(TokenType.COMMENT, this.context.input.slice(start, this.context.position));
	}

	private isMultilineCommentStart(): boolean {
		if (this.context.peek() !== '[') return false;
		let offset = 1;
		while (this.context.peek(offset) === '=') {
			offset++;
		}
		return this.context.peek(offset) === '[';
	}

	private tokenizeMultilineComment(start: number): Token {
		this.context.advance(); // Skip '['
    
		let level = 0;
		while (this.context.peek() === '=') {
			this.context.advance();
			level++;
		}
    
		if (this.context.peek() === '[') {
			this.context.advance();
		}
    
		const endPattern = ']' + '='.repeat(level) + ']';
    
		while (!this.context.isAtEnd()) {
			if (this.context.input.slice(this.context.position, this.context.position + endPattern.length) === endPattern) {
				for (let index = 0; index < endPattern.length; index++) this.context.advance();
				break;
			}
      
      
			this.context.advance();
		}
    
		return this.context.createToken(TokenType.MULTILINE_COMMENT, this.context.input.slice(start, this.context.position));
	}
}
