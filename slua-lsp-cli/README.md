# SLua LSP CLI

Check SLua source and inspect APIs, symbols, dependencies, and generated output
without an editor. Analysis is shared with the VS Code extension.

Use Node.js 22 or 24. Build with `pnpm exec node scripts/package-cli.mjs`.
Run `node .local/artifacts/cli/slua-lsp.mjs --help` from a built checkout.
Copy the complete CLI artifact directory when relocating it; ordinary checks
need neither network access nor repository dependencies.

The examples use `slua-lsp` as shorthand for `node /path/to/cli/slua-lsp.mjs`.

## Common workflows

```sh
slua-lsp capabilities
slua-lsp check script.luau --json
slua-lsp check path/to/project --json --warnings-as-errors
printf 'local value = 1\nprint(value)\n' | slua-lsp check - --stdin-filepath scratch.luau --json
slua-lsp lookup ll.Say --json
slua-lsp hover script.luau --position 3:8 --json
slua-lsp symbols script.luau --json
slua-lsp modules path/to/main.luau --json
slua-lsp preprocess path/to/main.luau --json
```

Directory checks select `.lua`, `.luau`, and `.slua` files and skip generated
and dependency trees. Each file/stdin accepts at most 8 MiB of strict UTF-8.
Malformed UTF-8, NUL bytes, and oversized inputs fail before analysis.

## Commands

| Command | Result |
| --- | --- |
| `capabilities` | Machine-readable operations and limits |
| `check <files...>` | Diagnostics, optionally proposed quick fixes |
| `lookup <name>` / `dump-defs` | API signatures or loaded definitions |
| `hover <file>` / `symbols <file>` | Source/type/API hover or source outline |
| `definition <file>` | Local, known-member, or module target |
| `references <file>` / `rename <file>` | Supported local references or proposed edits |
| `modules <file>` | Hashed source/configuration dependency graph |
| `preprocess <file>` | Generated SLua and source mappings |
| `update-defs` | Validated definitions refresh into a local cache |

## JSON and agent use

Responses use `schema: "slua-lsp.cli.v1"`. Diagnostics include filename, severity,
code, message, and zero-based UTF-16 ranges. Inspection and edit proposals bind
the input with `sourceSha256`. Text diagnostic positions are one-based;
`--position LINE:CHARACTER` uses zero-based UTF-16.

Exit codes are 0 for success, 1 for diagnostics or no safe inspection result,
and 2 for usage/input/operational failures. Warnings fail checks only with
`--warnings-as-errors`. Inspect response status for navigation/generation.

```sh
slua-lsp check script.luau --json --include-actions
slua-lsp definition script.luau --position 3:8 --json
slua-lsp references script.luau --position 3:8 --exclude-declaration --json
slua-lsp rename script.luau --position 3:8 --new-name total --json
```

Verify the source hash before applying proposed UTF-16 edits. The CLI never
writes the input or executes source. Rename refuses parse errors and binding
capture. Arbitrary fields, standalone alias names, and cross-file
reference/rename are outside its scope.

`definition`, `references`, `rename`, `modules`, and `preprocess` always return
JSON, including operational errors. Other commands support `--json`.
No MCP server or interactive prompts are needed.

## Modules and preprocessing

`modules` follows direct unshadowed literal requires and JSONC `.luaurc`
aliases. Dynamic requires are diagnosed. `preprocess` emits generated source
and mappings without uploading or executing it.

```sh
slua-lsp preprocess main.luau --preprocessor-context context.json --json
slua-lsp check main.luau --preprocessor-context context.json --json
```

An empty context enables file/line macros. Optional `agentId`, `agentName`,
and UTC ISO `timestamp` enable identity/time macros; values are never inferred.

For generated-to-source mapping, repeat `preprocess` with the same inputs,
`--generated-position LINE:CHARACTER`, and `--generated-sha256 HEX` from
the previous result's `contentSha256`. The response reports `mapped`,
`unmapped`, `stale`, `unavailable`, or `generated-changed`.
Mappings check source and output hashes.
See [compatibility](../docs/compatibility.md) for boundaries.

## Definition updates

Selection order is explicit `--defs`, `SLUA_LSP_DEFS_PATH`, validated cache,
then bundled definitions. Ordinary checks never fetch.

```sh
slua-lsp update-defs --cache-dir /path/to/cache --json
slua-lsp check --cache-dir /path/to/cache script.luau --json
slua-lsp check --auto-update-defs script.luau --json
```

Updates validate YAML before replacement and preserve the previous generation
on failure. Explicit file/environment overrides take precedence.
