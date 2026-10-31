const fs = require('node:fs');
const path = require('node:path');

const client = path.resolve(__dirname, '..');
const root = path.resolve(client, '..');
for (const [source, destination] of [
	['third_party/lsl-definitions/lsl_definitions.yaml', 'third_party/lsl-definitions/lsl_definitions.yaml'],
	['third_party/lsl-definitions/LICENSE', 'third_party/lsl-definitions/LICENSE'],
	['slua-lsp-core/src/slua/builtins.yaml', 'server/out/builtins.yaml']
]) {
	const target = path.join(client, destination);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(path.join(root, source), target);
}
