# SLua LSP for VS Code

Language tooling for Second Life SLua (Luau), with a bundled language server:

- Syntax, supported type, builtin call, and common-mistake diagnostics.
- Completion, hover, signatures, symbols, and semantic highlighting.
- Definitions for locals, known members, and literal source modules.
- Local references, capture-safe rename, and quick fixes.
- Read-only preprocessing previews with navigation back to source.

## Getting started

Use VS Code 1.90 or later. Install the built VSIX using **Extensions: Install
from VSIX…**, then open a `.lua`, `.luau`, or `.slua` file.
No separate server installation is needed.

## Definitions and settings

Official Second Life definitions are bundled for offline use. Failed updates
retain the last accepted definitions and are logged in **SLua LSP**.

| Setting | Default | Purpose |
| --- | --- | --- |
| `slua.definitions.autoUpdate` | `true` | Check for definitions updates |
| `slua.definitions.updateIntervalHours` | `24` | Minimum time between checks |
| `slua.definitionsPath` | empty | Custom YAML path |
| `slua.definitions.updateUrl` | official Second Life YAML | Alternative update URL |
| `slua.preprocessor.context` | `null` | Explicit optional source macro context |

Custom definitions take precedence; relative paths resolve from the workspace.
Use **SLua: Update LSL Definitions** to refresh explicitly and **SLua: Show Active
LSL Definitions** to inspect the selected file.

## Source previews

**SLua: Preview Preprocessed Source** opens a read-only generated snapshot,
including supported unsaved imports. F12 or **SLua: Go to Original Source**
returns to a mapped source location. Changed/missing originals need a fresh
preview; generated helpers have no source target.

Set `slua.preprocessor.context` to `{}` for file/line macros, or supply
explicit `agentId`, `agentName`, and UTC ISO `timestamp` for identity/time
macros. The default `null` disables macros. Invalid updates retain the last
accepted context. Generation never uploads, executes, or saves your source.

## Diagnostics

Quick Fix can repair supported dot/colon call separators or suppress one
semantic diagnostic code on the next line. Existing directives are preserved.
Suppression does not repair a program; parse errors cannot be suppressed.

`truthy-literal` explains that zero/empty text are true in Luau.
`ipairs-literal-hole` identifies provably skipped entries in a literal table.
Both are suppressible advice; valid iteration is not rejected.

Analysis covers a bounded SLua profile rather than the complete Luau type solver.
Experimental syntax can require simulator flags. Known-member definitions are
supported; arbitrary field references/rename and cross-file rename are not.

The extension does not synchronize with a viewer or execute scripts.
See the repository CLI and compatibility guides for detailed boundaries.
