import { createScanner, parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';

/** Configuration is data only. In particular, this never evaluates .config.luau. */
export function parseSourceAliases(text: string, file: string): Map<string, string> {
	if (Buffer.byteLength(text) > 1024 * 1024) throw new Error(`Source config exceeds 1048576 bytes: ${file}`);
	const scanner = createScanner(text, true);
	let depth = 0, tokens = 0;
	for (;;) {
		scanner.scan();
		const length = scanner.getTokenLength();
		if (!length) break;
		const token = length === 1 ? text[scanner.getTokenOffset()] : undefined;
		if (++tokens > 65536) throw new Error(`Source config exceeds 65536 tokens: ${file}`);
		if (token === '{' || token === '[') {
			if (++depth > 64) throw new Error(`Source config exceeds depth 64: ${file}`);
		} else if (token === '}' || token === ']') depth = Math.max(0, depth - 1);
	}
	const errors: ParseError[] = [];
	const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
	if (errors.length) throw new Error(`Invalid .luaurc JSONC (${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}): ${file}`);
	if (root?.type !== 'object') throw new Error(`Invalid .luaurc object: ${file}`);
	const declarations = (root.children ?? []).filter((property) => property.children?.[0]?.value === 'aliases');
	if (declarations.length > 1) throw new Error(`Duplicate aliases section in ${file}`);
	const map = declarations[0]?.children?.[1];
	const result = new Map<string, string>();
	if (!map) return result;
	if (map.type !== 'object') throw new Error(`Invalid aliases in ${file}`);
	if ((map.children?.length ?? 0) > 4096) throw new Error(`Source config exceeds 4096 aliases: ${file}`);
	for (const property of map.children ?? []) {
		const name = property.children?.[0]?.value as string;
		const target = property.children?.[1];
		const key = name.toLowerCase();
		if (!/^[a-z0-9._-]+$/i.test(name) || name === '.' || name === '..' || target?.type !== 'string' ||
			!target.value || /[\0\r\n]/.test(target.value as string) || result.has(key)) throw new Error(`Invalid or duplicate alias '${name}' in ${file}`);
		// JSON escapes can introduce lone surrogates even when the config file is
		// valid UTF-8. Node path IO would replace them with U+FFFD, selecting a
		// different directory. Unicode mode preserves valid supplementary pairs.
		if (/[\ud800-\udfff]/u.test(target.value as string)) throw new Error(`Invalid Unicode alias target '${name}' in ${file}`);
		result.set(key, target.value as string);
	}
	return result;
}

export function splitSourceAlias(specifier: string): { name: string; parts: string[] } {
	const [name, ...parts] = specifier.slice(1).split('/');
	if (!name || !/^[a-z0-9._-]+$/i.test(name) || name === '.' || name === '..' || name.toLowerCase().startsWith('sl-') || parts.includes('..') || /[\0\r\n\\]/.test(specifier)) throw new Error(`Invalid or reserved module alias: ${specifier}`);
	if (name.toLowerCase() === 'self') throw new Error('Native @self module contexts are unsupported by source inspection');
	return { name: name.toLowerCase(), parts };
}
