import { attributeLiteral, validDeprecatedArguments } from '../../../parser/functionAttributes.js';
import { AnnotationReader } from '../../../parser/annotationSyntax.js';
import { SourceTextIndex } from '../../../parser/sourceTextIndex.js';
import { recordTypeRegion, copyTypeRegions, type TypeSource } from '../../../parser/typeRegions.js';
import { Token, TokenType, Lexer } from '../clients/lexer';
import * as AST from '../types';
import { stringLiteralValue } from '../clients/components/stringLiteral.js';
import { integerLiteralValue } from '../clients/components/integerLiteral.js';

export class ParseError extends Error {
	constructor(message: string, public token: Token) {
		super(message);
		this.name = 'ParseError';
	}
}

export class LuaParser {
	private tokens: Token[] = [];
	private current: number = 0;
	private input: string;
	private errors: ParseError[] = [];

	constructor(input: string = '', private annotationSource: TypeSource = { input }) {
		this.input = input;
	}

	public getErrors(): ParseError[] {
		return [...this.errors];
	}

	public setTokens(tokens: Token[], position: number): void {
		this.tokens = tokens;
		this.current = position;
	}

	public parseStatement(): AST.Statement | null {
		this.skipStatementSeparators();
		return this.statement();
	}

	/** Parse a typeof value expression with the same grammar as ordinary code. */
	public parseNavigationExpression(): AST.Expression { return this.expression(); }

	public getCurrentPosition(): number {
		return this.current;
	}

	public parse(input?: string): AST.Program {
		if (input) {
			this.input = input;
			this.annotationSource = { input };
		}
		const lexer = new Lexer(this.input);
		this.tokens = lexer.tokenize(this.input);
		this.current = 0;
		this.errors = [];

		const statements: AST.Statement[] = [];
		let safetyCounter = 0; // Prevent infinite loops

		while (!this.isAtEnd()) {
			if (this.skipStatementSeparators()) {
				continue;
			}
			const stmt = this.statement();
			if (stmt) {
				statements.push(stmt);
			} else {
				// Prevent infinite loop: advance if statement() returned null
				this.advance();
			}
			safetyCounter++;
			if (safetyCounter > 10000) {
				throw new Error('Parser safety break: too many iterations (possible infinite loop)');
			}
		}

		return {
			type: 'Program',
			body: statements,
			location: this.getLocation(),
		};
	}

	private statement(): AST.Statement | null {
		try {
			if (this.check(TokenType.AT)) {
				const start = this.peek();
				const attributes = this.functionAttributes();
				const node = this.statement();
				if (node?.type !== 'FunctionDeclaration') throw new ParseError('Attributes must precede a function declaration', start);
				node.attributes = attributes;
				node.location = { start: this.tokenLocation(start).start, end: node.location!.end };
				return node;
			}
			if (this.check(TokenType.EXPORT) && this.exportDeclarationFollows()) return this.exportStatement();
			if (this.match(TokenType.LOCAL)) return this.localStatement();
			if (this.checkConstDeclaration()) {
				const keyword = this.advance();
				this.skipSeparatorsInDelimitedList();
				return this.localStatement(keyword);
			}
			if (this.match(TokenType.FUNCTION)) return this.functionDeclaration(false);
			if (this.match(TokenType.IF)) return this.ifStatement();
			if (this.match(TokenType.WHILE)) return this.whileStatement();
			if (this.match(TokenType.FOR)) return this.forStatement();
			if (this.match(TokenType.DO)) return this.doStatement();
			if (this.match(TokenType.REPEAT)) return this.repeatStatement();
			if (this.match(TokenType.RETURN)) return this.returnStatement();
			if (this.match(TokenType.BREAK)) return this.breakStatement();
			if (this.checkContinueStatement()) {
				this.advance();
				return this.continueStatement();
			}

			return this.assignmentOrExpressionStatement();
		} catch (err) {
			const token = err instanceof ParseError ? err.token : this.peek();
			const message = err instanceof Error ? err.message : String(err);
			if (err instanceof ParseError) this.errors.push(err);
			const loc: AST.SourceLocation = {
				start: { line: token.line, column: token.column },
				end: { line: token.line, column: token.column + Math.max(1, token.value.length) }
			};
			this.synchronize();
			return { type: 'ErrorStatement', message, location: loc };
		}
	}

	private functionAttributes(): AST.FunctionAttribute[] {
		const attributes: AST.FunctionAttribute[] = [];
		const names = new Set<string>();
		while (this.match(TokenType.AT)) {
			this.annotationSource.hasFunctionAttributes = true;
			const marker = this.previous();
			if (marker.end !== this.peek().start) throw new ParseError('Attribute name or list must immediately follow @', this.peek());
			const list = this.match(TokenType.LEFT_BRACKET);
			if (list) this.skipSeparatorsInDelimitedList();
			do {
				const token = this.consume(TokenType.IDENTIFIER, 'Expected attribute name');
				const name = token.value;
				if (name !== 'native' && name !== 'checked' && name !== 'deprecated') throw new ParseError(`Unknown attribute '${name}'`, token);
				if (names.has(name)) throw new ParseError(`Duplicate attribute '${name}'`, token);
				names.add(name);
				const args: AST.Expression[] = [];
				if (list) {
					this.skipSeparatorsInDelimitedList();
					if (this.match(TokenType.LEFT_PAREN)) {
						this.skipSeparatorsInDelimitedList();
						if (!this.check(TokenType.RIGHT_PAREN)) do {
							this.skipSeparatorsInDelimitedList(); args.push(this.expression()); this.skipSeparatorsInDelimitedList();
						} while (this.match(TokenType.COMMA));
						this.consume(TokenType.RIGHT_PAREN, 'Expected ) after attribute arguments');
					} else if (this.match(TokenType.LEFT_BRACE)) args.push(this.table());
					else if (this.match(TokenType.STRING)) args.push(this.stringFromPrevious());
				}
				let values: AST.AttributeLiteral[];
				try { values = args.map((arg) => attributeLiteral(arg)); }
				catch { throw new ParseError('Attribute arguments must be constant literals or literal tables', token); }
				if (name === 'deprecated' && !validDeprecatedArguments(values)) throw new ParseError('deprecated accepts no arguments or one record table containing string use/reason fields', token);
				attributes.push({ type: 'FunctionAttribute', name, arguments: values, location: { start: this.tokenLocation(token).start, end: this.getLocation().end } });
				this.skipSeparatorsInDelimitedList();
			} while (list && this.match(TokenType.COMMA) && (this.skipSeparatorsInDelimitedList(), true));
			if (list) this.consume(TokenType.RIGHT_BRACKET, 'Expected ] after attributes');
			this.skipSeparatorsInDelimitedList();
		}
		return attributes;
	}

	/** Ordinary source permits attributes on typeof VALUE functions, not function types. */
	public validateAttributeTypes(tokens: Token[]): void {
		if (!tokens.some((token) => token.type === TokenType.AT)) return;
		const trivia = new Set([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT, TokenType.WHITESPACE]);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			let open = i + 1;
			while (tokens[open] && trivia.has(tokens[open]!.type)) open++;
			if (token.value === 'typeof' && tokens[open]?.type === TokenType.LEFT_PAREN) {
				const parser = new LuaParser(this.input, this.annotationSource);
				parser.setTokens([...tokens, { ...tokens[tokens.length - 1]!, type: TokenType.EOF, value: '' }], open + 1);
				parser.skipSeparatorsInDelimitedList();
				parser.parseNavigationExpression();
				parser.skipSeparatorsInDelimitedList();
				if (parser.getErrors().length) throw parser.getErrors()[0]!;
				const end = parser.getCurrentPosition();
				if (tokens[end]?.type !== TokenType.RIGHT_PAREN) throw new ParseError('Expected ) after typeof value', tokens[end] ?? token);
				i = end;
			} else if (token.type === TokenType.AT) throw new ParseError('Function type attributes require a declaration-file parser context', token);
		}
	}

	private exportDeclarationFollows(): boolean {
		let offset = this.current + 1;
		while ([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.tokens[offset]?.type)) offset++;
		const next = this.tokens[offset];
		return !!next && (next.type === TokenType.LOCAL || next.type === TokenType.FUNCTION || next.value === 'const');
	}

	private exportStatement(): AST.Statement {
		const keyword = this.advance();
		this.skipSeparatorsInDelimitedList();
		let node: AST.Statement;
		if (this.match(TokenType.LOCAL)) {
			if (this.check(TokenType.FUNCTION)) throw new ParseError('Use \'export function\', without \'local\'', this.peek());
			node = this.localStatement();
		} else if (this.match(TokenType.FUNCTION)) {
			node = this.functionDeclaration(true);
			if (node.type === 'FunctionDeclaration') {
				node.isConst = true;
				if (node.identifier) node.identifier.isConst = true;
			}
		} else {
			const constant = this.advance();
			this.skipSeparatorsInDelimitedList();
			if (this.check(TokenType.FUNCTION)) throw new ParseError('Use \'export function\', without \'const\'', this.peek());
			node = this.localStatement(constant);
		}
		node.exported = true;
		node.exportKeywordLocation = this.tokenLocation(keyword);
		if (node.type === 'LocalStatement') for (const variable of node.variables) variable.exported = true;
		if (node.type === 'FunctionDeclaration' && node.identifier) node.identifier.exported = true;
		return node;
	}

	private localStatement(constKeyword?: Token): AST.Statement {
		if (this.match(TokenType.FUNCTION)) {
			return this.functionDeclaration(true, constKeyword);
		}

		const variables: AST.Identifier[] = [];
		variables.push(this.typedIdentifierInLocal());

		while (this.match(TokenType.COMMA)) {
			this.skipSeparatorsInDelimitedList();
			variables.push(this.typedIdentifierInLocal());
		}

		let init: AST.Expression[] | undefined;
		this.skipSeparatorsBefore(TokenType.ASSIGN);
		if (this.match(TokenType.ASSIGN)) {
			init = [];
			this.skipSeparatorsBeforeExpression();
			init.push(this.expression());

			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsBeforeExpression();
				init.push(this.expression());
			}
		}

		if (constKeyword) for (const variable of variables) variable.isConst = true;
		const location = this.getLocation();
		return {
			type: 'LocalStatement', variables, init,
			...(constKeyword ? { isConst: true, constKeywordLocation: this.tokenLocation(constKeyword) } : {}),
			location: constKeyword ? { start: this.tokenLocation(constKeyword).start, end: location.end } : location,
		};
	}

	private functionDeclaration(isLocal: boolean, constKeyword?: Token): AST.FunctionDeclaration {
		let identifier: AST.Expression | undefined;
		let injectSelfParam = false;

		if (this.isIdentifierLike(this.peek().type)) {
			if (isLocal) {
				// Lua only allows `local function name(...)`.
				identifier = this.identifier();
			} else {
				// Lua grammar: functionname ::= Name {'.' Name} [':' Name]
				let expr: AST.Expression = this.identifier();
				while (this.match(TokenType.DOT)) {
					const prop = this.identifier();
					expr = {
						type: 'MemberExpression',
						object: expr,
						property: prop,
						indexer: '.',
						location: this.getLocation(),
					};
				}
				if (this.match(TokenType.COLON)) {
					injectSelfParam = true;
					const prop = this.identifier();
					expr = {
						type: 'MemberExpression',
						object: expr,
						property: prop,
						indexer: ':',
						location: this.getLocation(),
					};
				}
				identifier = expr;
			}
		}

		const typeParameters = this.optionalGenericTypeParameters();
		this.consume(TokenType.LEFT_PAREN, 'Expected \'(\' after function name');
		this.skipSeparatorsInDelimitedList();

		const parameters: AST.Identifier[] = [];
		if (!this.check(TokenType.RIGHT_PAREN)) {
			parameters.push(this.typedIdentifierInParamList());
			this.skipSeparatorsInDelimitedList();
			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsInDelimitedList();
				if (this.check(TokenType.RIGHT_PAREN)) break;
				parameters.push(this.typedIdentifierInParamList());
				this.skipSeparatorsInDelimitedList();
			}
		}

		if (injectSelfParam) {
			parameters.unshift({ type: 'Identifier', name: 'self' });
		}

		this.consume(TokenType.RIGHT_PAREN, 'Expected \')\' after parameters');

		// Luau allows return type annotations: `function f(): number`.
		const returnTypeOwner = {};
		let returnTypeAnnotation: string | undefined;
		if (this.match(TokenType.COLON)) {
			returnTypeAnnotation = this.readTypeAnnotationRaw([
				TokenType.NEWLINE,
				TokenType.RETURN,
				TokenType.LOCAL,
				TokenType.IF,
				TokenType.FOR,
				TokenType.WHILE,
				TokenType.REPEAT,
				TokenType.DO,
				TokenType.FUNCTION,
				TokenType.BREAK,
				TokenType.CONTINUE,
				TokenType.END,
			], returnTypeOwner);
		}

		const body: AST.Statement[] = [];
		while (!this.check(TokenType.END) && !this.isAtEnd()) {
			if (this.skipStatementSeparators()) continue;
			const stmt = this.statement();
			if (stmt) body.push(stmt);
		}

		this.consume(TokenType.END, 'Expected \'end\' after function body');

		const node: AST.FunctionDeclaration = {
			type: 'FunctionDeclaration',
			identifier,
			isLocal,
			typeParameters,
			parameters,
			body,
			location: this.getLocation(),
		};
		if (returnTypeAnnotation) node.returnTypeAnnotation = returnTypeAnnotation;
		copyTypeRegions(returnTypeOwner, node);
		if (constKeyword) {
			node.isConst = true; node.constKeywordLocation = this.tokenLocation(constKeyword);
			if (identifier) identifier.isConst = true;
			node.location = { start: node.constKeywordLocation.start, end: node.location!.end };
		}

		return node;
	}

	/** Native conditional declarations bind one value only in the successful branch. */
	private ifCondition(): { test: AST.Expression; conditionLocal?: AST.Identifier; conditionIsConst?: boolean; conditionKeywordLocation?: AST.SourceLocation; constKeywordLocation?: AST.SourceLocation } {
		this.skipSeparatorsInDelimitedList();
		let offset = 1;
		while ([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.peekAt(offset).type)) offset++;
		const isConst = this.check(TokenType.IDENTIFIER) && this.peek().value === 'const' && this.isIdentifierLike(this.peekAt(offset).type);
		if (!this.check(TokenType.LOCAL) && !isConst) return { test: this.expression() };
		const keyword = this.advance();
		const conditionKeywordLocation = { start: { line: keyword.line, column: keyword.column }, end: { line: keyword.line, column: keyword.column + keyword.value.length } };
		this.skipSeparatorsInDelimitedList();
		const conditionLocal = this.identifier();
		if (isConst) conditionLocal.isConst = true;
		this.skipSeparatorsInDelimitedList();
		if (this.match(TokenType.COLON)) {
			this.skipSeparatorsInDelimitedList();
			conditionLocal.typeAnnotation = this.readTypeAnnotationRaw([TokenType.ASSIGN, TokenType.COMMA, TokenType.THEN], conditionLocal);
			if (!conditionLocal.typeAnnotation.trim()) throw new ParseError('Expected type annotation in conditional binding', this.peek());
		}
		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.ASSIGN, 'Expected \'=\' after the single conditional binding');
		this.skipSeparatorsInDelimitedList();
		return { test: this.expression(), conditionLocal, conditionIsConst: isConst, conditionKeywordLocation, ...(isConst ? { constKeywordLocation: conditionKeywordLocation } : {}) };
	}

	private ifStatement(consumeEnd = true): AST.IfStatement {
		const start = this.previous();
		const condition = this.ifCondition();
		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.THEN, 'Expected \'then\' after if condition');
		const thenKeywordLocation = this.getLocation();

		const consequent: AST.Statement[] = [];
		while (!this.check(TokenType.ELSEIF) && !this.check(TokenType.ELSE) &&
           !this.check(TokenType.END) && !this.isAtEnd()) {
			if (this.skipStatementSeparators()) continue;
			const stmt = this.statement();
			if (stmt) consequent.push(stmt);
		}

		let alternate: AST.Statement[] | AST.IfStatement | undefined;
		let alternateKeywordLocation: AST.SourceLocation | undefined;
		if (this.match(TokenType.ELSEIF)) {
			alternateKeywordLocation = this.getLocation();
			alternate = this.ifStatement(false);
		} else if (this.match(TokenType.ELSE)) {
			alternateKeywordLocation = this.getLocation();
			alternate = [];
			while (!this.check(TokenType.END) && !this.isAtEnd()) {
				if (this.skipStatementSeparators()) continue;
				const stmt = this.statement();
				if (stmt) alternate.push(stmt);
			}
		}

		if (consumeEnd) this.consume(TokenType.END, 'Expected \'end\' after if statement');

		return {
			type: 'IfStatement',
			...condition,
			thenKeywordLocation,
			alternateKeywordLocation,
			consequent,
			alternate,
			location: { start: { line: start.line, column: start.column }, end: this.getLocation().end },
		};
	}

	private whileStatement(): AST.WhileStatement {
		this.skipSeparatorsBeforeExpression();
		const test = this.expression();
		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.DO, 'Expected \'do\' after while condition');

		const body: AST.Statement[] = [];
		while (!this.check(TokenType.END) && !this.isAtEnd()) {
			if (this.skipStatementSeparators()) continue;
			const stmt = this.statement();
			if (stmt) body.push(stmt);
		}

		this.consume(TokenType.END, 'Expected \'end\' after while body');

		return {
			type: 'WhileStatement',
			test,
			body,
			location: this.getLocation(),
		};
	}

	private forStatement(): AST.ForStatement | AST.GenericForStatement {
		const variables: AST.Identifier[] = [];
		variables.push(this.typedIdentifierInForList());

		if (!this.check(TokenType.ASSIGN)) {
			while (this.match(TokenType.COMMA)) {
				variables.push(this.typedIdentifierInForList());
			}
			this.consume(TokenType.IN, 'Expected \'in\' after generic for variables');
			this.skipSeparatorsBeforeExpression();
			const iterators: AST.Expression[] = [];
			iterators.push(this.expression());
			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsBeforeExpression();
				iterators.push(this.expression());
			}
			this.skipSeparatorsInDelimitedList();
			this.consume(TokenType.DO, 'Expected \'do\' after for clause');
			const body = this.blockUntil(TokenType.END);
			this.consume(TokenType.END, 'Expected \'end\' after for body');
			return {
				type: 'GenericForStatement',
				variables,
				iterators,
				body,
				location: this.getLocation(),
			};
		}

		const variable = variables[0]!;
		this.consume(TokenType.ASSIGN, 'Expected \'=\' after for variable');

		this.skipSeparatorsBeforeExpression();
		const start = this.expression();
		this.consume(TokenType.COMMA, 'Expected \',\' after for start value');

		this.skipSeparatorsBeforeExpression();
		const end = this.expression();
		let step: AST.Expression | undefined;

		if (this.match(TokenType.COMMA)) {
			this.skipSeparatorsBeforeExpression();
			step = this.expression();
		}

		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.DO, 'Expected \'do\' after for clause');

		const body = this.blockUntil(TokenType.END);
		this.consume(TokenType.END, 'Expected \'end\' after for body');

		return {
			type: 'ForStatement',
			variable,
			start,
			end,
			step,
			body,
			location: this.getLocation(),
		};
	}

	private doStatement(): AST.Statement {
		const body = this.blockUntil(TokenType.END);
		this.consume(TokenType.END, 'Expected \'end\' after do block');
		return {
			type: 'DoStatement',
			body,
			location: this.getLocation(),
		} as unknown as AST.Statement;
	}

	private repeatStatement(): AST.Statement {
		const body = this.blockUntil(TokenType.UNTIL);
		this.consume(TokenType.UNTIL, 'Expected \'until\' after repeat body');
		const test = this.expression();
		return {
			type: 'RepeatStatement',
			body,
			test,
			location: this.getLocation(),
		} as unknown as AST.Statement;
	}

	private blockUntil(...endTokens: TokenType[]): AST.Statement[] {
		const body: AST.Statement[] = [];
		while (!endTokens.some((type) => this.check(type)) && !this.isAtEnd()) {
			if (this.skipStatementSeparators()) continue;
			const stmt = this.statement();
			if (stmt) body.push(stmt);
		}
		return body;
	}

	private typedIdentifierInParamList(): AST.Identifier {
		if (this.match(TokenType.DOTS)) {
			const id: AST.Identifier = {
				type: 'Identifier',
				name: '...',
				location: this.getLocation(),
			};
			if (this.match(TokenType.COLON)) {
				id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.RIGHT_PAREN], id);
			}
			return id;
		}

		const id = this.identifier();
		if (this.match(TokenType.COLON)) {
			id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.RIGHT_PAREN], id);
		}
		return id;
	}

	private typedIdentifierInForList(): AST.Identifier {
		const id = this.identifier();
		if (this.match(TokenType.COLON)) {
			id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.IN, TokenType.ASSIGN], id);
		}
		return id;
	}

	private typedIdentifierInLocal(): AST.Identifier {
		const id = this.identifier();
		if (this.match(TokenType.COLON)) {
			id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.ASSIGN, TokenType.NEWLINE], id);
		}
		return id;
	}

	private readTypeAnnotationRaw(stops: TokenType[], owner?: object): string {
		const firstToken = this.current;
		// Best-effort capture for Luau type syntax.
		// We slice the original input by token offsets to preserve exact formatting.
		const startToken = this.peek();
		const startIndex = startToken?.start ?? 0;
		let endIndex = startIndex;
		let consumed = false;

		let depthParen = 0;
		let depthBrace = 0;
		let depthBracket = 0;
		let depthAngle = 0;

		while (!this.isAtEnd()) {
			const t = this.peek().type;
			// An empty return pack is a complete return annotation. A following
			// identifier starts a body statement; it cannot extend that pack.
			if (t === TokenType.IDENTIFIER && stops.includes(TokenType.RETURN) && /^\(\s*\)$/.test(this.input.slice(startIndex, endIndex))) break;
			if (depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0 && (stops.includes(t) || (consumed && stops.includes(TokenType.LOCAL) && !['|', '&', '->', ':', ',', '<'].includes(this.previous().value) && this.checkConstDeclaration()))) {
				break;
			}

			switch (t) {
				case TokenType.LEFT_PAREN:
					depthParen++;
					break;
				case TokenType.RIGHT_PAREN:
					if (depthParen > 0) depthParen--;
					break;
				case TokenType.LEFT_BRACE:
					depthBrace++;
					break;
				case TokenType.RIGHT_BRACE:
					if (depthBrace > 0) depthBrace--;
					break;
				case TokenType.LEFT_BRACKET:
					depthBracket++;
					break;
				case TokenType.RIGHT_BRACKET:
					if (depthBracket > 0) depthBracket--;
					break;
				case TokenType.LESS_THAN:
					depthAngle++;
					break;
				case TokenType.GREATER_THAN:
					if (depthAngle > 0) depthAngle--;
					break;
			}

			this.advance();
			consumed = true;
			endIndex = this.previous().end;
		}

		if (consumed && stops.includes(TokenType.RETURN)) {
			const tokens = this.tokens.slice(firstToken, this.current);
			const region = { input: this.input, source: this.annotationSource, tokens };
			const end = new AnnotationReader(region, this.annotationSource.index ??= new SourceTextIndex(this.input)).prefixEnd();
			if (end !== undefined && end < endIndex) {
				const next = tokens.findIndex((token) => token.start >= end && token.type !== TokenType.COMMENT && token.type !== TokenType.MULTILINE_COMMENT && token.type !== TokenType.NEWLINE);
				// Keep opaque suffixes intact; only a complete supported type followed
				// by a value statement start establishes a new boundary.
				if (next >= 0 && (this.isIdentifierLike(tokens[next]!.type) || tokens[next]!.type === TokenType.LEFT_PAREN || tokens[next]!.type === TokenType.AT)) {
					this.current = firstToken + next; endIndex = end;
				}
			}
		}
		this.validateAttributeTypes(this.tokens.slice(firstToken, this.current));
		if (owner) recordTypeRegion(owner, this.input, this.tokens.slice(firstToken, this.current), this.annotationSource);
		if (!consumed) return '';
		return this.input.slice(startIndex, endIndex).trim();
	}

	private skipTypeAnnotation(stops: TokenType[]): void {
		// Best-effort skip for Luau type syntax.
		this.readTypeAnnotationRaw(stops);
	}

	private optionalGenericTypeParameters(): string[] | undefined {
		if (!this.match(TokenType.LESS_THAN)) return undefined;

		const params: string[] = [];
		params.push(this.parseTypeParameterName());
		while (this.match(TokenType.COMMA)) {
			params.push(this.parseTypeParameterName());
		}
		this.consume(TokenType.GREATER_THAN, 'Expected \'>\' after type parameters');
		return params;
	}

	private parseTypeParameterName(): string {
		let name = this.identifier().name;
		if (this.match(TokenType.DOTS)) name += '...';
		return name;
	}

	private returnStatement(): AST.ReturnStatement {
		const args: AST.Expression[] = [];
		while (this.match(TokenType.COMMENT) || this.match(TokenType.MULTILINE_COMMENT)) {
			// skip inline comments after `return`
		}
		this.skipSeparatorsBeforeExpression();

		if (!this.check(TokenType.NEWLINE) && !this.check(TokenType.EOF) &&
		        !this.check(TokenType.END) && !this.check(TokenType.ELSE) &&
	        !this.check(TokenType.ELSEIF) && !this.check(TokenType.SEMICOLON)) {
			args.push(this.expression());

			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsBeforeExpression();
				args.push(this.expression());
			}
		}

		return {
			type: 'ReturnStatement',
			arguments: args,
			location: this.getLocation(),
		};
	}

	private breakStatement(): AST.BreakStatement {
		return {
			type: 'BreakStatement',
			location: this.getLocation(),
		};
	}

	private continueStatement(): AST.Statement {
		return {
			type: 'ContinueStatement',
			location: this.getLocation(),
		} as unknown as AST.Statement;
	}

	private assignmentOrExpressionStatement(): AST.Statement {
		const compound = this.compoundAssignmentStatement();
		if (compound) return compound;

		const expr = this.expression();
		const variables = [expr];
		while (this.match(TokenType.COMMA)) {
			this.skipSeparatorsInDelimitedList();
			variables.push(this.expression());
		}

		this.skipSeparatorsBefore(TokenType.ASSIGN);
		if (this.match(TokenType.ASSIGN)) {
			const init: AST.Expression[] = [];
			this.skipSeparatorsBeforeExpression();
			init.push(this.expression());

			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsBeforeExpression();
				init.push(this.expression());
			}

			return {
				type: 'AssignmentStatement',
				variables,
				init,
				location: this.getLocation(),
			};
		}

		return {
			type: 'ExpressionStatement',
			expression: expr,
			location: this.getLocation(),
		};
	}

	private compoundAssignmentStatement(): AST.AssignmentStatement | null {
		const start = this.current;
		const variable = this.call();
		const opToken = this.peek();
		if (!this.isCompoundAssignmentOperator(opToken.type) || this.peekAt(1).type !== TokenType.ASSIGN) {
			this.current = start;
			return null;
		}

		this.advance();
		this.advance();
		const right = this.expression();
		const init: AST.Expression = {
			type: 'BinaryExpression',
			operator: opToken.value as AST.BinaryOperator,
			left: variable,
			right,
			location: this.getLocation(),
		};
		return {
			type: 'AssignmentStatement',
			variables: [variable],
			init: [init],
			location: this.getLocation(),
		};
	}

	private isCompoundAssignmentOperator(type: TokenType): boolean {
		return (
			type === TokenType.PLUS ||
			type === TokenType.MINUS ||
			type === TokenType.MULTIPLY ||
			type === TokenType.DIVIDE ||
			type === TokenType.MODULO ||
			type === TokenType.POWER ||
			type === TokenType.CONCAT
		);
	}

	private expression(): AST.Expression {
		return this.or();
	}

	private typeCast(): AST.Expression {
		let expr = this.call();
		while (this.match(TokenType.DOUBLE_COLON)) {
			const owner = {};
			const typeAnnotation = this.readTypeAnnotationRaw(this.typeCastAnnotationStops(), owner);
			expr = { type: 'TypeCastExpression', expression: expr, typeAnnotation, location: this.getLocation() };
			copyTypeRegions(owner, expr);
		}
		return expr;
	}

	private typeCastAnnotationStops(): TokenType[] {
		return [
			TokenType.COMMA,
			TokenType.RIGHT_PAREN,
			TokenType.RIGHT_BRACKET,
			TokenType.RIGHT_BRACE,
			TokenType.SEMICOLON,
			TokenType.NEWLINE,
			TokenType.COMMENT,
			TokenType.MULTILINE_COMMENT,
			TokenType.END,
			TokenType.ELSE,
			TokenType.ELSEIF,
			TokenType.THEN,
			TokenType.DO,
			TokenType.UNTIL,
			TokenType.OR,
			TokenType.AND,
			TokenType.EQUAL,
			TokenType.NOT_EQUAL,
			TokenType.PLUS,
			TokenType.MINUS,
			TokenType.MULTIPLY,
			TokenType.DIVIDE,
			TokenType.FLOOR_DIVIDE,
			TokenType.MODULO,
			TokenType.POWER,
			TokenType.CONCAT,
		];
	}

	private or(): AST.Expression {
		let expr = this.and();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.OR);
			if (!this.match(TokenType.OR)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.and();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private and(): AST.Expression {
		let expr = this.equality();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.AND);
			if (!this.match(TokenType.AND)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.equality();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private equality(): AST.Expression {
		let expr = this.comparison();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.EQUAL, TokenType.NOT_EQUAL);
			if (!this.match(TokenType.EQUAL, TokenType.NOT_EQUAL)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.comparison();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private comparison(): AST.Expression {
		let expr = this.concatenation();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.GREATER_THAN, TokenType.GREATER_EQUAL, TokenType.LESS_THAN, TokenType.LESS_EQUAL);
			if (!this.match(TokenType.GREATER_THAN, TokenType.GREATER_EQUAL, TokenType.LESS_THAN, TokenType.LESS_EQUAL)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.concatenation();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private concatenation(): AST.Expression {
		let expr = this.term();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.CONCAT);
			if (!this.match(TokenType.CONCAT)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.term();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private term(): AST.Expression {
		let expr = this.factor();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.PLUS, TokenType.MINUS);
			if (!this.match(TokenType.PLUS, TokenType.MINUS)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.factor();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private factor(): AST.Expression {
		let expr = this.unary();

		while (true) {
			this.skipNewlinesBeforeExpressionContinuation(TokenType.MULTIPLY, TokenType.DIVIDE, TokenType.FLOOR_DIVIDE, TokenType.MODULO);
			if (!this.match(TokenType.MULTIPLY, TokenType.DIVIDE, TokenType.FLOOR_DIVIDE, TokenType.MODULO)) break;
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.unary();
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private unary(): AST.Expression {
		if (this.match(TokenType.NOT, TokenType.MINUS, TokenType.LENGTH)) {
			const operator = this.previous().value as AST.UnaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.unary();
			return {
				type: 'UnaryExpression',
				operator,
				argument: right,
				location: this.getLocation(),
			};
		}

		return this.power();
	}

	private power(): AST.Expression {
		let expr = this.typeCast();

		if (this.match(TokenType.POWER)) {
			const operator = this.previous().value as AST.BinaryOperator;
			this.skipSeparatorsBeforeExpression();
			const right = this.unary(); // Right associative
			expr = {
				type: 'BinaryExpression',
				operator,
				left: expr,
				right,
				location: this.getLocation(),
			};
		}

		return expr;
	}

	private call(): AST.Expression {
		let expr = this.primary();

		while (true) {
			this.skipNewlinesBeforeCallSuffix();
			if (this.match(TokenType.LEFT_PAREN)) {
				expr = this.finishCall(expr);
			} else if (this.match(TokenType.STRING)) {
				expr = this.callWithSingleArg(expr, this.stringFromPrevious());
			} else if (this.match(TokenType.LEFT_BRACE)) {
				expr = this.callWithSingleArg(expr, this.table());
			} else if (this.match(TokenType.DOT)) {
				const property = this.memberIdentifier();
				expr = {
					type: 'MemberExpression',
					object: expr,
					property,
					indexer: '.',
					location: this.getLocation(),
				};
				if (!property.name) break;
			} else if (this.match(TokenType.COLON)) {
				const property = this.memberIdentifier();
				expr = {
					type: 'MemberExpression',
					object: expr,
					property,
					indexer: ':',
					location: this.getLocation(),
				};
				if (!property.name) break;
				expr = this.finishMethodCall(expr);
			} else if (this.match(TokenType.LEFT_BRACKET)) {
				const index = this.expression();
				this.consume(TokenType.RIGHT_BRACKET, 'Expected \']\' after index');
				expr = {
					type: 'IndexExpression',
					object: expr,
					index,
					location: this.getLocation(),
				};
			} else if (this.check(TokenType.LESS_THAN) && this.peekAt(1).type === TokenType.LESS_THAN) {
				this.skipExplicitTypeInstantiation();
			} else {
				break;
			}
		}

		return expr;
	}

	private finishMethodCall(callee: AST.Expression): AST.Expression {
		const methodLine = this.previous().line;
		const trivia = () => {
			let offset = 0;
			while ([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.peekAt(offset).type)) offset++;
			return offset;
		};
		let offset = trivia();
		if (this.peekAt(offset).type === TokenType.LESS_THAN && this.peekAt(offset + 1).type === TokenType.LESS_THAN) {
			for (let i = 0; i < offset; i++) this.advance();
			this.skipExplicitTypeInstantiation();
			offset = trivia();
		}
		const argument = this.peekAt(offset);
		if (![TokenType.LEFT_PAREN, TokenType.LEFT_BRACE, TokenType.STRING].includes(argument.type)) {
			// Keep the receiver/method recovery AST for completions and following statements.
			this.errors.push(new ParseError('Expected \'(\', \'{\' or string after method name', argument));
			return callee;
		}
		for (let i = 0; i < offset; i++) this.advance();
		if (this.match(TokenType.LEFT_PAREN)) {
			if (argument.line !== methodLine) this.errors.push(new ParseError('Ambiguous syntax: method call parentheses must start on the method name line', argument));
			return this.finishCall(callee);
		}
		if (this.match(TokenType.STRING)) return this.callWithSingleArg(callee, this.stringFromPrevious());
		this.consume(TokenType.LEFT_BRACE, 'Expected method call arguments');
		return this.callWithSingleArg(callee, this.table());
	}

	private memberIdentifier(): AST.Identifier {
		const separator = this.previous();
		let offset = 0;
		while ([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.peekAt(offset).type)) offset++;
		if (this.peekAt(offset).type === TokenType.IDENTIFIER) {
			for (let i = 0; i < offset; i++) this.advance();
			return this.identifier();
		}
		if ([TokenType.EOF, TokenType.NEWLINE, TokenType.SEMICOLON, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.peek().type)) {
			this.errors.push(new ParseError('Expected identifier after member separator', this.peek()));
			const position = { line: separator.line, column: separator.column + separator.value.length };
			return { type: 'Identifier', name: '', location: { start: position, end: { ...position } } };
		}
		return this.identifier();
	}

	private skipNewlinesBeforeCallSuffix(): void {
		let offset = 0;
		while (
			this.peekAt(offset).type === TokenType.NEWLINE ||
			this.peekAt(offset).type === TokenType.COMMENT ||
			this.peekAt(offset).type === TokenType.MULTILINE_COMMENT
		) {
			offset++;
		}
		if (offset === 0) return;

		const suffix = this.peekAt(offset).type;
		if (
			suffix !== TokenType.DOT &&
				suffix !== TokenType.COLON &&
				suffix !== TokenType.LEFT_BRACKET
		) {
			return;
		}

		for (let i = 0; i < offset; i++) this.advance();
	}

	private finishCall(callee: AST.Expression): AST.CallExpression {
		const args: AST.Expression[] = [];
		this.skipSeparatorsInDelimitedList();

		if (!this.check(TokenType.RIGHT_PAREN)) {
			args.push(this.expression());
			this.skipSeparatorsInDelimitedList();
			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsInDelimitedList();
				if (this.check(TokenType.RIGHT_PAREN)) break;
				args.push(this.expression());
				this.skipSeparatorsInDelimitedList();
			}
		}

		this.consume(TokenType.RIGHT_PAREN, 'Expected \')\' after arguments');

		return {
			type: 'CallExpression',
			callee,
			arguments: args,
			location: this.getLocation(),
		};
	}

	private primary(): AST.Expression {
		if (this.match(TokenType.DOTS)) {
			return {
				type: 'VarargLiteral',
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.IF)) {
			return this.ifExpression();
		}

		if (this.match(TokenType.CONTINUE)) {
			return {
				type: 'Identifier',
				name: this.previous().value,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.EXPORT)) {
			return {
				type: 'Identifier',
				name: this.previous().value,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.TRUE)) {
			return {
				type: 'Boolean',
				value: true,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.FALSE)) {
			return {
				type: 'Boolean',
				value: false,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.NIL)) {
			return {
				type: 'Nil',
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.NUMBER)) {
			const token = this.previous();
			if (token.value.endsWith('i')) {
				try { return { type: 'Integer', value: integerLiteralValue(token.value), location: this.getLocation() }; }
				catch (error) { throw new ParseError(error instanceof Error ? error.message : 'Malformed integer', token); }
			}
			const raw = token.value.replace(/_/g, '');
			const normalizedRaw = raw.endsWith('.') ? `${raw}0` : raw;
			return {
				type: 'Number',
				value:
					normalizedRaw.startsWith('0b') || normalizedRaw.startsWith('0B')
						? Number.parseInt(normalizedRaw.slice(2), 2)
						: Number(normalizedRaw),
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.STRING)) return this.stringFromPrevious();
		if (this.match(TokenType.TEMPLATE_START)) return this.interpolatedString();

		if (this.match(TokenType.IDENTIFIER)) {
			return {
				type: 'Identifier',
				name: this.previous().value,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.LEFT_PAREN)) {
			this.skipSeparatorsBeforeExpression();
			const expr = this.expression();
			this.skipSeparatorsInDelimitedList();
			this.consume(TokenType.RIGHT_PAREN, 'Expected \')\' after expression');
			expr.parenthesized = true;
			return expr;
		}

		if (this.match(TokenType.LEFT_BRACE)) {
			return this.table();
		}

		if (this.check(TokenType.AT)) {
			const start = this.peek();
			const attributes = this.functionAttributes();
			this.consume(TokenType.FUNCTION, 'Attributes in expressions must precede function');
			const node = this.functionExpression();
			node.attributes = attributes;
			node.location = { start: this.tokenLocation(start).start, end: node.location!.end };
			return node;
		}
		if (this.match(TokenType.FUNCTION)) {
			return this.functionExpression();
		}

		throw new ParseError(`Unexpected token: ${this.peek().value}`, this.peek());
	}

	private ifExpression(): AST.Expression {
		const start = this.previous();
		const condition = this.ifCondition();
		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.THEN, 'Expected \'then\' after if expression condition');
		this.skipSeparatorsInDelimitedList();
		const consequent = this.expression();
		this.skipSeparatorsInDelimitedList();
		if (this.match(TokenType.ELSEIF)) {
			const alternate = this.ifExpression();
			return {
				type: 'IfExpression',
				...condition,
				consequent,
				alternate,
				location: { start: { line: start.line, column: start.column }, end: this.getLocation().end },
			} as unknown as AST.Expression;
		}
		this.consume(TokenType.ELSE, 'Expected \'else\' after if expression consequent');
		this.skipSeparatorsInDelimitedList();
		const alternate = this.expression();

		return {
			type: 'IfExpression',
			...condition,
			consequent,
			alternate,
			location: { start: { line: start.line, column: start.column }, end: this.getLocation().end },
		} as unknown as AST.Expression;
	}

	private interpolatedString(): AST.Expression {
		const start = this.previous();
		const parts: AST.Expression[] = [];
		while (!this.check(TokenType.TEMPLATE_END) && !this.isAtEnd()) {
			if (this.match(TokenType.STRING)) parts.push(this.stringFromPrevious());
			else {
				this.consume(TokenType.INTERPOLATION_START, 'Expected interpolation expression');
				this.skipSeparatorsInDelimitedList();
				parts.push(this.expression());
				this.skipSeparatorsInDelimitedList();
				this.consume(TokenType.INTERPOLATION_END, 'Expected closing interpolation brace');
			}
		}
		const end = this.consume(TokenType.TEMPLATE_END, 'Expected closing backtick');
		const location = { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column + end.end - end.start } };
		// Native InterpStringSimple is a constant string, including its delimiters.
		if (parts.length === 1 && parts[0]!.type === 'String') return { ...parts[0]!, location };
		return { type: 'InterpolatedString', parts, location };
	}

	private stringFromPrevious(): AST.LuaString {
		return {
			type: 'String',
			value: this.previous().stringValue ?? stringLiteralValue(this.previous().value, this.previous().start),
			location: this.getLocation(),
		};
	}

	private callWithSingleArg(callee: AST.Expression, argument: AST.Expression): AST.CallExpression {
		return {
			type: 'CallExpression',
			callee,
			arguments: [argument],
			location: this.getLocation(),
		};
	}

	private skipExplicitTypeInstantiation(): void {
		this.consume(TokenType.LESS_THAN, 'Expected \'<\' to start type instantiation');
		this.consume(TokenType.LESS_THAN, 'Expected \'<<\' to start type instantiation');

		let depth = 0;
		while (!this.isAtEnd()) {
			if (this.check(TokenType.LESS_THAN)) {
				depth++;
				this.advance();
				continue;
			}

			if (this.check(TokenType.GREATER_THAN)) {
				if (depth === 0 && this.peekAt(1).type === TokenType.GREATER_THAN) {
					this.advance();
					this.advance();
					return;
				}
				if (depth > 0) depth--;
				this.advance();
				continue;
			}

			this.advance();
		}
	}

	private table(): AST.LuaTable {
		const fields: AST.TableField[] = [];

		while (!this.check(TokenType.RIGHT_BRACE) && !this.isAtEnd()) {
			if (this.match(TokenType.NEWLINE) || this.match(TokenType.COMMENT) || this.match(TokenType.MULTILINE_COMMENT) || this.match(TokenType.COMMA) || this.match(TokenType.SEMICOLON)) {
				continue;
			}

			let key: AST.Expression | undefined;
			let computed = false;
			let value: AST.Expression;

			if (this.match(TokenType.LEFT_BRACKET)) {
				computed = true;
				key = this.expression();
				this.consume(TokenType.RIGHT_BRACKET, 'Expected \']\' after table key');
				this.consume(TokenType.ASSIGN, 'Expected \'=\' after table key');
				value = this.expression();
			} else if (this.check(TokenType.IDENTIFIER) && this.peekNext().type === TokenType.ASSIGN) {
				key = this.identifier();
				this.consume(TokenType.ASSIGN, 'Expected \'=\' after table key');
				value = this.expression();
			} else {
				value = this.expression();
			}

			fields.push({
				type: 'TableField',
				key,
				computed,
				value,
				location: this.getLocation(),
			});

			this.skipSeparatorsInDelimitedList();
			if (!this.match(TokenType.COMMA) && !this.match(TokenType.SEMICOLON)) {
				break;
			}
		}

		this.consume(TokenType.RIGHT_BRACE, 'Expected \'}\' after table');

		return {
			type: 'Table',
			fields,
			location: this.getLocation(),
		};
	}

	private skipSeparatorsInDelimitedList(): void {
		while (this.match(TokenType.NEWLINE) || this.match(TokenType.COMMENT) || this.match(TokenType.MULTILINE_COMMENT)) {
			// skip
		}
	}

	private skipStatementSeparators(): boolean {
		let skipped = false;
		while (this.match(TokenType.NEWLINE) || this.match(TokenType.COMMENT) || this.match(TokenType.MULTILINE_COMMENT) || this.match(TokenType.SEMICOLON)) {
			skipped = true;
		}
		return skipped;
	}

	private skipSeparatorsBeforeExpression(): void {
		let offset = 0;
		while (this.peekAt(offset).type === TokenType.NEWLINE || this.peekAt(offset).type === TokenType.COMMENT || this.peekAt(offset).type === TokenType.MULTILINE_COMMENT) {
			offset++;
		}
		if (offset === 0) return;
		if (!this.canStartExpression(this.peekAt(offset).type)) return;
		for (let i = 0; i < offset; i++) this.advance();
	}

	private skipSeparatorsBefore(type: TokenType): void {
		let offset = 0;
		while (this.peekAt(offset).type === TokenType.NEWLINE || this.peekAt(offset).type === TokenType.COMMENT || this.peekAt(offset).type === TokenType.MULTILINE_COMMENT) {
			offset++;
		}
		if (offset === 0 || this.peekAt(offset).type !== type) return;
		for (let i = 0; i < offset; i++) this.advance();
	}

	private canStartExpression(type: TokenType): boolean {
		return (
			type === TokenType.IDENTIFIER ||
			type === TokenType.NUMBER ||
			type === TokenType.STRING ||
			type === TokenType.BOOLEAN ||
			type === TokenType.NIL ||
			type === TokenType.TRUE ||
			type === TokenType.FALSE ||
			type === TokenType.LEFT_PAREN ||
			type === TokenType.LEFT_BRACE ||
			type === TokenType.FUNCTION ||
			type === TokenType.AT ||
			type === TokenType.IF ||
			type === TokenType.NOT ||
			type === TokenType.MINUS ||
			type === TokenType.LENGTH ||
			type === TokenType.DOTS
		);
	}

	private skipNewlinesBeforeExpressionContinuation(...continuations: TokenType[]): void {
		let offset = 0;
		while (this.peekAt(offset).type === TokenType.NEWLINE || this.peekAt(offset).type === TokenType.COMMENT || this.peekAt(offset).type === TokenType.MULTILINE_COMMENT) {
			offset++;
		}
		if (offset === 0) return;
		if (!continuations.includes(this.peekAt(offset).type)) return;
		for (let i = 0; i < offset; i++) this.advance();
	}

	private functionExpression(): AST.LuaFunction {
		const typeParameters = this.optionalGenericTypeParameters();
		this.consume(TokenType.LEFT_PAREN, 'Expected \'(\' after \'function\'');
		this.skipSeparatorsInDelimitedList();

		const parameters: AST.Identifier[] = [];
		if (!this.check(TokenType.RIGHT_PAREN)) {
			parameters.push(this.typedIdentifierInParamList());
			this.skipSeparatorsInDelimitedList();
			while (this.match(TokenType.COMMA)) {
				this.skipSeparatorsInDelimitedList();
				if (this.check(TokenType.RIGHT_PAREN)) break;
				parameters.push(this.typedIdentifierInParamList());
				this.skipSeparatorsInDelimitedList();
			}
		}

		this.consume(TokenType.RIGHT_PAREN, 'Expected \')\' after parameters');

		// Luau allows return type annotations: `function(): number`.
		const returnTypeOwner = {};
		let returnTypeAnnotation: string | undefined;
		if (this.match(TokenType.COLON)) {
			returnTypeAnnotation = this.readTypeAnnotationRaw([
				TokenType.NEWLINE,
				TokenType.RETURN,
				TokenType.LOCAL,
				TokenType.IF,
				TokenType.FOR,
				TokenType.WHILE,
				TokenType.REPEAT,
				TokenType.DO,
				TokenType.FUNCTION,
				TokenType.BREAK,
				TokenType.CONTINUE,
				TokenType.END,
			], returnTypeOwner);
		}

		const body: AST.Statement[] = [];
		while (!this.check(TokenType.END) && !this.isAtEnd()) {
			if (this.skipStatementSeparators()) continue;
			const stmt = this.statement();
			if (stmt) body.push(stmt);
		}

		this.consume(TokenType.END, 'Expected \'end\' after function body');

		const node: AST.LuaFunction = {
			type: 'Function',
			typeParameters,
			parameters,
			body,
			location: this.getLocation(),
		};
		if (returnTypeAnnotation) node.returnTypeAnnotation = returnTypeAnnotation;
		copyTypeRegions(returnTypeOwner, node);
		return node;
	}

	private identifier(): AST.Identifier {
		if (!this.isIdentifierLike(this.peek().type)) {
			throw new ParseError('Expected identifier', this.peek());
		}
		const token = this.advance();
		return {
			type: 'Identifier',
			name: token.value,
			location: this.getLocation(),
		};
	}

	private isIdentifierLike(type: TokenType): boolean {
		return type === TokenType.IDENTIFIER || type === TokenType.CONTINUE || type === TokenType.EXPORT;
	}

	// Utility methods
	private match(...types: TokenType[]): boolean {
		for (const type of types) {
			if (this.check(type)) {
				this.advance();
				return true;
			}
		}
		return false;
	}

	private check(type: TokenType): boolean {
		if (this.isAtEnd()) return false;
		return this.peek().type === type;
	}

	private advance(): Token {
		if (!this.isAtEnd()) this.current++;
		return this.previous();
	}

	private isAtEnd(): boolean {
		return this.peek().type === TokenType.EOF;
	}

	private peek(): Token {
		return this.tokens[this.current];
	}

	private peekNext(): Token {
		if (this.current + 1 >= this.tokens.length) {
			return this.tokens[this.tokens.length - 1]; // EOF token
		}
		return this.tokens[this.current + 1];
	}

	private peekAt(offset: number): Token {
		const index = this.current + offset;
		if (index >= this.tokens.length) return this.tokens[this.tokens.length - 1];
		return this.tokens[index];
	}

	private previous(): Token {
		return this.tokens[this.current - 1];
	}

	private consume(type: TokenType, message: string): Token {
		if (this.check(type)) return this.advance();

		throw new ParseError(message, this.peek());
	}

	private tokenLocation(token: Token): AST.SourceLocation {
		return { start: { line: token.line, column: token.column }, end: { line: token.line, column: token.column + token.value.length } };
	}

	private checkConstDeclaration(): boolean {
		if (!this.check(TokenType.IDENTIFIER) || this.peek().value !== 'const') return false;
		let offset = 1;
		while ([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.peekAt(offset).type)) offset++;
		return this.isIdentifierLike(this.peekAt(offset).type) || this.peekAt(offset).type === TokenType.FUNCTION;
	}

	private checkContinueStatement(): boolean {
		if (!this.check(TokenType.CONTINUE)) return false;
		let offset = 1;
		while (this.peekAt(offset).type === TokenType.COMMENT || this.peekAt(offset).type === TokenType.MULTILINE_COMMENT) offset++;
		return this.isStatementBoundary(this.peekAt(offset).type);
	}

	private isStatementBoundary(type: TokenType): boolean {
		return (
			type === TokenType.EOF ||
			type === TokenType.NEWLINE ||
			type === TokenType.SEMICOLON ||
			type === TokenType.END ||
			type === TokenType.ELSE ||
			type === TokenType.ELSEIF ||
			type === TokenType.UNTIL
		);
	}

	private synchronize(): void {
		this.advance();

		while (!this.isAtEnd()) {
			if (this.previous().type === TokenType.NEWLINE) return;

			switch (this.peek().type) {
				case TokenType.FUNCTION:
				case TokenType.LOCAL:
				case TokenType.FOR:
				case TokenType.IF:
				case TokenType.WHILE:
				case TokenType.RETURN:
					return;
			}

			this.advance();
		}
	}

	private getLocation(): AST.SourceLocation {
		const token = this.current > 0 ? this.previous() : this.peek();
		return {
			start: { line: token.line, column: token.column },
			end: { line: token.line, column: token.column + token.end - token.start },
		};
	}
}
