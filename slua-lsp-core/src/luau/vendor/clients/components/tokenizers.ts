import { Token, TokenType } from './types';

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
		return /\d/.test(char);
	}

	tokenize(): Token {
		const start = this.context.position - 1;
    
		// Integer part
		while (/\d/.test(this.context.peek())) {
			this.context.advance();
		}
    
		// Decimal part
		if (this.context.peek() === '.' && /\d/.test(this.context.peek(1))) {
			this.context.advance(); // consume '.'
			while (/\d/.test(this.context.peek())) {
				this.context.advance();
			}
		}
    
		// Scientific notation
		if (this.context.peek() === 'e' || this.context.peek() === 'E') {
			this.context.advance();
			if (this.context.peek() === '+' || this.context.peek() === '-') {
				this.context.advance();
			}
			while (/\d/.test(this.context.peek())) {
				this.context.advance();
			}
		}
    
		return this.context.createToken(TokenType.NUMBER, this.context.input.slice(start, this.context.position));
	}
}

export class StringTokenizer extends BaseTokenizer {
	canHandle(char: string): boolean {
		return char === '"' || char === '\'' || char === '`';
	}

	tokenize(): Token {
		const quote = this.context.input[this.context.position - 1];
		const start = this.context.position - 1;
    
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
					this.context.advance();
				}
			} else {
				if (this.context.peek() === '\n') {
					this.context.line++;
					this.context.column = 1;
				}
				this.context.advance();
			}
		}
    
		if (this.context.isAtEnd()) {
			throw new Error(`Unterminated string at line ${this.context.line}`);
		}
    
		this.context.advance(); // Closing quote
		return this.context.createToken(TokenType.STRING, this.context.input.slice(start, this.context.position));
	}

	private tokenizeTemplateString(start: number): Token {
		const input = this.context.input;
		const openingLine = this.context.line;
		const openingColumn = this.context.column - 1; // backtick was already consumed
		const openingOffset = start;

		function makeToken(type: TokenType, value: string, at: { line: number; column: number; offset: number }): Token {
			return {
				type,
				value,
				line: at.line,
				column: at.column,
				start: at.offset,
				end: at.offset + Math.max(0, value.length),
			};
		}

		function quoteAsBacktickString(text: string): string {
			// The parser only strips the first/last char; it doesn't care which quote.
			// We use backticks to avoid escaping `"` and to keep the value readable.
			return '`' + text.replace(/`/g, '\\`') + '`';
		}

		const parts: Token[][] = [];
		let segmentStartOffset = this.context.position;
		let segmentStartLine = this.context.line;
		let segmentStartColumn = this.context.column;

		while (!this.context.isAtEnd() && this.context.peek() !== '`') {
			if (this.context.peek() === '\\') {
				// Skip escape sequence within the template literal text.
				this.context.advance();
				if (!this.context.isAtEnd()) {
					if (this.context.peek() === '\n') {
						this.context.line++;
						this.context.column = 1;
					}
					this.context.advance();
				}
				continue;
			}

			if (this.context.peek() === '{') {
				// Flush preceding literal segment.
				const segEndOffset = this.context.position;
				const segText = input.slice(segmentStartOffset, segEndOffset);
				if (segText.length > 0) {
					parts.push([
						makeToken(
							TokenType.STRING,
							quoteAsBacktickString(segText),
							{ line: segmentStartLine, column: segmentStartColumn, offset: segmentStartOffset }
						),
					]);
				}

				// Consume '{' and lex the interpolation expression.
				this.context.advance();
				let braceCount = 1;
				const exprStartOffset = this.context.position;
				const exprStartLine = this.context.line;
				const exprStartColumn = this.context.column;

				while (!this.context.isAtEnd() && braceCount > 0) {
					const ch = this.context.peek();
					if (ch === '{') braceCount++;
					else if (ch === '}') braceCount--;
					if (ch === '\n') {
						this.context.line++;
						this.context.column = 1;
					}
					this.context.advance();
				}

				if (braceCount !== 0) {
					throw new Error(`Unterminated template interpolation at line ${exprStartLine}`);
				}

				const exprEndOffset = this.context.position - 1; // exclude the closing '}'
				const exprText = input.slice(exprStartOffset, exprEndOffset);
				const exprTokens = this.context
					.tokenizeFragment(exprText, { line: exprStartLine, column: exprStartColumn, offset: exprStartOffset })
					.filter(
						(t) =>
							t.type !== TokenType.EOF &&
							t.type !== TokenType.NEWLINE &&
							t.type !== TokenType.COMMENT &&
							t.type !== TokenType.MULTILINE_COMMENT
					);

				// Wrap interpolation expressions in parens for safety.
				const openExpr = makeToken(TokenType.LEFT_PAREN, '(', {
					line: exprStartLine,
					column: Math.max(1, exprStartColumn - 1),
					offset: Math.max(openingOffset, exprStartOffset - 1),
				});
				const closeExpr = makeToken(TokenType.RIGHT_PAREN, ')', {
					line: this.context.line,
					column: this.context.column,
					offset: this.context.position,
				});
				parts.push([openExpr, ...exprTokens, closeExpr]);

				// Start the next literal segment after '}'.
				segmentStartOffset = this.context.position;
				segmentStartLine = this.context.line;
				segmentStartColumn = this.context.column;
				continue;
			}

			if (this.context.peek() === '\n') {
				this.context.line++;
				this.context.column = 1;
			}
			this.context.advance();
		}

		if (this.context.isAtEnd()) {
			throw new Error(`Unterminated template string at line ${this.context.line}`);
		}

		// Flush trailing literal segment.
		const trailingText = input.slice(segmentStartOffset, this.context.position);
		if (trailingText.length > 0) {
			parts.push([
				makeToken(TokenType.STRING, quoteAsBacktickString(trailingText), {
					line: segmentStartLine,
					column: segmentStartColumn,
					offset: segmentStartOffset,
				}),
			]);
		}

		// Consume closing backtick.
		const closingLine = this.context.line;
		const closingColumn = this.context.column;
		const closingOffset = this.context.position;
		this.context.advance();

		// Turn the template string into a parenthesized concatenation expression.
		const tokens: Token[] = [];
		tokens.push(makeToken(TokenType.LEFT_PAREN, '(', { line: openingLine, column: openingColumn, offset: openingOffset }));

		if (parts.length === 0) {
			tokens.push(makeToken(TokenType.STRING, '``', { line: openingLine, column: openingColumn, offset: openingOffset }));
		} else {
			for (let i = 0; i < parts.length; i++) {
				if (i > 0) {
					// Location is best-effort; identifiers inside expr tokens have real positions.
					tokens.push(
						makeToken(TokenType.CONCAT, '..', {
							line: parts[i]![0]!.line,
							column: Math.max(1, parts[i]![0]!.column - 2),
							offset: Math.max(openingOffset, parts[i]![0]!.start - 2),
						})
					);
				}
				tokens.push(...parts[i]!);
			}
		}

		tokens.push(makeToken(TokenType.RIGHT_PAREN, ')', { line: closingLine, column: closingColumn, offset: closingOffset }));

		// Emit the expanded token stream.
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
		if (this.context.peek() === '[') {
			return this.tokenizeMultilineComment(start);
		}
    
		// Single line comment
		while (!this.context.isAtEnd() && this.context.peek() !== '\n') {
			this.context.advance();
		}
    
		return this.context.createToken(TokenType.COMMENT, this.context.input.slice(start, this.context.position));
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
				this.context.position += endPattern.length;
				break;
			}
      
			if (this.context.peek() === '\n') {
				this.context.line++;
				this.context.column = 1;
			}
      
			this.context.advance();
		}
    
		return this.context.createToken(TokenType.MULTILINE_COMMENT, this.context.input.slice(start, this.context.position));
	}
}
