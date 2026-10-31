"""Disposable archive and failed-activation contracts; no GUI or external inputs."""
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vsix_artifact as artifact

class VsixArtifact(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='slua-vsix-contract-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / 'candidate.vsix'
        self.destination = self.root / 'unpacked'
        self.metadata = self.root / 'contents.json'
        self.files = {name: ('fixture:' + name).encode() for name in artifact.FILES}
        self.files['extension/out/extension.js'] = b'FIXTURE_BODY_EXTENSION'
        self.files['extension/package.json'] = json.dumps({'name': 'slua-lsp-client', 'publisher': 'Sekkmer', 'version': '0.1.0'}).encode()
        self.files['extension.vsixmanifest'] = b'<PackageManifest><Metadata><Identity Id="slua-lsp-client" Publisher="Sekkmer" Version="0.1.0"/><Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"/></Properties></Metadata></PackageManifest>'

    def write(self, changes=None, extra=(), remove=()):
        files = dict(self.files, **(changes or {}))
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_STORED) as archive:
                for name, data in files.items():
                    if name not in remove:
                        archive.writestr(name, data)
                for name, data in extra:
                    archive.writestr(name, data)
        return self.archive

    def existing(self):
        self.destination.mkdir()
        (self.destination / 'old').write_text('old extraction')
        self.metadata.write_text('old metadata')

    def assert_old(self):
        self.assertEqual((self.destination / 'old').read_text(), 'old extraction')
        self.assertEqual(self.metadata.read_text(), 'old metadata')

    def test_valid_complete_payload_and_version(self):
        self.write()
        report, files = artifact.inspect_vsix(self.archive, '0.1.0')
        self.assertEqual(len(report['inventory']), 17)
        self.assertTrue(report['preRelease'])
        self.assertEqual(files, self.files)
        with self.assertRaisesRegex(ValueError, 'version mismatch'):
            artifact.inspect_vsix(self.archive, '0.2.0')

    def test_unsafe_missing_unknown_duplicate_and_case_colliding_entries(self):
        for name in ['../outside', '/absolute', 'extension/../outside', 'extension\\outside', 'C:/outside', './outside']:
            with self.subTest(name=name):
                self.write(extra=[(name, b'unsafe')])
                with self.assertRaisesRegex(ValueError, 'Unsafe VSIX path'):
                    artifact.inspect_vsix(self.archive)
        self.write(remove=['extension/out/extension.js'])
        with self.assertRaisesRegex(ValueError, 'Missing VSIX files'):
            artifact.inspect_vsix(self.archive)
        for name, message in [('extension/private.env', 'Unexpected'), ('extension/package.json', 'Duplicate'), ('extension/Package.json', 'Duplicate')]:
            with self.subTest(name=name):
                self.write(extra=[(name, b'unexpected')])
                with self.assertRaisesRegex(ValueError, message):
                    artifact.inspect_vsix(self.archive)

    def test_symlink_and_special_file_entries_are_refused(self):
        for mode in [stat.S_IFLNK, stat.S_IFIFO]:
            name = zipfile.ZipInfo('extension/out/extension.js')
            name.create_system = 3
            name.external_attr = (mode | 0o777) << 16
            self.write(remove=['extension/out/extension.js'], extra=[(name, b'../outside')])
            with self.assertRaisesRegex(ValueError, 'Non-regular'):
                artifact.inspect_vsix(self.archive)

    def test_crc_corruption_is_detected_before_the_old_extraction_moves(self):
        self.existing()
        self.write()
        data = self.archive.read_bytes().replace(b'FIXTURE_BODY_EXTENSION', b'BROKEN__BODY_EXTENSION')
        self.archive.write_bytes(data)
        with self.assertRaises(zipfile.BadZipFile):
            artifact.extract_candidate(self.archive, self.destination, self.metadata)
        self.assert_old()
        self.assertFalse((self.root / 'history').exists())

    def test_nonregular_archive_is_refused_without_waiting_for_a_producer(self):
        os.mkfifo(self.archive)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            artifact.inspect_vsix(self.archive)

    def test_limits_and_identity_mismatch_are_refused(self):
        self.write()
        for name in ['MAX_ARCHIVE', 'MAX_FILE', 'MAX_TOTAL']:
            with self.subTest(limit=name), patch.object(artifact, name, 1):
                with self.assertRaisesRegex(ValueError, 'limit'):
                    artifact.inspect_vsix(self.archive)
        self.write(changes={'extension.vsixmanifest': self.files['extension.vsixmanifest'].replace(b'Version="0.1.0"', b'Version="9.9.9"')})
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            artifact.inspect_vsix(self.archive)

    def test_valid_activation_preserves_old_extraction_and_records_exact_inventory(self):
        self.existing()
        self.write()
        report = artifact.extract_candidate(self.archive, self.destination, self.metadata, '0.1.0')
        self.assertEqual(json.loads(self.metadata.read_text()), report)
        self.assertEqual((self.destination / 'extension/out/extension.js').read_bytes(), self.files['extension/out/extension.js'])
        [history] = list((self.root / 'history').iterdir())
        self.assertEqual((history / 'old').read_text(), 'old extraction')

    def test_directory_or_metadata_activation_failure_restores_old_state(self):
        for failure in ['directory', 'metadata']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=self.root) as temp:
                root = Path(temp)
                destination, metadata = root / 'unpacked', root / 'contents.json'
                destination.mkdir()
                (destination / 'old').write_text('old')
                metadata.write_text('old metadata')
                self.write()
                def replace(source, target):
                    if ((failure == 'directory' and str(source).split('/')[-1].startswith('.vsix-extract-') and target == destination)
                            or (failure == 'metadata' and target == metadata)):
                        raise OSError('simulated activation failure')
                    os.replace(source, target)
                with self.assertRaisesRegex(RuntimeError, 'staged evidence retained'):
                    artifact.extract_candidate(self.archive, destination, metadata, replace=replace)
                self.assertEqual((destination / 'old').read_text(), 'old')
                self.assertEqual(metadata.read_text(), 'old metadata')
                self.assertEqual(len(list(root.glob('.vsix-extract-*'))), 1)
                self.assertFalse((root / '.vsix-candidate.lock').exists())

    def test_concurrent_lock_is_preserved_and_symlink_destination_is_rejected(self):
        self.write()
        with artifact.candidate_lock(self.root):
            owner = (self.root / '.vsix-candidate.lock/owner.json').read_text()
            with self.assertRaises(FileExistsError):
                artifact.extract_candidate(self.archive, self.destination, self.metadata)
            self.assertEqual((self.root / '.vsix-candidate.lock/owner.json').read_text(), owner)
        self.destination.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'staged evidence retained'):
            artifact.extract_candidate(self.archive, self.destination, self.metadata)
        self.assertTrue(self.destination.is_symlink())

if __name__ == '__main__':
    unittest.main()
