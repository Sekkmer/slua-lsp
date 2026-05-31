import type { Token } from './types';
import { TokenType } from './types';
import { OPERATORS, SINGLE_CHAR_TOKENS, KEYWORDS } from './operators';
import { 
	TokenizerContext, 
	NumberTokenizer, 
	StringTokenizer, 
	IdentifierTokenizer, 
	CommentTokenizer 
} from './tokenizers';

export type { Token };
export { TokenType };

export class Lexer implements TokenizerContext {
	public input: string;
	public position: number = 0;
	public line: number = 1;
	public column: number = 1;

	private pendingTokens: Token[] = [];

	private tokenizers: Array<NumberTokenizer | StringTokenizer | IdentifierTokenizer | CommentTokenizer> = [];

	constructor(input: string) {
		this.input = input;
		this.initializeTokenizers();
	}

	private initializeTokenizers(): void {
		this.tokenizers = [
			new NumberTokenizer(this),
			new StringTokenizer(this),  
			new IdentifierTokenizer(this, KEYWORDS),
			new CommentTokenizer(this),
		];
	}

	public tokenize(input: string): Token[] {
		this.input = input;
		this.reset();
    
		const tokens: Token[] = [];
    
		while (!this.isAtEnd()) {
			// If a tokenizer expanded into multiple tokens, drain those first.
			if (this.pendingTokens.length) {
				tokens.push(this.pendingTokens.shift()!);
				continue;
			}

			this.skipWhitespace();
			if (this.isAtEnd()) break;
      
			const token = this.nextToken();
			tokens.push(token);
		}
    
		// Drain any remaining pending tokens.
		while (this.pendingTokens.length) {
			tokens.push(this.pendingTokens.shift()!);
		}

		tokens.push(this.createToken(TokenType.EOF, ''));
		return tokens;
	}

	private reset(): void {
		this.position = 0;
		this.line = 1;
		this.column = 1;
		this.pendingTokens = [];
	}

	private nextToken(): Token {
		const mergeMarker = this.tryTokenizeMergeMarker();
		if (mergeMarker) return mergeMarker;

		const char = this.advance();
    
		// Try specialized tokenizers first
		for (const tokenizer of this.tokenizers) {
			if (tokenizer.canHandle(char)) {
				return tokenizer.tokenize();
			}
		}
    
		if (char === '\n') {
			return this.tokenizeNewline();
		}
    
		// Try multi-character operators
		const multiCharToken = this.tryTokenizeMultiCharOperator(char);
		if (multiCharToken) {
			return multiCharToken;
		}
    
		// Fall back to single character tokens
		const tokenType = SINGLE_CHAR_TOKENS.get(char);
		if (tokenType) {
			return this.createToken(tokenType, char);
		}
    
		throw new Error(`Unexpected character: ${char} at line ${this.line}, column ${this.column}`);
	}

	private tryTokenizeMergeMarker(): Token | null {
		// Git conflict/3-way merge markers. Treat as comments so parsing can continue.
		// Examples:
		// <<<<<<< ours
		// ||||||| base
		// =======
		// >>>>>>> theirs
		if (this.column !== 1) return null;
		const start = this.position;
		const lineText = this.input.slice(start, Math.min(this.input.length, start + 64));
		const isMarker =
			lineText.startsWith('<<<<<<<') ||
			lineText.startsWith('=======') ||
			lineText.startsWith('>>>>>>>') ||
			lineText.startsWith('|||||||');
		if (!isMarker) return null;

		while (!this.isAtEnd() && this.peek() !== '\n') {
			this.advance();
		}
		const value = this.input.slice(start, this.position);
		return this.createToken(TokenType.COMMENT, value);
	}

	private tokenizeNewline(): Token {
		this.line++;
		this.column = 1;
		return this.createToken(TokenType.NEWLINE, '\n');
	}

	private tryTokenizeMultiCharOperator(char: string): Token | null {
		const operatorInfo = OPERATORS.get(char);
		if (!operatorInfo) return null;
    
		// Check for triple character operator
		if (operatorInfo.triple && this.peek() === char && this.peek(1) === char) {
			this.advance(); // Second char
			this.advance(); // Third char
			return this.createToken(operatorInfo.triple, char.repeat(3));
		}
    
		// Check for double character operator
		if (operatorInfo.double && this.peek() === char) {
			this.advance(); // Second char
			return this.createToken(operatorInfo.double, char.repeat(2));
		}
    
		// Special cases for operators with different second characters
		if (char === '=' && this.peek() === '=') {
			this.advance();
			return this.createToken(TokenType.EQUAL, '==');
		}
    
		if (char === '~' && this.peek() === '=') {
			this.advance();
			return this.createToken(TokenType.NOT_EQUAL, '~=');
		}
    
		if (char === '<' && this.peek() === '=') {
			this.advance();
			return this.createToken(TokenType.LESS_EQUAL, '<=');
		}
    
		if (char === '>' && this.peek() === '=') {
			this.advance();
			return this.createToken(TokenType.GREATER_EQUAL, '>=');
		}
    
		// Return single character operator
		return this.createToken(operatorInfo.single, char);
	}

	// TokenizerContext implementation
	public advance(): string {
		if (this.isAtEnd()) return '\0';
		const char = this.input[this.position];
		this.position++;
		this.column++;
		return char;
	}

	public peek(offset = 0): string {
		if (this.position + offset >= this.input.length) return '\0';
		return this.input[this.position + offset];
	}

	public isAtEnd(): boolean {
		return this.position >= this.input.length;
	}

	public createToken(type: TokenType, value: string): Token {
		return {
			type,
			value,
			line: this.line,
			column: this.column - value.length,
			start: this.position - value.length,
			end: this.position,
		};
	}

	public enqueueTokens(tokens: Token[]): void {
		if (!tokens.length) return;
		this.pendingTokens.push(...tokens);
	}

	public tokenizeFragment(fragment: string, base: { line: number; column: number; offset: number }): Token[] {
		const inner = new Lexer(fragment);
		const innerTokens = inner.tokenize(fragment);
		return innerTokens
			.filter((t) => t.type !== TokenType.EOF)
			.map((t) => {
				const line = base.line + (t.line - 1);
				const column = t.line === 1 ? base.column + (t.column - 1) : t.column;
				return {
					...t,
					line,
					column,
					start: base.offset + t.start,
					end: base.offset + t.end,
				};
			});
	}

	private skipWhitespace(): void {
		while (!this.isAtEnd()) {
			const char = this.peek();
			if (char === ' ' || char === '\t' || char === '\r') {
				this.advance();
			} else {
				break;
			}
		}
	}
}
