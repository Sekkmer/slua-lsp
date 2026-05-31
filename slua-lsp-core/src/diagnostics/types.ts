export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

// Prefer stable, human-readable codes like "unused-variable".
// (Numeric codes can still be used, but we don't special-case them.)
export type DiagnosticCode = string;

export type Position = {
	line: number;
	character: number;
};

export type Range = {
	start: Position;
	end: Position;
};

export type CoreDiagnostic = {
	code: DiagnosticCode;
	message: string;
	severity: DiagnosticSeverity;
	range: Range;
};
