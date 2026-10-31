"""Verified, offline-first preparation of the pinned local SLua oracle source.

No old research JSON, package dependency, Git clone or live simulator is needed.
Extraction only publishes a new directory; existing source is verified in place.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile
import urllib.request


class OracleError(Exception):
    pass


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            result.update(data)
    return result.hexdigest()


def read_pin(path: Path) -> dict:
    pin = json.loads(path.read_text())
    if not isinstance(pin, dict):
        raise OracleError("Source pin must be an object")
    commit = pin.get("commit", "")
    if (pin.get("schema") != 1 or not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit)
            or not isinstance(pin.get("archive_sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", pin.get("archive_sha256", ""))
            or pin.get("repository") not in ("https://github.com/secondlife/slua", "https://github.com/secondlife/create",
                                              "https://github.com/secondlife/sl-vscode-plugin")
            or pin.get("archive_url") != f"https://codeload.github.com/secondlife/{source_name(pin)}/tar.gz/{commit}"):
        raise OracleError("Invalid official oracle source pin")
    for name in ("files", "maximum_archive_bytes", "maximum_unpacked_bytes"):
        if type(pin.get(name)) is not int or pin[name] <= 0:
            raise OracleError(f"Invalid pin limit: {name}")
    return pin


def source_name(pin: dict) -> str:
    return pin["repository"].rsplit("/", 1)[-1]


def inventory(archive: Path, pin: dict) -> list[dict]:
    if archive.is_symlink() or not archive.is_file():
        raise OracleError(f"Expected a regular source archive: {archive}")
    if archive.stat().st_size > pin["maximum_archive_bytes"] or digest(archive) != pin["archive_sha256"]:
        raise OracleError("Source archive size/hash does not match the tracked pin")
    prefix = f"{source_name(pin)}-{pin['commit']}"
    entries, seen, total = [], set(), 0
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or not path.parts or path.parts[0] != prefix
                    or not (member.isfile() or member.isdir())):
                raise OracleError(f"Unsupported archive entry: {member.name}")
            relative = path.relative_to(prefix).as_posix()
            if relative in seen:
                raise OracleError(f"Duplicate archive entry: {member.name}")
            seen.add(relative)
            if member.isdir():
                continue
            total += member.size
            if member.size < 0 or total > pin["maximum_unpacked_bytes"]:
                raise OracleError("Unpacked source exceeds the tracked size limit")
            stream = source.extractfile(member)
            assert stream is not None
            content_hash = hashlib.sha256()
            for data in iter(lambda: stream.read(1024 * 1024), b""):
                content_hash.update(data)
            entries.append({"path": relative, "bytes": member.size,
                            "sha256": content_hash.hexdigest(), "executable": bool(member.mode & 0o111)})
    if len(entries) != pin["files"]:
        raise OracleError(f"Source file count differs from the pin: {len(entries)} != {pin['files']}")
    return sorted(entries, key=lambda entry: entry["path"])


def verify_tree(directory: Path, entries: list[dict]) -> list[str]:
    if directory.is_symlink() or not directory.is_dir():
        raise OracleError(f"Expected a real source directory: {directory}")
    expected = {entry["path"]: entry for entry in entries}
    actual, modes = set(), []
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            path = Path(parent) / name
            if path.is_symlink():
                raise OracleError(f"Source contains a symbolic link: {path}")
        for name in files:
            path = Path(parent) / name
            relative = path.relative_to(directory).as_posix()
            actual.add(relative)
            entry = expected.get(relative)
            if (not stat.S_ISREG(path.stat().st_mode) or entry is None
                    or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]):
                raise OracleError(f"Source has extra or changed content: {relative}; existing data was preserved")
            if bool(path.stat().st_mode & 0o111) != entry["executable"]:
                modes.append(relative)
    missing = set(expected) - actual
    if missing:
        raise OracleError(f"Source is incomplete: {sorted(missing)[0]}; existing data was preserved")
    return modes


@contextlib.contextmanager
def exclusive(path: Path):
    # Keep an acquired lock's inode stable across runs; no stale lockfile deletion.
    import fcntl
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise OracleError(f"Another oracle operation owns {path}") from error
        yield


def prepare(local: Path, pin: dict, *, archive_input: Path | None = None,
            download: bool = False, check: bool = False) -> dict:
    if check and (archive_input is not None or download):
        raise OracleError("--check is read-only and cannot import or download an archive")
    upstream = local / "upstream"
    directory = upstream / f"{source_name(pin)}-{pin['commit']}"
    archive = upstream / f"{directory.name}.tar.gz"

    def observe(entries: list[dict], created: bool) -> dict:
        modes = verify_tree(directory, entries)
        content = [{key: entry[key] for key in ("path", "bytes", "sha256")} for entry in entries]
        content_hash = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return {"schema": "slua-lsp.oracle.v1", "status": "prepared" if created else "verified",
                "commit": pin["commit"], "archive": str(archive), "archiveSha256": pin["archive_sha256"],
                "root": str(directory), "files": len(entries), "contentSha256": content_hash,
                "executableModeDifferences": modes,
                "scope": "Complete regular-file content checked against the pinned archive; executable-bit differences reported, existing files never repaired."}

    if check:
        return observe(inventory(archive, pin), False)
    upstream.mkdir(parents=True, exist_ok=True)
    if upstream.is_symlink():
        raise OracleError("Source cache must not be a symbolic link")
    with exclusive(upstream / ".oracle.lock"):
        if archive.exists() or archive.is_symlink():
            entries = inventory(archive, pin)  # Never replace an invalid existing archive.
        else:
            if archive_input is None and not download:
                raise OracleError("Pinned archive is missing; use --archive PATH for offline import or --download before reserving build resources")
            fd, temporary = tempfile.mkstemp(prefix=".oracle-download-", dir=upstream)
            staged = Path(temporary)
            try:
                with os.fdopen(fd, "wb") as target:
                    if archive_input is not None:
                        if archive_input.is_symlink() or not archive_input.is_file():
                            raise OracleError("Offline import requires a regular archive file")
                        stream = archive_input.open("rb")
                    else:
                        request = urllib.request.Request(pin["archive_url"], headers={"User-Agent": "slua-lsp-native-preparation/1"})
                        stream = urllib.request.urlopen(request, timeout=30)
                        if stream.geturl() != pin["archive_url"]:
                            stream.close()
                            raise OracleError("Oracle download redirected away from the pinned official URL")
                    with stream:
                        size = 0
                        for data in iter(lambda: stream.read(1024 * 1024), b""):
                            size += len(data)
                            if size > pin["maximum_archive_bytes"]:
                                raise OracleError("Archive download/import exceeds the tracked size limit")
                            target.write(data)
                entries = inventory(staged, pin)
                os.link(staged, archive)  # Exclusive publication; never replace another writer.
            finally:
                staged.unlink(missing_ok=True)
        if directory.exists() or directory.is_symlink():
            return observe(entries, False)
        staging = Path(tempfile.mkdtemp(prefix=".oracle-extract-", dir=upstream))
        try:
            by_path = {entry["path"]: entry for entry in entries}
            with tarfile.open(archive, "r:gz") as source:
                for member in source:
                    if not member.isfile():
                        continue
                    relative = PurePosixPath(member.name).relative_to(directory.name).as_posix()
                    entry = by_path[relative]
                    destination = staging / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    stream = source.extractfile(member)
                    assert stream is not None
                    with destination.open("xb") as target:
                        shutil.copyfileobj(stream, target)
                    destination.chmod(0o755 if entry["executable"] else 0o644)
            verify_tree(staging, entries)
            staging.rename(directory)
        finally:
            if staging.exists():
                shutil.rmtree(staging)  # Only this invocation's unpublished temporary tree.
        return observe(entries, True)
