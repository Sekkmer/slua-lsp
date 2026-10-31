"""Prepare the pinned public SLua source; network access is explicitly opt-in."""
import argparse
import json
import os
from pathlib import Path
import sys
import tarfile

from oracle_source import OracleError, prepare, read_pin


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-dir", type=Path)
    parser.add_argument("--archive", type=Path, help="Import an already downloaded pinned archive offline")
    parser.add_argument("--download", action="store_true", help="Explicitly download a missing pinned official archive")
    parser.add_argument("--check", action="store_true", help="Read-only verification; never create or repair files")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--documentation", action="store_true", help="Prepare the pinned official creator-docs snapshot instead of C++ source")
    selection.add_argument("--preprocessor", action="store_true", help="Prepare the pinned official plugin/preprocessor source instead of C++ source")
    args = parser.parse_args()
    try:
        pin_name = "preprocessor-source.json" if args.preprocessor else "oracle-docs.json" if args.documentation else "oracle-source.json"
        fallback = os.environ.get("SLUA_ORACLE_LOCAL", root / ".local")
        local = args.local_dir if args.local_dir is not None else Path(os.environ.get("SLUA_PREPROCESSOR_LOCAL", fallback) if args.preprocessor else fallback)
        result = prepare(local.absolute(), read_pin(root / "scripts" / pin_name),
                         archive_input=args.archive, download=args.download, check=args.check)
        print(json.dumps(result))
        return 0
    except (OracleError, OSError, ValueError, EOFError, tarfile.TarError) as error:
        print(json.dumps({"schema": "slua-lsp.oracle.v1", "status": "error", "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
