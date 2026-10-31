import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as vscode from 'vscode';

type CaseResult = { name: string; seconds: number; error?: string };

export async function run(): Promise<void> {
	const results: CaseResult[] = [];
	const destination = process.env.SLUA_LSP_TEST_EVIDENCE;
	assert.ok(destination, 'Test runner must provide an evidence path');
	const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'slua-lsp-client');
	assert.ok(extension, 'Extension loaded in the actual host');
	async function test(name: string, body: () => Promise<void>) {
		const start = performance.now();
		try { await body(); results.push({ name, seconds: (performance.now() - start) / 1000 }); }
		catch (err) { results.push({ name, seconds: (performance.now() - start) / 1000, error: err instanceof Error ? err.stack : String(err) }); }
		await fs.writeFile(destination!, JSON.stringify({ vscode: vscode.version, extension: extension!.id, cacheFault: process.env.SLUA_TEST_CACHE_FAULT ?? null, results }, null, 2) + '\n');
	}
	async function document(content: string) {
		const doc = await vscode.workspace.openTextDocument({ language: 'luau', content });
		await vscode.window.showTextDocument(doc);
		return doc;
	}
	await test('headless host has its own runtime and D-Bus session', async () => {
		assert.equal(process.env.SLUA_HOST_SESSION_ISOLATED, '1');
		const runtime = process.env.SLUA_HOST_PRIVATE_RUNTIME;
		assert.ok(runtime);
		assert.equal(process.env.XDG_RUNTIME_DIR, runtime);
		const info = await fs.stat(runtime);
		assert.ok(info.isDirectory());
		assert.equal(info.mode & 0o777, 0o700);
		assert.equal(info.uid, process.getuid?.());
		const address = process.env.DBUS_SESSION_BUS_ADDRESS;
		assert.ok(address);
		assert.notEqual(crypto.createHash('sha256').update(address).digest('hex'), process.env.SLUA_HOST_PARENT_BUS_SHA256);
		assert.equal(process.env.WAYLAND_DISPLAY, undefined);
	});
	await test('activation and actual language server startup', async () => {
		await extension.activate();
		assert.ok(extension.isActive);
		const active = await vscode.commands.executeCommand<string>('slua.showActiveDefinitions');
		assert.ok(active?.endsWith('.yaml'));
		await fs.access(active);
	});
	await test('source require definition opens the relative module rather than an unrelated lexical binding', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-modules-'));
		const target = path.join(folder, 'helper.luau'); const source = path.join(folder, 'main.luau');
		await fs.writeFile(target, 'return {value = 42}'); await fs.writeFile(source, 'local result = require("helper")\nprint(result)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 25));
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.fsPath, target);
	});
	await test('source member definitions stay separate from same-named local references and rename', async () => {
		const source='local field=1\nlocal object={field=field}\nobject.field=2\nprint(object.field,field)';
		const doc=await document(source),pos=new vscode.Position(3,14);
		const targets=await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider',doc.uri,pos);
		assert.equal(targets?.length,1); assert.deepEqual(targets![0]!.range.start,new vscode.Position(2,7));
		const refs=await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider',doc.uri,pos); assert.equal(refs?.length,0);
		await assert.rejects(async () => await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider',doc.uri,pos,'newField'), /can't be renamed/);
		const locals=await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider',doc.uri,new vscode.Position(0,7)); assert.equal(locals?.length,3);
	});
	await test('module member definitions follow unsaved dependency edits and recover from malformed buffers', async () => {
		const root=vscode.workspace.workspaceFolders![0]!.uri.fsPath,folder=await fs.mkdtemp(path.join(root,'member-origins-'));
		const module=path.join(folder,'api.luau'),main=path.join(folder,'main.luau'),original='local M={}\nM.field=42\nreturn M';
		await fs.writeFile(module,original);await fs.writeFile(main,'local api=require("api")\nprint(api.field)');
		const doc=await vscode.workspace.openTextDocument(main);await vscode.window.showTextDocument(doc);const pos=new vscode.Position(1,10);
		async function definition(line:number){const targets=await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider',doc.uri,pos);assert.equal(targets?.length,1);assert.equal(targets![0]!.uri.fsPath,module);assert.deepEqual(targets![0]!.range.start,new vscode.Position(line,2));}
		await definition(1);const imported=await vscode.workspace.openTextDocument(module);await vscode.window.showTextDocument(imported);
		async function replace(text:string){const edit=new vscode.WorkspaceEdit();edit.replace(imported.uri,new vscode.Range(imported.positionAt(0),imported.positionAt(imported.getText().length)),text);assert.ok(await vscode.workspace.applyEdit(edit));}
		await replace('-- unsaved\n'+original);await definition(2);
		await replace('local broken=');await waitForDiagnostics(imported.uri,(items)=>items.some((item)=>item.code==='parse-error'));
		const refused=await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider',doc.uri,pos);assert.equal(refused?.length,0);
		await replace('-- repaired\n'+original);await waitForDiagnostics(imported.uri,(items)=>items.length===0);await definition(2);
		assert.equal(await fs.readFile(module,'utf8'),original);
	});
	await test('conditional const scope shares hover, navigation, rename and edit recovery in the packaged host', async () => {
		const source = 'local value="outer"\nif const value=42 then\nmath.abs(value)\nelse\nprint(value)\nend';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const pos = new vscode.Position(2, 10);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
		assert.ok(hover?.some((h) => h.contents.some((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '').includes('const value: number'))));
		const inner = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, pos);
		assert.deepEqual(inner![0]!.range.start, new vscode.Position(1, 9));
		const outer = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(4, 8));
		assert.deepEqual(outer![0]!.range.start, new vscode.Position(0, 6));
		const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, pos, 'bound');
		assert.equal(rename!.get(doc.uri).length, 2);
		const replace = async (text: string) => {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
			assert.ok(await vscode.workspace.applyEdit(edit));
		};
		await replace(source.replace('math.abs(value)', 'value=2'));
		await waitForDiagnostics(doc.uri, (items) => items.some((d) => d.code === 'parse-error'));
		await replace(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(source.replace('math.abs(value)', 'math.abs(value)\n  '));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 1));
		const value = completions!.items.find((item) => item.label === 'value');
		assert.equal(value!.kind, vscode.CompletionItemKind.Constant);
		assert.ok(value!.detail?.includes('number'));
	});
	await test('opt-in source macro context revalidates diagnostics, hover and generated previews', async () => {
		const cfg = vscode.workspace.getConfiguration('slua');
		const previous = cfg.get('preprocessor.context');
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-context-'));
		const file = path.join(folder, 'main.luau');
		const source = 'local line: number = __LINE__\r\nlocal id: uuid = __AGENTKEY__\r\nprint(line, id, __FILE__)';
		await fs.writeFile(file, source);
		const doc = await vscode.workspace.openTextDocument(file); await vscode.window.showTextDocument(doc);
		try {
			await cfg.update('preprocessor.context', null, vscode.ConfigurationTarget.Workspace);
			await waitForDiagnostics(doc.uri, (items) => items.filter((d) => d.code === 'undeclared-name').length === 3);
			await cfg.update('preprocessor.context', {}, vscode.ConfigurationTarget.Workspace);
			await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'preprocessor-context');
			const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 20));
			assert.ok(hover?.some((h) => h.contents.some((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '').includes(file))));
			await cfg.update('preprocessor.context', { agentId: '12345678-1234-1234-1234-123456789abc' }, vscode.ConfigurationTarget.Workspace);
			await waitForDiagnostics(doc.uri, (items) => items.length === 0);
			const generated = await vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', doc.uri, { preview: false });
			assert.ok(generated?.success); assert.ok(generated.content?.includes('uuid("12345678-1234-1234-1234-123456789abc")'));
			assert.equal(await fs.readFile(file, 'utf8'), source);
		} finally { await cfg.update('preprocessor.context', previous, vscode.ConfigurationTarget.Workspace); }
	});
	await test('preprocess command previews a read-only snapshot and returns source hashes and mappings', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'generated-preview-'));
		const main = path.join(folder, 'main.luau'), helper = path.join(folder, 'helper.luau');
		await fs.writeFile(main, 'local value=require("helper")\nprint(value)'); await fs.writeFile(helper, 'return 42');
		const doc = await vscode.workspace.openTextDocument(main); await vscode.window.showTextDocument(doc);
		const result = await vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', doc.uri);
		assert.ok(result?.success); assert.equal(result.contentSha256, crypto.createHash('sha256').update(result.content!).digest('hex'));
		assert.equal(result.graph.modules[1]!.file, helper); assert.ok(result.mappings.some((mapping) => mapping.file === main));
		const preview = vscode.window.activeTextEditor!.document;
		assert.equal(preview.uri.scheme, 'slua-generated'); assert.equal(preview.languageId, 'plaintext'); assert.equal(preview.getText(), result.content);
		assert.equal(await fs.readFile(main, 'utf8'), 'local value=require("helper")\nprint(value)');
	});
	await test('preprocessing uses unsaved imports, refuses dynamic calls and recovers without source writes', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'generated-buffers-'));
		const main = path.join(folder, 'main.luau'), helper = path.join(folder, 'helper.luau');
		await fs.writeFile(main, 'print(require("helper"))'); await fs.writeFile(helper, 'return 1');
		const imported = await vscode.workspace.openTextDocument(helper); await vscode.window.showTextDocument(imported);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(imported.uri, new vscode.Range(imported.positionAt(0), imported.positionAt(imported.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('return require(variable)');
		const generate = () => vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', vscode.Uri.file(main), { preview: false });
		const failed = await generate(); assert.equal(failed!.success, false); assert.equal(failed!.content, null);
		assert.ok(failed!.diagnostics.some((item) => item.code === 'module-dynamic-require'));
		await replace('return __LINE__');
		const repaired = await vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', vscode.Uri.file(main), { preview: false, context: {} });
		assert.ok(repaired?.success); assert.ok(repaired.content!.includes('return 1'));
		assert.equal(repaired.graph.modules[1]!.sourceSha256, crypto.createHash('sha256').update('return __LINE__').digest('hex'));
		assert.equal(await fs.readFile(helper, 'utf8'), 'return 1');
	});
	await test('generated preview F12 and original-source command map unsaved Unicode/CRLF and macro anchors', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, folder = await fs.mkdtemp(path.join(root, 'generated-navigation-'));
		const main = path.join(folder, 'main.luau'), helper = path.join(folder, 'helper.luau');
		await fs.writeFile(main, 'local value=require("helper")\nprint(value,__LINE__)'); await fs.writeFile(helper, '-- disk\r\nreturn 42');
		const imported = await vscode.workspace.openTextDocument(helper); await vscode.window.showTextDocument(imported, { preview: false });
		const edit = new vscode.WorkspaceEdit(); edit.replace(imported.uri, new vscode.Range(imported.positionAt(0), imported.positionAt(imported.getText().length)), '-- 😀\r\nreturn "unsaved"');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.equal(imported.eol, vscode.EndOfLine.CRLF); assert.ok(imported.getText().includes('\r\n'));
		const result = await vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', vscode.Uri.file(main), { context: {} }); assert.ok(result?.success);
		const preview = vscode.window.activeTextEditor!.document, point = preview.positionAt(preview.getText().indexOf('"unsaved"'));
		assert.equal(preview.getText().replace(/\r\n/g, '\n'), result.content!.replace(/\r\n/g, '\n'), 'The command awaits matching display text, allowing VS Code CRLF normalization');
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, point);
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.fsPath, helper); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(1, 7));
		const macroPoint = preview.positionAt(preview.getText().lastIndexOf(',2)') + 1);
		const macro = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, macroPoint);
		assert.equal(macro?.length, 1); assert.equal(macro![0]!.uri.fsPath, main); assert.deepEqual(macro![0]!.range.start, new vscode.Position(1, 12));
		const synthetic = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, preview.positionAt(preview.getText().indexOf('function require(mod)')));
		assert.equal(synthetic?.length ?? 0, 0);
		const selected = await vscode.commands.executeCommand<vscode.Location>('slua.openGeneratedSource', preview.uri, point);
		assert.equal(selected?.uri.fsPath, helper); assert.equal(vscode.window.activeTextEditor!.document.uri.fsPath, helper);
		assert.deepEqual(vscode.window.activeTextEditor!.selection.active, new vscode.Position(1, 7));
		assert.equal(await fs.readFile(helper, 'utf8'), '-- disk\r\nreturn 42'); assert.ok(imported.isDirty);
	});
	await test('generated navigation refuses changed disk/open sources and missing files, then recovers with fresh preview', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, folder = await fs.mkdtemp(path.join(root, 'generated-stale-'));
		const main = path.join(folder, 'main.luau'), helper = path.join(folder, 'helper.luau');
		await fs.writeFile(main, 'print(require("helper"))'); await fs.writeFile(helper, 'return 42');
		const generate = async () => { await vscode.commands.executeCommand('slua.preprocess', vscode.Uri.file(main)); return vscode.window.activeTextEditor!.document; };
		let preview = await generate();
		await fs.writeFile(helper, 'return 43');
		let definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, preview.positionAt(preview.getText().indexOf('42')));
		assert.equal(definitions?.length ?? 0, 0);
		assert.equal(await vscode.commands.executeCommand('slua.openGeneratedSource', preview.uri, preview.positionAt(preview.getText().indexOf('42'))), null);
		assert.equal(vscode.window.activeTextEditor!.document.uri.scheme, 'slua-generated');
		preview = await generate(); await fs.unlink(helper);
		assert.equal(await vscode.commands.executeCommand('slua.openGeneratedSource', preview.uri, preview.positionAt(preview.getText().indexOf('43'))), null);
		await fs.writeFile(helper, 'return 44'); preview = await generate();
		assert.ok(await vscode.commands.executeCommand('slua.openGeneratedSource', preview.uri, preview.positionAt(preview.getText().indexOf('44'))));
		const imported = vscode.window.activeTextEditor!.document;
		const edit = new vscode.WorkspaceEdit(); edit.replace(imported.uri, new vscode.Range(imported.positionAt(0), imported.positionAt(imported.getText().length)), 'return 45');
		assert.ok(await vscode.workspace.applyEdit(edit));
		await vscode.window.showTextDocument(preview);
		definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, preview.positionAt(preview.getText().indexOf('44')));
		assert.equal(definitions?.length ?? 0, 0);
		preview = await generate();
		definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, preview.positionAt(preview.getText().indexOf('45')));
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.fsPath, helper);
		assert.equal(await fs.readFile(helper, 'utf8'), 'return 44');
	});
	await test('overlapping preview commands retain the most recently requested source and its mappings', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, folder = await fs.mkdtemp(path.join(root, 'generated-overlap-'));
		const slow = path.join(folder, 'slow.luau'), latest = path.join(folder, 'latest.luau');
		for (let index = 0; index < 64; index++) await fs.writeFile(path.join(folder, `m${index}.luau`), `return ${index}`);
		await fs.writeFile(slow, Array.from({ length: 64 }, (_, index) => `local a${index}=require("m${index}")`).join('\n'));
		await fs.writeFile(latest, 'print("latest-owned-preview")');
		const results = await Promise.all([vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', vscode.Uri.file(slow)), vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', vscode.Uri.file(latest))]);
		assert.ok(results.every((item) => item?.success));
		const preview = vscode.window.activeTextEditor!.document; assert.equal(preview.getText(), results[1]!.content);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, new vscode.Position(0, 0));
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.fsPath, latest);
	});
	await test('bare-CR disk generation navigates through normalized clean editor buffers and still refuses dirty sources', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, folder = await fs.mkdtemp(path.join(root, 'generated-bare-cr-'));
		const main = path.join(folder, 'main.luau'), helper = path.join(folder, 'helper.luau');
		await fs.writeFile(main, '-- root\rprint(require("helper"))'); await fs.writeFile(helper, '-- module\rreturn 42\r');
		const generated = await vscode.commands.executeCommand<import('slua-lsp-core').PreprocessedSource>('slua.preprocess', vscode.Uri.file(main)); assert.ok(generated?.success);
		const preview = vscode.window.activeTextEditor!.document, point = preview.positionAt(preview.getText().indexOf('42'));
		assert.equal(preview.getText().replace(/\r\n|\r/g, '\n'), generated.content!.replace(/\r\n|\r/g, '\n'));
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, point);
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.fsPath, helper); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(1, 7));
		assert.ok(await vscode.commands.executeCommand('slua.openGeneratedSource', preview.uri, point));
		const imported = vscode.window.activeTextEditor!.document; assert.equal(imported.uri.fsPath, helper); assert.ok(!imported.isDirty);
		assert.deepEqual(vscode.window.activeTextEditor!.selection.active, new vscode.Position(1, 7));
		const edit = new vscode.WorkspaceEdit(); edit.replace(imported.uri, new vscode.Range(1, 7, 1, 9), '43'); assert.ok(await vscode.workspace.applyEdit(edit));
		const stale = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', preview.uri, point); assert.equal(stale?.length ?? 0, 0);
		assert.equal(await fs.readFile(helper, 'utf8'), '-- module\rreturn 42\r');
	});
	await test('nested interpolation keeps source navigation, string types and malformed-buffer recovery in the packaged host', async () => {
		const source = 'const value=42\r\nlocal message=`outer {`inner {value} {"}"}`} end`\r\nmath.abs(message)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		const position = doc.positionAt(source.indexOf('value}', source.indexOf('message')) + 2);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, position);
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.toString(), doc.uri.toString());
		assert.deepEqual([definitions![0]!.range.start.line, definitions![0]!.range.start.character], [0, 6]);
		const edits = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, position, 'changed');
		assert.equal(edits?.get(doc.uri).length, 2);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 11));
		assert.ok(hover?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n').includes('message: string'));
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('print(`{{42}}`)'); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		await replace('string.lower(`{false}`)'); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('Luau gotcha advice and suppression edits preserve valid source in the packaged host', async () => {
		const source = '-- 😀\r\nif 0 then print("taken") end\r\nfor k,v in ipairs({name=42}) do print(k,v) end';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 2 && items.some((item) => item.code === 'truthy-literal') && items.some((item) => item.code === 'ipairs-literal-hole'));
		for (const code of ['truthy-literal', 'ipairs-literal-hole']) {
			const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((item) => item.code === code); assert.ok(diagnostic);
			const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
			const suppression = actions?.find((action) => action.title === `Suppress '${code}' on this line`); assert.ok(suppression?.edit);
			assert.ok(await vscode.workspace.applyEdit(suppression.edit));
			await waitForDiagnostics(doc.uri, (items) => !items.some((item) => item.code === code));
			assert.ok(doc.getText().includes('-- slua-lsp:disable-next-line ' + code + '\r\n'));
		}
		assert.equal(vscode.languages.getDiagnostics(doc.uri).length, 0);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source.replace('if 0 then', 'if 0 == 0 then').replace('ipairs(', 'pairs('));
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('experimental class diagnostics repair without losing class navigation in the packaged host', async () => {
		const source = 'class Point\npublic x: number\npublic function new(x: number)\nreturn Point {x=x}\nend\nfunction value(self) return self.x end\nend\nlocal p=Point.new(42)\nprint(p:value())';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(7, 10));
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.toString(), doc.uri.toString());
		assert.deepEqual(definitions![0]!.range.start, new vscode.Position(0, 6));
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		for (const invalid of ['class Point\npublic x\npublic x\nend', 'class Point\npublic __index\nend', 'class Point\npublic x', 'class Point\nfunction value(self: Point) end\nend', 'class Point\nprint(42)\nend']) {
			await replace(invalid); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
			await replace(source); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		}
		const repaired = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(7, 10));
		assert.equal(repaired?.length, 1); assert.deepEqual(repaired![0]!.range.start, new vscode.Position(0, 6));
		await replace('class Box\nfunction new() return 42 end\nend\nlocal result=Box.new()\nmath.abs(result)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(4, 11));
		assert.ok(hover?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n').includes('result: number'));
		await replace('class Box\nfunction new() return "value" end\nend\nmath.abs(Box.new())');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
	});
	await test('class method body calls, field assignments, returns and directives recover in the packaged host', async () => {
		const valid = 'class Box\npublic x: number\nfunction value(self): number\nreturn self.x\nend\nend\nassert(Box {x=42}:value()==42)';
		const doc = await document(valid);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		for (const [body, code] of [
			['math.abs("wrong")', 'call-argument-type-mismatch'],
			['math.abs()', 'call-argument-count-mismatch'],
			['self.x="wrong"', 'assignment-type-mismatch'],
			['return "wrong"', 'declared-return-type-mismatch']
		]) {
			await replace(valid.replace('return self.x', body + '\nreturn self.x'));
			await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === code));
			await replace(valid); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		}
		await replace(valid.replace('return self.x', '-- slua-lsp:disable-next-line assignment-type-mismatch\nself.x="wrong"\nreturn self.x'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace('class Box\nfunction value(): () local function nested(): () math.abs("wrong") end\nnested()\nend\nend');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		await replace(valid); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(6, 9));
		assert.equal(definitions?.length, 1); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(0, 6));
	});
	await test('class constructors share signatures, argument checks, default field validation and recovery', async () => {
		const valid = 'class Box\npublic x: number\nfunction __init(self, x: number)\nself.x=x\nend\nend\nlocal item=Box(42)\nprint(item.x)';
		const doc = await document(valid);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(6, 15));
		assert.deepEqual(signature?.signatures[0]?.parameters.map((item) => item.label), ['arg1: number']);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace(valid.replace('Box(42)', 'Box("wrong")'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		await replace(valid.replace('Box(42)', 'Box()'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-count-mismatch');
		await replace(valid.replace('Box(42)', 'Box(42,43)'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		for (const initializer of ['{}', '{x="wrong"}']) {
			await replace('class Box\npublic x: number\nend\nlocal item=Box '+initializer+'\nprint(item.x)');
			await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		}
		await replace('class Box\npublic x: number?\nend\nlocal item=Box {}\nprint(item.x)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid.replace('__init(self, x: number)', '__init(self, x: number): ()'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'class-constructor-return-annotation');
		await replace(valid); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('constructor initialization warnings share field, instance, shadow and edit recovery behavior', async () => {
		const valid = 'class Box\npublic x: number\nfunction __init(self)\nself.x=42\nprint(self.x)\nend\nend\nBox()';
		const doc = await document(valid);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid.replace('self.x=42', 'print(self.x)\nself.x=42'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'class-uninitialized-access');
		const field = vscode.languages.getDiagnostics(doc.uri);
		assert.equal(field[0]!.range.start.line, 3); assert.match(field[0]!.message, /field 'x'/);
		await replace(valid.replace('self.x=42', 'print(self)\nself.x=42'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'class-uninitialized-access' && items[0]!.message.includes('Cannot use self'));
		const instance = vscode.languages.getDiagnostics(doc.uri);
		assert.equal(instance[0]!.severity, vscode.DiagnosticSeverity.Warning);
		await replace(valid.replace('self.x=42', 'do local self={x=1} print(self.x) end\nself.x=42'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid.replace('self.x=42', '-- slua-lsp:disable-next-line class-uninitialized-access\nprint(self.x)\nself.x=42'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(7, 1));
		assert.equal(definitions?.length, 1); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(0, 6));
	});
	await test('class member visibility, method signatures, source navigation and readonly recovery use the packaged server', async () => {
		const valid = 'class Box\npublic x: number\nfunction increment(self, amount: number): number\nself.x+=amount\nreturn self.x\nend\nfunction twice(value: number): number return value*2 end\nend\nlocal item=Box {x=1}\nprint(item:increment(2))';
		const doc = await document(valid);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(9, 21));
		assert.deepEqual(signature?.signatures[0]?.parameters.map((item) => item.label), ['arg1: number']);
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(9, 11));
		assert.ok(completion?.items.some((item) => item.label === 'increment'));
		assert.ok(!completion?.items.some((item) => item.label === 'x'));
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(9, 13));
		assert.equal(definitions?.length, 1); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(2, 9));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(9, 13));
		assert.match(hover?.flatMap((item) => item.contents).map((content) => typeof content === 'string' ? content : content.value).join('\n') ?? '', /number/);
		await replace(valid.replace('print(item:increment(2))', 'print(Box.increment)'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'class-unknown-member');
		await replace(valid.replace('print(item:increment(2))', 'Box.twice=function() return 1 end'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'class-readonly-member');
		await replace(valid.replace('increment(2)', 'increment("wrong")'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		await replace(valid.replace('print(item:increment(2))', 'local alias=item\nprint(alias:increment(2))'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('class binding immutability and type namespace collisions share readonly editor metadata and recovery', async () => {
		const valid = 'class Box end\nlocal item=Box {}\nprint(item)';
		const doc = await document(valid);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 12));
		assert.match(hover?.flatMap((item) => item.contents).map((content) => typeof content === 'string' ? content : content.value).join('\n') ?? '', /const Box/);
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
		const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
		assert.ok(tokens && legend); const readonly = legend.tokenModifiers.indexOf('readonly'); assert.ok(readonly >= 0);
		let line = 0, character = 0; let classReadonly = false;
		for (let i = 0; i < tokens.data.length; i += 5) { const delta = tokens.data[i]!; line += delta; character = delta ? tokens.data[i + 1]! : character + tokens.data[i + 1]!; if (line === 0 && character === 6) classReadonly = Boolean(tokens.data[i + 4]! & (1 << readonly)); }
		assert.equal(classReadonly, true);
		await replace(valid + '\nBox=nil');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'parse-error' && items[0]!.message.includes('constant'));
		await replace(valid + '\n-- slua-lsp:disable all\nBox=nil');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'parse-error' && items[0]!.range.start.line === 4);
		await replace(valid + '\ntype Box=number');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'duplicate-type-definition');
		await replace(valid + '\n-- slua-lsp:disable-next-line duplicate-type-definition\ntype Box=number');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid + '\ndo local Box=1 Box=2 print(Box) end');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(valid); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('class type references rename with value uses through unsaved-buffer recovery', async () => {
		const original = 'class Box end\ntype Alias=Box\nlocal item: Box=Box{}\nprint(item)';
		const doc = await document(original), position = new vscode.Position(1, 11);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, position);
		assert.equal(definitions?.length, 1); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(0, 6));
		const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, position); assert.equal(references?.length, 4);
		const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, position, 'Cell');
		assert.equal(edit?.entries().flatMap(([, edits]) => edits).length, 4); assert.ok(await vscode.workspace.applyEdit(edit!));
		assert.equal(doc.getText(), original.replace(/Box/g, 'Cell')); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace('class Cell\n'); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		await replace(original); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const recovered = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, position, 'Recovered');
		assert.equal(recovered?.entries().flatMap(([, edits]) => edits).length, 4);
	});
	await test('native class library preserves constructor members and recovers from invalid arguments', async () => {
		const prefix = 'class Box\npublic x: number\nfunction answer(): number return 42 end\nend\nlocal item=Box{x=1}\nlocal inspect=class.classof\nlocal Make=inspect(item)\n';
		const original = prefix + 'print(Make.answer())', doc = await document(original);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(7, 11), '.');
		assert.ok(completion?.items.some((item) => item.label === 'answer'));
		const definition = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(7, 12));
		assert.equal(definition?.[0]?.range.start.line, 2);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(5, 23));
		assert.match(hover?.flatMap((item) => item.contents).map((item) => typeof item === 'string' ? item : item.value).join('\n') ?? '', /Experimental class runtime flag/);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace(prefix + 'class.isinstance(item,{})');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		await replace(original); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const recovered = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(7, 12));
		assert.equal(recovered?.[0]?.range.start.line, 2);
	});
	await test('native class library distinguishes omitted arguments from explicit nil and respects a local shadow', async () => {
		const doc = await document('class.classof()\nclass.classof(nil)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-count-mismatch');
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(1, 14));
		assert.equal(signature?.signatures[0]?.parameters.length, 1);
		const source = 'local class={classof=function(value: number): number return value end}\nlocal result: number=class.classof(42)\nprint(result)';
		const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source); assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('class rename refuses an unused alias destination without touching the buffer', async () => {
		const original = 'class Box end\ntype Cell=number', doc = await document(original);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await assert.rejects(async () => await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(0, 6), 'Cell'), /No result/);
		assert.equal(doc.getText(), original);
		const typed = 'class Box end\nlocal item: Box=Box{}\nprint(item)';
		const replacement = new vscode.WorkspaceEdit(); replacement.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), typed); assert.ok(await vscode.workspace.applyEdit(replacement));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await assert.rejects(async () => await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(0, 6), 'typeof'), /No result/);
		assert.equal(doc.getText(), typed);
	});
	await test('escaped names, malformed escape recovery and decoded module navigation use the actual packaged server', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'string-literals-'));
		const main = path.join(folder, 'main.luau'), helper = path.join(folder, 'mod.luau');
		const source = 'local value=require("\\x6dod")\nmath["\\x61bs"]("bad")\nprint(value)';
		await fs.writeFile(main, source); await fs.writeFile(helper, 'return 42');
		const doc = await vscode.workspace.openTextDocument(main); await vscode.window.showTextDocument(doc);
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]!.code === 'call-argument-type-mismatch');
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 24));
		assert.equal(definitions?.length, 1); assert.equal(definitions![0]!.uri.fsPath, helper);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('print("\\xGG")'); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		await replace('math["\\097bs"](42)'); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		assert.equal(await fs.readFile(main, 'utf8'), source);
	});
	await test('module exports supply completion, hover and argument diagnostics in the actual packaged host', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-project-types-'));
		await fs.writeFile(path.join(folder, 'api.luau'), 'return {count = 42, double = function(value: number): number return value * 2 end}');
		const source = path.join(folder, 'main.luau'); await fs.writeFile(source, 'local api = require("api")\nlocal value: string = api.count\napi.double("wrong")\nprint(value)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-type-mismatch'));
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => item.code).sort(), ['assignment-type-mismatch', 'call-argument-type-mismatch']);
		const members = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(1, 26), '.');
		assert.ok(members?.items.some((item) => item.label === 'double'));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 27));
		assert.ok(hover?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n').includes('number'));
	});
	await test('incrementally built module fields and methods are typed in the packaged host', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-project-constructed-'));
		await fs.writeFile(path.join(folder, 'api.luau'), 'local M = {}\nlocal alias = M\nalias.count = 42\nfunction M.double(value: number): number return value * 2 end\nfunction M:message(value: string): string return value end\nreturn M');
		const source = path.join(folder, 'main.luau'); await fs.writeFile(source, 'local api = require("api")\nlocal value: string = api.count\napi.double("wrong")\napi:message(1)\nprint(value)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		await waitForDiagnostics(doc.uri, (items) => items.length === 3, 'constructed module diagnostics');
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => item.code).sort(), ['assignment-type-mismatch', 'call-argument-type-mismatch', 'call-argument-type-mismatch']);
		const members = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(1, 26), '.');
		assert.ok(members?.items.some((item) => item.label === 'double'));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 27));
		assert.ok(hover?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n').includes('number'));
		const signatures = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(3, 13), '(');
		assert.ok(signatures?.signatures[0]!.label.includes('string')); assert.ok(!signatures?.signatures[0]!.label.includes('unknown'));
	});
	await test('saved imported errors and repairs update dependency diagnostics without editing the importer', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-project-watch-'));
		const target = path.join(folder, 'api.luau'); await fs.writeFile(target, 'return 42');
		const source = path.join(folder, 'main.luau'); await fs.writeFile(source, 'local value: number = require("api")\nprint(value)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 8));
		await fs.writeFile(target, 'const count = 1\ncount = 2\nreturn count');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'module-dependency'), 'closed import edit');
		const dependency = vscode.languages.getDiagnostics(doc.uri).find((item) => item.code === 'module-dependency')!;
		assert.equal(dependency.relatedInformation?.[0]!.location.uri.fsPath, target);
		await fs.writeFile(target, 'return 42');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0, 'closed import repair');
	});
	await test('source require aliases reload after config edits and never treat a local require function as an include', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-aliases-'));
		await fs.mkdir(path.join(folder, 'one')); await fs.mkdir(path.join(folder, 'two'));
		await fs.writeFile(path.join(folder, 'one/helper.luau'), 'return 1'); await fs.writeFile(path.join(folder, 'two/helper.luau'), 'return 2');
		const config = path.join(folder, '.luaurc'); await fs.writeFile(config, '{"aliases":{"lib":"one"}}');
		const source = path.join(folder, 'main.luau'); await fs.writeFile(source, 'local result = require("@lib/helper")\nprint(result)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		const definition = () => vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 25));
		assert.equal((await definition())?.[0]!.uri.fsPath, path.join(folder, 'one/helper.luau'));
		await fs.writeFile(config, '{"aliases":{"lib":"two"}}');
		assert.equal((await definition())?.[0]!.uri.fsPath, path.join(folder, 'two/helper.luau'));
		const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'local function require(value) return value end\nprint(require("missing"))');
		assert.ok(await vscode.workspace.applyEdit(edit));
		const local = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(1, 8));
		assert.equal(local?.[0]!.uri.fsPath, source); assert.equal(local?.[0]!.range.start.line, 0);
	});
	await test('JSONC alias chains navigate and recover from saved configuration cycles', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-jsonc-'));
		await fs.mkdir(path.join(folder, 'library')); const target = path.join(folder, 'library/value.luau'); await fs.writeFile(target, 'return 42');
		const config = path.join(folder, '.luaurc'); const jsonc = '{// comment\n"aliases":{"root":"./library","pkg":"@ROOT",},}';
		await fs.writeFile(config, jsonc);
		const source = path.join(folder, 'main.luau'); await fs.writeFile(source, 'local value: number = require("@Pkg/value")\nprint(value)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		const definition = () => vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 33));
		assert.equal((await definition())?.[0]!.uri.fsPath, target);
		await fs.writeFile(config, '{"aliases":{"pkg":"@other","other":"@pkg"}}');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'module-resolution'), 'saved alias cycle');
		await fs.writeFile(config, jsonc);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0, 'saved alias repair');
		assert.equal((await definition())?.[0]!.uri.fsPath, target);
	});
	await test('malformed Unicode alias targets refuse navigation and recover to an exact supplementary path', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
		const folder = await fs.mkdtemp(path.join(root, 'source-unicode-alias-'));
		await fs.mkdir(path.join(folder, '�')); await fs.writeFile(path.join(folder, '�/value.luau'), 'return "wrong target"');
		await fs.mkdir(path.join(folder, '😀')); const target = path.join(folder, '😀/value.luau'); await fs.writeFile(target, 'return 42');
		const config = path.join(folder, '.luaurc'); await fs.writeFile(config, '{"aliases":{"lib":"\\ud800"}}');
		const source = path.join(folder, 'main.luau'); await fs.writeFile(source, 'local value: number = require("@lib/value")\nprint(value)');
		const doc = await vscode.workspace.openTextDocument(source); await vscode.window.showTextDocument(doc);
		const definition = () => vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 34));
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'module-resolution' && item.message.includes('Unicode')), 'invalid Unicode alias target');
		assert.equal((await definition())?.length ?? 0, 0);
		await fs.writeFile(config, '{"aliases":{"lib":"\\ud83d\\ude00"}}');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0, 'supplementary alias repair');
		assert.equal((await definition())?.[0]!.uri.fsPath, target);
	});
	if (process.env.SLUA_TEST_CACHE_FAULT) await test('unreadable optional cache falls back at startup without changing the fault', async () => {
		const fault = process.env.SLUA_TEST_CACHE_FAULT;
		const faultPath = process.env.SLUA_TEST_CACHE_FAULT_PATH;
		assert.ok(faultPath);
		const active = await vscode.commands.executeCommand<string>('slua.showActiveDefinitions');
		assert.equal(active, path.join(extension.extensionPath, 'third_party/lsl-definitions/lsl_definitions.yaml'));
		const info = await fs.stat(faultPath);
		if (fault === 'metadata-directory') assert.ok(info.isDirectory());
		else assert.equal(info.mode & 0o777, 0, 'Startup must not modify cache permissions');
		const doc = await document('ll.Say(0, "bundled fallback")');
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 4));
		assert.ok(hover?.length, 'Actual bundled server remains functional');
		// Repair only this runner-created profile; the later HTTP refresh test must
		// then activate a cache and survive offline failure in the same host.
		if (fault === 'metadata-directory') await fs.rmdir(faultPath);
		else await fs.chmod(faultPath, 0o600);
	});
	await test('standard-library optional arguments, numeric buffers and typed variadics', async () => {
		const doc = await document('local b = buffer.create(8)\nbuffer.writeu32(b, 0, 42)\nprint(string.sub("abc", 2), string.char(), math.random(), table.pack(), utf8.len("a"), buffer.readu32(b, 0))\nmissingSentinel()');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		assert.ok(vscode.languages.getDiagnostics(doc.uri).every((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		const bad = await document('string.char(65, false)\nlocal n: number = tonumber("invalid")\nprint(n)');
		await waitForDiagnostics(bad.uri, (items) => items.length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(bad.uri).map((item) => item.code).sort(), ['assignment-type-mismatch', 'call-argument-type-mismatch']);
		const signatureDoc = await document('string.char(65, 66)');
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', signatureDoc.uri, new vscode.Position(0, 15));
		assert.ok(signature?.signatures[0]?.label.includes('...: number'));
	});
	await test('SLua boolean profiles and detected callback hover, completion and inlays', async () => {
		const source = [
			'local active: boolean = ll.GetStatus(1)',
			'local legacy: number = llcompat.GetStatus(1)',
			'll.SetStatus(1, true)',
			'print(active, legacy)',
			'LLEvents:on("touch_start", function(items)',
			' local item = items[1]',
			' local same = item:getGroup()',
			' local damage = item:getDamage()',
			' print(same, damage)',
			'end)',
			'missingSentinel()'
		].join('\n');
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		assert.ok(vscode.languages.getDiagnostics(doc.uri).every((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		const position = new vscode.Position(6, source.split('\n')[6]!.indexOf('getGroup') + 2);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
		assert.ok(hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('): boolean'))));
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
		assert.ok(completion?.items.some((item) => item.label === 'getGroup' && item.detail?.includes('boolean')));
		const inlays = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, new vscode.Range(0, 0, 10, 17));
		assert.ok(inlays?.some((hint) => hint.position.line === 6 && (typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join('')).includes('boolean')));
		const bad = await document('LLEvents:on("touch_start", function(items)\n local item = items[1]\n local wrong: uuid = item:getGroup()\n item.valid = false\n print(wrong)\nend)');
		await waitForDiagnostics(bad.uri, (items) => items.some((item) => item.code === 'readonly-write') && items.some((item) => item.code === 'assignment-type-mismatch'));
	});
	await test('typed array keys and element writes reach the editor without invented detected hover', async () => {
		const doc = await document('local values: {number} = {1}\nvalues[false] = 2\nvalues[1] = "bad"\nprint(values)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => item.code), ['array-index-type-mismatch', 'assignment-type-mismatch']);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri)[0]?.range, new vscode.Range(1, 7, 1, 12));
		const invalid = await document('LLEvents:on("touch_start", function(items)\n local item = items[false]\n print(item:getGroup())\nend)');
		await waitForDiagnostics(invalid.uri, (items) => items.some((item) => item.code === 'array-index-type-mismatch'));
		const position = new vscode.Position(2, 16);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', invalid.uri, position);
		assert.ok(!hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('): boolean'))));
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', invalid.uri, position);
		assert.ok(!completion?.items.some((item) => item.label === 'getGroup'));
	});
	await test('nullable guards share diagnostics, completion, hover and inlays in the packaged editor', async () => {
		const source = 'local index = ll.SubStringIndex("hello", "e")\nif index then\n local inside = index\n print(math.abs(inside))\nend\nprint(math.abs(index))\nlocal function inspect(item: DetectedEvent?)\n if not item then return end\n local detected = item\n print(detected:getGroup())\nend\nprint(inspect)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]?.code === 'call-argument-type-mismatch');
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => [item.code, item.range.start.line]), [['call-argument-type-mismatch', 5]]);
		const position = new vscode.Position(9, source.split('\n')[9]!.indexOf('getGroup') + 2);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
		assert.ok(hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('): boolean'))));
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
		assert.ok(completion?.items.some((item) => item.label === 'getGroup'));
		const inlays = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, new vscode.Range(0, 0, 11, 14));
		assert.ok(inlays?.some((hint) => hint.position.line === 2 && (typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join('')).includes('number')));
		assert.ok(inlays?.some((hint) => hint.position.line === 8 && (typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join('')).includes('DetectedEvent')));
	});
	await test('function return contracts reach caller diagnostics and native object editor features', async () => {
		const source = 'local function requireItem(item: DetectedEvent?)\n assert(item)\n return item\nend\nlocal function maybe(flag: boolean)\n if flag then return 1 end\nend\nlocal result = maybe(false)\nmath.abs(result)\nlocal function inspect(item: DetectedEvent)\n local detected = requireItem(item)\n print(detected:getGroup())\nend\nprint(inspect)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 2 && items.some((item) => item.code === 'missing-return'));
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => [item.code, item.range.start.line]), [['missing-return', 4], ['call-argument-type-mismatch', 8]]);
		const position = new vscode.Position(11, source.split('\n')[11]!.indexOf('getGroup') + 2);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
		assert.ok(hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('): boolean'))));
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
		assert.ok(completion?.items.some((item) => item.label === 'getGroup'));
		const inlays = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, new vscode.Range(0, 0, 13, 14));
		assert.ok(inlays?.some((hint) => hint.position.line === 10 && (typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join('')).includes('DetectedEvent')));
	});
	await test('compatibility declarations and shadowed ordinary API names use lexical diagnostics', async () => {
		const source = 'llcompat.SetTimerEvent(1)\nllcompat.ResetTime()\nlocal api = ll\napi.ResetTime()\napi["SetTimerEvent"](1)\nlocal ll = {}\nll.ResetTime()';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => [item.code, item.range.start.line]), [['removed-ll-api', 3], ['legacy-timer-api', 4]]);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 12));
		assert.ok(hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('ResetTime'))));
		const completionDoc = await document('llcompat.SetTime');
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', completionDoc.uri, new vscode.Position(0, 16));
		assert.ok(completion?.items.some((item) => item.label === 'SetTimerEvent'));
	});
	await test('public definitions hide private entries and removed events while supporting global constants', async () => {
		const source = 'print(ALL_SIDES)\nfunction timer() end\nLLEvents:on("timer", timer)\nprint(ll.TRUE)\nLLEvents:on("state_exit", function() end)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => item.code).sort(), ['removed-ll-constant', 'unknown-event']);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 9));
		assert.ok(hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('ALL_SIDES: number'))));
		const members = await document('ll.Clear');
		const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', members.uri, new vscode.Position(0, 8));
		assert.ok(completions?.items.some((item) => item.label === 'ClearCameraParams'));
		assert.ok(completions?.items.every((item) => item.label !== 'ClearExperience'));
	});
	await test('builtin completion', async () => {
		const doc = await document('ll.Sa');
		const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 5));
		assert.ok(items?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'Say'));
	});
	await test('builtin hover', async () => {
		const doc = await document('ll.Say(0, "hello")');
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 4));
		assert.ok(hover?.length && hover[0]!.contents.length);
	});
	await test('ordinary source hover shows local types, parameter refinement and bare functions', async () => {
		const source = 'local count = 1\nprint(count)\nlocal function use(value: number?)\n if value then print(value) end\nend\nprint(use)';
		const doc = await document(source);
		async function hoverAt(line: number, character: number) {
			const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, character));
			return result?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n') ?? '';
		}
		assert.ok((await hoverAt(1, 8)).includes('count: number'));
		assert.ok((await hoverAt(1, 2)).includes('print'));
		assert.ok((await hoverAt(3, source.split('\n')[3]!.lastIndexOf('value') + 1)).includes('value: number'));
	});
	await test('source outline includes variables, assigned functions and nested declarations', async () => {
		const doc = await document('local count = 1\nlocal handler = function(value: number)\n local result = value * 2\n return result\nend\nprint(count, handler)');
		const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
		assert.deepEqual(result?.map((item) => [item.name, item.kind]), [['count', vscode.SymbolKind.Variable], ['handler', vscode.SymbolKind.Function]]);
		assert.deepEqual(result?.[1]?.children.map((item) => item.name), ['result']);
	});
	await test('source hover does not identify a string, field name or type alias as a local value', async () => {
		const source = 'local value = 1\nlocal object = {value = value}\nprint("value", object.value)\ntype value = number';
		const doc = await document(source);
		for (const position of [new vscode.Position(1, 17), new vscode.Position(2, 8), new vscode.Position(3, 7)]) {
			const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
			assert.ok(!result?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : content.value).includes('value: number'))));
		}
		const field = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 23));
		assert.ok(field?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n').includes('object.value: number'));
	});
	await test('definition references and rename', async () => {
		const doc = await document('local count = 1\nprint(count)\n');
		const position = new vscode.Position(1, 8);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, position);
		assert.ok(definitions?.length);
		const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, position);
		assert.ok(references?.length >= 2);
		const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, position, 'total');
		assert.ok(edit && edit.entries().flatMap(([, edits]) => edits).length >= 2);
	});
	await test('lexical rename applies without changing table fields or shadowed locals', async () => {
		const source = 'local value = 1\nlocal object = {value = value}\nwhile false do local value = 2; print(value); break end\nprint(object.value, value)';
		const doc = await document(source);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 7));
		assert.equal(definitions?.[0]?.range.start.line, 0);
		const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(0, 7), 'total');
		assert.equal(edit?.entries().flatMap(([, edits]) => edits).length, 3);
		assert.equal(await vscode.workspace.applyEdit(edit!), true);
		assert.equal(doc.getText(), source.replace('local value = 1', 'local total = 1').replace('{value = value}', '{value = total}').replace('object.value, value', 'object.value, total'));
		const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, new vscode.Position(0, 7));
		assert.equal(refs?.length, 3);
	});
	await test('assignment targets and computed keys retain UTF-16 navigation ranges', async () => {
		const doc = await document('local key = "x"\nlocal object = {[key] = 1, key = 2}\nobject[key] = object[key] + 1\nprint("😀", key)');
		const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(2, 1));
		assert.equal(defs?.[0]?.range.start.line, 1);
		const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, new vscode.Position(0, 7));
		assert.equal(refs?.length, 5);
		assert.ok(refs?.some((ref) => ref.range.start.line === 3 && ref.range.start.character === 12));
	});
	await test('rename refuses capture of another binding without modifying the document', async () => {
		const source = 'local source = 1\ndo local target = 2; print(source, target) end';
		const doc = await document(source);
		// VS Code turns the server's refused/null edit into this command-level rejection.
		await assert.rejects(async () => await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(0, 7), 'target'), /No result\./);
		assert.equal(doc.getText(), source);
	});
	await test('native JSON options distinguish omission from nil and retain optional signature help', async () => {
		const source = 'local encode = lljson.encode\nlocal result = encode(42, nil)\nprint(result)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-type-mismatch'));
		const help = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(1, source.split('\n')[1]!.indexOf('nil')), ',');
		assert.ok(help?.signatures.some((item) => item.label.includes('arg2?: table')));
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace(source.replace('42, nil', '42, {}'));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(source.replace('42, nil', '42, {}, 1'));
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-count-mismatch'));
		await replace('local result = lljson.decode("42", function(key, value) print(key); return value end)\nprint(result)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('native conversions accept buffers and preserve nullable results with edit recovery', async () => {
		const source = 'local convert = tovector\nlocal value: vector = convert("invalid")\nprint(value)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-type-mismatch'));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 18));
		assert.ok(hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n').includes('nil'));
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('local value = tovector(nil)\nif value ~= nil then local checked: vector = value; print(checked) end');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace('tovector()');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-count-mismatch'));
		await replace('local value: uuid = uuid.create(buffer.create(16))\nlocal converted = touuid(value)\nprint(value, converted)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('variable native string return packs keep captures and recover after scalar grouping', async () => {
		const source = 'local first, last, capture = string.find("a12", "(%d+)")\nprint(first, last, capture)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, source.split('\n')[0]!.indexOf('find') + 2));
		assert.ok(hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n').includes('...unknown'));
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('local first, last = (string.find("abc", "a"))\nprint(first, last)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-return-count-mismatch'));
		await replace('local a, b, c, nextByte = string.unpack("BBB", "abc")\nprint(a, b, c, nextByte)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('stdlib open results preserve status, numeric guards, captures and edit recovery', async () => {
		const source = 'local ok,a,b=pcall(function() return 1,"two" end)\nprint(ok,a,b)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, source.indexOf('pcall') + 2));
		assert.ok(hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n').includes('...unknown'));
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('local ok:string,a,b=pcall(function() return 1,2 end)\nprint(ok,a,b)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-type-mismatch'));
		await replace('local a,b=string.byte("ab",1,2)\nif a~=nil then local n:number=a; print(n) end\nif b~=nil then local n:number=b; print(n) end');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace('local a,b=(string.byte("ab",1,2))\nprint(a,b)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-return-count-mismatch'));
		await replace('local a:number,b:string=string.match("abc","()(%a+)")\nprint(a,b)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('finite native result bounds and debug overloads recover in the packaged editor', async () => {
		const doc = await document('local n=utf8.len("abc")\nprint(n)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const replace = async (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); };
		await replace('local a,b,c=utf8.len("abc")\nprint(a,b,c)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-return-count-mismatch'));
		await replace('local co=coroutine.create(function() end)\nlocal source=debug.info(co,0,"s")\nprint(source)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(1, 29));
		assert.strictEqual(signature?.signatures[0]?.parameters.length, 3);
		await replace('debug.info(true,"s")');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-type-mismatch'));
		await replace('local text=debug.traceback()\nprint(text)');
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('function attributes preserve same-line functions aliases navigation and invalid-edit recovery', async () => {
		const source = '@[native,checked] local function double(value: number): number return value*2 end\nlocal alias=double\nassert(alias(21)==42)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const position = new vscode.Position(1, 14);
		const definition = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, position);
		assert.equal(definition?.length, 1); assert.equal(definition![0]!.range.start.line, 0);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 9));
		assert.ok(hover?.some((h) => h.contents.some((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '').includes('number'))));
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(2, 13), '(');
		assert.equal(signature?.signatures[0]?.parameters.length, 1);
		const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, position); assert.equal(refs?.length, 2);
		const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, position, 'twice');
		assert.equal(rename?.get(doc.uri).length, 2); assert.ok(await vscode.workspace.applyEdit(rename!)); assert.ok(doc.getText().includes('local alias=twice'));
		async function replace(text: string) { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); }
		await replace(source.replace('alias(21)', 'alias("bad")')); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-type-mismatch'));
		await replace(source.replace('@[native,checked]', '@unknown')); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		await replace(source); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		assert.deepEqual(await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, position), definition);
	});
	await test('multiline deprecated argument records parse and malformed literal metadata repairs', async () => {
		const source = '@[deprecated{\nuse="newApi",\nreason="old API"\n}]\nlocal function old(): number return 42 end\nassert(old()==42)';
		const doc = await document(source); await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]?.code === 'deprecated-function');
		assert.ok(vscode.languages.getDiagnostics(doc.uri)[0]?.tags?.includes(vscode.DiagnosticTag.Deprecated));
		async function replace(text: string) { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); }
		await replace(source.replace('reason="old API"', 'reason=42')); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		await replace(source); await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]?.code === 'deprecated-function');
	});
	await test('root global initialization and function writes preserve diagnostic edit recovery', async () => {
		const source = 'counter=0\nlocal function increment() counter+=1 return counter end\nprint(increment())';
		const doc = await document(source); await waitForDiagnostics(doc.uri, items => items.length === 0);
		async function replace(text: string) { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); }
		await replace('local function increment() counter=1 end\nprint(increment)');
		await waitForDiagnostics(doc.uri, items => items.length === 1 && items[0]?.code === 'accidental-global-write');
		await replace('do counter=0 end\nprint(counter)'); await waitForDiagnostics(doc.uri, items => items.length === 0);
		await replace('do local counter=0 counter=1 print(counter) end\nprint(counter)');
		await waitForDiagnostics(doc.uri, items => items.length === 1 && items[0]?.code === 'undeclared-name' && items[0]?.range.start.line === 1);
		await replace(source); await waitForDiagnostics(doc.uri, items => items.length === 0);
	});
	await test('deprecated source aliases share warning tags hover completion suppression and repair', async () => {
		const source = '@[deprecated{use="fresh",reason="old API"}]\nlocal function old(n: number): number if n==0 then return 42 end return old(n-1) end\nlocal alias=old\nprint(alias(2))\n';
		const doc = await document(source); await waitForDiagnostics(doc.uri, (items) => items.length === 2 && items.every((item) => item.code === 'deprecated-function'));
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => item.range.start.line), [2, 3]);
		assert.ok(vscode.languages.getDiagnostics(doc.uri).every((item) => item.tags?.includes(vscode.DiagnosticTag.Deprecated)));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(3, 8));
		assert.ok(hover?.some((h) => h.contents.some((c) => { const value = typeof c === 'string' ? c : 'value' in c ? c.value : ''; return value.includes('**Deprecated**') && value.includes('fresh'); })));
		const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(4, 0));
		assert.ok(completions?.items.find((item) => item.label === 'alias')?.tags?.includes(vscode.CompletionItemTag.Deprecated));
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(3, 6, 3, 11));
		const suppress = actions?.find((item) => item.title === 'Suppress \'deprecated-function\' on this line'); assert.ok(suppress?.edit); assert.ok(await vscode.workspace.applyEdit(suppress!.edit!));
		await waitForDiagnostics(doc.uri, (items) => items.length === 1 && items[0]?.range.start.line === 2);
		async function replace(text: string) { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); }
		await replace(source.slice(source.indexOf('\n') + 1)); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(source); await waitForDiagnostics(doc.uri, (items) => items.length === 2 && items.every((item) => item.code === 'deprecated-function'));
	});
	await test('attribute names share completion hover and semantic keyword presentation', async () => {
		const doc = await document('@[');
		const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 2));
		assert.deepEqual(completions!.items.map((item) => item.label).sort(), ['checked', 'deprecated', 'native']);
		const source = '@[native,checked] local function answer(): number return 42 end\nprint(answer())';
		const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source); assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 4));
		assert.ok(hover?.some((h) => h.contents.some((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '').includes('@native'))));
		const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri); assert.ok(legend && tokens);
		let line = 0, character = 0, found = false;
		for (let i = 0; i < tokens!.data.length; i += 5) { const delta = tokens!.data[i]!; line += delta; character = delta ? tokens!.data[i+1]! : character + tokens!.data[i+1]!; if (line === 0 && character === 2 && legend!.tokenTypes[tokens!.data[i+3]!] === 'keyword') found = true; }
		assert.ok(found);
	});
	await test('open class inheritance shares navigation rename typed members and malformed-header recovery', async () => {
		const source = 'open class Base\npublic x: number\nfunction get(self): number return self.x end\nend\nclass Child extends Base end\nlocal value=Child{x=42}\nassert(value:get()==42)\nvalue.x="wrong"';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-type-mismatch'));
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((item) => item.code), ['assignment-type-mismatch']);
		const target = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(6, 14));
		assert.equal(target?.length, 1); assert.equal(target![0]!.range.start.line, 2);
		const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(6, 13));
		assert.ok(completion?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'get'));
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(6, 17), '(');
		assert.equal(signature?.signatures[0]?.parameters.length, 0);
		const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, new vscode.Position(4, 21)); assert.equal(refs?.length, 2);
		const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(4, 21), 'Root');
		assert.equal(rename?.get(doc.uri).length, 2); assert.ok(await vscode.workspace.applyEdit(rename!));
		assert.ok(doc.getText().includes('extends Root'));
		async function replace(text: string) { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); }
		const repaired = source.replaceAll('Base', 'Root').replace('value.x="wrong"', 'value.x=43');
		await replace(repaired); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		await replace(repaired.replace('extends Root', 'extends')); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		await replace(repaired); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const recovered = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(6, 14)); assert.equal(recovered?.[0]?.range.start.line, 2);
	});
	await test('exported open class inheritance follows unsaved module changes and closed-base repair', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, folder = await fs.mkdtemp(path.join(root, 'class-inheritance-'));
		const base = path.join(folder, 'base.luau'), main = path.join(folder, 'main.luau');
		const original = 'export open class Base\npublic x: number\nfunction get(self): number return self.x end\nend';
		await fs.writeFile(base, original); await fs.writeFile(main, 'local api=require("base")\nclass Child extends api.Base end\nlocal value=Child{x=42}\nassert(value:get()==42)');
		const doc = await vscode.workspace.openTextDocument(main); await vscode.window.showTextDocument(doc);
		async function definition(line: number) { const result = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(3, 14)); assert.equal(result?.length, 1); assert.equal(result![0]!.uri.fsPath, base); assert.equal(result![0]!.range.start.line, line); }
		await definition(2); await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		const dependency = await vscode.workspace.openTextDocument(base); await vscode.window.showTextDocument(dependency);
		async function replace(text: string) { const edit = new vscode.WorkspaceEdit(); edit.replace(dependency.uri, new vscode.Range(dependency.positionAt(0), dependency.positionAt(dependency.getText().length)), text); assert.ok(await vscode.workspace.applyEdit(edit)); }
		await replace('-- unsaved\n' + original); await definition(3);
		await replace(original.replace('export open class', 'export class')); await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'class-closed-base'));
		await replace(original); await waitForDiagnostics(doc.uri, (items) => items.length === 0); await definition(2);
	});
	await test('value exports share readonly function binding, navigation and invalid-buffer recovery', async () => {
		const source = 'export function double(value: number): number return value*2 end\nprint(double(3))\ndo local double=2 print(double) end';
		const doc = await document(source), position = new vscode.Position(1, 8);
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, position);
		assert.equal(definitions?.length, 1); assert.deepEqual(definitions![0]!.range.start, new vscode.Position(0, 16));
		const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, position);
		assert.equal(references?.length, 2);
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
		assert.ok(hover?.some((item) => item.contents.some((content) => (typeof content === 'string' ? content : 'value' in content ? content.value : '').includes('const double'))));
		const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, position, 'twice');
		assert.equal(rename?.get(doc.uri).length, 2);
		const invalid = new vscode.WorkspaceEdit(); invalid.insert(doc.uri, doc.positionAt(doc.getText().length), '\nreturn 1'); assert.ok(await vscode.workspace.applyEdit(invalid));
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		const repair = new vscode.WorkspaceEdit(); repair.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source); assert.ok(await vscode.workspace.applyEdit(repair));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('value-export module members retain origins through unsaved edits and reject frozen writes', async () => {
		const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath, folder = await fs.mkdtemp(path.join(root, 'value-exports-'));
		const module = path.join(folder, 'api.luau'), main = path.join(folder, 'main.luau');
		const api = 'export local count=1\nexport function double(value: number): number return value*2 end';
		await fs.writeFile(module, api); await fs.writeFile(main, 'local api=require("api")\nprint(api.count)\napi.count=2');
		const doc = await vscode.workspace.openTextDocument(main); await vscode.window.showTextDocument(doc);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'readonly-write'));
		const targets = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(1, 11));
		assert.equal(targets?.length, 1); assert.equal(targets![0]!.uri.fsPath, module); assert.deepEqual(targets![0]!.range.start, new vscode.Position(0, 13));
		const imported = await vscode.workspace.openTextDocument(module);
		const edit = new vscode.WorkspaceEdit(); edit.replace(imported.uri, new vscode.Range(imported.positionAt(0), imported.positionAt(imported.getText().length)), '-- unsaved\n' + api); assert.ok(await vscode.workspace.applyEdit(edit));
		const updated = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(1, 11));
		assert.equal(updated?.length, 1); assert.deepEqual(updated![0]!.range.start, new vscode.Position(1, 13));
		assert.equal(await fs.readFile(module, 'utf8'), api);
	});
	await test('parse diagnostics reach the editor', async () => {
		const doc = await document('local =\n');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.severity === vscode.DiagnosticSeverity.Error));
	});
	await test('colon method values are rejected and recover after a valid call edit', async () => {
		const source = 'local object = {run = function(self) return self end}\nlocal result = object:run\nprint(result)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(1, 17));
		assert.equal(definitions?.[0]?.range.start.line, 0);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source.replace('object:run\n', 'object:run()\n'));
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
	});
	await test('native integer parameters accept normal Luau numbers', async () => {
		const doc = await document('ll.Say(0, "hello")\nlocal =\n');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error'));
		assert.ok(!vscode.languages.getDiagnostics(doc.uri).some((item) => item.code === 'call-argument-type-mismatch'));
	});
	await test('native timer signature and callback diagnostics reach the packaged editor', async () => {
		const text = 'LLTimers:every(1, function(time: number, interval: number) print(time, interval) end)\nLLTimers:once(0, function(time: number, interval: number) print(time, interval) end)';
		const doc = await document(text);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'callback-param-type-mismatch'));
		assert.equal(vscode.languages.getDiagnostics(doc.uri).filter((item) => item.code === 'callback-param-type-mismatch').length, 1);
		assert.ok(!vscode.languages.getDiagnostics(doc.uri).some((item) => item.code === 'undeclared-name' || item.code === 'call-argument-type-mismatch'));
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(0, 16), ',');
		assert.ok(signature?.signatures.some((item) => item.label.includes('(number, number)')));
	});
	await test('builtin aliases and explicit self retain valid diagnostics with shadowed globals', async () => {
		const doc = await document([
			'local events, timers = LLEvents, LLTimers',
			'events.on(LLEvents, "listen", function(channel: number) end)',
			'timers.once(LLTimers, 0, function(time: number, interval: nil) end)',
			'local LLEvents, LLTimers, lljson = {}, {}, {}',
			'LLEvents:on("not-an-event"); LLTimers:custom(); lljson.encode()',
			'missingSentinel()'
		].join('\n'));
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		assert.ok(vscode.languages.getDiagnostics(doc.uri).every((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
	});
	await test('aliased call style, event and callback errors reach the packaged editor', async () => {
		const doc = await document([
			'local events, timers = LLEvents, LLTimers',
			'timers.once(0, function() end)',
			'events:on("state_exit", function() end)',
			'events.on(LLEvents, "listen", function(channel: string) end)',
			'timers:once(0, function(time: string) end)'
		].join('\n'));
		await waitForDiagnostics(doc.uri, (items) => items.filter((item) => item.code === 'callback-param-type-mismatch').length === 2);
		const diagnostics = vscode.languages.getDiagnostics(doc.uri);
		assert.equal(diagnostics.filter((item) => item.code === 'unknown-event').length, 1);
		const style = diagnostics.find((item) => item.code === 'use-colon-call');
		assert.ok(style);
		assert.deepEqual([style.range.start.line, style.range.start.character, style.range.end.character], [1, 7, 11]);
	});
	await test('annotated assignment type errors reach the packaged editor', async () => {
		const doc = await document('local value: number = "bad"\nprint(value)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'assignment-type-mismatch'));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((item) => item.code === 'assignment-type-mismatch');
		assert.equal(diagnostic?.range.start.line, 0);
		assert.equal(diagnostic?.range.start.character, 22);
	});
	await test('event callbacks may ignore arguments and use callable tables without false errors', async () => {
		const doc = await document('LLEvents:on("listen", function() return 3 end)\nlocal callback = setmetatable({}, { __call = function(self) print(self) end })\nLLEvents:once("listen", callback)\nmissingSentinel()');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		assert.ok(vscode.languages.getDiagnostics(doc.uri).every((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
	});
	await test('loop scopes and array literals retain valid types in the packaged editor', async () => {
		const doc = await document('local value = "outer"\nfor value = 1, 2 do\n while true do\n local value = "inner"\n print(string.len(value))\n break\n end\n print(math.abs(value))\nend\nlocal values: {number}? = {1, 2}\nprint(value, values)\nmissingSentinel()');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		assert.ok(vscode.languages.getDiagnostics(doc.uri).every((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
	});
	await test('loop assignment and array element errors reach the packaged editor', async () => {
		const doc = await document('while true do\n local value: number = function() end\n print(value)\n break\nend\nlocal values: {{number}} = {{1}, {"bad"}}\nprint(values)');
		await waitForDiagnostics(doc.uri, (items) => items.filter((item) => item.code === 'assignment-type-mismatch').length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).filter((item) => item.code === 'assignment-type-mismatch').map((item) => item.range.start.line), [1, 5]);
	});
	await test('code action edits repair an aliased module call in the actual editor', async () => {
		const doc = await document('local json = lljson\njson:encode(3)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'use-dot-call'));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((item) => item.code === 'use-dot-call')!;
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
		const fix = actions?.find((action) => action.isPreferred && action.edit);
		assert.ok(fix?.edit);
		assert.equal(await vscode.workspace.applyEdit(fix.edit), true);
		assert.equal(doc.getText(), 'local json = lljson\njson.encode(3)');
		await waitForDiagnostics(doc.uri, (items) => !items.some((item) => item.code === 'use-dot-call'));
	});
	await test('suppression code actions preserve existing next-line directives', async () => {
		const doc = await document('-- slua-lsp:disable-next-line use-colon-call\nLLTimers.once(0, missingSentinel)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name'));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((item) => item.code === 'undeclared-name')!;
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
		const suppression = actions?.find((action) => action.title === 'Suppress \'undeclared-name\' on this line');
		assert.ok(suppression?.edit);
		assert.equal(await vscode.workspace.applyEdit(suppression.edit), true);
		assert.ok(doc.getText().startsWith('-- slua-lsp:disable-next-line use-colon-call, undeclared-name\n'));
		await waitForDiagnostics(doc.uri, (items) => !items.some((item) => item.code === 'undeclared-name'));
		assert.ok(!vscode.languages.getDiagnostics(doc.uri).some((item) => item.code === 'use-colon-call'));
	});
	await test('literal directive text cannot hide editor diagnostics', async () => {
		const doc = await document('local example = "-- slua-lsp:disable all"\nprint(example)\nmissingSentinel()');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
	});
	await test('readonly aliases and callback writes respect mutable local shadows', async () => {
		const doc = await document('local math = {pi = 1}\nmath.pi = 2\nlocal native = utf8\nnative.charpattern = "bad"\nlocal callback = function(item: {read x: number}) item.x = 2 end\nprint(callback)');
		await waitForDiagnostics(doc.uri, (items) => items.filter((item) => item.code === 'readonly-write').length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).filter((item) => item.code === 'readonly-write').map((item) => item.range.start.line), [3, 4]);
	});
	await test('native const bindings share completion, hover, symbols, rename and readonly tokens', async () => {
		const doc = await document('const count: number = 1\nprint(count)');
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 8));
		assert.ok(hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n').includes('const count: number'));
		const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(1, 8));
		assert.ok(completions?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'count' && item.kind === vscode.CompletionItemKind.Constant));
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
		assert.ok(symbols?.some((symbol) => symbol.name === 'count' && symbol.detail === 'const number'));
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
		const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
		assert.ok(tokens && legend); const readonly = legend.tokenModifiers.indexOf('readonly'); assert.ok(readonly >= 0);
		let line = 0; let character = 0; let marked = false;
		for (let i = 0; i < tokens.data.length; i += 5) {
			character = tokens.data[i] === 0 ? character + tokens.data[i + 1]! : tokens.data[i + 1]!; line += tokens.data[i]!;
			if (line === 1 && character === 6) marked = (tokens.data[i + 4]! & (1 << readonly)) !== 0;
		}
		assert.ok(marked, 'Const use has the readonly semantic modifier');
		const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, new vscode.Position(1, 8), 'total');
		assert.ok(rename && await vscode.workspace.applyEdit(rename)); assert.equal(doc.getText(), 'const total: number = 1\nprint(total)');
	});
	await test('const table mutation is valid while rebinding remains an unsuppressible parse error', async () => {
		const doc = await document('const values = {count = 1}\nvalues.count += 1\n-- slua-lsp:disable all\nvalues = {}');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'parse-error' && item.range.start.line === 3));
		assert.ok(vscode.languages.getDiagnostics(doc.uri).some((item) => item.message.includes('constant and may not be reassigned')));
		assert.ok(!vscode.languages.getDiagnostics(doc.uri).some((item) => item.range.start.line === 1));
	});
	await test('semantic tokens stay stable on repeat requests and refresh after editing the same document', async () => {
		const doc = await document('local count = 1\nprint(count)');
		const original = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
		const repeated = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
		assert.ok(original?.data.length);
		assert.deepEqual(repeated?.data, original.data);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(0, 0, 1, 12), 'print("replacement")\nmissingSentinel()');
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'undeclared-name' && item.message.includes('missingSentinel')));
		const changed = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
		assert.notDeepEqual(changed?.data, original.data);
	});
	await test('semantic tokens', async () => {
		const doc = await document('local count = 1\nprint(count)\n');
		const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
		assert.ok(tokens && tokens.data.length > 0);
	});
	await test('current integer library completion hover and variadic signature help', async () => {
		const doc = await document('integer.fr\ninteger.band(integer.maxsigned, integer.minsigned, integer.maxsigned)');
		const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 10));
		assert.ok(items?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'fromstring'));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 10));
		const hoverText = hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n');
		assert.ok(hoverText?.includes('...: integer'), `Actual hover text: ${hoverText}`);
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(1, 64), ',');
		assert.ok(signature?.signatures.some((item) => item.label.includes('...: integer')));
	});
	await test('historical integer and number constructors report useful diagnostics', async () => {
		const doc = await document('integer(1)\nnumber("1")\ninteger.band(integer.maxsigned, integer.maxsigned, 1)');
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-non-callable') && items.some((item) => item.code === 'undeclared-name') && items.some((item) => item.code === 'call-argument-type-mismatch'));
		const diagnostics = vscode.languages.getDiagnostics(doc.uri);
		assert.ok(diagnostics.find((item) => item.code === 'call-non-callable')?.message.includes('integer.create'));
		assert.equal(diagnostics.find((item) => item.code === 'call-argument-type-mismatch')?.range.start.line, 2);
	});
	await test('exact integer literals share hover, completion and diagnostic repair in the packaged editor', async () => {
		const source = 'local value=9007199254740993i\ninteger.add(value, -42i)\nmath.abs(value)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'call-argument-type-mismatch' && item.range.start.line === 2));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 14));
		assert.ok(hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n').includes('value: integer'));
		const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(2, 9));
		assert.ok(items?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'value' && item.detail?.includes('integer')));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(2, 0, 2, 15), 'math.abs(integer.tonumber(value))');
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		assert.ok(doc.getText().includes('9007199254740993i'));
	});
	await test('native vector multiplication and rotation floor division recover in the packaged editor', async () => {
		const source = 'local product=vector(1,2,3)*vector(3,2,1)\nlocal rotated=rotation(0,0,0,1)//rotation(0,0,0,1)\nmath.abs(product)';
		const doc = await document(source);
		await waitForDiagnostics(doc.uri, (items) => items.some((item) => item.code === 'native-operator' && item.range.start.line === 1) && items.some((item) => item.code === 'call-argument-type-mismatch' && item.range.start.line === 2));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 10));
		assert.ok(hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n').includes('product: vector'));
		const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(2, 10));
		assert.ok(items?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'product' && item.detail?.includes('vector')));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(0, 0, 2, doc.lineAt(2).text.length), source.replace(')//rotation', ')/rotation').replace('math.abs(product)', 'math.abs(vector.dot(product, product))'));
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitForDiagnostics(doc.uri, (items) => items.length === 0);
		assert.ok(doc.getText().includes(')/rotation'));
	});
	await test('nested builder namespace and instance completion hover and signatures', async () => {
		const namespace = await document('llprim.ParamSetter.ne');
		const constructors = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', namespace.uri, new vscode.Position(0, 20));
		assert.ok(constructors?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'new'));
		const chained = await document('llprim.ParamSetter.new():size(vector.one):');
		const fluent = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', chained.uri, new vscode.Position(0, chained.lineAt(0).text.length), ':');
		assert.ok(fluent?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'color'));
		const doc = await document('local ParamSetter = llprim.ParamSetter\nlocal rules = ParamSetter.new():size(vector.one)\nrules:color(0, vector.one, 0.5)\nrules:col');
		const members = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 9));
		assert.ok(members?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'color'));
		const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 9));
		const hoverText = hover?.flatMap((item) => item.contents.map((part) => typeof part === 'string' ? part : part.value)).join('\n');
		assert.ok(hoverText?.includes('rules:color') && hoverText.includes('vector'));
		const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, new vscode.Position(2, 25), ',');
		assert.ok(signature?.signatures.some((item) => item.label.includes('vector')));
	});
	await test('builder argument and clear-sentinel diagnostics reach the packaged editor', async () => {
		const doc = await document('local rules = llprim.ParamSetter.new()\nrules:size("bad")\nrules:gltfNormal(0, "asset", "", vector.one, 0)\nrules:gltfNormal(0, "asset", "not-empty", vector.one, 0)');
		await waitForDiagnostics(doc.uri, (items) => items.filter((item) => item.code === 'call-argument-type-mismatch').length === 2);
		assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).filter((item) => item.code === 'call-argument-type-mismatch').map((item) => item.range.start.line), [1, 3]);
	});
	await test('explicit definitions survive a manual update request', async () => {
		const cfg = vscode.workspace.getConfiguration('slua');
		const original = await vscode.commands.executeCommand<string>('slua.showActiveDefinitions');
		assert.ok(original);
		await cfg.update('definitionsPath', original, vscode.ConfigurationTarget.Workspace);
		await vscode.commands.executeCommand('slua.updateDefinitions');
		assert.equal(await vscode.commands.executeCommand('slua.showActiveDefinitions'), original);
		await cfg.update('definitionsPath', '', vscode.ConfigurationTarget.Workspace);
	});
	await test('rejected custom definitions do not erase or misreport the active registry', async () => {
		const cfg = vscode.workspace.getConfiguration('slua');
		const previous = await vscode.commands.executeCommand<string>('slua.showActiveDefinitions');
		assert.ok(previous);
		// Pin and acknowledge a valid predecessor. A prior case clearing its
		// override may legitimately select a newly repaired cache asynchronously.
		await cfg.update('definitionsPath', previous, vscode.ConfigurationTarget.Workspace);
		await vscode.commands.executeCommand('slua.updateDefinitions');
		assert.equal(await vscode.commands.executeCommand('slua.showActiveDefinitions'), previous);
		try {
			await cfg.update('definitionsPath', path.join(extension.extensionPath, 'missing-custom-definitions.yaml'), vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('slua.updateDefinitions');
			assert.equal(await vscode.commands.executeCommand('slua.showActiveDefinitions'), previous);
			const doc = await document('ll.Say(0, "still working")');
			const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 4));
			assert.ok(hover?.length);
		} finally {
			await cfg.update('definitionsPath', previous, vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('slua.updateDefinitions');
			await cfg.update('definitionsPath', '', vscode.ConfigurationTarget.Workspace);
		}
	});
	await test('real HTTP refresh and offline failure retain the last good definitions', async () => {
		// A fresh body proves this invocation activated the download, rather than
		// silently retaining a cache from a previous launch after validation failed.
		const raw = await fs.readFile(path.join(extension.extensionPath, 'third_party/lsl-definitions/lsl_definitions.yaml'), 'utf8') + `\n# packaged refresh acceptance ${crypto.randomUUID()}\n`;
		const server = http.createServer((_request, response) => { response.setHeader('ETag', '"integration"'); response.end(raw); });
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address(); assert.ok(address && typeof address === 'object');
		const cfg = vscode.workspace.getConfiguration('slua');
		try {
			await cfg.update('definitions.updateUrl', `http://127.0.0.1:${address.port}/definitions.yaml`, vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('slua.updateDefinitions');
			const cached = await vscode.commands.executeCommand<string>('slua.showActiveDefinitions');
			assert.ok(cached && !cached.startsWith(extension.extensionPath));
			assert.equal(await fs.readFile(cached, 'utf8'), raw, 'This exact fresh download must be active before the offline step');
			await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
			await vscode.commands.executeCommand('slua.updateDefinitions');
			assert.equal(await vscode.commands.executeCommand('slua.showActiveDefinitions'), cached);
			assert.equal(await fs.readFile(cached, 'utf8'), raw);
		} finally { if (server.listening) server.close(); }
	});
	const failed = results.filter((r) => r.error);
	if (failed.length) throw new Error(`${failed.length} extension-host checks failed: ${failed.map((r) => `${r.name}: ${r.error}`).join('; ')}`);
}

async function waitForDiagnostics(uri: vscode.Uri, predicate: (items: readonly vscode.Diagnostic[]) => boolean, stage = 'diagnostic expectation'): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { listener.dispose(); reject(new Error(`${stage} timed out: ${JSON.stringify(vscode.languages.getDiagnostics(uri).map((item) => ({ code: item.code, message: item.message })))}`)); }, 15000);
		const listener = vscode.languages.onDidChangeDiagnostics((event) => {
			if (event.uris.some((u) => u.toString() === uri.toString()) && predicate(vscode.languages.getDiagnostics(uri))) finish();
		});
		function finish() { clearTimeout(timer); listener.dispose(); resolve(); }
		if (predicate(vscode.languages.getDiagnostics(uri))) finish();
	});
}
