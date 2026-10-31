import { parseSlua, type ParseResult } from 'slua-lsp-core';

type Document = { uri: string; version: number; getText(): string };
type Snapshot = { version: number; parsed: ParseResult; semanticData?: number[] };

/** Only open document versions are retained; close/reopen starts a new epoch. */
export class DocumentParseCache {
	private readonly entries = new Map<string, Snapshot>();

	private snapshot(document: Document): Snapshot {
		const cached = this.entries.get(document.uri);
		if (cached?.version === document.version) return cached;
		const entry = { version: document.version, parsed: parseSlua(document.getText()) };
		this.entries.set(document.uri, entry);
		return entry;
	}

	get(document: Document): ParseResult {
		return this.snapshot(document).parsed;
	}

	getSemanticData(document: Document, compute: (parsed: ParseResult) => number[]): number[] {
		const entry = this.snapshot(document);
		return entry.semanticData ??= compute(entry.parsed);
	}

	close(uri: string): void {
		this.entries.delete(uri);
	}
}
