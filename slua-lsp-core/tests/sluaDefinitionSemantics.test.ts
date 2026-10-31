import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { slua, sluaTypeFromLuauAnnotationText, sluaTypeToString } from '../src/slua/types.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { getBuiltinMemberHover } from '../src/typing/builtinHover.js';
import { getCompletions } from '../src/typing/completion.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { getSignatureHelp } from '../src/typing/signatureHelp.js';

const defs = await loadLslDefinitionsFromYamlFile();
const registry = buildSluaRegistryFromLslDefinitions(defs);
const oracle = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/slua-definition-contracts-e61af00.json'), 'utf8')) as {
	returns: Record<string, Record<string, string>>;
};
function expectedReturn(text: string) {
	// General LSL lists are represented by the core's unconstrained table type;
	// explicit typed/generic array declarations keep their separate array kind.
	return text === '()' ? slua.nil() : text === '{any}' ? slua.table() : sluaTypeFromLuauAnnotationText(text);
}
function analyze(source: string) { return analyzeTextWithDirectives(source, { registry, eventSignatures: registry.eventSignatures }); }
function at(source: string) {
	const offset = source.indexOf('$');
	const prefix = source.slice(0, offset).split('\n');
	const text = source.replace('$', '');
	return { text, ast: parseSlua(text).ast, pos: { line: prefix.length - 1, character: prefix.at(-1)!.length } };
}

describe('official ordinary SLua and compatibility declaration contracts', () => {
	it.each(['ll', 'llcompat'])('matches independently generated %s return declarations', (name) => {
		const mismatches: string[] = [];
		for (const [method, text] of Object.entries(oracle.returns[name]!)) {
			const actual = registry.getModule(name)!.functions[method]?.signature;
			if (actual?.kind !== 'function' || sluaTypeToString(actual.returns) !== sluaTypeToString(expectedReturn(text))) mismatches.push(`${method}: expected ${text}; got ${actual?.kind === 'function' ? sluaTypeToString(actual.returns) : 'missing'}`);
		}
		expect(mismatches).toEqual([]);
	});

	it('distinguishes ordinary boolean and nullable index returns from compatibility numbers', () => {
		expect(analyze('local active: boolean = ll.GetStatus(1)\nlocal legacy: number = llcompat.GetStatus(1)\nlocal index: number? = ll.SubStringIndex("abc", "x")\nlocal oldIndex: number = llcompat.SubStringIndex("abc", "x")\nprint(active, legacy, index, oldIndex)')).toEqual([]);
		expect(analyze('local active: number = ll.GetStatus(1)\nlocal index: number = ll.SubStringIndex("abc", "x")\nprint(active, index)').filter((d) => d.code === 'assignment-type-mismatch')).toHaveLength(2);
	});

	it('accepts documented boolean/numeric flags and asset UUIDs, preserving normal numeric parameters', () => {
		expect(analyze('ll.SetStatus(1, true)\nll.SetStatus(1, 1)\nllcompat.SetStatus(1, false)\nll.SetTexture(uuid.null, 0)')).toEqual([]);
		expect(analyze('ll.SetStatus(1, "bad")\nll.Say(true, "bad")').filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(2);
	});

	it('honors typed array overrides and treats a typed array as a plain Lua table', () => {
		expect(analyze('local texts: {string} = ll.CSV2List("a,b")\nlocal values: {number} = {1, 2}\nprint(table.concat(values), texts)\nll.Dialog(uuid.null, "Choose", {"A", "B"}, 0)')).toEqual([]);
		expect(analyze('ll.Dialog(uuid.null, "Choose", {42}, 0)').filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
	});

	it('uses event-specific SLua types rather than legacy LSL types', () => {
		expect(registry.eventSignatures.transaction_result!.params[1]?.type).toEqual(slua.boolean());
		expect(registry.eventSignatures.link_message!.params[3]?.type).toEqual(slua.string());
		expect(registry.eventSignatures.game_control!.params.at(-1)?.type).toEqual(slua.array(slua.number()));
	});
});

describe('DetectedEvent language-service contracts', () => {
	it('matches all nineteen official generated method return declarations', () => {
		const methods = registry.getObjectType('DetectedEvent')!.methods;
		expect(Object.keys(methods).sort()).toEqual(Object.keys(oracle.returns.DetectedEvent!).sort());
		for (const [name, text] of Object.entries(oracle.returns.DetectedEvent!)) {
			const signature = methods[name]!.signature;
			expect(signature.kind === 'function' ? signature.returns : null, name).toEqual(expectedReturn(text));
		}
	});

	it('checks annotated and indexed detected getters, method aliases and explicit self', () => {
		const source = 'local function inspect(events: {DetectedEvent})\n local item = events[1]\n local same: boolean = item:getGroup()\n local damage: table = item:getDamage()\n local key: uuid = item.getKey(item)\n local getter = item.getGroup\n local again: boolean = getter(item)\n print(same, damage, key, again)\n item:adjustDamage("bad")\n local wrong: uuid = item:getGroup()\n print(wrong)\nend\nprint(inspect)';
		const diagnostics = analyze(source);
		expect(diagnostics.filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(1);
		expect(diagnostics.filter((d) => d.code === 'assignment-type-mismatch')).toHaveLength(1);
		expect(diagnostics).toHaveLength(2);
	});

	it('infers callback local inlays and protects actual detected read-only properties', () => {
		const source = 'LLEvents:on("touch_start", function(items)\n local item = items[1]\n local same = item:getGroup()\n local damage = item:getDamage()\n item.valid = false\nend)';
		const types = new Map(inferLocalVariableTypes(parseSlua(source).ast, registry).map((v) => [v.name, sluaTypeToString(v.type)]));
		expect(types.get('item')).toBe('DetectedEvent');
		expect(types.get('same')).toBe('boolean');
		expect(types.get('damage')).toBe('table');
		expect(analyze(source).filter((d) => d.code === 'readonly-write')).toHaveLength(1);
		expect(analyze('print(DetectedEvent)').map((d) => d.code)).toContain('undeclared-name');
	});

	it('exposes detected getter hover and signature help inside an actual event callback', () => {
		const source = at('LLEvents:on("touch_start", function(events)\n local item = events[1]\n print(item:getGro$up())\nend)');
		expect(getBuiltinMemberHover(source.ast, source.pos, registry)?.markdown).toContain('): boolean');
		const signature = at('LLEvents:on("touch_start", function(events)\n local item = events[1]\n item:adjustDamage($2)\nend)');
		expect(getSignatureHelp(signature.ast, signature.pos, registry, signature.text)?.signatures[0]?.label).toContain('number');
	});

	it('completes methods and read-only properties in callbacks, declarations and direct array loops', () => {
		for (const template of [
			'LLEvents:on("touch_start", function(events)\n local item = events[1]\n item:$\nend)',
			'function LLEvents.touch_start(events)\n local item = events[1]\n item:$\nend',
			'local events = LLEvents\nevents.on(LLEvents, "touch_start", function(items)\n for _, item in items do\n item:$\n end\nend)'
		]) {
			const source = at(template);
			const items = getCompletions(source.ast, source.pos, registry, { sourceText: source.text, triggerCharacter: ':' });
			expect(items.find((x) => x.label === 'getGroup')?.detail, template).toContain('boolean');
			expect(items.find((x) => x.label === 'getDamage')?.detail, template).toContain('table');
		}
	});

	it('uses native event context for local diagnostic inference and respects receiver shadows', () => {
		const valid = 'LLEvents:on("touch_start", function(events)\n local item = events[1]\n local same: boolean = item:getGroup()\n print(same, item.valid)\nend)';
		expect(analyze(valid)).toEqual([]);
		const invalid = valid.replace('same: boolean', 'same: uuid');
		expect(analyze(invalid).filter((d) => d.code === 'assignment-type-mismatch')).toHaveLength(1);
		const shadow = 'local LLEvents = {}\nLLEvents:on("touch_start", function(events)\n local item = events[1]\n local value: uuid = item:getGroup()\n print(value)\nend)';
		expect(analyze(shadow).filter((d) => d.code === 'assignment-type-mismatch')).toEqual([]);
	});
});
