import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/** Source observation only. Watch before reading so newly created workspaces
 * and external alias libraries do not depend on editor watcher discovery. */
export class SourceFileWatchers {
	private readonly directories = new Map<string, { watcher: FSWatcher; names: Map<string, Set<string>> }>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(private readonly changed: () => void, private readonly failed: (message: string) => void) {}

	observe(root: string, source: string): void {
		let file = source;
		for (;;) {
			const dir = path.dirname(file);
			let entry = this.directories.get(dir);
			if (!entry) {
				if (this.directories.size >= 1024) { this.failed('Source watcher directory limit (1024) reached'); return; }
				try {
					const watcher = watch(dir, { persistent: false }, (_event, filename) => {
						const current = this.directories.get(dir);
						if (!current || filename && !current.names.has(filename.toString())) return;
						if (this.timer) clearTimeout(this.timer);
						// Coalesce the truncate/write sequence of an ordinary source save.
						this.timer = setTimeout(() => { this.timer = undefined; this.changed(); }, 25);
					});
					watcher.on('error', (error) => { this.failed(`Source watcher failed for ${dir}: ${error.message}`); watcher.close(); this.directories.delete(dir); });
					entry = { watcher, names: new Map() }; this.directories.set(dir, entry);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path.dirname(dir) !== dir) { file = dir; continue; }
					this.failed(`Cannot watch source directory ${dir}: ${String(error)}`); return;
				}
			}
			const name = path.basename(file); const roots = entry.names.get(name) ?? new Set();
			roots.add(root); entry.names.set(name, roots); return;
		}
	}

	closeRoot(root: string): void {
		for (const [dir, entry] of this.directories) {
			for (const [name, roots] of entry.names) { roots.delete(root); if (!roots.size) entry.names.delete(name); }
			if (!entry.names.size) { entry.watcher.close(); this.directories.delete(dir); }
		}
	}

	close(): void {
		if (this.timer) clearTimeout(this.timer);
		for (const entry of this.directories.values()) entry.watcher.close();
		this.directories.clear();
	}
}
