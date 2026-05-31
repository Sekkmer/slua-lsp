/* eslint-env node */
/* globals process */
const fs = require('node:fs');
const path = require('node:path');

function copyDir(src, dest) {
	if (!fs.existsSync(src)) return;
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src)) {
		const s = path.join(src, entry);
		const d = path.join(dest, entry);
		const st = fs.statSync(s);
		if (st.isDirectory()) copyDir(s, d);
		else fs.copyFileSync(s, d);
	}
}

function main() {
	const repoRoot = path.resolve(process.cwd(), '..');

	// Copy the definitions YAML into the extension so packaging is self-contained.
	const defsSrcDir = path.join(repoRoot, 'third_party', 'lsl-definitions');
	const defsDestDir = path.resolve(process.cwd(), 'third_party', 'lsl-definitions');
	copyDir(defsSrcDir, defsDestDir);
}

main();
