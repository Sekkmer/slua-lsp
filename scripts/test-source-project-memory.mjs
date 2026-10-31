import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {launchServer} from './lsp-harness.mjs';
const root=process.cwd();
const entry=process.env.SLUA_PROJECT_MEMORY_SERVER ?? path.join(root,'slua-lsp-server/out/index.js');
const fixtureRoot=process.env.SLUA_PROJECT_MEMORY_FIXTURE_ROOT??path.join(root,'.local/fixtures');
const sourceContextEnabled=process.env.SLUA_PROJECT_MEMORY_CONTEXT==='1';
await fs.mkdir(fixtureRoot,{recursive:true});
const folder=await fs.mkdtemp(path.join(fixtureRoot,'project-memory-'));
await fs.mkdir(path.join(folder,'shared'));
await fs.writeFile(path.join(folder,'.luaurc'),'{"aliases":{"shared":"shared"}}');
await fs.writeFile(path.join(folder,'shared/double.luau'),'return function(value: number): number return value * 2 end');
const documents=[];
for(let i=0;i<16;i++) {
 const dir=path.join(folder,String(i));await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'api.luau'),'local double = require("@shared/double")\nlocal M = {}\nM.count = 42\nM.double = double\nreturn M');
 const text='local api = require("api")\nlocal result: number = api.double(api.count)\nprint(result)'+(sourceContextEnabled?'\nlocal sourceLine: number = __LINE__\nprint(sourceLine)':'');
 const file=path.join(dir,'main.luau');await fs.writeFile(file,text);documents.push({uri:pathToFileURL(file).href,text});
}
async function watches() {
 let count=0;
 for(const name of await fs.readdir(`/proc/${lsp.child.pid}/fdinfo`)) {
  try {const text=await fs.readFile(`/proc/${lsp.child.pid}/fdinfo/${name}`,'utf8');count+=(text.match(/^inotify wd:/gm)??[]).length;} catch(e) {if(e.code!=='ENOENT')throw e;}
 }
 return count;
}
const lsp = launchServer(entry, root, { nodeArgs: ['--inspect=127.0.0.1:0'] });
let inspector;
async function connect() {
	const url = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Owned child did not expose its inspector endpoint')), 30000);
		let output = '';
		const listener = (data) => {
			output += data.toString();
			const match = /ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/.exec(output);
			if (match) { clearTimeout(timer); lsp.child.stderr.off('data', listener); resolve(match[0]); }
		};
		lsp.child.stderr.on('data', listener);
	});
	const socket = new WebSocket(url), pending = new Map(); let nextId = 0;
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		const request = pending.get(message.id); if (!request) return;
		clearTimeout(request.timer); pending.delete(message.id);
		if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
	});
	await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
	return {
		call(method) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 30000);
				pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method }));
			});
		},
		close() { return new Promise((resolve) => { socket.addEventListener('close', resolve, { once: true }); socket.close(); }); }
	};
}
async function heap(collect = false) {
	if (collect) await inspector.call('HeapProfiler.collectGarbage');
	const usage = await inspector.call('Runtime.getHeapUsage');
	assert.ok(Number.isFinite(usage.usedSize) && usage.usedSize > 0);
	const status = await fs.readFile(`/proc/${lsp.child.pid}/status`, 'utf8');
	return { ...usage, rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024, forcedGc: collect };
}
async function change(method, params) {
	const response = lsp.notification('textDocument/publishDiagnostics', (p) => p.uri === params.textDocument.uri);
	lsp.notify(method, params); return response;
}
async function tokens(uri) { return lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } }); }

const cycles=[];
try {
 inspector=await connect();
 await lsp.request('initialize',{processId:process.pid,rootUri:pathToFileURL(folder).href,capabilities:{},initializationOptions:{preprocessorContext:sourceContextEnabled?{}:null}});lsp.notify('initialized',{});
 const baseline=await heap(true), baselineWatches=await watches();
 for(let cycle=0;cycle<3;cycle++) {
  const start=performance.now();
  for(const doc of documents) {
   const response=await change('textDocument/didOpen',{textDocument:{uri:doc.uri,languageId:'luau',version:cycle+1,text:doc.text}});
   assert.deepEqual(response.diagnostics,[]);
   const hover=await lsp.request('textDocument/hover',{textDocument:{uri:doc.uri},position:{line:2,character:8}});assert.ok(hover.contents.value.includes('number'));
  }
  const open=await heap(true),openWatches=await watches(),openMs=performance.now()-start;
  for(const doc of documents)await change('textDocument/didClose',{textDocument:{uri:doc.uri}});
  await lsp.request('textDocument/documentSymbol',{textDocument:{uri:documents[0].uri}});
  const closed=await heap(true),closedWatches=await watches();
  const record={cycle,openMs,open,closed,openWatches,closedWatches,postCloseGrowthBytes:closed.usedSize-baseline.usedSize};cycles.push(record);
  assert.ok(openWatches>baselineWatches);assert.ok(closedWatches<=baselineWatches);assert.ok(record.postCloseGrowthBytes<16*1024*1024);
 }
 const report={passed:true,recordedAt:new Date().toISOString(),node:process.version,sourceContextEnabled,harnessSha256:crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),entry,entrySha256:crypto.createHash('sha256').update(await fs.readFile(entry)).digest('hex'),folder,rootDocuments:16,sourceFiles:33,cycles,
 limits:'Three local cycles of 16 open importing roots, one per-root API plus one shared aliased function. Normal source observation, stdio LSP and owned loopback inspector; no viewer/FS IPC or code execution. Counts owned child inotify watches and forced-GC heap, not a universal memory or latency guarantee.'};
 await fs.writeFile(process.env.SLUA_PROJECT_MEMORY_EVIDENCE??'.local/logs/project-memory.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally {if(inspector)await inspector.close();await lsp.close();}
