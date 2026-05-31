import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';

import { analyzeTextWithDirectives, parseSlua } from 'slua-lsp-core';
import type { SluaRegistry } from 'slua-lsp-core';

type ComputeDiagnosticsOptions = {
	registry: SluaRegistry | null;
	defsLoaded: boolean;
	serverName: string;
};

export function computeDiagnosticsForText(text: string, opts: ComputeDiagnosticsOptions): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	const parsed = parseSlua(text);
	for (const d of parsed.diagnostics) {
		const sev =
			d.severity === 'error'
				? DiagnosticSeverity.Error
				: d.severity === 'warning'
					? DiagnosticSeverity.Warning
					: DiagnosticSeverity.Information;
		diagnostics.push({
			severity: sev,
			range: d.range,
			message: d.message,
			code: d.code,
			source: opts.serverName
		});
	}

	if (opts.registry && parsed.ast) {
		const coreDiags = analyzeTextWithDirectives(text, {
			ast: parsed.ast,
			registry: opts.registry,
			eventSignatures: opts.registry.eventSignatures
		});
		for (const d of coreDiags) {
			const sev =
				d.severity === 'error'
					? DiagnosticSeverity.Error
					: d.severity === 'warning'
						? DiagnosticSeverity.Warning
						: DiagnosticSeverity.Information;
			diagnostics.push({
				severity: sev,
				range: d.range,
				message: d.message,
				code: d.code,
				source: opts.serverName
			});
		}
	}

	if (!opts.defsLoaded) {
		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 }
			},
			message: 'LSL definitions YAML failed to load; language features will be limited.',
			source: opts.serverName
		});
	}

	return diagnostics;
}
