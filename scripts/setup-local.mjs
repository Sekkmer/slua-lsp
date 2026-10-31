import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['bin', 'fixtures', 'logs', 'artifacts', 'research', 'vscode/user-data/User', 'vscode/extensions', 'vscode/workspace/.vscode']) {
	await fs.mkdir(path.join(root, '.local', name), { recursive: true });
}
async function create(relative, text, mode) {
	try { await fs.writeFile(path.join(root, '.local', relative), text, { flag: 'wx', mode }); }
	catch (err) { if (err.code !== 'EEXIST') throw err; }
}
await create('bin/slua-lsp', '#!/bin/sh\nexec node "$(dirname "$0")/../artifacts/cli/slua-lsp.mjs" "$@"\n', 0o755);
await create('fixtures/agent-smoke.luau', 'local value: number = 1\nprint(value)\n');
await create('fixtures/integer-smoke.luau', 'local value: integer = 9007199254740993i\nassert(tostring(value) == "9007199254740993")\nassert(integer.add(value, 1i) == 9007199254740994i)\n');
await create('fixtures/preprocessor-context.json', '{}\n');
await create('fixtures/source-context-smoke.luau', 'local sourceLine: number = __LINE__\nassert(sourceLine == 1)\nprint(__SHORTFILE__, sourceLine)\n');
await create('fixtures/conditional-smoke.luau', 'local function magnitude(input: number?)\n    return if const value = input then math.abs(value) else 0\nend\nassert(magnitude(nil) == 0)\nassert(magnitude(-42) == 42)\n');
await create('vscode/workspace/editor-smoke.luau', 'local count: number = 0\n\nfunction LLEvents.touch_start(detected: {DetectedEvent})\n    count += 1\n    ll.Say(0, `Touch count: {count}`)\nend\n');
await create('vscode/user-data/User/settings.json', JSON.stringify({
	'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off',
	'workbench.startupEditor': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false
}, null, 2) + '\n');
await create('vscode/workspace/.vscode/settings.json', JSON.stringify({
	'slua.definitions.autoUpdate': true,
	'window.title': '${dirty}${activeEditorShort} — SLua LSP Release Review'
}, null, 2) + '\n');
process.stdout.write('Local directories and fixtures ready. Existing local data was preserved.\n');
