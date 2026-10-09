"""
Unit tests for compile_variants.py's helpers (no arduino-cli needed).
Run by tools/firmware_host_test/run_tests.py (check 5), or directly:

  venv/Scripts/python.exe -m unittest tools/firmware_build/test_compile_variants.py
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compile_variants as cv  # noqa: E402


class ShownPathTests(unittest.TestCase):
    def test_inside_repo_is_relative(self):
        log = os.path.join(cv.REPO, "var", "fw_build", "logs", "gateway.log")
        self.assertEqual(cv.shown_path(log), os.path.join("var", "fw_build", "logs", "gateway.log"))

    def test_other_drive_falls_back_to_absolute(self):
        # What Windows' relpath does when SANJEEVNI_VAR_DIR is on another drive
        # (simulated, so the test also runs on one-drive machines and Linux).
        err = ValueError("path is on mount 'C:', start on mount 'D:'")
        log = os.path.join(tempfile.gettempdir(), "fw_build", "logs", "node-default.log")
        with mock.patch.object(cv.os.path, "relpath", side_effect=err):
            self.assertEqual(cv.shown_path(log), os.path.abspath(log))

    @unittest.skipUnless(os.name == "nt", "drive letters are Windows-only")
    def test_real_other_drive_on_windows(self):
        repo_drive = os.path.splitdrive(cv.REPO)[0].upper()
        other = "Z:" if repo_drive != "Z:" else "Y:"
        log = other + "\\sanjeevni_var\\fw_build\\logs\\gateway.log"
        self.assertEqual(cv.shown_path(log), os.path.abspath(log))  # no ValueError


class OverrideTests(unittest.TestCase):
    def test_overrides_replace_exactly_one_define(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "config.h")
            with open(cfg, "w", encoding="utf-8") as f:
                f.write("#define ENABLE_GAS 1          // MQ135\n#define MQ135_WARMUP_S 180\n")
            cv.apply_overrides(cfg, {"ENABLE_GAS": "0"})
            with open(cfg, encoding="utf-8") as f:
                text = f.read()
            self.assertIn("#define ENABLE_GAS 0          // MQ135", text)
            self.assertIn("#define MQ135_WARMUP_S 180", text)
            with self.assertRaises(SystemExit):
                cv.apply_overrides(cfg, {"NOT_THERE": "1"})


if __name__ == "__main__":
    unittest.main()
