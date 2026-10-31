# SLua LSP

Language tooling for Second Life SLua (Luau): a VS Code extension, a standalone
CLI, and a shared language server/core for diagnostics, completion, hover,
navigation, semantic highlighting, and source preprocessing.

See the [VS Code guide](slua-lsp-client/README.md) for editor use and the
[CLI guide](slua-lsp-cli/README.md) for noninteractive and agent workflows.
[Compatibility](docs/compatibility.md) describes the supported language profile.

## VS Code extension

Install [SLua LSP from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Sekkmer.slua-lsp-client),
or download `slua-lsp-client-0.1.2.vsix` from the [GitHub release](https://github.com/Sekkmer/slua-lsp/releases/latest)
and use **Extensions: Install from VSIX…**. Then open a `.lua`, `.luau`, or `.slua` file in VS Code 1.90 or later.
The extension includes its server and offline definitions.

The command palette provides:

- **SLua: Update LSL Definitions** — download and validate current definitions.
- **SLua: Show Active LSL Definitions** — inspect the selected definitions file.
- **SLua: Preview Preprocessed Source** — inspect generated source in a read-only tab.
- **SLua: Go to Original Source** — return from generated code to its source.

Definitions update automatically by default. Set `slua.definitionsPath` to use
your own YAML; automatic updates preserve that override. Failed updates retain
the last accepted definitions and are logged in **SLua LSP**.

## Command-line use

The CLI needs Node.js 22 or 24. Build it with
`pnpm exec node scripts/package-cli.mjs`, then run:

```sh
node .local/artifacts/cli/slua-lsp.mjs check script.luau --json
node .local/artifacts/cli/slua-lsp.mjs lookup ll.Say --json
node .local/artifacts/cli/slua-lsp.mjs hover script.luau --position 3:8 --json
node .local/artifacts/cli/slua-lsp.mjs preprocess script.luau --json
```

Copy the whole `cli/` artifact directory when relocating it; it includes the
bundle, definitions, builtins, source map, license notices, and checksums.
Ordinary checks run offline without VS Code or repository dependencies.

For coding agents, start with `capabilities` and `--help`, then use `check --json`,
source inspection, and proposed rename/quick-fix edits. Responses include source
hashes and UTF-16 ranges. No MCP server or interactive prompts are required.
The CLI never applies proposed edits or runs the checked source.

## Building and contributing

Use Node.js 22 or 24 and pnpm 10.27.0:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm exec node scripts/package-cli.mjs
pnpm exec node scripts/package-vsix.mjs
```

The VSIX is written to `.local/artifacts/`. Version 0.1.2 uses the stable VS Code channel. Building does not publish to a
marketplace. Tagged GitHub releases attach the pipeline-built VSIX and CLI bundle.

| Directory | Purpose |
| --- | --- |
| `slua-lsp-core` | Shared parser, definitions, analysis, source graph, and editor features |
| `slua-lsp-cli` | Standalone command-line interface |
| `slua-lsp-server` | Language Server Protocol process |
| `slua-lsp-client` | VS Code extension and packaged-host tests |
| `scripts` | Packaging, native comparison, integration tests, and benchmarks |
| `third_party/lsl-definitions` | Official Second Life definitions submodule |

The [development guide](docs/development.md) covers editor tests, pinned C++
comparisons, packaging, and the definitions update workflow. Portable regression
fixtures live with the package tests. Local probes, captures, caches, and build
products belong in ignored `.local/` directories.

SLua LSP provides bounded static analysis; it is not the complete Luau type
solver or a simulator. Experimental native syntax can depend on simulator
feature flags. Check deployment-specific behavior in Second Life.

Release notes are in the [changelog](slua-lsp-client/CHANGELOG.md).
Licensed under [MIT](LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.txt).
