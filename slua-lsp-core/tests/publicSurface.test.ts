import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { getCompletions } from '../src/typing/completion.js';
import { getBuiltinMemberHover } from '../src/typing/builtinHover.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { slua } from '../src/slua/types.js';

const defs = await loadLslDefinitionsFromYamlFile();
const registry = buildSluaRegistryFromLslDefinitions(defs);
const declarations = fs.readFileSync(path.resolve(import.meta.dirname, '../../third_party/lsl-definitions/generated/secondlife.d.luau'), 'utf8');
const contracts = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/slua-definition-contracts-e61af00.json'), 'utf8')) as { returns: Record<string, Record<string, string>> };
function cursor(marked: string) {
	const offset = marked.indexOf('$');
	const lines = marked.slice(0, offset).split('\n');
	const text = marked.replace('$', '');
	return { text, ast: parseSlua(text).ast, pos: { line: lines.length - 1, character: lines.at(-1)!.length } };
}
function complete(marked: string) {
	const { ast, text, pos } = cursor(marked);
	return getCompletions(ast, pos, registry, { sourceText: text, invoked: true }).map((item) => item.label);
}
function analyze(source: string) { return analyzeTextWithDirectives(source, { registry, eventSignatures: registry.eventSignatures }); }

describe('public YAML visibility and generated declaration parity', () => {
	it.each(['ll', 'llcompat'])('offers exactly the generated public %s functions', (name) => {
		const labels = complete(`${name}.$`);
		const actual = labels.filter((label) => registry.getModule(name)!.functions[label]);
		expect(actual.sort()).toEqual(Object.keys(contracts.returns[name]!).sort());
	});

	it('offers every public global constant from the independent official generated declarations', () => {
		const expected = [...declarations.matchAll(/^declare ([A-Z][A-Z_0-9]*):/gm)].map((match) => match[1]!).sort();
		expect(expected).toHaveLength(1064);
		expect([...registry.globalValues.values()].filter((value) => !value.private).map((value) => value.name).sort()).toEqual(expected);
		const labels = new Set(complete('$'));
		for (const name of expected) expect(labels.has(name), name).toBe(true);
	});

	it('retains explicit private lookup and hover without recommending private members or constants', () => {
		const labels = new Set(complete('ll.$'));
		for (const name of ['ClearExperience', 'RemoteLoadScript', 'GCNP_GET_WALKABILITY']) expect(labels.has(name)).toBe(false);
		expect(registry.getModule('ll')!.functions.ClearExperience?.private).toBe(true);
		expect(registry.getGlobalValue('GCNP_GET_WALKABILITY')?.private).toBe(true);
		for (const source of ['ll.ClearExpe$rience()', 'print(ll.GCNP_GET_WALK$ABILITY)']) {
			const { ast, pos } = cursor(source);
			expect(getBuiltinMemberHover(ast, pos, registry)?.markdown).toContain('Private upstream definition');
		}
	});

	it('removes state events, retains timer registration and accepts ordinary manually called functions', () => {
		expect(Object.keys(registry.eventSignatures)).toHaveLength(41);
		expect(registry.eventSignatures.state_entry).toBeUndefined();
		expect(registry.eventSignatures.state_exit).toBeUndefined();
		expect(registry.eventSignatures.timer).toBeDefined();
		expect(analyze('function timer() end\nLLEvents:on("timer", timer)\nfunction state_entry() end\nstate_entry()')).toEqual([]);
		for (const name of ['state_entry', 'state_exit']) expect(analyze(`LLEvents:on("${name}", function() end)`).map((diagnostic) => diagnostic.code)).toEqual(['unknown-event']);
		const labels = complete('LLEvents:on("$", function() end)');
		expect(labels).toContain('timer');
		expect(labels).not.toContain('state_entry');
		expect(labels).not.toContain('state_exit');
	});

	it('removes TRUE/FALSE from both modules and diagnoses alias/bracket reads with boolean replacements', () => {
		for (const name of ['ll', 'llcompat']) for (const value of ['TRUE', 'FALSE']) {
			expect(registry.getModule(name)!.values[value]).toBeUndefined();
			expect(registry.getGlobalValue(value)).toBeUndefined();
		}
		const source = 'local ordinary = ll\nlocal legacy = llcompat\nprint(ordinary.TRUE, legacy["FALSE"])';
		const diagnostics = analyze(source);
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['removed-ll-constant', 'removed-ll-constant']);
		expect(diagnostics[0]?.message).toContain('true');
		expect(diagnostics[1]?.message).toContain('false');
		expect(analyze('-- slua-lsp:disable removed-ll-constant\n' + source)).toEqual([]);
		expect(analyze('local ll = {TRUE = true}\nprint(ll.TRUE)')).toEqual([]);
	});

	it('infers global constants in local values and scalar argument/assignment checks', () => {
		const source = 'local side = ALL_SIDES\nlocal offset: number = ACTIVE\nll.SetAlpha(1, side)\nprint(offset)';
		expect(analyze(source)).toEqual([]);
		expect(inferLocalVariableTypes(parseSlua(source).ast, registry).find((value) => value.name === 'side')?.type).toEqual(slua.number());
		expect(analyze('local offset: string = ALL_SIDES\nll.Say(0, ALL_SIDES)\nprint(offset)').filter((diagnostic) => ['assignment-type-mismatch', 'call-argument-type-mismatch'].includes(diagnostic.code))).toHaveLength(2);
	});

	it('hovers bare global values and lets local bindings and member names win', () => {
		const value = cursor('print(ALL_SI$DES)');
		expect(getBuiltinMemberHover(value.ast, value.pos, registry)?.markdown).toContain('ALL_SIDES: number');
		for (const source of ['local ALL_SIDES = "local"\nprint(ALL_SI$DES)', 'local value = {}\nprint(value.ALL_SI$DES)', 'local value = {ALL_SI$DES = 1}']) {
			const { ast, pos } = cursor(source);
			expect(getBuiltinMemberHover(ast, pos, registry)).toBeNull();
		}
	});
});
