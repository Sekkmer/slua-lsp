"""An existing qualification report must not become stale success evidence."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys


class PreprocessorEvidence(unittest.TestCase):
    def test_preparation_environment_selects_correct_source_without_writing(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="preprocessor-selection-", dir=root / ".local") as temporary:
            directory = Path(temporary)
            native, plugin, explicit = [directory / name for name in ("native", "plugin", "explicit")]
            env = dict(os.environ, SLUA_ORACLE_LOCAL=str(native), SLUA_PREPROCESSOR_LOCAL=str(plugin))
            cases = [((), native), (("--preprocessor",), plugin),
                     (("--preprocessor", "--local-dir", str(explicit)), explicit)]
            for arguments, expected in cases:
                with self.subTest(arguments=arguments):
                    result = subprocess.run([sys.executable, "scripts/prepare-oracle.py", *arguments, "--check"],
                                            cwd=root, env=env, capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(str(expected).encode(), result.stderr)
                    self.assertEqual(list(directory.iterdir()), [])

    def test_existing_report_is_refused_before_build_or_fixture_creation(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="preprocessor-report-", dir=root / ".local") as temporary:
            directory = Path(temporary)
            output = directory / "prior.json"
            previous = b'{"passed":true,"historical":"preserve exact bytes"}\n'
            output.write_bytes(previous)
            missing = directory / "unprepared"
            env = dict(os.environ, SLUA_PREPROCESSOR_EVIDENCE=str(output),
                       SLUA_PREPROCESSOR_LOCAL=str(missing), SLUA_ORACLE_LOCAL=str(missing),
                       SLUA_PREPROCESSOR_FIXTURE_ROOT=str(directory / "fixtures"))
            result = subprocess.run(["node", "scripts/test-preprocessor.mjs"], cwd=root, env=env,
                                    capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"EEXIST", result.stderr)
            self.assertEqual(output.read_bytes(), previous)
            self.assertFalse(missing.exists())
            self.assertFalse((directory / "fixtures").exists())


if __name__ == "__main__":
    unittest.main()
