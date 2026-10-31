export type SourceComment = { start: number; end: number; line: number; kind: 'line' | 'block' };

type Frame = { kind: 'code'; depth: number } | { kind: 'quote'; quote: string } | { kind: 'template' };

/** Tolerant lexical scan: comments are never recognized inside literal text.
 * Interpolation expressions may contain comments, nested strings and braces.
 * Unlike parsing, this also works while another part of a document is incomplete.
 */
export function scanSourceComments(text: string): { comments: SourceComment[]; commentSafeLines: Set<number> } {
	const comments: SourceComment[] = [];
	const commentSafeLines = new Set<number>([0]);
	const stack: Frame[] = [{ kind: 'code', depth: -1 }];
	let offset = 0, line = 0;
	function advance(end: number, safe = false): void {
		while (offset < end) {
			const char = text[offset++];
			if (char === '\r' || char === '\n' && text[offset - 2] !== '\r') {
				line++;
				if (safe) commentSafeLines.add(line);
			}
		}
	}
	function longBracket(at: number): string | undefined {
		if (text[at] !== '[') return undefined;
		let end = at + 1;
		while (text[end] === '=') end++;
		return text[end] === '[' ? ']' + '='.repeat(end - at - 1) + ']' : undefined;
	}
	function skipLong(at: number, close: string): void {
		const end = text.indexOf(close, at + close.length);
		advance(end < 0 ? text.length : end + close.length);
	}
	function escape(): void {
		advance(Math.min(text.length, offset + 2));
		if (text[offset - 1] === 'z') while (offset < text.length && /\s/.test(text[offset]!)) advance(offset + 1);
		else if (text[offset - 1] === 'u' && text[offset] === '{') {
			const end = text.indexOf('}', offset + 1);
			advance(end < 0 ? text.length : end + 1);
		}
	}
	while (offset < text.length) {
		const frame = stack.at(-1)!;
		const char = text[offset]!;
		if (frame.kind === 'quote') {
			if (char === '\\') escape();
			else { advance(offset + 1); if (char === frame.quote) stack.pop(); }
			continue;
		}
		if (frame.kind === 'template') {
			if (char === '\\') escape();
			else if (char === '`') { advance(offset + 1); stack.pop(); }
			else if (char === '{') { advance(offset + 1); stack.push({ kind: 'code', depth: 0 }); }
			else advance(offset + 1);
			continue;
		}
		if (text.startsWith('--', offset)) {
			const start = offset, startLine = line;
			const close = longBracket(offset + 2);
			if (close) { advance(offset + 2); skipLong(offset, close); }
			else { let end = offset; while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++; advance(end); }
			comments.push({ start, end: offset, line: startLine, kind: close ? 'block' : 'line' });
		} else if (char === '"' || char === '\'') {
			stack.push({ kind: 'quote', quote: char }); advance(offset + 1);
		} else if (char === '`') {
			stack.push({ kind: 'template' }); advance(offset + 1);
		} else if (char === '[' && longBracket(offset)) {
			skipLong(offset, longBracket(offset)!);
		} else if (char === '}' && frame.depth === 0) {
			advance(offset + 1); stack.pop();
		} else {
			if (frame.depth >= 0 && char === '{') frame.depth++;
			else if (frame.depth > 0 && char === '}') frame.depth--;
			advance(offset + 1, true);
		}
	}
	return { comments, commentSafeLines };
}
