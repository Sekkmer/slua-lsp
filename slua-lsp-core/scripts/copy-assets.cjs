/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

function copyFileSync(src, dst) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.copyFileSync(src, dst);
}

const root = path.resolve(__dirname, '..');
const srcBuiltins = path.join(root, 'src', 'slua', 'builtins.yaml');
const outBuiltins = path.join(root, 'out', 'slua', 'builtins.yaml');

if (!fs.existsSync(srcBuiltins)) {
	console.warn('[copy-assets] builtins.yaml not found, skipping');
	process.exit(0);
}

copyFileSync(srcBuiltins, outBuiltins);
console.log('[copy-assets] copied', path.relative(root, srcBuiltins), '->', path.relative(root, outBuiltins));

const defsSource = path.join(root, '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');
copyFileSync(defsSource, path.join(root, 'out', 'lsl', 'lsl_definitions.yaml'));
