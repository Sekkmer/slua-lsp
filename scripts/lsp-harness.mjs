import { spawn } from 'node:child_process';

/** Small real stdio LSP peer for local qualification, with bounded requests. */
export function launchServer(entry, cwd, { nodeArgs = [] } = {}) {
	const child = spawn(process.execPath, [...nodeArgs, entry, '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
	let buffer = Buffer.alloc(0), nextId = 0, stderr = '';
	const pending = new Map(), listeners = new Set();
	const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
	function fail(error) {
		for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
		pending.clear();
	}
	child.once('error', fail);
	child.once('exit', () => fail(new Error(`LSP server exited: ${stderr}`)));
	child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16000); });
	child.stdout.on('data', (data) => {
		buffer = Buffer.concat([buffer, data]);
		for (;;) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) break;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
			if (!Number.isFinite(length)) { fail(new Error('Malformed LSP frame')); child.kill(); break; }
			if (buffer.length < headerEnd + 4 + length) break;
			const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
			buffer = buffer.subarray(headerEnd + 4 + length);
			if (message.id !== undefined && !message.method) {
				const request = pending.get(message.id);
				if (request) {
					clearTimeout(request.timer); pending.delete(message.id);
					if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
				}
			} else for (const listener of [...listeners]) listener(message);
		}
	});
	function send(message) {
		const body = JSON.stringify({ jsonrpc: '2.0', ...message });
		child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}
	function request(method, params) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`LSP timeout: ${method}`)); }, 30000);
			pending.set(id, { resolve, reject, timer }); send({ id, method, params });
		});
	}
	function notification(method, predicate = () => true) {
		let listener, timer;
		const promise = new Promise((resolve, reject) => {
			listener = (message) => {
				if (message.method !== method || !predicate(message.params)) return;
				clearTimeout(timer); listeners.delete(listener); resolve(message.params);
			};
			timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`LSP notification timeout: ${method}`)); }, 30000);
			listeners.add(listener);
		});
		return promise;
	}
	return { child, request, notification, notify: (method, params) => send({ method, params }),
		async close() {
			if (child.exitCode === null) {
				try { await request('shutdown', null); send({ method: 'exit' }); }
				finally { const timer = setTimeout(() => child.kill(), 2000); await exited; clearTimeout(timer); }
			}
		} };
}
