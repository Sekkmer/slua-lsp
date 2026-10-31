import { recordTypeProgram } from './typeRegions.js';
import { ParseError, LuauParser } from '../luau/vendor.js';

import type { CoreDiagnostic } from '../diagnostics/types.js';
import { normalizeAstLocations } from './astLocations.js';
import { constBindingDiagnostics } from './constBindings.js';
import { valueExportDiagnostics } from './valueExports.js';
import { SourceTextIndex } from './sourceTextIndex.js';

export type ParseResult = {
	ast: unknown | null;
	diagnostics: CoreDiagnostic[];
};

function diagFromParseError(err: ParseError, index: SourceTextIndex): CoreDiagnostic {
	const token = err.token;
	const start = index.positionAt(token.start);
	const end = index.positionAt(Math.max(token.start + 1, token.end));

	return {
		code: 'parse-error',
		message: err.message,
		severity: 'error',
		range: {
			start,
			end
		}
	};
}

export function parseSlua(text: string): ParseResult {
	const index = new SourceTextIndex(text);
	try {
		const source = { input: text, index, hasFunctionAttributes: false };
		const parser = new LuauParser(text, source);
		const ast = parser.parse();
		const parseErrors = parser.getErrors();
		if (ast) { normalizeAstLocations(ast, index); recordTypeProgram(ast, source); }

		return { ast, diagnostics: [...parseErrors.map((error) => diagFromParseError(error, index)), ...invalidStatementDiagnostics(ast), ...(text.includes('const') || text.includes('class') || text.includes('export') ? constBindingDiagnostics(ast) : []), ...(text.includes('export') ? valueExportDiagnostics(ast) : [])] };
	} catch (err) {
		if (err instanceof ParseError) {
			return { ast: null, diagnostics: [diagFromParseError(err, index)] };
		}
		const message = err instanceof Error ? err.message : String(err);
		const offset = err instanceof Error && 'offset' in err && typeof err.offset === 'number' ? err.offset : 0;
		const start = index.positionAt(offset), end = index.positionAt(offset + 1);
		return {
			ast: null,
			diagnostics: [
				{
					code: 'parse-error',
					message,
					severity: 'error',
					range: {
						start,
						end
					}
				}
			]
		};
	}
}

// Keep recovery ASTs for editor requests while rejecting standalone values in checks.
// Luau permits only assignments and function calls as expression statements.
function invalidStatementDiagnostics(ast: unknown): CoreDiagnostic[] {
	const diagnostics: CoreDiagnostic[] = [];
	function visit(value: unknown, loopDepth = 0): void {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) { value.forEach((child) => visit(child, loopDepth)); return; }
		const node = value as Record<string, unknown>;
		if (typeof node.type !== 'string') return;
		if (node.type === 'ExpressionStatement') {
			const expression = node.expression as Record<string, unknown> | undefined;
			if (expression && (expression.type !== 'CallExpression' || expression.parenthesized)) {
				const loc = node.location as { start?: { line?: number; column?: number } } | undefined;
				const line = Math.max(0, (loc?.start?.line ?? 1) - 1);
				const character = Math.max(0, (loc?.start?.column ?? 1) - 1);
				diagnostics.push({ code: 'parse-error', severity: 'error', message: 'Incomplete statement: expected assignment or a function call',
					range: { start: { line, character }, end: { line, character: character + 1 } } });
			}
		}
		if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && loopDepth === 0) {
			const loc = node.location as { start?: { line?: number; column?: number } } | undefined;
			const line = Math.max(0, (loc?.start?.line ?? 1) - 1);
			const character = Math.max(0, (loc?.start?.column ?? 1) - 1);
			diagnostics.push({ code: 'parse-error', severity: 'error', message: `${node.type === 'BreakStatement' ? 'break' : 'continue'} statement must be inside a loop`,
				range: { start: { line, character }, end: { line, character: character + 1 } } });
		}
		const childDepth = node.type === 'Function' || node.type === 'FunctionDeclaration' ? 0
			: ['WhileStatement', 'ForStatement', 'GenericForStatement', 'RepeatStatement'].includes(String(node.type)) ? loopDepth + 1 : loopDepth;
		for (const key in node) if (key !== 'location' && key !== 'comments') visit(node[key], childDepth);
	}
	visit(ast);
	return diagnostics;
}
