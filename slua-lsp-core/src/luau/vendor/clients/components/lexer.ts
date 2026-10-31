import type { Token } from './types';
import { TokenType } from './types';
import { LexerError } from './types';
import { SourceTextIndex } from '../../../../parser/sourceTextIndex.js';
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
	private pendingIndex = 0;
	private sourceIndex: SourceTextIndex;

	private tokenizers: Array<NumberTokenizer | StringTokenizer | IdentifierTokenizer | CommentTokenizer> = [];

	constructor(input: string) {
		this.input = input;
		this.sourceIndex = new SourceTextIndex(input);
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
		if (input !== this.input) this.sourceIndex = new SourceTextIndex(input);
		this.input = input;
		this.reset();
    
		const tokens: Token[] = [];
    
		while (!this.isAtEnd()) {
			// If a tokenizer expanded into multiple tokens, drain those first.
			if (this.pendingTokens.length) {
				tokens.push(this.takePendingToken());
				continue;
			}

			this.skipWhitespace();
			if (this.isAtEnd()) break;
      
			const token = this.nextToken();
			tokens.push(token);
		}
    
		// Drain any remaining pending tokens.
		while (this.pendingTokens.length) {
			tokens.push(this.takePendingToken());
		}

		tokens.push(this.createToken(TokenType.EOF, ''));
		return tokens;
	}

	private reset(): void {
		this.position = 0;
		this.line = 1;
		this.column = 1;
		this.pendingTokens = [];
		this.pendingIndex = 0;
	}

	private takePendingToken(): Token {
		const token = this.pendingTokens[this.pendingIndex++]!;
		if (this.pendingIndex === this.pendingTokens.length) { this.pendingTokens = []; this.pendingIndex = 0; }
		return token;
	}

	public tokenizeInterpolation(): { tokens: Token[]; closing: Token } {
		const start = this.position;
		const tokens: Token[] = [];
		let depth = 0;
		while (!this.isAtEnd() || this.pendingTokens.length) {
			let token: Token;
			if (this.pendingTokens.length) token = this.takePendingToken();
			else {
				this.skipWhitespace();
				if (this.isAtEnd()) break;
				token = this.nextToken();
			}
			if (token.type === TokenType.RIGHT_BRACE) {
				if (depth === 0) return { tokens, closing: { ...token, type: TokenType.INTERPOLATION_END } };
				depth--;
			} else if (token.type === TokenType.LEFT_BRACE) depth++;
			tokens.push(token);
		}
		throw new LexerError('Unterminated template interpolation', start);
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
    
		throw new LexerError(`Unexpected character: ${char}`, this.position - 1);
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

		while (!this.isAtEnd() && this.peek() !== '\n' && this.peek() !== '\r') {
			this.advance();
		}
		const value = this.input.slice(start, this.position);
		return this.createToken(TokenType.COMMENT, value);
	}

	private tokenizeNewline(): Token {
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
		if (char === '\n') { this.line++; this.column = 1; }
		else this.column++;
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
		const start = this.position - value.length, point = this.sourceIndex.lfPositionAt(start);
		return {
			type,
			value,
			line: point.line + 1,
			column: point.character + 1,
			start,
			end: this.position,
		};
	}

	public enqueueTokens(tokens: Token[]): void {
		if (!tokens.length) return;
		for (const token of tokens) this.pendingTokens.push(token);
	}

	public tokenizeFragment(fragment: string, base: { line: number; column: number; offset: number }): Token[] {
		const inner = new Lexer(fragment);
		let innerTokens: Token[];
		try { innerTokens = inner.tokenize(fragment); }
		catch (error) {
			if (error instanceof LexerError) throw new LexerError(error.message, base.offset + error.offset);
			throw error;
		}
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
