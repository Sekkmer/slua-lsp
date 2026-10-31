import { TokenType } from './types';

export interface OperatorConfig {
  single: TokenType;
  double?: TokenType;
  triple?: TokenType;
}

export const OPERATORS: Map<string, OperatorConfig> = new Map([
	['=', { single: TokenType.ASSIGN, double: TokenType.EQUAL }],
	['~', { single: TokenType.LENGTH, double: TokenType.NOT_EQUAL }],
	['<', { single: TokenType.LESS_THAN }],
	['>', { single: TokenType.GREATER_THAN }],
	['.', { single: TokenType.DOT, double: TokenType.CONCAT, triple: TokenType.DOTS }],
	[':', { single: TokenType.COLON, double: TokenType.DOUBLE_COLON }],
	['/', { single: TokenType.DIVIDE, double: TokenType.FLOOR_DIVIDE }],
]);

export const SINGLE_CHAR_TOKENS: Map<string, TokenType> = new Map([
	['@', TokenType.AT],
	['+', TokenType.PLUS],
	['-', TokenType.MINUS],
	['*', TokenType.MULTIPLY],
	['%', TokenType.MODULO],
	['^', TokenType.POWER],
	['#', TokenType.LENGTH],
	['(', TokenType.LEFT_PAREN],
	[')', TokenType.RIGHT_PAREN],
	['[', TokenType.LEFT_BRACKET],
	[']', TokenType.RIGHT_BRACKET],
	['{', TokenType.LEFT_BRACE],
	['}', TokenType.RIGHT_BRACE],
	[';', TokenType.SEMICOLON],
	[',', TokenType.COMMA],
	['?', TokenType.QUESTION],
	['|', TokenType.PIPE],
	['&', TokenType.AMPERSAND],
]);

export const KEYWORDS: Map<string, TokenType> = new Map([
	['and', TokenType.AND],
	['break', TokenType.BREAK],
	['continue', TokenType.CONTINUE],
	['do', TokenType.DO],
	['else', TokenType.ELSE],
	['elseif', TokenType.ELSEIF],
	['end', TokenType.END],
	['false', TokenType.FALSE],
	['for', TokenType.FOR],
	['function', TokenType.FUNCTION],
	['if', TokenType.IF],
	['in', TokenType.IN],
	['local', TokenType.LOCAL],
	['nil', TokenType.NIL],
	['not', TokenType.NOT],
	['or', TokenType.OR],
	['repeat', TokenType.REPEAT],
	['return', TokenType.RETURN],
	['then', TokenType.THEN],
	['true', TokenType.TRUE],
	['until', TokenType.UNTIL],
	['while', TokenType.WHILE],
	// Luau keywords
	// NOTE: We intentionally do NOT treat `type`/`typeof` as keywords.
	// In SLua/Lua code, these are commonly used as runtime functions.
	['export', TokenType.EXPORT],
]);
