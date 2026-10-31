import { LexerError } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hex = (byte: number | undefined) => byte !== undefined && (byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102);
const digit = (byte: number | undefined) => byte !== undefined && byte >= 48 && byte <= 57;
const space = (byte: number) => byte === 32 || byte >= 9 && byte <= 13;

/** UTF-8 text stays ordinary JS text. Invalid bytes use U+DC80..U+DCFF,
 * preserving byte identity without conflating e.g. \xff and UTF-8 U+00FF.
 * These surrogate escapes are internal string values, never source-file text.
 */
function decodeBytes(bytes: Uint8Array): string {
	try { return decoder.decode(bytes); } catch { /* Keep invalid bytes losslessly. */ }
	const parts: string[] = [], chunks: string[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length;) {
		const a = bytes[i]!;
		let size = a < 0x80 ? 1 : a >= 0xc2 && a <= 0xdf ? 2 : a >= 0xe0 && a <= 0xef ? 3 : a >= 0xf0 && a <= 0xf4 ? 4 : 0;
		for (let j = 1; j < size; j++) if (bytes[i + j] === undefined || (bytes[i + j]! & 0xc0) !== 0x80) { size = 0; break; }
		const b = bytes[i + 1]!;
		if (a === 0xe0 && b < 0xa0 || a === 0xed && b >= 0xa0 || a === 0xf0 && b < 0x90 || a === 0xf4 && b >= 0x90) size = 0;
		if (size) { i += size; continue; }
		if (i > start) parts.push(decoder.decode(bytes.subarray(start, i)));
		parts.push(String.fromCharCode(0xdc00 + a));
		i++; start = i;
		if (parts.length >= 4096) { chunks.push(parts.join('')); parts.length = 0; }
	}
	if (start < bytes.length) parts.push(decoder.decode(bytes.subarray(start)));
	chunks.push(parts.join(''));
	return chunks.join('');
}

/** Decode the pinned Luau lexer's string fixups; token spelling/ranges stay raw. */
export function stringLiteralValue(raw: string, sourceOffset: number): string {
	if (raw.startsWith('[')) {
		const length = /^\[=*\[/.exec(raw)![0].length;
		return raw.slice(length, -length).replace(/^\r?\n/, '').replace(/\r\n/g, '\n');
	}
	const body = raw.slice(1, -1);
	if (!body.includes('\\')) return body;
	const bytes = encoder.encode(body);
	let write = 0;
	const fail = (offset: number): never => {
		// The working bytes are modified in place. Re-encode only on error to
		// recover the original UTF-16 offset after non-ASCII source characters.
		const prefix = encoder.encode(body).subarray(0, offset);
		throw new LexerError('Malformed string escape', sourceOffset + 1 + decoder.decode(prefix).length);
	};
	for (let i = 0; i < bytes.length;) {
		if (bytes[i] !== 92) { bytes[write++] = bytes[i++]!; continue; }
		const start = i++, escape = bytes[i++];
		if (escape === undefined || escape === 0) fail(start);
		if (escape === 13 || escape === 10) {
			bytes[write++] = 10;
			if (escape === 13 && bytes[i] === 10) i++;
		} else if (escape === 122) {
			while (i < bytes.length && space(bytes[i]!)) i++;
		} else if (escape === 120) {
			if (!hex(bytes[i]) || !hex(bytes[i + 1])) fail(start);
			bytes[write++] = Number.parseInt(String.fromCharCode(bytes[i]!, bytes[i + 1]!), 16); i += 2;
		} else if (escape === 117) {
			if (bytes[i++] !== 123) fail(start);
			let code = 0, count = 0;
			while (hex(bytes[i]) && count < 16) { code = (code * 16 + Number.parseInt(String.fromCharCode(bytes[i++]!), 16)) >>> 0; count++; }
			if (!count || bytes[i++] !== 125 || code > 0x10ffff) fail(start);
			// The pinned implementation also emits UTF-8-shaped surrogate bytes.
			// Keep those distinct from real Unicode with decodeBytes above.
			if (code < 0x80) bytes[write++] = code;
			else if (code < 0x800) { bytes[write++] = 0xc0 | code >> 6; bytes[write++] = 0x80 | code & 63; }
			else if (code < 0x10000) { bytes[write++] = 0xe0 | code >> 12; bytes[write++] = 0x80 | code >> 6 & 63; bytes[write++] = 0x80 | code & 63; }
			else { bytes[write++] = 0xf0 | code >> 18; bytes[write++] = 0x80 | code >> 12 & 63; bytes[write++] = 0x80 | code >> 6 & 63; bytes[write++] = 0x80 | code & 63; }
		} else if (digit(escape)) {
			let code = escape! - 48;
			for (let n = 0; n < 2 && digit(bytes[i]); n++) code = code * 10 + bytes[i++]! - 48;
			if (code > 255) fail(start);
			bytes[write++] = code;
		} else {
			bytes[write++] = ({ 97: 7, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11 } as Record<number, number>)[escape!] ?? escape!;
		}
	}
	return decodeBytes(bytes.subarray(0, write));
}
