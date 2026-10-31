"""Validate and stage the current versioned VSIX, preserving the prior test copy."""
import json
from pathlib import Path
from vsix_artifact import extract_candidate

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'slua-lsp-client/package.json').read_text())
version = package['version']
archive = root / f'.local/artifacts/slua-lsp-client-{version}.vsix'
destination = root / '.local/artifacts/vsix-unpacked'
extract_candidate(archive, destination, root / '.local/artifacts/vsix-contents.json', version)
print(destination / 'extension')
