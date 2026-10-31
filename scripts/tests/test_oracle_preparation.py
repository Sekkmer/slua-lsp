"""Contract tests with disposable archives and mocked build tools, not C++ builds."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from oracle_source import OracleError, digest, exclusive, inventory, prepare, read_pin

spec = importlib.util.spec_from_file_location("oracle_build", SCRIPTS / "build-oracle.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class OraclePreparation(unittest.TestCase):
    def setUp(self):
        parent = SCRIPTS.parent / ".local"
        parent.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="oracle-contract-", dir=parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.local = self.root / "local"
        self.archive = self.root / "download.tar.gz"
        self.pin = {"schema": 1, "repository": "https://github.com/secondlife/slua", "commit": "a" * 40,
                    "archive_url": "https://codeload.github.com/secondlife/slua/tar.gz/" + "a" * 40,
                    "archive_sha256": "", "files": 2, "maximum_archive_bytes": 1024 * 1024,
                    "maximum_unpacked_bytes": 1024 * 1024}
        self.prefix = "slua-" + "a" * 40
        self.make_archive([(f"{self.prefix}/CMakeLists.txt", b"# fixture\n", 0o644),
                           (f"{self.prefix}/tools/check.sh", b"#!/bin/sh\n", 0o755)])

    def make_archive(self, items):
        with tarfile.open(self.archive, "w:gz") as output:
            for name, content, mode in items:
                member = tarfile.TarInfo(name)
                member.mode = mode
                if isinstance(content, bytes):
                    member.size = len(content)
                    output.addfile(member, io.BytesIO(content))
                else:
                    member.type = content[0]
                    member.linkname = "../outside"
                    output.addfile(member)
        self.pin["archive_sha256"] = digest(self.archive)

    def prepared(self):
        return prepare(self.local, self.pin, archive_input=self.archive)

    def test_fresh_offline_import_and_reuse_preserve_bytes_and_modes(self):
        first = self.prepared()
        self.assertEqual(first["status"], "prepared")
        self.assertEqual(first["files"], 2)
        self.assertEqual(first["executableModeDifferences"], [])
        before = {str(p): (p.stat().st_mtime_ns, digest(p)) for p in self.local.rglob("*") if p.is_file()}
        with patch("urllib.request.urlopen", side_effect=AssertionError("network not permitted")):
            second = prepare(self.local, self.pin)
        self.assertEqual(second["status"], "verified")
        self.assertEqual(second["contentSha256"], first["contentSha256"])
        self.assertEqual(before, {str(p): (p.stat().st_mtime_ns, digest(p)) for p in self.local.rglob("*") if p.is_file()})

    def test_check_is_read_only_even_when_missing(self):
        with self.assertRaises(OracleError):
            prepare(self.local, self.pin, check=True)
        self.assertFalse(self.local.exists())
        with self.assertRaises(OracleError):
            prepare(self.local, self.pin, check=True, download=True)

    def test_plugin_source_has_separate_verified_cache_from_native_source(self):
        native_pin = dict(self.pin)
        native = self.prepared()
        self.prefix = "sl-vscode-plugin-" + "a" * 40
        self.pin.update(repository="https://github.com/secondlife/sl-vscode-plugin",
                        archive_url="https://codeload.github.com/secondlife/sl-vscode-plugin/tar.gz/" + "a" * 40)
        self.make_archive([(f"{self.prefix}/LICENSE", b"fixture license\n", 0o644),
                           (f"{self.prefix}/packages/preprocessor.ts", b"export {};\n", 0o644)])
        pin_file = self.root / "plugin-pin.json"
        pin_file.write_text(json.dumps(self.pin))
        read_pin(pin_file)
        with self.assertRaises(OracleError):
            prepare(self.local, self.pin, check=True)
        plugin = self.prepared()
        self.assertNotEqual(plugin["root"], native["root"])
        self.assertEqual(prepare(self.local, self.pin, check=True)["contentSha256"], plugin["contentSha256"])
        self.assertEqual(prepare(self.local, native_pin, check=True)["contentSha256"], native["contentSha256"])
        self.assertEqual((Path(native["root"]) / "CMakeLists.txt").read_text(), "# fixture\n")

    def test_missing_archive_never_downloads_implicitly(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("network not permitted")):
            with self.assertRaisesRegex(OracleError, "missing"):
                prepare(self.local, self.pin)

    def test_wrong_hash_keeps_existing_cache_unchanged(self):
        result = self.prepared()
        archive = Path(result["archive"])
        archive.write_bytes(b"corrupt cached archive")
        with self.assertRaisesRegex(OracleError, "size/hash"):
            prepare(self.local, self.pin, archive_input=self.archive, download=True)
        self.assertEqual(archive.read_bytes(), b"corrupt cached archive")
        self.assertEqual((Path(result["root"]) / "CMakeLists.txt").read_bytes(), b"# fixture\n")

    def test_modified_missing_and_extra_source_are_preserved(self):
        result = self.prepared()
        source = Path(result["root"])
        path = source / "CMakeLists.txt"
        for kind in ("modified", "missing", "extra"):
            with self.subTest(kind=kind):
                if kind == "modified":
                    path.write_bytes(b"operator WIP\n")
                elif kind == "missing":
                    path.unlink()
                else:
                    (source / "WIP.txt").write_text("operator evidence")
                with self.assertRaises(OracleError):
                    prepare(self.local, self.pin)
                if kind == "modified":
                    self.assertEqual(path.read_bytes(), b"operator WIP\n")
                    path.write_bytes(b"# fixture\n")
                elif kind == "missing":
                    self.assertFalse(path.exists())
                    path.write_bytes(b"# fixture\n")
                else:
                    self.assertEqual((source / "WIP.txt").read_text(), "operator evidence")

    def test_mode_differences_reported_without_repair(self):
        first = self.prepared()
        path = Path(first["root"]) / "tools/check.sh"
        path.chmod(0o644)
        observed = prepare(self.local, self.pin, check=True)
        self.assertEqual(observed["executableModeDifferences"], ["tools/check.sh"])
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_source_symlink_cannot_escape_verification(self):
        result = self.prepared()
        path = Path(result["root"]) / "CMakeLists.txt"
        path.unlink()
        outside = self.root / "outside.txt"
        outside.write_text("private")
        path.symlink_to(outside)
        with self.assertRaisesRegex(OracleError, "symbolic link"):
            prepare(self.local, self.pin, check=True)
        self.assertEqual(outside.read_text(), "private")

    def test_tar_traversal_links_devices_and_wrong_roots_rejected(self):
        for name, kind in [(f"{self.prefix}/../outside", b"content"),
                           ("/absolute", b"content"), ("wrong-root/source", b"content"),
                           (f"{self.prefix}/link", (tarfile.SYMTYPE,)),
                           (f"{self.prefix}/hardlink", (tarfile.LNKTYPE,)),
                           (f"{self.prefix}/device", (tarfile.CHRTYPE,))]:
            with self.subTest(name=name):
                self.make_archive([(name, kind, 0o644)])
                with self.assertRaisesRegex(OracleError, "Unsupported"):
                    inventory(self.archive, self.pin)
        self.assertFalse((self.root / "outside").exists())

    def test_duplicate_member_and_wrong_count_rejected(self):
        self.make_archive([(f"{self.prefix}/same", b"a", 0o644), (f"{self.prefix}/same", b"b", 0o644)])
        with self.assertRaisesRegex(OracleError, "Duplicate"):
            inventory(self.archive, self.pin)
        self.make_archive([(f"{self.prefix}/one", b"a", 0o644)])
        with self.assertRaisesRegex(OracleError, "file count"):
            inventory(self.archive, self.pin)

    def test_archive_and_unpacked_size_limits(self):
        for name in ("maximum_archive_bytes", "maximum_unpacked_bytes"):
            with self.subTest(name=name):
                pin = dict(self.pin, **{name: 1})
                with self.assertRaises(OracleError):
                    inventory(self.archive, pin)

    def test_failed_import_does_not_publish_partial_archive(self):
        self.archive.write_bytes(b"bad bytes")
        with self.assertRaises(OracleError):
            self.prepared()
        self.assertEqual(list((self.local / "upstream").glob("*.tar.gz")), [])
        self.assertEqual(list((self.local / "upstream").glob(".oracle-download-*")), [])

    def test_download_requires_explicit_flag_and_validates_before_publication(self):
        body = self.archive.read_bytes()
        response = io.BytesIO(body)
        response.geturl = lambda: self.pin["archive_url"]
        with patch("urllib.request.urlopen", return_value=response) as request:
            result = prepare(self.local, self.pin, download=True)
        request.assert_called_once()
        self.assertEqual(result["archiveSha256"], hashlib.sha256(body).hexdigest())

    def test_redirect_rejected_without_publication(self):
        response = io.BytesIO(self.archive.read_bytes())
        response.geturl = lambda: "https://unrelated.invalid/archive"
        with patch("urllib.request.urlopen", return_value=response):
            with self.assertRaisesRegex(OracleError, "redirected"):
                prepare(self.local, self.pin, download=True)
        self.assertEqual(list((self.local / "upstream").glob("*.tar.gz")), [])

    def test_failed_extraction_leaves_no_partial_source(self):
        original = shutil.copyfileobj
        def failure(*args, **kwargs):
            original(*args, **kwargs)
            raise OSError("injected interrupted extraction")
        with patch("oracle_source.shutil.copyfileobj", side_effect=failure):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.prepared()
        self.assertFalse((self.local / "upstream" / self.prefix).exists())
        self.assertEqual(list((self.local / "upstream").glob(".oracle-extract-*")), [])
        self.assertEqual(prepare(self.local, self.pin)["status"], "prepared")

    def test_exclusive_owner_refused_without_deleting_lock(self):
        self.local.mkdir()
        path = self.local / "lock"
        with exclusive(path):
            inode = path.stat().st_ino
            with self.assertRaisesRegex(OracleError, "Another oracle operation"):
                with exclusive(path):
                    self.fail("second owner was admitted")
        self.assertEqual(path.stat().st_ino, inode)

    def test_pin_rejects_unpinned_and_unofficial_urls(self):
        path = self.root / "pin.json"
        path.write_text(json.dumps(self.pin))
        self.assertEqual(read_pin(path), self.pin)
        for key, value in [("archive_url", "https://unrelated.invalid/latest"), ("commit", "main"),
                           ("files", 0), ("archive_sha256", "bad"), ("repository", "https://github.com/other/slua")]:
            path.write_text(json.dumps(dict(self.pin, **{key: value})))
            with self.subTest(key=key), self.assertRaises(OracleError):
                read_pin(path)

    def fake_tools(self):
        return {name: {"path": f"/fake/{name}", "sha256": name * 4, "version": "contract fixture"}
                for name in ("cmake", "ninja", "cc", "cxx")}

    def build_fixture(self, directory, *, fail_configure=False):
        def command(args, **kwargs):
            if "--build" in args:
                for name in builder.BINARIES:
                    path = directory / name
                    path.write_text("#!/bin/sh\nexit 0\n")
                    path.chmod(0o755)
            return subprocess.CompletedProcess(args, 7 if fail_configure else 0)
        return command

    def test_build_plan_writes_nothing_and_honors_admitted_slots(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        for slots, expected in [("1", "1"), ("2", "2"), ("16", "4")]:
            with patch.object(builder, "toolchain", return_value=self.fake_tools()), patch.dict(os.environ, AOF_RESOURCE_CPU_SLOTS=slots):
                result = builder.build(self.local, directory, self.pin, plan=True)
            self.assertEqual(result["commands"][1][-1], expected)
            self.assertIn("-DTAILSLIDE_SKIP_GEN=ON", result["commands"][0])
            self.assertFalse(directory.parent.exists())

    def test_build_records_then_reuses_without_running_commands(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory)) as execute:
                first = builder.build(self.local, directory, self.pin)
            self.assertEqual(execute.call_count, 2)
            self.assertEqual(first["status"], "built")
            with patch.object(builder.subprocess, "run", side_effect=AssertionError("unchanged rebuild")):
                second = builder.build(self.local, directory, self.pin)
            self.assertEqual(second["status"], "reused")
            self.assertEqual(second["binaries"], first["binaries"])

    def test_failed_configure_stops_build_and_preserves_attempt_before_resume(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory, fail_configure=True)) as execute:
                with self.assertRaisesRegex(OracleError, "phase 0 failed"):
                    builder.build(self.local, directory, self.pin)
            self.assertEqual(execute.call_count, 1)
            old_report = next((self.local / "logs/cpp-oracle").glob("*/results.json"))
            failed_bytes = old_report.read_bytes()
            self.assertFalse((directory / "oracle-build.json").exists())
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory)):
                result = builder.build(self.local, directory, self.pin)
            self.assertEqual(result["status"], "built")
            self.assertEqual(old_report.read_bytes(), failed_bytes)
            self.assertNotEqual(result["buildReport"], str(old_report))

    def test_unrecorded_build_and_changed_binaries_never_overwritten(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        directory.mkdir(parents=True)
        existing = directory / "recovery.txt"
        existing.write_text("old evidence")
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with self.assertRaisesRegex(OracleError, "unrecorded"):
                builder.build(self.local, directory, self.pin)
            self.assertEqual(existing.read_text(), "old evidence")
            existing.unlink()
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory)):
                builder.build(self.local, directory, self.pin)
            binary = directory / builder.BINARIES[0]
            binary.write_text("changed binary")
            with self.assertRaisesRegex(OracleError, "binary content"):
                builder.build(self.local, directory, self.pin)
            self.assertEqual(binary.read_text(), "changed binary")

    def test_changed_toolchain_refuses_stale_reuse(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        tools = self.fake_tools()
        with patch.object(builder, "toolchain", return_value=tools):
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory)):
                builder.build(self.local, directory, self.pin)
            tools["cxx"]["sha256"] = "changed compiler"
            with self.assertRaisesRegex(OracleError, "inputs changed"):
                builder.build(self.local, directory, self.pin)

    def test_changed_build_flags_refuse_stale_reuse(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory)):
                builder.build(self.local, directory, self.pin)
            with patch.dict(os.environ, CXXFLAGS="-DCHANGED_ENVIRONMENT=1"):
                with self.assertRaisesRegex(OracleError, "inputs changed"):
                    builder.build(self.local, directory, self.pin)

    def test_build_launch_error_records_failure_without_qualification_stamp(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with patch.object(builder.subprocess, "run", side_effect=OSError("injected launch failure")):
                with self.assertRaisesRegex(OracleError, "launch failed"):
                    builder.build(self.local, directory, self.pin)
        report = json.loads(next((self.local / "logs/cpp-oracle").glob("*/results.json")).read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["phases"][0]["exit"], None)
        self.assertIn("injected launch failure", report["phases"][0]["error"])
        self.assertFalse((directory / "oracle-build.json").exists())

    def test_build_cannot_certify_source_changed_by_tools(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        command = self.build_fixture(directory)
        def change_source(args, **kwargs):
            result = command(args, **kwargs)
            if "--build" in args:
                (self.local / "upstream" / self.prefix / "CMakeLists.txt").write_text("regenerated input")
            return result
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with patch.object(builder.subprocess, "run", side_effect=change_source):
                with self.assertRaisesRegex(OracleError, "changed content"):
                    builder.build(self.local, directory, self.pin)
        self.assertFalse((directory / "oracle-build.json").exists())
        report = json.loads(next((self.local / "logs/cpp-oracle").glob("*/results.json")).read_text())
        self.assertEqual(report["status"], "failed")
        self.assertIn("changed content", report["sourceVerificationError"])

    def test_failed_record_is_not_a_reusable_completed_build(self):
        self.prepared()
        directory = self.local / "build" / "fresh"
        with patch.object(builder, "toolchain", return_value=self.fake_tools()):
            with patch.object(builder.subprocess, "run", side_effect=self.build_fixture(directory)):
                builder.build(self.local, directory, self.pin)
            record = directory / "oracle-build.json"
            data = json.loads(record.read_text())
            data["status"] = "failed"
            record.write_text(json.dumps(data))
            with self.assertRaisesRegex(OracleError, "Invalid completed-build"):
                builder.build(self.local, directory, self.pin)
            self.assertEqual(json.loads(record.read_text())["status"], "failed")


if __name__ == "__main__":
    unittest.main()
