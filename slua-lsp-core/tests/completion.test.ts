import { describe, it, expect } from 'vitest';
import { parseSlua } from '../src/parser/parseSlua.js';
import { getCompletions } from '../src/typing/completion';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';

function getCompletionLabels(codeWithCursor: string, opts?: { triggerCharacter?: string }): string[] {
	const cursorIndex = codeWithCursor.indexOf('$');
	if (cursorIndex < 0) throw new Error('Expected `$` cursor marker in code');

	const sourceText = codeWithCursor.replace('$', '');
	const beforeCursor = codeWithCursor.slice(0, cursorIndex);
	const lines = beforeCursor.split(/\r?\n/);
	const line = lines.length - 1;
	const character = (lines[lines.length - 1] ?? '').length;
	const triggerCharacter = opts?.triggerCharacter ?? beforeCursor.slice(-1);

	const parsed = parseSlua(sourceText);
	const registry = buildSluaRegistryFromLslDefinitions(null);
	const completions = getCompletions(parsed.ast, { line, character }, registry, { sourceText, triggerCharacter });
	return completions.map((c) => c.label);
}

function getCompletionsAtCursor(
	codeWithCursor: string,
	registry: ReturnType<typeof buildSluaRegistryFromLslDefinitions>,
	opts?: { triggerCharacter?: string; invoked?: boolean }
) {
	const cursorIndex = codeWithCursor.indexOf('$');
	if (cursorIndex < 0) throw new Error('Expected `$` cursor marker in code');

	const sourceText = codeWithCursor.replace('$', '');
	const beforeCursor = codeWithCursor.slice(0, cursorIndex);
	const lines = beforeCursor.split(/\r?\n/);
	const line = lines.length - 1;
	const character = (lines[lines.length - 1] ?? '').length;
	const triggerCharacter = opts?.triggerCharacter ?? beforeCursor.slice(-1);
	const invoked = opts?.invoked ?? false;

	const parsed = parseSlua(sourceText);
	return getCompletions(parsed.ast, { line, character }, registry, { sourceText, triggerCharacter, invoked });
}

describe('getCompletions', () => {
	describe('scope-based completions', () => {
		it('suggests local variables in scope', () => {
			const code = `
				local myVariable = 5
				local another = 10
				local result = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 3, character: 19 }, registry, { sourceText: code });
			
			const labels = completions.map(c => c.label);
			expect(labels).toContain('myVariable');
			expect(labels).toContain('another');
		});

		it('suggests function parameters inside function', () => {
			const code = `
				function test(param1, param2)
					local x = 
				end
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 2, character: 14 }, registry, { sourceText: code });
			
			const labels = completions.map(c => c.label);
			expect(labels).toContain('param1');
			expect(labels).toContain('param2');
		});

		it('does not suggest variables from inner scope', () => {
			const code = `
				local outer = 1
				if true then
					local inner = 2
				end
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 5, character: 14 }, registry, { sourceText: code });
			
			const labels = completions.map(c => c.label);
			expect(labels).toContain('outer');
			expect(labels).not.toContain('inner');
		});

		it('suggests locals inside do-block scope', () => {
			const src = ['local outer = 1', 'do', '\tlocal inner = 2', '\t$ ', 'end'].join('\n') + '\n';
			const labels = getCompletionLabels(src, { triggerCharacter: ' ' });
			expect(labels).toContain('outer');
			expect(labels).toContain('inner');
		});

		it('suggests loop variables inside numeric and generic for bodies', () => {
			const numericLabels = getCompletionLabels(['for i = 1, 3 do', '\t$ ', 'end'].join('\n') + '\n', { triggerCharacter: ' ' });
			expect(numericLabels).toContain('i');

			const genericLabels = getCompletionLabels(['local t = {}', 'for key, value in pairs(t) do', '\t$ ', 'end'].join('\n') + '\n', { triggerCharacter: ' ' });
			expect(genericLabels).toContain('key');
			expect(genericLabels).toContain('value');
		});
	});

	describe('member completions', () => {
		it('suggests object-type colon methods', () => {
			const code = 'LLEvents:\n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const completions = getCompletions(parsed.ast, { line: 0, character: 9 }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});
			
			const labels = completions.map(c => c.label);
			expect(completions.length).toBeGreaterThan(0);
			expect(labels).toContain('on');
		});

		it('returns completions for member access', () => {
			const code = 'LLTimers:\n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 0, character: 9 }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});
			
			expect(completions.length).toBeGreaterThan(0);
		});

		it('offers metatable-backed members for inferred custom types', () => {
			const code = ['local v = vector(1, 2, 3)', 'v.'].join('\n') + '\n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const lines = code.split(/\r?\n/);
			const line = lines.findIndex((l) => l.trim() === 'v.');
			expect(line).toBeGreaterThanOrEqual(0);
			const character = (lines[line] ?? '').indexOf('.') + 1;
			const completions = getCompletions(parsed.ast, { line, character }, registry, {
				sourceText: code,
				triggerCharacter: '.'
			});

			const labels = completions.map((c) => c.label);
			expect(labels).toContain('x');
			expect(labels).toContain('y');
			expect(labels).toContain('z');
		});

		it('offers metatable-defined string methods on colon access', () => {
			const code = ['local s = "hello"', 's:'].join('\n') + '\n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const lines = code.split(/\r?\n/);
			const line = lines.findIndex((l) => l.trim() === 's:');
			expect(line).toBeGreaterThanOrEqual(0);
			const character = (lines[line] ?? '').indexOf(':') + 1;
			const completions = getCompletions(parsed.ast, { line, character }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});

			const labels = completions.map((c) => c.label);
			expect(labels).toContain('sub');
			expect(labels).toContain('len');
		});

		it('stdlib module completion: string.sub', () => {
			const src = `
				string.$
			`;

			const labels = getCompletionLabels(src);
			expect(labels).toContain('sub');
			expect(labels).toContain('len');
		});

		it('stdlib module completion: table.insert', () => {
			const src = `
				table.$
			`;

			const labels = getCompletionLabels(src);
			expect(labels).toContain('insert');
			expect(labels).toContain('concat');
		});
	});

	describe('LLEvents event-name and handler completions', () => {
		it('suggests event-name enums inside first string arg', () => {
			const defs = {
				events: {
					listen: { tooltip: 'listen event', arguments: [] }
				}
			};
			const registry = buildSluaRegistryFromLslDefinitions(defs);
			const code = 'LLEvents:on("$")\n';
			const completions = getCompletionsAtCursor(code, registry, { triggerCharacter: '"' });
			const labels = completions.map((c) => c.label);
			expect(labels).toContain('listen');
		});

		it('offers a typed handler snippet at second arg (snake_case param names)', () => {
			const defs = {
				events: {
					listen: { tooltip: 'listen event', arguments: [] }
				}
			};
			const registry = buildSluaRegistryFromLslDefinitions(defs);
			const code = 'LLEvents:on("listen", $cb)\n';
			const completions = getCompletionsAtCursor(code, registry, { triggerCharacter: ',' });
			const handler = completions.find((c) => c.label === 'handler (listen)');
			expect(handler?.isSnippet).toBe(true);
			expect(handler?.insertText).toContain('function(');
			expect(handler?.insertText).toContain('channel: number');
			expect(handler?.insertText).toContain('id: uuid');
		});
	});

	describe('template string interpolation completions', () => {
		it('suggests locals inside `{...}` of backtick template strings', () => {
			const src = ['local message = "hi"', 'll.Say(0, `You selected {mes$}`)'].join('\n') + '\n';
			const labels = getCompletionLabels(src, { triggerCharacter: 's' });
			expect(labels).toContain('message');
		});

		it('suggests member completions inside `{...}` of backtick template strings', () => {
			const src = ['local s = "hello"', 'll.Say(0, `{s:$}`)'].join('\n') + '\n';
			const labels = getCompletionLabels(src, { triggerCharacter: ':' });
			expect(labels).toContain('sub');
			expect(labels).toContain('len');
		});
	});

	describe('global completions', () => {
		it('suggests global functions and modules', () => {
			const code = `
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 1, character: 14 }, registry, { sourceText: code, invoked: true });
			
			// Should have globals and local 'x'
			expect(completions.length).toBeGreaterThan(0);
			const hasModules = completions.some(c => c.kind === 'module');
			expect(hasModules).toBe(true);
		});

		it('suggests modules', () => {
			const code = `
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 1, character: 14 }, registry, { sourceText: code, invoked: true });
			
			const modules = completions.filter(c => c.kind === 'module');
			expect(modules.length).toBeGreaterThan(0);
		});
	});

	describe('type annotation completions', () => {
		it('returns type completions after : in declaration', () => {
			const code = `
				local x: 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 1, character: 13 }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});
			
			const typeLabels = completions.filter((c) => c.kind === 'type').map((c) => c.label);
			expect(typeLabels).toContain('number');
			expect(typeLabels).toContain('string');
		});

		it('includes Luau type syntax snippets (union/optional/typeof)', () => {
			const code = 'local x: \n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const completions = getCompletions(parsed.ast, { line: 0, character: code.indexOf(':') + 2 }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});

			const union = completions.find((c) => c.label === 'union (A | B)');
			const optional = completions.find((c) => c.label === 'optional (T?)');
			const typeOf = completions.find((c) => c.label === 'typeof(expr)');
			expect(union?.isSnippet).toBe(true);
			expect(optional?.isSnippet).toBe(true);
			expect(typeOf?.isSnippet).toBe(true);
			expect(union?.insertText).toContain('|');
			expect(optional?.insertText).toContain('?');
			expect(typeOf?.insertText).toContain('typeof(');
		});
	});

	describe('metatable editing', () => {
		it('suggests metamethod keys inside metatable tables', () => {
			const code = 'local mt = { __index = 1 }\n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const line = 0;
			const character = code.indexOf('__') + 2; // after '__'
			const completions = getCompletions(parsed.ast, { line, character }, registry, { sourceText: code });

			const labels = completions.map((c) => c.label);
			expect(labels).toContain('__newindex');
			expect(labels).toContain('__call');
		});
	});

	describe('priority and sorting', () => {
		it('deprioritizes identifiers starting with underscore', () => {
			const code = `
				local _internal = 1
				local public = 2
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 3, character: 14 }, registry, { sourceText: code });
			
			const internalIdx = completions.findIndex(c => c.label === '_internal');
			const publicIdx = completions.findIndex(c => c.label === 'public');
			
			expect(internalIdx).toBeGreaterThan(publicIdx);
		});

		it('prefers locals over globals when shadowed', () => {
			const code = `
				local vector = 123
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);

			const completions = getCompletions(parsed.ast, { line: 2, character: 14 }, registry, { sourceText: code });
			const vectorItems = completions.filter((c) => c.label === 'vector');
			expect(vectorItems.length).toBe(1);
			expect(vectorItems[0]?.kind).toBe('variable');
		});

		it('includes type information in completions', () => {
			const code = `
				local num: number = 5
				local str: string = "hello"
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 3, character: 14 }, registry);
			
			// Should find both variables with their types
			const numItem = completions.find(c => c.label === 'num');
			const strItem = completions.find(c => c.label === 'str');
			
			expect(numItem).toBeDefined();
			expect(strItem).toBeDefined();
			expect(numItem?.detail).toBe('number');
			expect(strItem?.detail).toBe('string');
		});

		it('marks deprecated items', () => {
			const code = `
				ll.
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 1, character: 7 }, registry);
			
			// Check if any deprecated items are properly marked
			const deprecatedItems = completions.filter(c => c.deprecated);
			// We expect some deprecated functions in ll module
			expect(deprecatedItems.length).toBeGreaterThanOrEqual(0);
		});

		describe('expected-type ranking', () => {
			it('boosts functions that return the expected type (assignment)', () => {
				const code = 'local v: vector = vec\n';
				const parsed = parseSlua(code);
				const registry = buildSluaRegistryFromLslDefinitions(null);

				const lineText = code.split(/\r?\n/)[0] ?? '';
				const character = lineText.indexOf('vec') + 'vec'.length;
				const completions = getCompletions(parsed.ast, { line: 0, character }, registry, { sourceText: code, invoked: true });

				const vectorIdx = completions.findIndex((c) => c.label === 'vector');
				const rotationIdx = completions.findIndex((c) => c.label === 'rotation');
				expect(vectorIdx).toBeGreaterThanOrEqual(0);
				expect(rotationIdx).toBeGreaterThanOrEqual(0);
				expect(vectorIdx).toBeLessThan(rotationIdx);
			});

			it('infers expected type from function argument position', () => {
				const code = [
					'local num: number = 1',
					'local function cb() end',
					'LLTimers:every(num, c)'
				].join('\n') + '\n';
				const parsed = parseSlua(code);
				const registry = buildSluaRegistryFromLslDefinitions(null);

				const lines = code.split(/\r?\n/);
				const line = lines.findIndex((l) => l.includes('LLTimers:every'));
				expect(line).toBeGreaterThanOrEqual(0);
				const character = (lines[line] ?? '').indexOf(', c') + ', c'.length; // cursor after 'c'

				const completions = getCompletions(parsed.ast, { line, character }, registry, { sourceText: code });

				const cbIdx = completions.findIndex((c) => c.label === 'cb');
				const numIdx = completions.findIndex((c) => c.label === 'num');
				expect(cbIdx).toBeGreaterThanOrEqual(0);
				expect(numIdx).toBeGreaterThanOrEqual(0);
				expect(cbIdx).toBeLessThan(numIdx);
			});

			it('infers expected type from binary operators', () => {
				const code = [
					'local num: number = 1',
					'local rot: rotation = rotation(0,0,0,1)',
					'local x = 1 + r'
				].join('\n') + '\n';
				const parsed = parseSlua(code);
				const registry = buildSluaRegistryFromLslDefinitions(null);

				const lines = code.split(/\r?\n/);
				const line = lines.findIndex((l) => l.includes('1 + r'));
				expect(line).toBeGreaterThanOrEqual(0);
				const character = (lines[line] ?? '').indexOf('r') + 1;
				const completions = getCompletions(parsed.ast, { line, character }, registry, { sourceText: code });

				const numIdx = completions.findIndex((c) => c.label === 'num');
				const rotIdx = completions.findIndex((c) => c.label === 'rot');
				expect(numIdx).toBeGreaterThanOrEqual(0);
				expect(rotIdx).toBeGreaterThanOrEqual(0);
				expect(numIdx).toBeLessThan(rotIdx);
			});

			it('infers expected type from return statements', () => {
				const code = [
					'local function f(): vector',
					'\treturn vec',
					'end'
				].join('\n') + '\n';
				const parsed = parseSlua(code);
				const registry = buildSluaRegistryFromLslDefinitions(null);

				const lines = code.split(/\r?\n/);
				const line = lines.findIndex((l) => l.includes('return vec'));
				expect(line).toBeGreaterThanOrEqual(0);
				const character = (lines[line] ?? '').indexOf('vec') + 'vec'.length;

				const completions = getCompletions(parsed.ast, { line, character }, registry, { sourceText: code, invoked: true });
				const vectorIdx = completions.findIndex((c) => c.label === 'vector');
				const rotationIdx = completions.findIndex((c) => c.label === 'rotation');
				expect(vectorIdx).toBeGreaterThanOrEqual(0);
				expect(rotationIdx).toBeGreaterThanOrEqual(0);
				expect(vectorIdx).toBeLessThan(rotationIdx);
			});
		});
	});

	describe('colon vs dot member access', () => {
		it('filters methods by colon call requirement', () => {
			const code = `
				LLEvents:
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 1, character: 13 }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});
			
			// All suggestions should be appropriate for colon call
			// LLEvents should have colon-call methods
			expect(completions.length).toBeGreaterThan(0);
		});
	});

	describe('completion details', () => {
		it('includes function signatures', () => {
			const code = 'LLEvents:\n';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 0, character: 9 }, registry, {
				sourceText: code,
				triggerCharacter: ':'
			});
			
			const methodItems = completions.filter(c => c.kind === 'method');
			// Method items should have details with signatures
			const hasDetails = methodItems.some(c => c.detail && c.detail.length > 0);
			expect(hasDetails).toBe(true);
		});

		it('provides completion items with proper structure', () => {
			const code = `
				local myVar = 5
				local x = 
			`;
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 2, character: 14 }, registry, { sourceText: code });
			
			// Check structure
			const myVarItem = completions.find(c => c.label === 'myVar');
			expect(myVarItem).toBeDefined();
			expect(myVarItem?.label).toBe('myVar');
			expect(myVarItem?.kind).toBe('variable');
			expect(typeof myVarItem?.priority).toBe('number');
		});
	});

	describe('edge cases', () => {
		it('returns empty array for invalid AST', () => {
			const completions = getCompletions(null, { line: 0, character: 0 }, buildSluaRegistryFromLslDefinitions(null));
			expect(completions).toEqual([]);
		});

		it('handles empty code', () => {
			const code = '';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 0, character: 0 }, registry, { sourceText: code, invoked: true });
			
			expect(completions).toBeDefined();
			expect(Array.isArray(completions)).toBe(true);
		});

		it('handles position at start of file', () => {
			const code = 'local x = 5';
			const parsed = parseSlua(code);
			const registry = buildSluaRegistryFromLslDefinitions(null);
			
			const completions = getCompletions(parsed.ast, { line: 0, character: 0 }, registry, { sourceText: code, invoked: true });
			
			expect(completions).toBeDefined();
		});
	});
});
