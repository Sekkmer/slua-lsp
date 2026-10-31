import type { LspPosition } from './ast.js';

/** UTF-16 source coordinates. Editor lines recognize CRLF, CR and LF; lexer grammar lines use LF. */
export class SourceTextIndex {
	readonly starts: Uint32Array;
	private readonly lfStarts: Uint32Array;
	constructor(readonly text: string) {
		let lines = 1, lfLines = 1;
		for (let offset = 0; offset < text.length; offset++) {
			const char = text.charCodeAt(offset);
			if (char === 13) {
				lines++;
				if (text.charCodeAt(offset + 1) === 10) { offset++; lfLines++; }
			} else if (char === 10) { lines++; lfLines++; }
		}
		const starts = new Uint32Array(lines), lfStarts = lines === lfLines ? starts : new Uint32Array(lfLines);
		let line = 1, lfLine = 1;
		for (let offset = 0; offset < text.length; offset++) {
			const char = text.charCodeAt(offset);
			if (char === 13) {
				if (text.charCodeAt(offset + 1) === 10) { offset++; lfStarts[lfLine++] = offset + 1; }
				starts[line++] = offset + 1;
			} else if (char === 10) { starts[line++] = offset + 1; lfStarts[lfLine++] = offset + 1; }
		}
		this.starts = starts; this.lfStarts = lfStarts;
	}
	lineEnd(line: number): number {
		const next = this.starts[line + 1];
		if (next === undefined) return this.text.length;
		return next - (this.text.charCodeAt(next - 1) === 10 && this.text.charCodeAt(next - 2) === 13 ? 2 : 1);
	}
	eol(line: number): string { return this.text.slice(this.lineEnd(line), this.starts[line + 1] ?? this.text.length); }
	offsetAt(position: LspPosition): number | undefined {
		const { line, character } = position, start = this.starts[line];
		if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 0 || character < 0 || start === undefined || character > this.lineEnd(line) - start) return undefined;
		return start + character;
	}
	private lineAt(starts: Uint32Array, offset: number): number {
		let low = 0, high = starts.length;
		while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle; else high = middle; }
		return low;
	}
	positionAt(offset: number): LspPosition {
		offset = Math.max(0, Math.min(this.text.length, offset));
		const line = this.lineAt(this.starts, offset);
		return { line, character: Math.min(offset, this.lineEnd(line)) - this.starts[line]! };
	}
	lfPositionAt(offset: number): LspPosition {
		offset = Math.max(0, Math.min(this.text.length, offset));
		const line = this.lineAt(this.lfStarts, offset); return { line, character: offset - this.lfStarts[line]! };
	}
	/** Lexer/AST coordinates may encode a multi-line token end as start column plus raw length. */
	lfOffsetAt(position: LspPosition): number {
		return Math.max(0, Math.min(this.text.length, (this.lfStarts[position.line] ?? this.text.length) + position.character));
	}
}
