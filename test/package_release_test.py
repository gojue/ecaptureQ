"""Exercise release archive boundaries and distribution metadata."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location("package_release", Path(__file__).resolve().parents[1] / "scripts/package-release.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class ReleasePackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("LICENSE", "NOTICE", "README.md"):
            (self.root / name).write_text(name)
        (self.root / "config").mkdir()
        (self.root / "config/sources.example.json").write_text("[]")
        (self.root / "docs").mkdir()
        (self.root / "docs/upgrade.md").write_text("Upgrade instructions")
        (self.root / "bin").mkdir()
        self.binary = self.root / "bin/ecaptureq-server"
        self.binary.write_bytes(b"synthetic executable")
        (self.root / "bin/private.key").write_text("must not ship")
        (self.root / "sources.local.json").write_text("private settings")
        self.output = self.root / "packages"

    def package(self, target_os):
        with patch.object(packager, "ROOT", self.root), patch.object(packager, "check_binary"), contextlib.redirect_stdout(io.StringIO()):
            return packager.package("server", target_os, "arm64", "1.2.3-rc.1", self.binary, self.output)[0]

    def test_tar_contains_only_selected_executable_and_public_docs(self):
        archive = self.package("linux")
        prefix = "ecaptureq-1.2.3-rc.1-server-linux-arm64"
        with tarfile.open(archive) as contents:
            names = contents.getnames()
            self.assertFalse(any("private" in name or "sources.local" in name for name in names))
            binary = contents.getmember(prefix + "/ecaptureq-server")
            self.assertTrue(binary.mode & stat.S_IXUSR)
            self.assertEqual((binary.uid, binary.gid), (0, 0))
            self.assertEqual(contents.extractfile(binary).read(), b"synthetic executable")
            info = json.load(contents.extractfile(prefix + "/BUILD-INFO.json"))
            self.assertEqual(info["version"], "1.2.3-rc.1")
            self.assertEqual(info["signing"], "unsigned")
        checksum = archive.with_name(archive.name + ".sha256").read_text()
        self.assertEqual(checksum, hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")

    def test_windows_zip_contains_exe_and_sources_example(self):
        archive = self.package("windows")
        with zipfile.ZipFile(archive) as contents:
            prefix = "ecaptureq-1.2.3-rc.1-server-windows-arm64/"
            self.assertEqual(contents.read(prefix + "ecaptureq-server.exe"), b"synthetic executable")
            self.assertEqual(contents.read(prefix + "config/sources.example.json"), b"[]")
            self.assertFalse(any("private" in name or "sources.local" in name for name in contents.namelist()))

    def test_target_metadata_is_required(self):
        with patch.object(packager.subprocess, "check_output", return_value="build GOOS=linux\n\tbuild GOARCH=arm64\n"):
            packager.check_binary(self.binary, "linux", "arm64")
            with self.assertRaisesRegex(ValueError, "GOARCH=amd64"):
                packager.check_binary(self.binary, "linux", "amd64")
            with self.assertRaisesRegex(ValueError, "GOOS=windows"):
                packager.check_binary(self.binary, "windows", "arm64")

    def test_version_cannot_escape_output_directory(self):
        with self.assertRaisesRegex(ValueError, "semantic version"):
            packager.package("server", "linux", "arm64", "../../private", self.binary, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
