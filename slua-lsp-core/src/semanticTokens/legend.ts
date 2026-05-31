// Semantic token legend for SLua/Luau.
//
// This is shared between core/server/client so everyone agrees on token type
// strings and modifier ordering.

export const SLUA_SEMANTIC_TOKEN_TYPES = [
	'comment',
	'string',
	'number',
	'keyword',
	'function',
	'method',
	'property',
	'variable',
	'type',
	'class',
	'namespace',
	'enumMember'
] as const;

export type SluaSemanticTokenType = (typeof SLUA_SEMANTIC_TOKEN_TYPES)[number];

export const SLUA_SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'deprecated'] as const;

export type SluaSemanticTokenModifier = (typeof SLUA_SEMANTIC_TOKEN_MODIFIERS)[number];
