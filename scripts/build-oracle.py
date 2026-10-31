"""Build the pinned SLua C++ tools, with provenance and safe unchanged reuse."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tarfile
import uuid

from oracle_source import OracleError, digest, exclusive, prepare, read_pin

BINARIES = ("slua-compile", "slua-analyze", "slua")
TARGETS = ("Luau.Compile.CLI", "Luau.Analyze.CLI", "Luau.Repl.CLI")


def write_json(path: Path, value: dict) -> None:
    fd, name = tempfile.mkstemp(prefix=".oracle-record-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(value, indent=2) + "\n")
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def toolchain() -> dict:
    result = {}
    for name, executable in (("cmake", "cmake"), ("ninja", "ninja"),
                             ("cc", os.environ.get("CC", "cc")), ("cxx", os.environ.get("CXX", "c++"))):
        path = shutil.which(executable)
        if path is None:
            raise OracleError(f"Missing toolchain executable: {executable}")
        version = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15, check=True)
        result[name] = {"path": path, "sha256": digest(Path(path)), "version": version.stdout.splitlines()[0]}
    return result


def build(local: Path, build_dir: Path, pin: dict, *, plan: bool = False) -> dict:
    source = prepare(local, pin, check=True)
    tools = toolchain()
    try:
        slots = int(os.environ.get("AOF_RESOURCE_CPU_SLOTS", "1"))
    except ValueError as error:
        raise OracleError("AOF_RESOURCE_CPU_SLOTS must be a positive integer") from error
    if slots < 1:
        raise OracleError("AOF_RESOURCE_CPU_SLOTS must be positive")
    slots = min(slots, 4)
    commands = [[tools["cmake"]["path"], "-S", source["root"], "-B", str(build_dir), "-G", "Ninja",
                 "-DCMAKE_BUILD_TYPE=Release", "-DLUAU_BUILD_TESTS=OFF", "-DTAILSLIDE_SKIP_GEN=ON",
                 f"-DCMAKE_MAKE_PROGRAM={tools['ninja']['path']}",
                 f"-DCMAKE_C_COMPILER={tools['cc']['path']}", f"-DCMAKE_CXX_COMPILER={tools['cxx']['path']}"],
                [tools["cmake"]["path"], "--build", str(build_dir), "--target", *TARGETS, "--parallel", str(slots)]]
    inputs = {"schema": 1, "pin": pin, "sourceContentSha256": source["contentSha256"],
              "sourceRoot": source["root"], "toolchain": tools, "configure": commands[0],
              "buildEnvironment": {name: os.environ.get(name) for name in (
                  "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "CMAKE_TOOLCHAIN_FILE", "CMAKE_PREFIX_PATH",
                  "CMAKE_C_COMPILER_LAUNCHER", "CMAKE_CXX_COMPILER_LAUNCHER", "CMAKE_GENERATOR_PLATFORM",
                  "CMAKE_GENERATOR_TOOLSET", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET", "CPATH", "C_INCLUDE_PATH",
                  "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "COMPILER_PATH", "GCC_EXEC_PREFIX", "LD_LIBRARY_PATH")}}
    input_hash = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    result = {"schema": "slua-lsp.oracle.v1", "status": "plan", "source": source,
              "inputSha256": input_hash, "inputs": inputs, "commands": commands,
              "buildDirectory": str(build_dir), "phases": [],
              "scope": "Tool build provenance only; syntax/type/runtime qualification is a separate gate."}
    if plan:
        return result
    build_dir.parent.mkdir(parents=True, exist_ok=True)
    if build_dir.is_symlink():
        raise OracleError("Build directory must not be a symbolic link")
    with exclusive(build_dir.parent / f".{build_dir.name}.oracle.lock"):
        record_path = build_dir / "oracle-build.json"
        intent_path = build_dir / "oracle-inputs.json"
        if record_path.exists():
            previous = json.loads(record_path.read_text())
            if (not isinstance(previous, dict) or previous.get("schema") != "slua-lsp.oracle.v1"
                    or previous.get("status") != "built" or not isinstance(previous.get("binaries"), dict)
                    or not isinstance(previous.get("buildReport"), str)):
                raise OracleError("Invalid completed-build record; existing data was preserved")
            if previous.get("inputSha256") != input_hash:
                raise OracleError("Recorded build inputs changed; preserve this build and select a new --build-dir")
            if not all((build_dir / name).is_file() and not (build_dir / name).is_symlink()
                       and os.access(build_dir / name, os.X_OK)
                       and digest(build_dir / name) == previous.get("binaries", {}).get(name) for name in BINARIES):
                raise OracleError("Recorded binary content/permissions changed; preserve this build and select a new --build-dir")
            result.update(status="reused", binaries=previous["binaries"], buildReport=previous["buildReport"])
            return result
        if intent_path.exists():
            intent = json.loads(intent_path.read_text())
            if not isinstance(intent, dict) or intent.get("inputSha256") != input_hash:
                raise OracleError("Incomplete build belongs to different inputs; select a new --build-dir")
        elif build_dir.exists() and any(build_dir.iterdir()):
            raise OracleError("Existing unrecorded build preserved; reuse its separately qualified binaries or select an empty --build-dir")
        build_dir.mkdir(parents=True, exist_ok=True)
        write_json(intent_path, {"inputSha256": input_hash, "inputs": inputs})
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
        logs = local / "logs" / "cpp-oracle" / stamp
        logs.mkdir(parents=True)
        report_path = logs / "results.json"
        result.update(status="building", buildReport=str(report_path))
        write_json(report_path, result)
        for index, command in enumerate(commands):
            start = time.monotonic()
            log_path = logs / f"{index}.log"
            try:
                with log_path.open("w") as log:
                    process = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
            except (OSError, subprocess.SubprocessError) as error:
                result["status"] = "failed"
                result["phases"].append({"argv": command, "exit": None, "error": str(error),
                                         "seconds": time.monotonic() - start, "log": str(log_path)})
                write_json(report_path, result)
                raise OracleError(f"Native build phase {index} launch failed; evidence: {report_path}") from error
            result["phases"].append({"argv": command, "exit": process.returncode,
                                     "seconds": time.monotonic() - start, "log": str(log_path)})
            result["status"] = "failed" if process.returncode else "building"
            write_json(report_path, result)
            if process.returncode:
                raise OracleError(f"Native build phase {index} failed with exit {process.returncode}; evidence: {report_path}")
        if not all((build_dir / name).is_file() and not (build_dir / name).is_symlink()
                   and os.access(build_dir / name, os.X_OK) for name in BINARIES):
            result.update(status="failed", outputError="Build did not produce every executable")
            write_json(report_path, result)
            raise OracleError(f"Build did not produce every executable; evidence: {report_path}")
        # Tailslide can otherwise regenerate checked-in scanner/parser inputs.
        # Do not certify a build that changed the verified source in place.
        try:
            after = prepare(local, pin, check=True)
            if after["contentSha256"] != source["contentSha256"]:
                raise OracleError("Build changed verified source content")
        except (OracleError, OSError, tarfile.TarError) as error:
            result.update(status="failed", sourceVerificationError=str(error))
            write_json(report_path, result)
            raise OracleError(f"Post-build source verification failed: {error}; evidence: {report_path}") from error
        result.update(status="built", binaries={name: digest(build_dir / name) for name in BINARIES})
        write_json(report_path, result)
        write_json(record_path, result)
        return result


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-dir", type=Path, default=Path(os.environ.get("SLUA_ORACLE_LOCAL", root / ".local")))
    parser.add_argument("--build-dir", type=Path, help="Empty or matching recorded build; defaults to LOCAL/build/slua-oracle")
    parser.add_argument("--plan", action="store_true", help="Verify source/toolchain and print commands without building or writing")
    args = parser.parse_args()
    local = args.local_dir.absolute()
    try:
        result = build(local, (args.build_dir or local / "build/slua-oracle").absolute(),
                       read_pin(root / "scripts/oracle-source.json"), plan=args.plan)
        print(json.dumps(result))
        return 0
    except (OracleError, OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(json.dumps({"schema": "slua-lsp.oracle.v1", "status": "error", "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
