import type { CoreDiagnostic, DiagnosticCode } from './types.js';

export type DirectiveKind = 'disable' | 'disable-next-line' | 'enable';

export type ParsedDirective = {
	kind: DirectiveKind;
	line: number;
	codes: DiagnosticCode[] | 'all';
};

function normalizeCodes(raw: string): DiagnosticCode[] | 'all' {
	const trimmed = raw.trim();
	if (!trimmed) return 'all';
	if (trimmed.toLowerCase() === 'all') return 'all';

	return trimmed
		.split(/[\s,]+/g)
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

export function parseDirectives(text: string): ParsedDirective[] {
	const directives: ParsedDirective[] = [];
	const lines = text.split(/\r?\n/g);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Lua/Luau line comments start with "--".
		// We accept directives anywhere on the line, as long as they appear after a comment start.
		const match = line.match(/--\s*slua-lsp:(disable-next-line|disable|enable)\b(.*)$/i);
		if (!match) continue;

		const kind = match[1].toLowerCase() as DirectiveKind;
		const rest = match[2] ?? '';
		directives.push({
			kind,
			line: i,
			codes: normalizeCodes(rest)
		});
	}

	return directives;
}

export function applyDirectives(text: string, diags: readonly CoreDiagnostic[]): CoreDiagnostic[] {
	const directives = parseDirectives(text);
	if (directives.length === 0) return [...diags];

	const directivesByLine = new Map<number, ParsedDirective[]>();
	const disabledNextLine = new Map<number, { all: boolean; codes: Set<string> }>();

	for (const d of directives) {
		if (d.kind === 'disable-next-line') {
			const target = d.line + 1;
			const existing = disabledNextLine.get(target) ?? { all: false, codes: new Set<string>() };
			if (d.codes === 'all') existing.all = true;
			else for (const c of d.codes) existing.codes.add(String(c).toLowerCase());
			disabledNextLine.set(target, existing);
			continue;
		}

		const list = directivesByLine.get(d.line) ?? [];
		list.push(d);
		directivesByLine.set(d.line, list);
	}

	// Track currently disabled codes as we sweep through the file.
	let disabledAll = false;
	const disabled = new Set<string>();

	const indexed = diags.map((diag, idx) => ({ diag, idx }));
	indexed.sort((a, b) => {
		const la = a.diag.range.start.line;
		const lb = b.diag.range.start.line;
		return la === lb ? a.idx - b.idx : la - lb;
	});

	let currentLine = -1;
	const keep = new Array<boolean>(diags.length).fill(true);

	function applyLineDirectives(line: number): void {
		const list = directivesByLine.get(line);
		if (!list) return;
		for (const d of list) {
			if (d.kind === 'disable') {
				if (d.codes === 'all') {
					disabledAll = true;
					disabled.clear();
					continue;
				}
				for (const c of d.codes) disabled.add(String(c).toLowerCase());
				continue;
			}

			// enable
			if (d.codes === 'all') {
				disabledAll = false;
				disabled.clear();
				continue;
			}
			for (const c of d.codes) disabled.delete(String(c).toLowerCase());
		}
	}

	for (const { diag, idx } of indexed) {
		const line = diag.range.start.line;
		while (currentLine < line) {
			currentLine += 1;
			applyLineDirectives(currentLine);
		}

		const nextLine = disabledNextLine.get(line);
		if (nextLine) {
			if (nextLine.all) {
				keep[idx] = false;
				continue;
			}
			if (nextLine.codes.has(String(diag.code).toLowerCase())) {
				keep[idx] = false;
				continue;
			}
		}

		if (disabledAll) {
			keep[idx] = false;
			continue;
		}

		if (disabled.has(String(diag.code).toLowerCase())) {
			keep[idx] = false;
		}
	}

	return diags.filter((_d, i) => keep[i]);
}
