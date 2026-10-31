# SLua compatibility

SLua LSP uses a TypeScript parser and bounded static analysis shared by its CLI
and language server. It does not embed the complete Luau type solver or simulate
the Second Life world.

Native source, documentation, and preprocessor comparisons are pinned in
`scripts/oracle-source.json`, `scripts/oracle-docs.json`, and
`scripts/preprocessor-source.json`. API definitions come from the official
`third_party/lsl-definitions` submodule.

## Syntax and analysis

The supported profile includes Luau expressions, annotations, interpolation,
const bindings, function attributes, experimental classes, and conditional
`if local`/`if const` declarations. Native classes require parser and runtime
flags. Editor recognition does not establish deployed simulator support.

Const protects a binding, not mutable table contents. Grouped calls supply one
value; a final unparenthesized call can supply a return pack. Known call/results
and local refinements are modeled conservatively. Full generic, recursive,
or interprocedural type-solver equivalence is not provided.

Tagged `i` literals retain exact signed 64-bit values. Use the `integer`
library for arithmetic and `integer.tonumber` when conversion is required.
Vector multiplication is component-wise; use `vector.dot` for a scalar.
Rotation/vector operators, JSON absent-vs-nil arguments, nullable results, and
variable return packs use supported native contracts.

## Navigation

Locals, parameters, functions, and proven class type/value bindings share
lexical definition/reference/rename resolution. Known table/member origins and
imported reexports can provide definition targets. Ambiguous writes do not
produce an invented target.

Arbitrary field references/rename, standalone alias-name rename, and cross-file
references/rename are outside the profile. Editor recovery can retain useful
features in malformed buffers; CLI inspection refuses parse errors.

## Modules and input

Direct unshadowed `require("literal")` calls resolve relative to the requiring
file. Lookup tries exact paths, `.luau`, `.lua`, then directory
`init.luau`/`init.lua`. Dynamic paths and direct absolute require strings
are unsupported.

JSONC `.luaurc` aliases support comments, trailing commas, case-insensitive
names, ancestor lookup, and bounded chains from their declaring configuration.
Cycles, malformed configs, and invalid-Unicode aliases are diagnosed.

A global reassignment/function declaration replacing `require` disables
source-import interpretation for that document. Local shadows do not disable
unrelated imports. This is conservative across the document, without proving
execution order or arbitrary environment mutation.

Default depth is five edges, configurable from 1 to 50. Graphs allow 256 modules,
8,192 requires, 8 MiB per file, and 32 MiB of read source/configuration text.
Reads are cached individually within inspection, not an atomic filesystem
snapshot. Editor analysis uses unsaved imports and bounded invalidated caches.

Inputs require strict UTF-8 without NUL. A leading BOM stays in source hashes
and ranges and produces a native-compatible syntax error.

## Generated source and diagnostics

Preprocessing supports bounded literal imports and explicit macro context.
It refuses unsupported indirect/replaced loader patterns. The generated loader
uses a sandboxed truthy-result cache: false/nil results execute again.

Source mappings bind original text by hash. Unsaved imports are included;
changed originals need a fresh preview. Generated helpers are unmapped.
Clean LF/CRLF display normalization is accepted after checking the disk snapshot.

Semantic diagnostics support directives:

```lua
-- slua-lsp:disable-next-line truthy-literal
if 0 then print("Luau treats zero as true") end
```

`-- slua-lsp:disable CODE` and `-- slua-lsp:enable CODE` control subsequent
diagnostics; `all` controls all semantic codes. String/long-comment contents
are not directives. Parse errors remain visible.

Native tests exercise language contracts. Viewer behavior, region flags, host
APIs, memory ceilings, and scheduling depend on the actual deployment.
