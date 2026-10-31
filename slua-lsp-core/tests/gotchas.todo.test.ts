import { describe, it, expect } from 'vitest';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { buildSluaRegistryFromLslDefinitions } from '../src/slua/registry.js';
import { parseSlua } from '../src/parser/parseSlua.js';
const registry = buildSluaRegistryFromLslDefinitions(null);

describe('reviewed diagnostic policy for Luau gotchas', () => {
	it('warns on accidental global writes and honors suppression', () => {
		expect(analyzeTextWithDirectives('local function check()\n leaked = 1\nend\nprint(check)', { registry }).map((d) => d.code)).toEqual(['accidental-global-write']);
		expect(analyzeTextWithDirectives('local function check()\n-- slua-lsp:disable-next-line accidental-global-write\nleaked = 1\nend\nprint(check)', { registry })).toEqual([]);
	});
	it.each(['0', '-0', '""', '`' + '`'])('explains the always-truthy literal %s in a condition', (value) => {
		const source = `if ${value} then print("taken") end`;
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['truthy-literal']);
		expect(analyzeTextWithDirectives('-- slua-lsp:disable-next-line truthy-literal\n' + source, { registry })).toEqual([]);
	});
	it.each(['if 0 then print(1) end', 'while "" do break end', 'repeat print(1) until 0', 'print(not 0)', 'print(0 or 42)', 'print(if "" then 1 else 2)', 'if true and "" then print(1) end'])('checks boolean contexts without duplicate messages: %s', (source) => {
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['truthy-literal']);
	});
	it('does not guess numeric/string variable intent or warn on explicit comparisons', () => {
		const source = 'local value=0\nlocal text=""\nprint(value,text,0,"")\nif value then print(value) end\nif text ~= "" then print(text) end\nif 0 == value then print(value) end\nwhile true do break end';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it.each(['{name=42}', '{[2]=42}', '{nil,42}', '{1,nil,42}'])('warns when ipairs provably skips literal entries: %s', (value) => {
		const source = `for key,value in ipairs(${value}) do print(key,value) end`;
		expect(analyzeTextWithDirectives(source, { registry }).map((d) => d.code)).toEqual(['ipairs-literal-hole']);
		expect(analyzeTextWithDirectives('-- slua-lsp:disable-next-line ipairs-literal-hole\n' + source, { registry })).toEqual([]);
	});
	it.each(['{}', '{1,2,3}', '{1,2,name=42}', '{[1]=42}', '{[1]=42,[1]=nil,[2]=42}', '{[math.random()]=42}'])('does not speculate about valid or ambiguous ipairs literals: %s', (value) => {
		expect(analyzeTextWithDirectives(`for key,value in ipairs(${value}) do print(key,value) end`, { registry })).toEqual([]);
	});
	it('keeps local ipairs replacements and intentional pairs/generalized iteration valid', () => {
		for (const source of ['local ipairs=pairs\nfor k,v in ipairs({name=42}) do print(k,v) end', 'for k,v in pairs({name=42}) do print(k,v) end', 'for k,v in {name=42} do print(k,v) end']) expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it.each(['function ipairs(value) return pairs(value) end', 'ipairs=pairs', '_G.ipairs=pairs', '_G["ipairs"]=pairs', 'local function change() ipairs=pairs end\nprint(change)'])('omits builtin-specific advice after a possible explicit replacement: %s', (prefix) => {
		const source = prefix + '\nfor k,v in ipairs({name=42}) do print(k,v) end';
		expect(analyzeTextWithDirectives(source, { registry }).some((d) => d.code === 'ipairs-literal-hole')).toBe(false);
	});
	it('keeps UTF-16/newline positions and disable/enable scope for custom advice', () => {
		const source = '-- 😀\r\n-- slua-lsp:disable truthy-literal\r\nif 0 then print(1) end\r\n-- slua-lsp:enable truthy-literal\r\nif "" then print(2) end';
		const diagnostics = analyzeTextWithDirectives(source, { registry });
		expect(diagnostics.map((d) => d.code)).toEqual(['truthy-literal']);
		expect(diagnostics[0]!.range).toEqual({ start: { line: 4, character: 3 }, end: { line: 4, character: 5 } });
	});
	it('permits metatable delegation and intercepted writes without blanket metamethod warnings', () => {
		const source = 'local backing={value=42}\nlocal proxy=setmetatable({}, {__index=backing, __newindex=function(_,key,value) rawset(backing,key,value) end})\nproxy.value=43\nprint(proxy.value)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('warns when a value-returning function has a fallthrough path', () => {
		const text = 'local function maybe(flag: boolean) if flag then return 1 end end\nprint(maybe)';
		expect(analyzeTextWithDirectives(text, { registry }).map((d) => d.code)).toEqual(['missing-return']);
		expect(analyzeTextWithDirectives('-- slua-lsp:disable-next-line missing-return\n' + text, { registry })).toEqual([]);
	});
	it('keeps language-specific diagnostics concrete rather than treating legal Luau as LSL', () => {
		const source = 'local value=0\nvalue+=1\nfor _,item in {value} do if item then continue end end\nprint(value)';
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
	it('keeps a long ordinary logical condition valid without emitting speculative advice', () => {
		const condition = Array(512).fill('flag').join(' and ');
		const source = `local function check(flag: boolean) if ${condition} then return 1 else return 0 end end\nprint(check(true),check(false))`;
		expect(parseSlua(source).diagnostics).toEqual([]);
		expect(analyzeTextWithDirectives(source, { registry })).toEqual([]);
	});
});
