import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSlua, buildSluaRegistryFromLslDefinitions, findDefinitionAtPosition, prepareRename, findAllReferences, SourceTextIndex, analyzeSourceProject, inferLocalVariableTypes } from '../src/index.js';
const base=buildSluaRegistryFromLslDefinitions(null);
const cases=JSON.parse(readFileSync(new URL('../../scripts/fixtures/member-definitions.json',import.meta.url),'utf8')) as Array<{name:string;source:string;query:string;target:string|null;targetLast:boolean}>;
describe('source member definitions',()=>{
	it.each(cases)('$name',({source,query,target,targetLast})=>{
		const parsed=parseSlua(source);expect(parsed.diagnostics).toEqual([]);
		const index=new SourceTextIndex(source), position=index.positionAt(source.lastIndexOf(query));
		const result=findDefinitionAtPosition(parsed.ast,position,base);
		if(target){
			expect(result?.kind).toBe('field');
			const start=index.positionAt(targetLast?source.lastIndexOf(target):source.indexOf(target));
			expect(result?.identifier.location?.start).toEqual({line:start.line+1,column:start.character+1});
		}else expect(result).toBeNull();
		expect(prepareRename(parsed.ast,position,base)).toBeNull();
		expect(findAllReferences(parsed.ast,position,base)).toEqual([]);
	});
	it('unknown literal keys cannot retain a named value contract that they may overwrite',()=>{
		const ast=parseSlua('local key="field"\nlocal object={field=1,[key]="changed"}\nprint(object.field)').ast;
		expect(inferLocalVariableTypes(ast,base).find((item)=>item.name==='object')?.type).toEqual({kind:'table'});
	});
	it('different module return branches do not pick a same-shaped arbitrary field',async()=>{
		const files:Record<string,string>={'/project/main.luau':'local api=require("api")\nprint(api.field)','/project/api.luau':'if math.random()>0 then return {field=1} else return {field=2} end'};
		const project=await analyzeSourceProject('/project/main.luau',base,{readFile:async(file)=>files[file]});
		expect(findDefinitionAtPosition(project.documents.get(project.graph.entry)!.parsed.ast,{line:1,character:10},project.registry)).toBeNull();
	});
	it.each([
		['literal','return {field=42}',0,8],
		['incremental','local M={}\nM.field=42\nreturn M',1,2],
		['method','local M={}\nfunction M:field() return 42 end\nreturn M',1,11],
		['nested-reexport','return require("nested")',0,8]
	])('module %s carries exact file and field token',async(name,module,line,column)=>{
		const files:Record<string,string>={'/project/main.luau':'local api=require("api")\nprint(api.field)','/project/api.luau':String(module),'/project/nested.luau':'return {field=42}'};
		const project=await analyzeSourceProject('/project/main.luau',base,{readFile:async(file)=>files[file]});
		const result=findDefinitionAtPosition(project.documents.get(project.graph.entry)!.parsed.ast,{line:1,character:10},project.registry);
		expect(result?.kind).toBe('field');
		const file=name==='nested-reexport'?'/project/nested.luau':'/project/api.luau';
		expect(result).toMatchObject({file,sourceSha256:createHash('sha256').update(files[file]!).digest('hex'),identifier:{location:{start:{line:Number(line)+1,column:Number(column)+1}}}});
		expect(base.sourceNodeFiles.has(result!.identifier)).toBe(false); expect(base.sourceFileHashes.size).toBe(0);
	});
});
