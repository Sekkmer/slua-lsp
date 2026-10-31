import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { ruleRemovedLlApis } from '../src/diagnostics/rules/removedLlApis.js';
import { ruleLegacyTimerApis } from '../src/diagnostics/rules/legacyTimerApis.js';

const registry = buildSluaRegistryFromLslDefinitions(await loadLslDefinitionsFromYamlFile());
const codes = new Set(['removed-ll-api', 'legacy-timer-api', 'unknown-member']);
function availability(source: string) {
	return analyzeTextWithDirectives(source, { registry }).filter((diagnostic) => codes.has(diagnostic.code));
}

describe('ordinary and compatibility module availability after lexical resolution', () => {
	it('retains all four upstream compatibility declarations and their full return contracts', () => {
		for (const name of ['SetTimerEvent', 'SetMemoryLimit', 'ResetTime', 'GetAndResetTime']) {
			expect(registry.getModule('ll')!.functions[name], name).toBeUndefined();
			expect(registry.getModule('llcompat')!.functions[name], name).toBeDefined();
		}
		expect(availability('llcompat.SetTimerEvent(1)\nllcompat.ResetTime()\nprint(llcompat.GetAndResetTime(), llcompat.SetMemoryLimit(65536))')).toEqual([]);
	});

	it.each([
		'local ll = {ResetTime = function() end}\nll.ResetTime()',
		'local function use(ll) ll.SetTimerEvent(1) end\nprint(use)',
		'do local ll = {}\nll["SetMemoryLimit"](1) end',
		'for ll in {} do ll.ResetTime() end',
		'local timer = function() end\ntimer()',
		'local function timer() end\ntimer()'
	])('does not mistake a user binding for a removed native API: %s', (source) => {
		expect(availability(source)).toEqual([]);
	});

	it('keeps actual unknown native member diagnostics while accepting shadows', () => {
		expect(availability('ll.DoesNotExist()').map((diagnostic) => diagnostic.code)).toEqual(['unknown-member']);
		expect(availability('local ll = {}\nll.DoesNotExist()')).toEqual([]);
	});

	it('follows module aliases while keeping shadowing, declaration order and block restoration', () => {
		const source = 'local native = ll\ndo local ll = {}\nll.ResetTime()\nnative.ResetTime() end\nll.SetTimerEvent(1)\nlocal ll = {}\nll.SetTimerEvent(1)';
		const diagnostics = availability(source);
		expect(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.range.start.line])).toEqual([
			['removed-ll-api', 3], ['legacy-timer-api', 4]
		]);
	});

	it('checks bracket references and alias chains once at the original member read', () => {
		const diagnostics = availability('local native = ll\nlocal alias = native\nlocal f = alias["ResetTime"]\nlocal timer = alias["SetTimerEvent"]\nprint(f, timer)');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['removed-ll-api', 'legacy-timer-api']);
	});

	it('respects alias reassignment and parameters without losing the native outer alias', () => {
		const source = 'local api = ll\nlocal function inspect(api) api.ResetTime() end\napi = {}\napi.ResetTime()\nprint(inspect)\ndo local api = ll\napi.ResetTime() end';
		expect(availability(source).map((diagnostic) => diagnostic.range.start.line)).toEqual([6]);
	});

	it('keeps compatibility wrappers and directives on the same lexical path', () => {
		const source = 'local api = ll\napi.ResetTime()\napi.SetTimerEvent(1)';
		const ast = parseSlua(source).ast;
		expect(ruleRemovedLlApis(ast, registry)).toHaveLength(1);
		expect(ruleLegacyTimerApis(ast, registry)).toHaveLength(1);
		expect(availability('-- slua-lsp:disable removed-ll-api, legacy-timer-api\n' + source)).toEqual([]);
	});
});
