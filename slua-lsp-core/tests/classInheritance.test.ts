import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSlua, buildSluaRegistryFromLslDefinitions, inferLocalVariableTypes, sluaTypeToString, getCompletions, getSignatureHelp, getHover, findDefinitionAtPosition, findAllReferences, getRenameEdits, classifySemanticTokens } from '../src/index.js';
import { analyzeTextWithDirectives } from '../src/diagnostics/engine.js';
import { analyzeSourceProject } from '../src/workspace/analyzeSourceProject.js';

const registry = buildSluaRegistryFromLslDefinitions(null);
const base = 'open class Base\npublic x: number\nfunction get(self): number return self.x end\nfunction answer(): number return 42 end\nend\n';
const child = base + 'class Child extends Base\npublic y: string\nend\nlocal value=Child{x=42,y="yes"}\n';
function diagnostics(source: string) { const parsed = parseSlua(source); return analyzeTextWithDirectives(source, { ast: parsed.ast, registry }); }
function codes(source: string) { return diagnostics(source).map((x) => x.code).sort(); }
const native = JSON.parse(fs.readFileSync(new URL('../../scripts/fixtures/class-inheritance.json', import.meta.url), 'utf8')) as Array<{ name: string; source: string; expectedNative: { syntax: number } }>;

describe('native known-source open class inheritance', () => {
	it.each(native.filter((x) => x.name !== 'inheritance-disabled-control'))('$name exact native grammar', ({ source, expectedNative }) => {
		expect(parseSlua(source).diagnostics.length === 0).toBe(expectedNative.syntax === 0);
	});
	it.each(['assert(value:get()==42)', 'value.x=43\nassert(value:get()==43)', 'local item: Base=value\nassert(item:get()==42)', 'local function read(item: Base): number return item.x end\nassert(read(value)==42)'])('retains inherited members and base assignability: %s', (tail) => { expect(diagnostics(child + tail)).toEqual([]); });
	it.each(['Base', 'alias', 'namespace.Parent', 'namespace["Parent"]'])('inherits an exact known constructor through %s', (reference) => {
		const source = base + 'local alias=Base\nlocal namespace={Parent=Base}\nclass Child extends '+reference+' end\nlocal value=Child{x=42}\nassert(value:get()==42)';
		expect(diagnostics(source)).toEqual([]);
	});
	it('keeps unresolved dynamic ancestry opaque without inventing missing or readonly instance members', () => {
		const source=base+'local namespace={Parent=Base}\nlocal key="Parent"\nclass Child extends namespace[key] end\nlocal value=Child{x=42}\nvalue.x=43\nassert(value:get()==43)';
		expect(diagnostics(source)).toEqual([]);
		expect(findDefinitionAtPosition(parseSlua(source).ast,{line:10,character:14},registry)).toBeNull();
	});
	it('retains exact base annotations for completion and class typeof queries without crossing a value shadow', () => {
		const source=child+'local item: Base=value\nitem.';
		const labels=getCompletions(parseSlua(source).ast,{line:10,character:5},registry,{sourceText:source}).map((x)=>x.label);
		expect(labels).toContain('get');expect(labels).toContain('x');expect(labels).not.toContain('y');
		expect(codes(base+'class Child extends Base end\nlocal Make: typeof(Base)=Child\nprint(Make)')).toEqual(['assignment-type-mismatch']);
	});
	it.each([true,false])('checks every fixed return slot of an override: second slot matches=%s', (valid) => {
		const source='open class Base\nfunction get(self): (number,string) return 1,"yes" end\nend\nclass Child extends Base\nfunction get(self): (number,'+(valid?'string':'boolean')+') return 2,'+(valid?'"yes"':'true')+' end\nend';
		expect(codes(source)).toEqual(valid?[]:['class-method-override']);
	});
	it('keeps an own override and its new member origin while inherited fields retain base origins', () => {
		const source = base+'class Child extends Base\nfunction get(self): number return self.x+1 end\nend\nlocal value=Child{x=41}\nassert(value:get()==42)';
		const ast = parseSlua(source).ast;
		expect(diagnostics(source)).toEqual([]);
		expect(findDefinitionAtPosition(ast, { line: 9, character: 15 }, registry)?.identifier.location?.start.line).toBe(7);
		expect(findDefinitionAtPosition(ast, { line: 6, character: 'function get(self): number return self.'.length }, registry)?.identifier.location?.start.line).toBe(2);
	});
	it('offers inherited field and callable member completion and signatures', () => {
		const source = child+'value.';
		const labels = getCompletions(parseSlua(source).ast, { line: 9, character: 6 }, registry, { sourceText: source }).map((x) => x.label);
		expect(labels).toEqual(expect.arrayContaining(['x','y','get','answer']));
		const call = child+'value:get()';
		expect(getSignatureHelp(parseSlua(call).ast, { line: 9, character: 10 }, registry, call)?.signatures[0]?.parameters).toEqual([]);
		expect(getHover(parseSlua(call).ast, { line: 9, character: 7 }, registry)?.markdown).toContain('number');
	});
	it.each([
		['closed', 'class Base end\nclass Child extends Base end', 'class-closed-base'],
		['cycle', 'open class Base extends Base end', 'class-inheritance-cycle'],
		['nonclass', 'local Parent={}\nclass Child extends Parent end', 'class-invalid-base'],
		['instance', base+'local Parent=Base{x=1}\nclass Child extends Parent end', 'class-invalid-base'],
		['field method', base+'class Child extends Base\nfunction x(self): number return 1 end\nend', 'class-field-override'],
		['field property', base+'class Child extends Base\npublic x: number\nend', 'class-field-override'],
		['method property', base+'class Child extends Base\npublic get: number\nend', 'class-field-override'],
		['wrong field', child+'value.x="bad"', 'assignment-type-mismatch'],
		['wrong ctor', base+'class Child extends Base end\nChild{x="bad"}', 'call-argument-type-mismatch'],
		['missing ctor', base+'class Child extends Base end\nChild{}', 'call-argument-type-mismatch'],
		['readonly method', child+'value.get=function(self): number return 2 end', 'class-readonly-member'],
		['reverse ancestry', child+'local item: Child=Base{x=42}\nprint(item)', 'assignment-type-mismatch'],
		['constructor ancestry', base+'class Child extends Base end\nlocal item: typeof(Base)=Child\nprint(item)', 'assignment-type-mismatch'],
	])('reports %s with a shared precise diagnostic', (_name, source, code) => { expect(codes(source)).toEqual([code]); });
	it('requires a child initializer at call sites when any ancestor has a user initializer', () => {
		const source='open class Base\nfunction __init(self) end\nend\nopen class Middle extends Base end\nclass Child extends Middle end\n';
		expect(diagnostics(source)).toEqual([]);
		expect(codes(source+'local Make=Child\nMake{}')).toEqual(['class-constructor-required']);
	});
	it('allows explicit user parent initialization without inventing automatic parent calls', () => {
		const source='open class Base\npublic x: number\nfunction __init(self,x: number) self.x=x end\nend\nclass Child extends Base\nfunction __init(self,x: number) Base.__init(self,x) end\nend\nassert(Child(42).x==42)';
		expect(diagnostics(source)).toEqual([]);
		expect(codes(source.replace('Base.__init(self,x)','Base.__init(self,"bad")'))).toEqual(['call-argument-type-mismatch']);
	});
	it.each(['__eq','__lt','__le'])('refuses inherited comparison %s', (name) => {
		const source=`open class Base\nfunction ${name}(self,other: Base): boolean return true end\nend\nclass Child extends Base\nfunction ${name}(self,other: Child): boolean return false end\nend`;
		expect(codes(source)).toEqual(['class-method-override']);
	});
	it.each([
		['number|string','number|string|nil','number','number',false],
		['number|string','number','number','number',true],
		['number','number','number','number|string',true],
	])('checks ordinary override variance', (baseArg, childArg, baseReturn, childReturn, invalid) => {
		const source=`open class Base\nfunction get(self,x: ${baseArg}): ${baseReturn} return 1 end\nend\nclass Child extends Base\nfunction get(self,x: ${childArg}): ${childReturn} return 2 end\nend`;
		expect(codes(source)).toEqual(invalid ? ['class-method-override'] : []);
	});
	it('binds base-header uses for references and rename without renaming unrelated fields or shadows', () => {
		const source=base+'local namespace={Parent=Base}\nclass Child extends Base end\nclass Other extends namespace.Parent end\nlocal value: Base=Child{x=42}\nprint(value)';
		const ast=parseSlua(source).ast;
		expect(findAllReferences(ast,{line:6,character:21},registry)).toHaveLength(4);
		const edits=getRenameEdits(ast,{line:6,character:21},'Root',registry);
		expect(edits).toHaveLength(4);
		expect(edits.every((x)=>x.identifier.name==='Base')).toBe(true);
		expect(getRenameEdits(ast,{line:0,character:13},'Child',registry)).toEqual([]);
	});
	it('highlights only actual header keywords while retaining contextual names and readonly base bindings', () => {
		const source='open class Base end\nclass Child extends Base end\nlocal open=1\nlocal extends=2\nprint(open,extends)';
		const tokens=classifySemanticTokens(source,{ast:parseSlua(source).ast});
		expect(tokens.find((x)=>x.line===0&&x.character===0)?.tokenType).toBe('keyword');
		expect(tokens.find((x)=>x.line===1&&x.character===12)?.tokenType).toBe('keyword');
		expect(tokens.find((x)=>x.line===1&&x.character===20)?.modifiers).toContain('readonly');
		expect(tokens.filter((x)=>x.line===4).every((x)=>x.tokenType!=='keyword')).toBe(true);
	});
	it('keeps semantic inheritance warnings suppressible and syntax failures unsuppressible', () => {
		expect(codes('-- slua-lsp:disable-next-line class-closed-base\nclass Child extends Base end\nclass Base end')).toContain('undeclared-name');
		expect(diagnostics('class Base end\n-- slua-lsp:disable-next-line class-closed-base\nclass Child extends Base end')).toEqual([]);
		expect(parseSlua('-- slua-lsp:disable all\nopen class Base extends end').diagnostics.map((x) => x.code)).toContain('parse-error');
	});
	it('retains a useful following declaration after an incomplete base', () => {
		const source='open class Base extends\nend\nlocal after=42\nprint(after)';
		expect(parseSlua(source).diagnostics.length).toBeGreaterThan(0);
		expect(inferLocalVariableTypes(parseSlua(source).ast,registry).find((x)=>x.name==='after')?.type).toEqual({kind:'primitive',name:'number'});
	});
	it('resolves an exported open class and inherited origins across ordinary source modules', async () => {
		const files: Record<string,string>={'/project/base.luau':base.replace('open class','export open class'),'/project/main.luau':'local api=require("base")\nclass Child extends api.Base end\nlocal value=Child{x=42}\nassert(value:get()==42)'};
		const project=await analyzeSourceProject('/project/main.luau',registry,{readFile:async(file)=>files[file]});
		expect(project.diagnostics).toEqual([]);
		const ast=project.documents.get('/project/main.luau')!.parsed.ast;
		expect(findDefinitionAtPosition(ast,{line:3,character:15},project.registry)).toMatchObject({file:'/project/base.luau',identifier:{name:'get'}});
		expect(sluaTypeToString(project.exports.get('/project/base.luau')!)).toContain('Base');
	});
});
