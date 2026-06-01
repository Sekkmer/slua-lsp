import { Token, TokenType, Lexer } from '../clients/lexer';
import * as AST from '../types';

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

	constructor(input: string = '') {
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

	public getCurrentPosition(): number {
		return this.current;
	}

	public parse(input?: string): AST.Program {
		if (input) {
			this.input = input;
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
			if (this.match(TokenType.LOCAL)) return this.localStatement();
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

	private localStatement(): AST.Statement {
		if (this.match(TokenType.FUNCTION)) {
			return this.functionDeclaration(true);
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

		return {
			type: 'LocalStatement',
			variables,
			init,
			location: this.getLocation(),
		};
	}

	private functionDeclaration(isLocal: boolean): AST.FunctionDeclaration {
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
			]);
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

		return node;
	}

	private ifStatement(consumeEnd = true): AST.IfStatement {
		this.skipSeparatorsBeforeExpression();
		const test = this.expression();
		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.THEN, 'Expected \'then\' after if condition');

		const consequent: AST.Statement[] = [];
		while (!this.check(TokenType.ELSEIF) && !this.check(TokenType.ELSE) &&
           !this.check(TokenType.END) && !this.isAtEnd()) {
			if (this.skipStatementSeparators()) continue;
			const stmt = this.statement();
			if (stmt) consequent.push(stmt);
		}

		let alternate: AST.Statement[] | AST.IfStatement | undefined;
		if (this.match(TokenType.ELSEIF)) {
			alternate = this.ifStatement(false);
		} else if (this.match(TokenType.ELSE)) {
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
			test,
			consequent,
			alternate,
			location: this.getLocation(),
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
				id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.RIGHT_PAREN]);
			}
			return id;
		}

		const id = this.identifier();
		if (this.match(TokenType.COLON)) {
			id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.RIGHT_PAREN]);
		}
		return id;
	}

	private typedIdentifierInForList(): AST.Identifier {
		const id = this.identifier();
		if (this.match(TokenType.COLON)) {
			id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.IN, TokenType.ASSIGN]);
		}
		return id;
	}

	private typedIdentifierInLocal(): AST.Identifier {
		const id = this.identifier();
		if (this.match(TokenType.COLON)) {
			id.typeAnnotation = this.readTypeAnnotationRaw([TokenType.COMMA, TokenType.ASSIGN, TokenType.NEWLINE]);
		}
		return id;
	}

	private readTypeAnnotationRaw(stops: TokenType[]): string {
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
			if (depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0 && stops.includes(t)) {
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
		let name = this.consume(TokenType.IDENTIFIER, 'Expected type parameter').value;
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
			expr = {
				type: 'TypeCastExpression',
				expression: expr,
				typeAnnotation: this.readTypeAnnotationRaw(this.typeCastAnnotationStops()),
				location: this.getLocation(),
			};
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
				const property = this.identifier();
				expr = {
					type: 'MemberExpression',
					object: expr,
					property,
					indexer: '.',
					location: this.getLocation(),
				};
			} else if (this.match(TokenType.COLON)) {
				const property = this.identifier();
				expr = {
					type: 'MemberExpression',
					object: expr,
					property,
					indexer: ':',
					location: this.getLocation(),
				};
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
			const raw = this.previous().value.replace(/_/g, '').replace(/i$/, '');
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
			return expr;
		}

		if (this.match(TokenType.LEFT_BRACE)) {
			return this.table();
		}

		if (this.match(TokenType.FUNCTION)) {
			return this.functionExpression();
		}

		throw new ParseError(`Unexpected token: ${this.peek().value}`, this.peek());
	}

	private ifExpression(): AST.Expression {
		const test = this.expression();
		this.skipSeparatorsInDelimitedList();
		this.consume(TokenType.THEN, 'Expected \'then\' after if expression condition');
		this.skipSeparatorsInDelimitedList();
		const consequent = this.expression();
		this.skipSeparatorsInDelimitedList();
		if (this.match(TokenType.ELSEIF)) {
			const alternate = this.ifExpression();
			return {
				type: 'IfExpression',
				test,
				consequent,
				alternate,
				location: this.getLocation(),
			} as unknown as AST.Expression;
		}
		this.consume(TokenType.ELSE, 'Expected \'else\' after if expression consequent');
		this.skipSeparatorsInDelimitedList();
		const alternate = this.expression();

		return {
			type: 'IfExpression',
			test,
			consequent,
			alternate,
			location: this.getLocation(),
		} as unknown as AST.Expression;
	}

	private stringFromPrevious(): AST.LuaString {
		const value = this.previous().value;
		if (value.startsWith('[')) {
			const match = /^\[=*\[/.exec(value);
			const delimiterLength = match?.[0].length ?? 1;
			return {
				type: 'String',
				value: value.slice(delimiterLength, -delimiterLength),
				location: this.getLocation(),
			};
		}
		return {
			type: 'String',
			value: value.slice(1, -1),
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
			let value: AST.Expression;

			if (this.match(TokenType.LEFT_BRACKET)) {
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
			]);
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
			end: { line: token.line, column: token.column + token.value.length },
		};
	}
}
