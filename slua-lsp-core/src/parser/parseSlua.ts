import { ParseError, LuauParser } from '../luau/vendor.js';

import type { CoreDiagnostic } from '../diagnostics/types.js';
import { normalizeAstLocations } from './astLocations.js';

export type ParseResult = {
	ast: unknown | null;
	diagnostics: CoreDiagnostic[];
};

function diagFromParseError(err: ParseError): CoreDiagnostic {
	const token = err.token;
	const line = Math.max(0, token.line - 1);
	const character = Math.max(0, token.column - 1);
	const endCharacter = Math.max(character + 1, character + Math.max(1, token.value.length));

	return {
		code: 'parse-error',
		message: err.message,
		severity: 'error',
		range: {
			start: { line, character },
			end: { line, character: endCharacter }
		}
	};
}

export function parseSlua(text: string): ParseResult {
	try {
		const parser = new LuauParser(text);
		const ast = parser.parse();
		const parseErrors = parser.getErrors();
		if (ast) normalizeAstLocations(ast);

		return { ast, diagnostics: parseErrors.map(diagFromParseError) };
	} catch (err) {
		if (err instanceof ParseError) {
			return { ast: null, diagnostics: [diagFromParseError(err)] };
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			ast: null,
			diagnostics: [
				{
					code: 'parse-error',
					message,
					severity: 'error',
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 }
					}
				}
			]
		};
	}
}
