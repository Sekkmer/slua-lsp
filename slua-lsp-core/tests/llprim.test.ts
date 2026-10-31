import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { defaultMetatableRegistry } from '../src/slua/metatables.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { inferLocalVariableTypes } from '../src/typing/inferLocals.js';
import { getCompletions } from '../src/typing/completion.js';
import { getBuiltinMemberHover } from '../src/typing/builtinHover.js';
import { getSignatureHelp } from '../src/typing/signatureHelp.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
function at(source: string) {
	const offset = source.indexOf('$');
	const text = source.replace('$', '');
	const prefix = source.slice(0, offset).split('\n');
	return { text, ast: parseSlua(text).ast, position: { line: prefix.length - 1, character: prefix.at(-1)!.length } };
}

describe('native local llprim builders', () => {
	it('covers every native builder entry in the namespace and instance metatable', () => {
		const surface = JSON.parse(fs.readFileSync(new URL('./fixtures/native/llprim-surface.json', import.meta.url), 'utf8')) as { rules: { name: string }[]; extraMethods: string[] };
		const expected = [...surface.rules.map((row) => row.name), ...surface.extraMethods].sort();
		expect(Object.keys(registry.getModule('llprim.ParamSetter')!.functions).sort()).toEqual(expected);
		expect(Object.keys(defaultMetatableRegistry.getMembers('llprim.ParamSetter')!).sort()).toEqual(expected);
	});
	it('checks aliased instance arity, explicit self and directives without executing apply', () => {
		const missing = 'local rules = llprim.ParamSetter.new()\nrules:size()\nrules:extend()\nrules:apply()';
		expect(analyzeTextWithDirectives(missing, { registry }).filter((d) => d.code === 'call-argument-count-mismatch')).toHaveLength(2);
		const valid = 'local rules = llprim.ParamSetter.new()\nllprim.ParamSetter.size(rules, vector.one)\nlocal size = rules.size\nsize(rules, vector.one)\n-- slua-lsp:disable-next-line call-argument-type-mismatch\nrules:size(42)';
		expect(analyzeTextWithDirectives(valid, { registry })).toEqual([]);
	});
	it('respects receiver shadowing and does not leak qualified namespaces into global completion', () => {
		const { text, ast, position } = at('local llprim = {}\nllprim.ParamSetter.$');
		expect(getCompletions(ast, position, registry, { sourceText: text, invoked: true }).some((x) => x.label === 'new')).toBe(false);
		const global = at('$');
		expect(getCompletions(global.ast, global.position, registry, { sourceText: global.text, invoked: true }).some((x) => x.label === 'llprim.ParamSetter')).toBe(false);
		expect(analyzeTextWithDirectives('local llprim = {}\nllprim.ParamSetter.size(1)', { registry })).toEqual([]);
	});
	it('retains callable-module aliases and rejects non-callable builder namespace aliases', () => {
		const text = 'local Constructor = vector\nlocal point = Constructor(1,2,3)\nlocal ParamSetter = llprim.ParamSetter\nParamSetter()\nprint(point)';
		expect(analyzeTextWithDirectives(text, { registry }).map((d) => d.code)).toEqual(['call-non-callable']);
	});
	it('recognizes nested constructors, module aliases, instances, chaining and setmetatable construction', () => {
	 const text = 'local ParamSetter = llprim.ParamSetter\nlocal rules = ParamSetter.new():size(vector.one):physical(true):extend({7, vector.one})\nlocal other = setmetatable({}, ParamSetter):name("local")\nprint(rules, other)';
	 expect(analyzeTextWithDirectives(text, { registry })).toEqual([]);
	 const inferred = inferLocalVariableTypes(parseSlua(text).ast, registry);
	 expect(inferred.find((x) => x.name === 'rules')?.type).toMatchObject({ kind: 'table', metatable: 'llprim.ParamSetter' });
	 expect(inferred.find((x) => x.name === 'other')?.type).toMatchObject({ kind: 'table', metatable: 'llprim.ParamSetter' });
	});
	it('checks rule arguments and exact empty-string sentinels', () => {
	 const text = 'local rules = llprim.ParamSetter.new()\nrules:size("bad")\nrules:name(42)\nrules:gltfNormal(0, "asset", "bad", vector.one, 0)';
	 expect(analyzeTextWithDirectives(text, { registry }).filter((d) => d.code === 'call-argument-type-mismatch')).toHaveLength(3);
	 expect(analyzeTextWithDirectives('local rules = llprim.ParamSetter.new()\nrules:gltfNormal(0, "asset", "", vector.one, 0)', { registry })).toEqual([]);
	});
	it('completes the nested namespace and aliased builder instances', () => {
	 for (const source of ['llprim.ParamSetter.$', 'local ParamSetter = llprim.ParamSetter\nParamSetter.$', 'local rules = llprim.ParamSetter.new()\nrules:$', 'llprim.ParamSetter.new():$', 'llprim.ParamSetter.new():size(vector.one):$']) {
	  const { text, ast, position } = at(source);
	  const names = getCompletions(ast, position, registry, { sourceText: text, invoked: true }).map((x) => x.label);
	  expect(names, source).toContain(source.endsWith(':$') ? 'size' : 'new');
	 }
	});
	it('shows nested and local-instance hover and signature help', () => {
	 for (const source of ['llprim.ParamSetter.ne$w()', 'local rules = llprim.ParamSetter.new()\nrules:si$ze(vector.one)']) {
	  const { ast, position } = at(source);
	  expect(getBuiltinMemberHover(ast, position, registry)).not.toBeNull();
	 }
	 const { text, ast, position } = at('local rules = llprim.ParamSetter.new()\nrules:size($vector.one)');
	 expect(getSignatureHelp(ast, position, registry, text)?.signatures[0]?.label).toContain('vector');
	});
});
