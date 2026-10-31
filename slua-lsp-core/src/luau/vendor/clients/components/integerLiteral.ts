/** Parse the native signed decimal / unsigned bit-pattern forms without double rounding. */
export function integerLiteralValue(raw: string): string {
	const normalized = raw.replace(/_/g, '');
	const hexadecimal = /^0[xX][0-9a-fA-F]+i$/.test(normalized);
	const binary = /^0[bB][01]+i$/.test(normalized);
	if (!hexadecimal && !binary && !/^\d+i$/.test(normalized)) throw new Error('Malformed integer');
	const digits = normalized.slice(hexadecimal || binary ? 2 : 0, -1).replace(/^0+/, '') || '0';
	// Bound BigInt work even for a huge source token. Leading zeroes do not change the value.
	if (digits.length > (hexadecimal ? 16 : binary ? 64 : 19)) throw new Error('Integer overflow');
	const value = BigInt((hexadecimal ? '0x' : binary ? '0b' : '') + digits);
	if (value > (hexadecimal || binary ? 0xffffffffffffffffn : 0x7fffffffffffffffn)) throw new Error('Integer overflow');
	return BigInt.asIntN(64, value).toString();
}
