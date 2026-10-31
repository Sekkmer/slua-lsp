import { recordTypeRegion, copyTypeRegions, type TypeSource } from '../../../parser/typeRegions.js';
import { Token, TokenType, Lexer } from '../clients/lexer';
import { LuaParser, ParseError } from '../parsers/lua';
import * as AST from '../types';

type LuauComment = {
	value: string;
	type: 'Block' | 'Line';
};

// Pinned native Parser::parseClassStat reserves the rest of the __ namespace.
const classMetamethods = new Set(['__init', '__call', '__concat', '__unm', '__add', '__sub', '__mul', '__div', '__mod', '__pow', '__tostring', '__eq', '__lt', '__le', '__iter', '__len', '__idiv']);
const disallowedClassMetamethods = new Set(['__index', '__newindex', '__mode', '__metatable', '__type']);

const isNameType = (type: TokenType) => [TokenType.IDENTIFIER, TokenType.CONTINUE, TokenType.EXPORT, TokenType.AS, TokenType.TYPE].includes(type);

export class LuauParser {
	private tokens: Token[] = [];
	private current: number = 0;
	private input: string = '';
	private errors: ParseError[] = [];
	private classNames = new Set<string>();

	constructor(input: string = '', private annotationSource: TypeSource = { input }) {
		this.input = input;
	}

	public getErrors(): ParseError[] {
		return [...this.errors];
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
		this.classNames.clear();

		const statements: AST.Statement[] = [];
		let previousToken = -1;
		let pendingComments: LuauComment[] = [];

		while (!this.isAtEnd()) {
			if (this.current <= previousToken) throw new Error('LuauParser safety break: parser made no token progress');
			previousToken = this.current;
			// Collect comments before the statement
			while (this.check(TokenType.COMMENT) || this.check(TokenType.MULTILINE_COMMENT)) {
				const commentToken = this.advance();
				pendingComments.push({
					value: commentToken.value,
					type: commentToken.type === TokenType.MULTILINE_COMMENT ? 'Block' : 'Line'
				});
			}
			if (this.isAtEnd()) break;

			if (this.match(TokenType.NEWLINE) || this.match(TokenType.SEMICOLON)) {
				continue;
			}

			// Handle Luau-specific statements
			if (this.check(TokenType.EXPORT) && this.checkTypeAliasStatement(1)) {
				this.advance();
				try {
					const node = this.typeAliasDeclaration(pendingComments);
					(node as AST.TypeAlias & { exported?: true }).exported = true;
					pendingComments = [];
					statements.push(node);
					continue;
				} catch (err) {
					if (err instanceof ParseError) {
						this.errors.push(err);
						statements.push(this.errorStatement(err));
					} else {
						statements.push(this.errorStatementMessage(String(err)));
					}
					this.synchronize();
					pendingComments = [];
					continue;
				}
			}

			if (this.check(TokenType.EXPORT) && this.checkClassDeclaration(1)) {
				this.advance();
				this.skipClassTrivia();
				const stmt = this.classDeclaration(pendingComments, true);
				pendingComments = [];
				statements.push(stmt);
				continue;
			}

			if (this.checkTypeAliasStatement()) {
				try {
					const node = this.typeAliasDeclaration(pendingComments);
					pendingComments = [];
					statements.push(node);
					continue;
				} catch (err) {
					if (err instanceof ParseError) {
						this.errors.push(err);
						statements.push(this.errorStatement(err));
					} else {
						statements.push(this.errorStatementMessage(String(err)));
					}
					this.synchronize();
					pendingComments = [];
					continue;
				}
			}

			if (this.checkContinueStatement()) {
				this.advance();
				statements.push({
					type: 'ContinueStatement',
					location: this.getLocation(),
				} as unknown as AST.Statement);
				continue;
			}

			if (this.checkClassDeclaration()) {
				const stmt = this.classDeclaration(pendingComments, false);
				pendingComments = [];
				statements.push(stmt);
				continue;
			}

			// Use base parser for other statements
			const baseParser = new LuaParser(this.input, this.annotationSource);
			baseParser.setTokens(this.tokens, this.current);
			try {
				const stmt = baseParser.parseStatement();
				this.errors.push(...baseParser.getErrors());
				if (stmt) {
					if (pendingComments.length && typeof stmt === 'object') {
						(stmt as AST.Statement & { comments?: LuauComment[] }).comments = pendingComments;
						pendingComments = [];
					}
					statements.push(stmt);
					this.current = baseParser.getCurrentPosition();
				} else {
					this.advance();
				}
			} catch (err) {
				if (err instanceof ParseError) {
					this.errors.push(err);
					statements.push(this.errorStatement(err));
				} else {
					statements.push(this.errorStatementMessage(String(err)));
				}
				this.current = baseParser.getCurrentPosition();
				this.synchronize();
				pendingComments = [];
			}

		}

		return {
			type: 'Program',
			body: statements.filter(
				(stmt) => stmt && typeof stmt === 'object' && typeof stmt.type === 'string'
			),
			location: this.getLocation(),
		};
	}

	private errorStatement(err: ParseError): AST.ErrorStatement {
		const token = err.token;
		return {
			type: 'ErrorStatement',
			message: err.message,
			location: {
				start: { line: token.line, column: token.column },
				end: { line: token.line, column: token.column + Math.max(1, token.value.length) }
			}
		};
	}

	private errorStatementMessage(message: string): AST.ErrorStatement {
		const token = this.peek();
		return {
			type: 'ErrorStatement',
			message,
			location: {
				start: { line: token.line, column: token.column },
				end: { line: token.line, column: token.column + Math.max(1, token.value.length) }
			}
		};
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
				case TokenType.TYPE:
				case TokenType.EXPORT:
					return;
			}

			this.advance();
		}
	}

	private checkClassDeclaration(offset = 0): boolean {
		let index = this.classSignificantIndex(this.current + offset);
		if (this.tokens[index]?.value === 'open') index = this.classSignificantIndex(index + 1);
		return this.tokens[index]?.value === 'class' && isNameType(this.tokens[this.classSignificantIndex(index + 1)]?.type);
	}

	private classSignificantIndex(index: number): number {
		while ([TokenType.NEWLINE, TokenType.COMMENT, TokenType.MULTILINE_COMMENT].includes(this.tokens[index]?.type)) index++;
		return Math.min(index, this.tokens.length - 1);
	}

	private skipClassTrivia(): void { this.current = this.classSignificantIndex(this.current); }

	/** Native parseClassRefExpr permits one suffix; its bracket key is an ordinary expression. */
	private classReference(): AST.Expression {
		this.skipClassTrivia();
		const object = this.identifier();
		this.skipClassTrivia();
		if (this.match(TokenType.DOT)) {
			this.skipClassTrivia();
			const property = this.identifier();
			return { type: 'MemberExpression', object, property, indexer: '.', location: { start: object.location!.start, end: property.location!.end } };
		}
		if (this.match(TokenType.LEFT_BRACKET)) {
			const parser = new LuaParser(this.input, this.annotationSource);
			parser.setTokens(this.tokens, this.current);
			try {
				const index = parser.parseNavigationExpression();
				this.current = parser.getCurrentPosition();
				this.skipClassTrivia();
				this.consume(TokenType.RIGHT_BRACKET, 'Expected \']\' after class reference');
				return { type: 'IndexExpression', object, index, location: { start: object.location!.start, end: this.getLocation().end } };
			} finally {
				this.errors.push(...parser.getErrors());
			}
		}
		return object;
	}

	private classDeclaration(pendingComments?: LuauComment[], exported = false): AST.Statement {
		this.annotationSource.hasClasses = true;
		const open = this.peek().value === 'open';
		let openKeywordLocation: AST.SourceLocation | undefined;
		if (open) { this.advance(); openKeywordLocation = this.getLocation(); this.skipClassTrivia(); }
		const classToken = this.advance();
		const classKeywordLocation = this.getLocation();
		this.skipClassTrivia();
		const name = this.identifier();
		const nameToken = this.previous();
		this.skipClassTrivia();
		let superClass: AST.Expression | undefined, extendsKeywordLocation: AST.SourceLocation | undefined;
		if (this.peek().value === 'extends') {
			this.advance(); extendsKeywordLocation = this.getLocation();
			try { superClass = this.classReference(); }
			catch (error) { if (!(error instanceof ParseError)) throw error; this.errors.push(error); }
		}
		const fields: AST.ClassField[] = [];
		const methods: AST.FunctionDeclaration[] = [];
		const members = new Set<string>();
		if (this.classNames.has(name.name)) this.errors.push(new ParseError(`A class named '${name.name}' has already been declared in this module`, nameToken));
		this.classNames.add(name.name);
		const register = (token: Token) => {
			if (members.has(token.value)) this.errors.push(new ParseError(`Duplicate class member '${token.value}'`, token));
			members.add(token.value);
		};

		while (!this.isAtEnd()) {
			while (this.match(TokenType.NEWLINE, TokenType.SEMICOLON, TokenType.COMMENT, TokenType.MULTILINE_COMMENT)) {
				// skip class trivia
			}
			if (this.check(TokenType.END)) break;
			if (this.isAtEnd()) break;

			if (this.checkClassField() && this.peekAt(1).type !== TokenType.FUNCTION) {
				const token = this.peekAt(1);
				try {
					fields.push(this.classFieldDeclaration());
					if (token.value.startsWith('__')) this.errors.push(new ParseError('Class properties cannot start with \'__\'', token));
					else register(token);
				} catch (error) {
					if (!(error instanceof ParseError)) throw error;
					this.errors.push(error);
				}
				continue;
			}

			if (this.checkClassField() && this.peekAt(1).type === TokenType.FUNCTION) {
				this.advance();
			}

			if (this.check(TokenType.FUNCTION)) {
				const methodStart = this.current;
				const methodName = this.peekAt(1);
				const baseParser = new LuaParser(this.input, this.annotationSource);
				baseParser.setTokens(this.tokens, this.current);
				try {
					const stmt = baseParser.parseStatement();
					if (stmt?.type === 'FunctionDeclaration') {
						methods.push(stmt);
						if (stmt.identifier?.type !== 'Identifier') this.errors.push(new ParseError('Expected an unqualified class method name', methodName));
						else {
							register(methodName);
							if (disallowedClassMetamethods.has(methodName.value)) this.errors.push(new ParseError(`Classes cannot define '${methodName.value}' as a metamethod`, methodName));
							else if (methodName.value.startsWith('__') && !classMetamethods.has(methodName.value)) this.errors.push(new ParseError(`Cannot use '${methodName.value}' as a method name: names starting with '__' are reserved`, methodName));
						}
						if (stmt.parameters[0]?.name === 'self' && stmt.parameters[0].typeAnnotation !== undefined) {
							let self = methodName;
							for (let index = methodStart + 2; index < baseParser.getCurrentPosition(); index++) {
								if (this.tokens[index].value === 'self') { self = this.tokens[index]; break; }
							}
							this.errors.push(new ParseError('The \'self\' parameter cannot have a type annotation', self));
						}
					}
				} catch (error) {
					if (!(error instanceof ParseError)) throw error;
					this.errors.push(error);
				} finally {
					this.errors.push(...baseParser.getErrors());
					this.current = Math.max(methodStart + 1, baseParser.getCurrentPosition());
				}
				continue;
			}

			this.errors.push(new ParseError('Only class properties and functions can be declared within a class', this.advance()));
		}
		if (!this.match(TokenType.END)) this.errors.push(new ParseError('Expected \'end\' after class body', this.peek()));

		const node = this.classDeclarationNode(classToken, name, fields, methods, exported, pendingComments);
		node.open = open;
		node.superClass = superClass;
		node.classKeywordLocation = classKeywordLocation;
		node.openKeywordLocation = openKeywordLocation;
		node.extendsKeywordLocation = extendsKeywordLocation;
		if (openKeywordLocation && node.location) node.location.start = openKeywordLocation.start;
		return node;
	}

	private classDeclarationNode(
		classToken: Token,
		name: AST.Identifier,
		fields: AST.ClassField[],
		methods: AST.FunctionDeclaration[],
		exported: boolean,
		pendingComments?: LuauComment[]
	): AST.ClassDeclaration {
		if (exported) name.exported = true;
		const node = {
			type: 'ClassDeclaration',
			name,
			fields,
			methods,
			exported,
			location: {
				start: { line: classToken.line, column: classToken.column },
				end: this.getLocation().end,
			},
		} as AST.ClassDeclaration & { comments?: LuauComment[] };
		if (pendingComments?.length) node.comments = pendingComments;
		return node;
	}

	private checkClassField(): boolean {
		const token = this.peek();
		return token.type === TokenType.IDENTIFIER && token.value === 'public';
	}

	private classFieldDeclaration(): AST.ClassField {
		const visibilityToken = this.advance();
		const name = this.identifier();
		const owner = {};
		let typeAnnotation: string | undefined;
		if (this.match(TokenType.COLON)) {
			typeAnnotation = this.readRawTypeUntilBoundary(owner);
			if (!typeAnnotation) this.errors.push(new ParseError('Expected class property type after colon', this.peek()));
		}

		const field: AST.ClassField = {
			type: 'ClassField',
			visibility: 'public',
			name,
			typeAnnotation,
			location: {
				start: { line: visibilityToken.line, column: visibilityToken.column },
				end: this.getLocation().end,
			},
		};
		copyTypeRegions(owner, field);
		return field;
	}

	private readRawTypeUntilBoundary(owner: object): string {
		const firstToken = this.current;
		const startToken = this.peek();
		const startIndex = startToken.start;
		let endIndex = startIndex;
		let consumed = false;
		let depthParen = 0;
		let depthBrace = 0;
		let depthBracket = 0;
		let depthAngle = 0;

		while (!this.isAtEnd()) {
			const t = this.peek().type;
			if (depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0 && (t === TokenType.NEWLINE || t === TokenType.SEMICOLON || t === TokenType.END || t === TokenType.COMMENT || t === TokenType.MULTILINE_COMMENT || t === TokenType.FUNCTION || (consumed && this.checkClassField()))) {
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

		new LuaParser(this.input, this.annotationSource).validateAttributeTypes(this.tokens.slice(firstToken, this.current));
		recordTypeRegion(owner, this.input, this.tokens.slice(firstToken, this.current), this.annotationSource);
		return consumed ? this.input.slice(startIndex, endIndex).trim() : '';
	}

	private typeAliasDeclaration(pendingComments?: LuauComment[]): AST.TypeAlias {

		this.consumeTypeAliasKeyword('Expected \'type\'');
		const name = this.identifier();

		let typeParameters: string[] | undefined = undefined;
		if (this.match(TokenType.LESS_THAN)) {
			typeParameters = [];
			typeParameters.push(this.parseTypeParameterName());

			while (this.match(TokenType.COMMA)) {
				typeParameters.push(this.parseTypeParameterName());
			}

			this.consume(TokenType.GREATER_THAN, 'Expected \'>\' after type parameters');
		}

		this.consume(TokenType.ASSIGN, 'Expected \'=\' after type name');

		while (this.match(TokenType.NEWLINE)) {
			// Skip newlines
		}

		const firstToken = this.current;
		const definition = this.parseType();

		const typeAlias: AST.TypeAlias = {
			type: 'TypeAlias' as const,
			name,
			typeParameters,
			definition,
			location: this.getLocation(),
		};

		if (pendingComments && pendingComments.length) {
			(typeAlias as AST.TypeAlias & { comments?: LuauComment[] }).comments = pendingComments;
		}

		new LuaParser(this.input, this.annotationSource).validateAttributeTypes(this.tokens.slice(firstToken, this.current));
		recordTypeRegion(typeAlias, this.input, this.tokens.slice(firstToken, this.current), this.annotationSource);
		return typeAlias;
	}

	private parseParameter(): AST.Parameter {
		if (this.match(TokenType.DOTS)) {
			let typeAnnotation: AST.TypeAnnotation | undefined = undefined;
			if (this.match(TokenType.COLON)) {
				typeAnnotation = {
					type: 'TypeAnnotation',
					typeAnnotation: this.parseType(),
					location: this.getLocation(),
				};
			} else if (!this.check(TokenType.COMMA) && !this.check(TokenType.RIGHT_PAREN)) {
				typeAnnotation = {
					type: 'TypeAnnotation',
					typeAnnotation: this.parseType(),
					location: this.getLocation(),
				};
			}
			return {
				type: 'Parameter',
				name: { type: 'Identifier', name: '...', location: this.getLocation() },
				typeAnnotation,
				location: this.getLocation(),
			};
		}

		if (!this.check(TokenType.IDENTIFIER)) {
			return {
				type: 'Parameter',
				name: { type: 'Identifier', name: '_', location: this.getLocation() },
				typeAnnotation: {
					type: 'TypeAnnotation',
					typeAnnotation: this.parseType(),
					location: this.getLocation(),
				},
				location: this.getLocation(),
			};
		}

		if (this.peekAt(1).type !== TokenType.COLON && this.peekAt(1).type !== TokenType.DOTS) {
			return {
				type: 'Parameter',
				name: { type: 'Identifier', name: '_', location: this.getLocation() },
				typeAnnotation: {
					type: 'TypeAnnotation',
					typeAnnotation: this.parseType(),
					location: this.getLocation(),
				},
				location: this.getLocation(),
			};
		}

		const name = this.identifier();
		if (this.match(TokenType.DOTS)) {
			name.name += '...';
		}
		let typeAnnotation: AST.TypeAnnotation | undefined = undefined;

		if (this.match(TokenType.COLON)) {
			typeAnnotation = {
				type: 'TypeAnnotation',
				typeAnnotation: this.parseType(),
				location: this.getLocation(),
			};
		}

		return {
			type: 'Parameter',
			name,
			typeAnnotation,
			location: this.getLocation(),
		};
	}

	private parseType(): AST.LuauType {
		return this.parseUnionType();
	}

	private parseUnionType(): AST.LuauType {
		let left = this.parseIntersectionType();

		while (true) {
			while (this.match(TokenType.NEWLINE)) {
				// Skip newlines
			}
			if (!this.match(TokenType.PIPE)) break;
			while (this.match(TokenType.NEWLINE)) {
				// Skip newlines
			}

			const right = this.parseIntersectionType();
			left = {
				type: 'UnionType',
				types:
					left.type === 'UnionType'
						? [...(left as AST.UnionType).types, right]
						: [left, right],
			};
		}

		return left;
	}

	private parseIntersectionType(): AST.LuauType {
		let left = this.parsePostfixType();

		while (true) {
			while (this.match(TokenType.NEWLINE)) {
				// Skip newlines
			}
			if (!this.match(TokenType.AMPERSAND)) break;
			while (this.match(TokenType.NEWLINE)) {
				// Skip newlines
			}
			const right = this.parsePostfixType();
			left = {
				type: 'IntersectionType',
				types:
					left.type === 'IntersectionType'
						? [...(left as AST.IntersectionType).types, right]
						: [left, right],
			};
		}

		return left;
	}

	private parsePostfixType(): AST.LuauType {
		let type = this.parsePrimaryType();
		while (this.match(TokenType.QUESTION)) {
			type = {
				type: 'UnionType',
				types: [type, { type: 'NilType', location: this.getLocation() }],
				location: this.getLocation(),
			} as AST.UnionType;
		}
		return type;
	}

	private parsePrimaryType(): AST.LuauType {
		if (this.match(TokenType.LEFT_PAREN)) {
			if (this.isFunctionType()) {
				return this.parseFunctionType();
			} else {
				const type = this.parseTupleOrParenthesizedType();
				this.consume(TokenType.RIGHT_PAREN, 'Expected \')\' after type');
				return type;
			}
		}

		if (this.match(TokenType.LEFT_BRACE)) {
			return this.parseRecordType();
		}

		if (this.match(TokenType.STRING)) {
			const value = this.previous().value;
			return {
				type: 'GenericType',
				name: value,
				typeParameters: undefined,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.DOTS)) {
			const inner = this.parsePrimaryType();
			const innerName = inner.type === 'GenericType' ? (inner as AST.GenericType).name : inner.type;
			return {
				type: 'GenericType',
				name: `...${innerName}`,
				typeParameters: inner.type === 'GenericType' ? (inner as AST.GenericType).typeParameters : [inner],
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.TYPEOF)) {
			this.consume(TokenType.LEFT_PAREN, 'Expected \'(\' after typeof');
			this.skipBalancedExpressionUntilRightParen();
			return {
				type: 'GenericType',
				name: 'typeof',
				typeParameters: undefined,
				location: this.getLocation(),
			};
		}

		if (this.match(TokenType.IDENTIFIER, TokenType.CONTINUE, TokenType.EXPORT, TokenType.AS, TokenType.TYPE)) {
			const name = this.previous().value;
			if (name === 'typeof' && this.match(TokenType.LEFT_PAREN)) {
				this.skipBalancedExpressionUntilRightParen();
				return {
					type: 'GenericType',
					name: 'typeof',
					typeParameters: undefined,
					location: this.getLocation(),
				};
			}

			switch (name) {
				case 'string':
					return { type: 'StringType', location: this.getLocation() };
				case 'number':
					return { type: 'NumberType', location: this.getLocation() };
				case 'boolean':
					return { type: 'BooleanType', location: this.getLocation() };
				case 'nil':
					return { type: 'NilType', location: this.getLocation() };
				case 'any':
					return { type: 'AnyType', location: this.getLocation() };
				case 'true':
				case 'false':
					return { type: 'GenericType', name, typeParameters: undefined, location: this.getLocation() };
				default: {
					let typeName = name;
					while (this.match(TokenType.DOT)) {
						typeName += `.${this.identifier().name}`;
					}
					if (this.match(TokenType.DOTS)) {
						typeName += '...';
					}
					let typeParameters: AST.LuauType[] | undefined = undefined;
					if (this.match(TokenType.LESS_THAN)) {
						typeParameters = [];
						if (!this.check(TokenType.GREATER_THAN)) {
							typeParameters.push(this.parseType());
							while (this.match(TokenType.COMMA)) {
								typeParameters.push(this.parseType());
							}
						}
						this.consume(TokenType.GREATER_THAN, 'Expected \'>\' after type parameters');
					}
					return {
						type: 'GenericType',
						name: typeName,
						typeParameters,
						location: this.getLocation(),
					};
				}
			}
		}

		if (this.match(TokenType.TRUE) || this.match(TokenType.FALSE)) {
			const value = this.previous().value;
			return {
				type: 'GenericType',
				name: value,
				typeParameters: undefined,
				location: this.getLocation(),
			};
		}

		return { type: 'AnyType', location: this.getLocation() };
	}

	private parseTupleOrParenthesizedType(): AST.LuauType {
		if (this.check(TokenType.RIGHT_PAREN)) {
			return { type: 'GenericType', name: '()', typeParameters: [], location: this.getLocation() };
		}

		const types: AST.LuauType[] = [this.parseType()];
		while (this.match(TokenType.COMMA)) {
			if (this.check(TokenType.RIGHT_PAREN)) break;
			types.push(this.parseType());
		}
		if (types.length === 1) return types[0]!;
		return {
			type: 'GenericType',
			name: 'tuple',
			typeParameters: types,
			location: this.getLocation(),
		};
	}

	private parseRecordType(): AST.TableType | AST.ArrayType {
		const properties: Array<AST.PropertySignature | AST.IndexSignature> = [];

		while (!this.check(TokenType.RIGHT_BRACE) && !this.isAtEnd()) {
			if (this.match(TokenType.NEWLINE) || this.match(TokenType.COMMENT) || this.match(TokenType.MULTILINE_COMMENT)) {
				continue;
			}

			if (this.check(TokenType.RIGHT_BRACE)) break;

			// Only check for array syntax at the beginning to prevent conflicts
			if (properties.length === 0 && this.checkArraySyntax()) {
				const elementType = this.parseType();
				this.consume(TokenType.RIGHT_BRACE, 'Expected \'}\' after array element type');
				return {
					type: 'ArrayType',
					elementType,
					location: this.getLocation(),
				};
			}

			let key: string;
			let optional = false;

			// Allow reserved keywords as property names
			if (this.check(TokenType.STRING)) {
				const stringToken = this.advance();
				key = stringToken.value;
			} else if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.TYPE) || this.check(TokenType.EXPORT) || this.check(TokenType.FUNCTION) || this.check(TokenType.LOCAL)) {
				const token = this.advance();
				key = token.value;
				if (this.check(TokenType.QUESTION)) {
					optional = true;
					this.advance();
				}
			} else if (this.check(TokenType.LEFT_BRACKET)) {
				this.advance();
				const keyType = this.parseType();
				this.consume(TokenType.RIGHT_BRACKET, 'Expected \']\' after index signature key');
				this.consume(TokenType.COLON, 'Expected \':\' after index signature');
				const valueType = this.parseType();

				properties.push({
					type: 'IndexSignature',
					keyType,
					valueType,
					location: this.getLocation(),
				});

				if (this.check(TokenType.COMMA)) {
					this.advance();
				}
				continue;
			} else {
				this.advance();
				continue;
			}

			if (!this.check(TokenType.COLON)) {
				continue;
			}

			this.advance();
			const valueType = this.parseType();

			properties.push({
				type: 'PropertySignature',
				key: { type: 'Identifier', name: key },
				typeAnnotation: valueType,
				optional,
				location: this.getLocation(),
			});

			if (this.check(TokenType.COMMA)) {
				this.advance();
				while (this.match(TokenType.NEWLINE)) {
					// skip
				}
			} else if (!this.check(TokenType.RIGHT_BRACE)) {
				while (this.match(TokenType.NEWLINE)) {
					// skip
				}
			}
		}

		this.consume(TokenType.RIGHT_BRACE, 'Expected \'}\' after table type');

		return {
			type: 'TableType',
			properties,
			location: this.getLocation(),
		};
	}

	private checkArraySyntax(): boolean {
		if (!this.check(TokenType.IDENTIFIER) && !this.check(TokenType.TYPEOF)) return false;

		let lookahead = 1;
		while (this.current + lookahead < this.tokens.length) {
			const token = this.tokens[this.current + lookahead];

			if (token.type === TokenType.NEWLINE || token.type === TokenType.COMMENT) {
				lookahead++;
				continue;
			} else if (token.type === TokenType.RIGHT_BRACE) {
				return true;
			} else {
				return false;
			}
		}

		return false;
	}

	private isFunctionType(): boolean {
		let lookahead = 0;
		let depthParen = 1;
		let depthBrace = 0;
		let depthBracket = 0;

		while (this.current + lookahead < this.tokens.length) {
			const token = this.tokens[this.current + lookahead];

			if (token.type === TokenType.NEWLINE || token.type === TokenType.COMMENT || token.type === TokenType.MULTILINE_COMMENT) {
				lookahead++;
				continue;
			}

			switch (token.type) {
				case TokenType.LEFT_PAREN:
					depthParen++;
					break;
				case TokenType.RIGHT_PAREN:
					depthParen--;
					if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
						lookahead++;
						while (this.current + lookahead < this.tokens.length) {
							const next = this.tokens[this.current + lookahead];
							if (next.type === TokenType.NEWLINE || next.type === TokenType.COMMENT || next.type === TokenType.MULTILINE_COMMENT) {
								lookahead++;
								continue;
							}
							return next.type === TokenType.MINUS;
						}
						return false;
					}
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
			}

			lookahead++;
		}

		return false;
	}

	private parseFunctionType(): AST.FunctionType {
		const parameters: AST.Parameter[] = [];
		this.skipTypeSeparators();

		if (!this.check(TokenType.RIGHT_PAREN)) {
			parameters.push(this.parseParameter());
			this.skipTypeSeparators();
			while (this.match(TokenType.COMMA)) {
				this.skipTypeSeparators();
				if (this.check(TokenType.RIGHT_PAREN)) break;
				parameters.push(this.parseParameter());
				this.skipTypeSeparators();
			}
		}

		this.consume(TokenType.RIGHT_PAREN, 'Expected \')\' after function parameters');

		let returnType: AST.LuauType = { type: 'AnyType', location: this.getLocation() };
		this.skipTypeSeparators();
		if (this.match(TokenType.MINUS) && this.match(TokenType.GREATER_THAN)) {
			this.skipTypeSeparators();
			returnType = this.parseType();
		}

		return {
			type: 'FunctionType',
			parameters,
			returnType,
			location: this.getLocation(),
		};
	}

	private skipTypeSeparators(): void {
		while (this.match(TokenType.NEWLINE) || this.match(TokenType.COMMENT) || this.match(TokenType.MULTILINE_COMMENT)) {
			// skip
		}
	}

	private parseTypeParameterName(): string {
		let name = this.identifier().name;
		if (this.match(TokenType.DOTS)) name += '...';
		return name;
	}

	private skipBalancedExpressionUntilRightParen(): void {
		let depthParen = 1;
		let depthBrace = 0;
		let depthBracket = 0;

		while (!this.isAtEnd()) {
			const t = this.peek().type;
			switch (t) {
				case TokenType.LEFT_PAREN:
					depthParen++;
					break;
				case TokenType.RIGHT_PAREN:
					depthParen--;
					this.advance();
					if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) return;
					continue;
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
			}
			this.advance();
		}
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

	private checkTypeAliasKeyword(offset = 0): boolean {
		const token = this.peekAt(offset);
		if (token.type === TokenType.TYPE) return true;
		return token.type === TokenType.IDENTIFIER && token.value === 'type';
	}

	private checkTypeAliasStatement(offset = 0): boolean {
		if (!this.checkTypeAliasKeyword(offset)) return false;
		if (!isNameType(this.peekAt(offset + 1).type)) return false;
		const afterName = this.peekAt(offset + 2);
		return afterName.type === TokenType.ASSIGN || afterName.type === TokenType.LESS_THAN;
	}

	private consumeTypeAliasKeyword(message: string): Token {
		if (this.checkTypeAliasKeyword()) return this.advance();
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

	private getLocation(): AST.SourceLocation {
		const token = this.current > 0 ? this.previous() : this.peek();
		return {
			start: { line: token.line, column: token.column },
			end: { line: token.line, column: token.column + token.value.length },
		};
	}

	private identifier(): AST.Identifier {
		if (!isNameType(this.peek().type)) throw new ParseError('Expected identifier', this.peek());
		this.advance();
		return {
			type: 'Identifier',
			name: this.previous().value,
			location: this.getLocation(),
		};
	}
}
