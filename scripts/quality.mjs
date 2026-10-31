import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, '.local/logs', new Date().toISOString().replaceAll(':', '-'));
await fs.mkdir(destination, { recursive: true });
const results = [];
const serial = process.argv.includes('--serial');
for (const phase of ['lint', 'build', 'test']) {
	if (phase === 'test' && results.find((r) => r.phase === 'build')?.exit !== 0) break;
	const logfile = path.join(destination, `${phase}.log`);
	const handle = await fs.open(logfile, 'w');
	const start = performance.now();
	const args = ['-r', ...(serial ? ['--workspace-concurrency=1'] : []), phase,
		...(serial && phase === 'test' ? ['--maxWorkers=1'] : [])];
	const child = spawn('pnpm', args, { cwd: root, stdio: ['ignore', handle.fd, handle.fd] });
	const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 2)); });
	await handle.close();
	results.push({ phase, exit, serial, seconds: (performance.now() - start) / 1000, logfile });
	await fs.writeFile(path.join(destination, 'results.json'), JSON.stringify(results, null, 2) + '\n');
	process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
	if (exit !== 0) break;
}
process.exitCode = results.some((r) => r.exit !== 0) ? 1 : 0;
