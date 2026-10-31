import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, analyzeTextWithDirectives, buildSluaRegistryFromLslDefinitions, getHover, getCompletions, classifySemanticTokens, slua, sluaTypeEquals } from '../src/index.js';
import { typeProgram } from '../src/parser/typeRegions.js';
import { inferClassDeclaration, inferLocalVariableTypes } from '../src/typing/inferLocals.js';
const registry=buildSluaRegistryFromLslDefinitions(null);
const fixtures=JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/function-metadata.json',import.meta.url),'utf8')) as Array<{name:string;source:string;kind:string;expectedNative:{syntax:number};deprecations:Array<{message:string;range:unknown}>}>;
function diagnostics(source:string){const parsed=parseSlua(source);return analyzeTextWithDirectives(source,{ast:parsed.ast,registry});}
describe('source function attributes and native deprecation',()=>{
	it.each(fixtures)('$name matches native attribute syntax and warning locations',({source,expectedNative,deprecations})=>{
		const parsed=parseSlua(source);expect(parsed.diagnostics.length===0).toBe(expectedNative.syntax===0);
		if(expectedNative.syntax!==0)return;
		expect(diagnostics(source).filter((x)=>x.code==='deprecated-function').map(({message,range})=>({message,range}))).toEqual(deprecations);
	});
	it.each(['disable-next-line deprecated-function','disable deprecated-function','disable all'])('honors %s without affecting parser errors',(directive)=>{
		const source='@deprecated local function old(): number return 42 end\n-- slua-lsp:'+directive+'\nprint(old())';
		expect(diagnostics(source)).toEqual([]);expect(parseSlua('-- slua-lsp:disable all\n@[native `tag`] function old() end').diagnostics.length).toBeGreaterThan(0);
	});
	it('reenables warnings and refuses directive-like literal metadata',()=>{
		const source='@[deprecated{reason="-- slua-lsp:disable all"}] local function old():number return 42 end\n-- slua-lsp:disable deprecated-function\nold()\n-- slua-lsp:enable deprecated-function\nold()';
		expect(diagnostics(source).map((x)=>[x.code,x.range.start.line])).toEqual([['deprecated-function',4]]);
	});
	it('keeps metadata out of structural equality and serialized public type shapes',()=>{
		const source='@deprecated local function old():number return 42 end\nlocal function fresh():number return 7 end';
		const types=inferLocalVariableTypes(parseSlua(source).ast,registry);expect(sluaTypeEquals(types[0]!.type,types[1]!.type)).toBe(true);expect(JSON.stringify(types[0]!.type)).not.toContain('deprecated');expect(sluaTypeEquals(types[0]!.type,slua.fn([],slua.number()))).toBe(true);
	});
	it('shows source deprecation and first-key explanations in alias/member hover and completions',()=>{
		const source='@[deprecated{use="first",use="last",reason="old API"}] local function old(): number return 42 end\nlocal alias=old\nprint(alias())\n';const ast=parseSlua(source).ast;
		const hover=getHover(ast,{line:2,character:8},registry);expect(hover?.markdown).toContain('**Deprecated**');expect(hover?.markdown).toContain('first');expect(hover?.markdown).not.toContain('last');
		expect(getCompletions(ast,{line:3,character:0},registry,{sourceText:source}).find((x)=>x.label==='alias')).toMatchObject({deprecated:true});
		const table='local api={old=@deprecated function():number return 42 end}\napi.old()\napi.';const parsed=parseSlua(table).ast;expect(getHover(parsed,{line:1,character:5},registry)?.markdown).toContain('**Deprecated**');expect(getCompletions(parsed,{line:2,character:4},registry,{sourceText:table}).find((x)=>x.label==='old')).toMatchObject({deprecated:true});
	});
	it.each(['@','@n','@[','@[native,','@[native, ch','@[native, -- note\nch'])('offers only ordinary attribute names at %s',(source)=>{
		const items=getCompletions(parseSlua(source).ast,{line:source.split('\n').length-1,character:source.split('\n').at(-1)!.length},registry,{sourceText:source});expect(items.length).toBeGreaterThan(0);expect(items.every((x)=>['native','checked','deprecated'].includes(x.label))).toBe(true);if(source.includes('native,'))expect(items.map((x)=>x.label)).not.toContain('native');
	});
	it.each(['-- @','local text="@','@[deprecated{use="@','@ n','@ [native,'])('does not offer attribute completions inside comments or literals: %s',(source)=>{
		expect(getCompletions(parseSlua(source).ast,{line:0,character:source.length},registry,{sourceText:source}).some((x)=>['native','checked','deprecated'].includes(x.label))).toBe(false);
	});
	it('explains attributes without claiming native code or checked runtime guards',()=>{
		const source='@[native,checked,deprecated] local function old() end';const ast=parseSlua(source).ast;
		expect(getHover(ast,{line:0,character:4},registry)?.markdown).toContain('native');expect(getHover(ast,{line:0,character:11},registry)?.markdown).toContain('runtime');
		const tokens=classifySemanticTokens(source,{ast});for(const character of [2,9,17])expect(tokens).toEqual(expect.arrayContaining([expect.objectContaining({line:0,character,tokenType:'keyword'})]));
	});
});


it('preserves nominal class constructor identity when normalizing equal union shapes',()=>{
	const ast=parseSlua('class C public value: number end').ast as {body:unknown[]};
	const first=inferClassDeclaration(ast.body[0],registry,new Map())!,second=inferClassDeclaration(ast.body[0],registry,new Map())!;
	expect(sluaTypeEquals(slua.union([first.constructorType,second.constructorType]),slua.union([first.constructorType]))).toBe(true);
});


describe('attribute hover source ownership', () => {
	it.each([
		['local text="@deprecated" -- @checked', false],
		['@native local function run() end', true],
		['local run = @checked function() end', true],
		['type Callback = typeof(@native function() end)', true],
		['local function run() end', false]
	] as const)('records parsed attribute presence without treating literal text as syntax: %s', (source, expected) => {
		const parsed = parseSlua(source);
		expect(parsed.diagnostics).toEqual([]);
		expect(typeProgram(parsed.ast as object)?.hasFunctionAttributes).toBe(expected);
	});
	it('retains attribute hover for caller-owned ASTs without parser source metadata', () => {
		const ast = JSON.parse(JSON.stringify(parseSlua('@native function run() end').ast));
		expect(typeProgram(ast)).toBeUndefined();
		expect(getHover(ast, {line: 0, character: 3}, registry)).toMatchObject({kind: 'attribute'});
	});
});
