"""Run the prepared local native qualification serially, without downloads."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from oracle_source import OracleError, read_pin
from importlib.util import module_from_spec, spec_from_file_location


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-dir", type=Path, default=Path(os.environ.get("SLUA_ORACLE_LOCAL", root / ".local")))
    args = parser.parse_args()
    local = args.local_dir.absolute()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    logs = root / ".local/logs/oracle-qualification" / stamp
    logs.mkdir(parents=True)
    # Share the atomic JSON writer with the build recorder.
    spec = spec_from_file_location("oracle_build", root / "scripts/build-oracle.py")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    report = {"schema": "slua-lsp.oracle-suite.v1", "status": "running", "localDirectory": str(local),
              "sourcePin": read_pin(root / "scripts/oracle-source.json"), "phases": [],
              "scope": "Prepared pinned C++ build/reuse, strict native cases and safe runtime profiles, documentation/probe parser corpus. No downloads, viewer/FS IPC or host/world effects."}
    env = dict(os.environ, SLUA_ORACLE_LOCAL=str(local), SLUA_CORPUS_LOCAL=str(local),
               SLUA_NATIVE_BIN=str(local / "build/slua-oracle"), SLUA_CORPUS_OUTPUT=str(local / "oracle-corpus"))
    commands = [("build", [sys.executable, str(root / "scripts/build-oracle.py")]),
                ("native", ["node", str(root / "scripts/qualify-native.mjs")]),
                ("corpus", ["node", str(root / "scripts/oracle-corpus.mjs")])]
    for name, command in commands:
        log_path = logs / f"{name}.log"
        start = time.monotonic()
        try:
            with log_path.open("w") as log:
                result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            phase = {"name": name, "exit": result.returncode, "seconds": time.monotonic() - start, "log": str(log_path)}
        except OSError as error:
            phase = {"name": name, "exit": None, "error": str(error), "seconds": time.monotonic() - start, "log": str(log_path)}
        report["phases"].append(phase)
        report["status"] = "failed" if phase["exit"] != 0 else "running"
        module.write_json(logs / "results.json", report)
        print(json.dumps(phase), flush=True)
        if phase["exit"] != 0:
            print(json.dumps({"status": "failed", "report": str(logs / "results.json")}))
            return 1
    report["status"] = "passed"
    module.write_json(logs / "results.json", report)
    print(json.dumps({"status": "passed", "report": str(logs / "results.json")}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OracleError, OSError, ValueError) as error:
        print(json.dumps({"schema": "slua-lsp.oracle-suite.v1", "status": "error", "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
