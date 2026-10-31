"""Validate a complete local VSIX before publishing or extracting any of it."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import uuid
import zipfile
import xml.etree.ElementTree as ET

FILES = frozenset({
    'extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json',
    'extension/media/icon.png',
    'extension/language-configuration.json', 'extension/bundled-licenses.json',
    'extension/THIRD_PARTY_NOTICES.txt', 'extension/readme.md', 'extension/changelog.md', 'extension/LICENSE.txt',
    'extension/syntaxes/luau.tmLanguage.json', 'extension/out/extension.js.map',
    'extension/out/extension.js', 'extension/third_party/lsl-definitions/lsl_definitions.yaml',
    'extension/third_party/lsl-definitions/LICENSE', 'extension/server/out/index.js.map',
    'extension/server/out/index.js', 'extension/server/out/builtins.yaml',
})
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_ICON = 1024 * 1024

def inspect_vsix(archive, expected_version=None):
    archive = Path(archive)
    flags = os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(archive, flags), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('VSIX archive must be a regular file')
        if info.st_size > MAX_ARCHIVE:
            raise ValueError('VSIX archive exceeds size limit')
        raw = source.read(MAX_ARCHIVE + 1)
    if len(raw) > MAX_ARCHIVE:
        raise ValueError('VSIX archive exceeds size limit')
    files = {}
    names = set()
    with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
        entries = bundle.infolist()
        if len(entries) > 64 or sum(entry.file_size for entry in entries) > MAX_TOTAL:
            raise ValueError('VSIX expanded inventory exceeds limits')
        for entry in entries:
            name = entry.filename.rstrip('/') if entry.is_dir() else entry.filename
            parts = PurePosixPath(name)
            if (not name or entry.orig_filename != entry.filename or '\\' in name
                    or parts.is_absolute() or any(p in ('.', '..', '') for p in name.split('/'))
                    or ':' in name or '\x00' in name):
                raise ValueError(f'Unsafe VSIX path: {entry.filename!r}')
            if name.casefold() in names:
                raise ValueError(f'Duplicate/case-colliding VSIX path: {name}')
            names.add(name.casefold())
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if kind not in ((0, stat.S_IFDIR) if entry.is_dir() else (0, stat.S_IFREG)):
                raise ValueError(f'Non-regular VSIX entry: {name}')
            if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError(f'Unsupported VSIX encoding: {name}')
            if entry.is_dir():
                if not any(p.startswith(name + '/') for p in FILES):
                    raise ValueError(f'Unexpected VSIX directory: {name}')
                continue
            if name not in FILES:
                raise ValueError(f'Unexpected VSIX file: {name}')
            if entry.file_size > MAX_FILE:
                raise ValueError(f'VSIX entry exceeds size limit: {name}')
            files[name] = bundle.read(entry)  # Checks the complete payload and CRC.
        if set(files) != FILES:
            raise ValueError(f'Missing VSIX files: {sorted(FILES - set(files))}')
    package = json.loads(files['extension/package.json'])
    if package.get('icon') != 'media/icon.png':
        raise ValueError('VSIX icon must reference the packaged PNG')
    if len(files['extension/media/icon.png']) > MAX_ICON:
        raise ValueError('VSIX icon exceeds Marketplace size limit of 1024 KB')
    version = package.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Invalid packaged extension version')
    if expected_version is not None and version != expected_version:
        raise ValueError(f'VSIX version mismatch: {version} != {expected_version}')
    if len(files['extension.vsixmanifest']) > 65536:
        raise ValueError('VSIX XML manifest exceeds limit')
    xml = ET.fromstring(files['extension.vsixmanifest'])
    identities = [x for x in xml.iter() if x.tag.split('}')[-1] == 'Identity']
    if len(identities) != 1 or any(identities[0].get(key) != package.get(field) for key, field in [('Version', 'version'), ('Id', 'name'), ('Publisher', 'publisher')]):
        raise ValueError('VSIX XML/package identity mismatch')
    prerelease = any(x.tag.split('}')[-1] == 'Property' and x.get('Id') == 'Microsoft.VisualStudio.Code.PreRelease' and x.get('Value') == 'true' for x in xml.iter())
    report = {'sha256': hashlib.sha256(raw).hexdigest(), 'files': sorted(files),
              'identity': {key: package[key] for key in ('name', 'publisher', 'version')},
              'preRelease': prerelease,
              'inventory': [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(files.items())]}
    return report, files

@contextmanager
def candidate_lock(parent):
    lock = Path(parent) / '.vsix-candidate.lock'
    lock.mkdir()  # Never reclaim a different or stale owner automatically.
    try:
        (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'startedAt': datetime.now(timezone.utc).isoformat()}) + '\n')
        yield
    finally:
        shutil.rmtree(lock)

def extract_candidate(archive, destination, metadata, expected_version=None, replace=os.replace):
    destination, metadata = Path(destination), Path(metadata)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with candidate_lock(destination.parent):
        report, files = inspect_vsix(archive, expected_version)
        stage = Path(tempfile.mkdtemp(prefix='.vsix-extract-', dir=destination.parent))
        staged_metadata = destination.parent / ('.vsix-contents-' + uuid.uuid4().hex + '.json')
        previous = None
        activated = False
        try:
            for name, data in files.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            staged_metadata.write_text(json.dumps(report, indent=2) + '\n')
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or not destination.is_dir():
                    raise ValueError('Previous VSIX extraction must be a real directory')
                history = destination.parent / 'history'
                history.mkdir(exist_ok=True)
                previous = history / ('unpacked-' + uuid.uuid4().hex)
                replace(destination, previous)
            replace(stage, destination)
            activated = True
            replace(staged_metadata, metadata)
        except Exception as error:
            try:
                if activated:
                    replace(destination, stage)
                if previous:
                    replace(previous, destination)
            except Exception as rollback:
                raise RuntimeError(f'VSIX extraction and rollback failed; inspect {previous}, {stage} and {staged_metadata}') from rollback
            raise RuntimeError(f'VSIX extraction failed; staged evidence retained at {stage} and {staged_metadata}') from error
        return report

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--version')
    args = parser.parse_args()
    print(json.dumps(inspect_vsix(args.archive, args.version)[0]))
