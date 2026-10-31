const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
	const root = path.resolve(__dirname, '../..');
	const local = path.join(root, '.local/vscode-tests');
	const reports = [];
	for (const fault of ['metadata-directory', 'unreadable-metadata', 'unreadable-generation']) {
		const child = spawn(process.execPath, [path.join(__dirname, 'run-vscode-tests.cjs')], {
			stdio: 'inherit', env: { ...process.env, SLUA_TEST_CACHE_FAULT: fault }
		});
		const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 2)); });
		const report = JSON.parse(await fs.readFile(path.join(local, 'results.json'), 'utf8'));
		await fs.mkdir(path.join(local, 'history'), { recursive: true });
		await fs.writeFile(path.join(local, 'history', `cache-fault-${report.vscode}-${fault}-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n');
		reports.push({ fault, exit, report });
		await fs.writeFile(path.join(local, 'cache-fault-results.json'), JSON.stringify({ passed: reports.every((r) => r.exit === 0), reports }, null, 2) + '\n');
		if (exit !== 0) throw new Error(`Editor cache fault test failed: ${fault} (${exit})`);
	}
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
