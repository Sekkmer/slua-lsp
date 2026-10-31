import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { parseSlua } from '../src/parser/parseSlua.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { loadLslDefinitionsFromYamlFile } from '../src/lsl/lslDefinitions.js';
import { slua } from '../src/slua/types.js';

const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/native/qualification.json'), 'utf8')) as { name: string; kind: string; source: string; valid: boolean }[];
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('native syntax/strict analyzer regression cases', () => {
	it.each(cases)('$name', ({ source, valid, kind }) => {
		const parsed = parseSlua(source);
		const diagnostics = kind === 'syntax' ? parsed.diagnostics : [...parsed.diagnostics, ...analyzeTextWithDirectives(source, { ast: parsed.ast, registry })];
		expect(diagnostics.length === 0, JSON.stringify(diagnostics)).toBe(valid);
	});

	it('checks simultaneous assignment against the original RHS bindings and keeps declared types', () => {
		const text = 'local a: number = 1\nlocal b: string = "text"\na, b = b, a\nmath.abs(a)\n';
		const diagnostics = analyzeTextWithDirectives(text, { registry });
		expect(diagnostics.filter((d) => d.code === 'assignment-type-mismatch')).toHaveLength(2);
		expect(diagnostics.filter((d) => d.code === 'call-argument-type-mismatch')).toEqual([]);
	});

	it('accepts nullable widening and arbitrary next keys without losing required inputs', () => {
		const source = 'local value: number | string = 1\nlocal wider: number | string | nil = value\nprint(wider, next({}, "key"))';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
		expect(analyzeTextWithDirectives('next()', { registry }).some((d) => d.code === 'call-argument-count-mismatch')).toBe(true);
	});

	it('does not leak generic parameters out of their function scope', () => {
		const text = 'local function identity<T>(value: T): T return value end\nlocal other: T = nil\nprint(identity(1), other)';
		const diagnostics = analyzeTextWithDirectives(text, { registry });
		expect(diagnostics.filter((d) => d.code === 'unknown-type')).toHaveLength(1);
	});

	it('scopes anonymous callback parameters and checks typed assignments inside the body', () => {
		const text = 'LLTimers:every(0, function(scheduled: number, interval: number)\n local value: number = "bad"\n print(scheduled, interval, value)\nend)';
		const diagnostics = analyzeTextWithDirectives(text, { registry });
		expect(diagnostics.filter((d) => d.code === 'undeclared-name')).toEqual([]);
		expect(diagnostics.filter((d) => d.code === 'assignment-type-mismatch')).toHaveLength(1);
	});

	it('honors assignment directives and rejects function/scalar writes after declaration', () => {
		const text = '-- slua-lsp:disable-next-line assignment-type-mismatch\nlocal value: number = function() end\nvalue = function() end\nprint(value)';
		const diagnostics = analyzeTextWithDirectives(text, { registry }).filter((d) => d.code === 'assignment-type-mismatch');
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.range.start.line).toBe(2);
	});

	it('does not leak body bindings into the numeric loop bounds or out of the loop', () => {
		const text = 'local limit = 2\nfor limit = math.abs(limit), 3 do\n local value = "inside"\n print(value, limit)\nend\nmath.abs(limit)';
		expect(analyzeTextWithDirectives(text, { registry })).toEqual([]);
	});
});

describe('current native event/timer callbacks', () => {
	it.each(['every', 'once'])('accepts omitted/returned callback values and callable tables for %s', (method) => {
		const source = `local callback = setmetatable({}, { __call = function(self) print(self) end })\nlocal first = LLTimers:${method}(0, function() return 3 end)\nlocal second = LLTimers:${method}(0, callback)\nLLTimers:off(first)\nLLTimers:off(second)`;
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});

	it('checks timer callback annotations against scheduled time and number/nil interval', () => {
		const valid = 'LLTimers:every(1, function(time: number, interval: number) print(time, interval) end)\nLLTimers:once(0, function(time: number, interval: nil) print(time, interval) end)';
		expect(analyzeTextWithDirectives(valid, { registry })).toEqual([]);
		const invalid = 'LLTimers:every(1, function(time: string) print(time) end)\nLLTimers:once(0, function(time: number, interval: number) print(time, interval) end)';
		expect(analyzeTextWithDirectives(invalid, { registry }).filter((d) => d.code === 'callback-param-type-mismatch')).toHaveLength(2);
	});

	it('does not apply native timer argument annotations to a shadowed receiver', () => {
		const source = 'local LLTimers = {}\nLLTimers:every(0, function(time: string) print(time) end)';
		expect(analyzeTextWithDirectives(source, { registry }).filter((d) => d.code === 'callback-param-type-mismatch')).toEqual([]);
	});

	it('honors directives for timer callback annotation mismatches', () => {
		const source = '-- slua-lsp:disable-next-line callback-param-type-mismatch\nLLTimers:every(0, function(time: string) print(time) end)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});

	it('accepts event handlers that ignore arguments or use callable tables with the full registry', async () => {
		const defs = await loadLslDefinitionsFromYamlFile();
		const full = buildSluaRegistryFromLslDefinitions(defs);
		const source = 'local token = LLEvents:on("listen", function() return 3 end)\nLLEvents:off("listen", token)\nlocal callable = setmetatable({}, { __call = function(self) print(self) end })\nLLEvents:once("listen", callable)';
		expect(analyzeTextWithDirectives(source, { registry: full, eventSignatures: full.eventSignatures })).toEqual([]);
		const wide = 'LLEvents:on("listen", function(channel: number | nil, name: string | nil, id: uuid | nil, text: string | nil, extra: nil) print(channel, name, id, text, extra) end)';
		expect(analyzeTextWithDirectives(wide, { registry: full, eventSignatures: full.eventSignatures })).toEqual([]);
		for (const name of ['sensor', 'on_damage', 'final_damage']) expect(full.eventSignatures[name]!.params.map((p) => p.type)).toEqual([slua.array(slua.detectedEvent())]);
	});
});
