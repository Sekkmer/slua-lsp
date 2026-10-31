# Development

Use Node.js 22 or 24 and pnpm 10.27.0:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test
```

Language logic lives in `slua-lsp-core`; CLI and server share it. Portable
regression inputs live with package tests. Generated data, local probes,
captures, and logs stay in ignored `.local/`.

`node scripts/setup-local.mjs` creates optional smoke fixtures and a launcher
without replacing existing data. `node scripts/quality.mjs --serial` records
separate lint/build/test statuses under `.local/logs/`.

## Packaging

```sh
pnpm exec node scripts/package-cli.mjs
pnpm exec node scripts/package-vsix.mjs
python3 scripts/unpack-vsix.py
node scripts/verify-candidate.mjs
```

Artifacts are written to `.local/artifacts/`. Packaging validates payloads,
versions, licenses, and hashes; atomic staging preserves the prior artifact
on failure. The VSIX uses the stable channel. Packaging does not publish.
Tags must match all package versions and the changelog. GitHub release jobs use
the Node 22 pipeline artifacts after all CI, native, and editor jobs pass.

The standalone CLI needs its neighboring YAML, builtin, and notice files.
Candidate verification checks offline relocation and packaged CLI/LSP behavior.

## Integration and editor tests

```sh
python3 -m unittest discover -s scripts/tests -v
node --test scripts/tests/artifact-publication.test.mjs
node scripts/test-definition-cache.mjs
node scripts/test-lsp-recovery.mjs
node scripts/test-source-modules.mjs
node scripts/test-source-input.mjs
```

Build the client test suite before packaged editor tests:

```sh
SLUA_EXTENSION_CANDIDATE="$PWD/.local/artifacts/vsix-unpacked/extension" \
  node slua-lsp-client/scripts/run-vscode-tests.cjs
```

On headless Linux, install Xvfb/D-Bus and prefix with `xvfb-run -a`.
Select `SLUA_VSCODE_VERSION=1.90.0` or `stable`, or set
`SLUA_VSCODE_EXECUTABLE` to a local executable. Tests use private profiles,
workspaces, runtime directories, and a session bus.
`run-vscode-cache-faults.cjs` tests startup cache failures.
Real extension-host tests are distinct from desktop interaction and simulator tests.

## Pinned native comparison

Install Python 3.10+, CMake, Ninja, and a C/C++ compiler, then prepare inputs:

```sh
export SLUA_ORACLE_LOCAL="$PWD/.local/oracle"
python3 scripts/prepare-oracle.py --download
python3 scripts/prepare-oracle.py --documentation --download
python3 scripts/prepare-oracle.py --preprocessor --download
python3 scripts/qualify-oracle.py
```

Offline preparation accepts `--archive /path/to/archive` instead of
`--download`. Downloads are explicit and archive hashes verified.
Qualification builds/reuses recorded tools, compares syntax/types/safe runtime
and the example corpus, and stops on failure. Set `SLUA_NATIVE_BIN` to select
prepared binaries for individual checks.

Native builds disable source regeneration and verify inputs afterward.
System headers/libraries are not a fully hermetic toolchain. Individual
`scripts/test-*.mjs` checks cover native contracts and CLI/LSP parity;
benchmarks and memory checks retain measurements locally.

## Definition updates

The definitions workflow checks official YAML daily or manually, validates API
deltas, and runs workspace, packaging, native, and editor checks before proposing
a draft pull request. It never automatically merges.

`scripts/update-bundled-definitions.mjs` validates and updates the submodule and
extension fallback. Runtime updates use content-addressed cache generations and
respect explicit overrides.
