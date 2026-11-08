"""Exercise release archive boundaries and distribution metadata."""
import contextlib
from base64 import b64decode
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
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
        (self.root / "frontend").mkdir()
        (self.root / "frontend/ecapture-logo.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        (self.root / "frontend/app.js").write_text("// frontend source is not part of the release archive")
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
        prefix = "ecaptureq-web-1.2.3-rc.1-linux-arm64"
        with tarfile.open(archive) as contents:
            names = contents.getnames()
            self.assertFalse(any("private" in name or "sources.local" in name for name in names))
            binary = contents.getmember(prefix + "/ecaptureq-web")
            self.assertTrue(binary.mode & stat.S_IXUSR)
            self.assertEqual((binary.uid, binary.gid), (0, 0))
            self.assertEqual(contents.extractfile(binary).read(), b"synthetic executable")
            info = json.load(contents.extractfile(prefix + "/BUILD-INFO.json"))
            self.assertEqual(info["version"], "1.2.3-rc.1")
            self.assertEqual(info["signing"], "unsigned")
            self.assertFalse(info["notarized"])
        checksum = archive.with_name(archive.name + ".sha256").read_text()
        self.assertEqual(checksum, hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")

    def test_windows_zip_contains_exe_and_sources_example(self):
        archive = self.package("windows")
        with zipfile.ZipFile(archive) as contents:
            prefix = "ecaptureq-web-1.2.3-rc.1-windows-arm64/"
            self.assertEqual(contents.read(prefix + "ecaptureq-web.exe"), b"synthetic executable")
            self.assertEqual(contents.read(prefix + "config/sources.example.json"), b"[]")
            self.assertFalse(any("private" in name or "sources.local" in name for name in contents.namelist()))

    def test_readme_screenshots_remain_available_in_tar_and_zip(self):
        image_path = "docs/images/overview.png"
        logo_path = "frontend/ecapture-logo.svg"
        screenshot = b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4p8AAAAASUVORK5CYII=")
        (self.root / "README.md").write_text(f'<img src="{logo_path}" alt="eCaptureQ"/>\n![Overview]({image_path})\n')
        (self.root / "docs/images").mkdir()
        (self.root / image_path).write_bytes(screenshot)
        (self.root / "docs/build.log").write_text("local build output; must not ship")
        for target_os in ("linux", "windows"):
            with self.subTest(target_os=target_os):
                archive = self.package(target_os)
                prefix = f"ecaptureq-web-1.2.3-rc.1-{target_os}-arm64/"
                if target_os == "linux":
                    with tarfile.open(archive) as contents:
                        readme = contents.extractfile(prefix + "README.md").read()
                        image = contents.extractfile(prefix + image_path).read()
                        logo = contents.extractfile(prefix + logo_path).read()
                        names = contents.getnames()
                else:
                    with zipfile.ZipFile(archive) as contents:
                        readme = contents.read(prefix + "README.md")
                        image = contents.read(prefix + image_path)
                        logo = contents.read(prefix + logo_path)
                        names = contents.namelist()
                self.assertIn(image_path.encode(), readme)
                self.assertIn(logo_path.encode(), readme)
                self.assertEqual(image, screenshot)
                self.assertEqual(logo, (self.root / logo_path).read_bytes())
                self.assertNotIn(prefix + "docs/build.log", names)
                self.assertNotIn(prefix + "frontend/app.js", names)

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

    def test_signing_status_cannot_be_used_for_other_platforms_or_server(self):
        for signing in ("adhoc", "notarized"):
            for kind, target_os in (("desktop", "linux"), ("desktop", "windows")) + ((("server", "darwin"),) if signing == "notarized" else ()):
                with self.subTest(signing=signing, kind=kind, target_os=target_os):
                    with self.assertRaisesRegex(ValueError, "only supported for macOS desktop"):
                        packager.package(kind, target_os, "arm64", "1.2.3", self.binary, self.output, signing=signing)
        with self.assertRaisesRegex(ValueError, "Unknown signing"):
            packager.package("desktop", "darwin", "arm64", "1.2.3", self.binary, self.output, signing="trusted")
        self.assertFalse(self.output.exists())

    def make_macos_bundle(self):
        bundle = self.root / "eCaptureQ.app"
        (bundle / "Contents/MacOS").mkdir(parents=True)
        shutil.copy2(self.binary, bundle / "Contents/MacOS/eCaptureQ")
        return bundle.resolve()

    def package_macos(self, signing, signature="adhoc", broken_source=False, broken_copy=False, broken_ticket=False):
        bundle = self.make_macos_bundle()

        def fake_run(command, **kwargs):
            if command[0] == "codesign":
                # Simulate platform validation, including damage introduced during copy.
                code = Path(command[-1])
                original = code == bundle or bundle in code.parents
                if broken_source or (broken_copy and not original):
                    raise subprocess.CalledProcessError(1, command, stderr="code or signature modified")
            elif command[:3] == ["xcrun", "stapler", "validate"]:
                if broken_ticket:
                    raise subprocess.CalledProcessError(1, command, stderr="ticket validation failed")
            elif command[0] == "ditto":
                if command[1] == "-c":
                    stage, archive_path = map(Path, command[-2:])
                    with zipfile.ZipFile(archive_path, "w") as archive:
                        for entry in stage.rglob("*"):
                            archive.write(entry, entry.relative_to(stage.parent).as_posix())
                else:
                    shutil.copytree(command[1], command[2])
            else:
                self.fail(f"Unexpected command: {command[0]}")
            return subprocess.CompletedProcess(command, 0)

        def fake_output(command, **kwargs):
            if command[0] == "codesign":
                if signature == "adhoc":
                    return "Identifier=com.gojue.ecaptureq\nSignature=adhoc\nTeamIdentifier=not set\n"
                return "Identifier=com.gojue.ecaptureq\nAuthority=Developer ID Application: Synthetic Identity\nTeamIdentifier=SYNTHETIC\n"
            if command[0] == "git":
                return "0" * 40 + "\n"
            self.fail(f"Unexpected metadata command: {command[0]}")

        with patch.object(packager, "ROOT", self.root), patch.object(packager, "check_binary"), \
                patch.object(packager.sys, "platform", "darwin"), \
                patch.object(packager.subprocess, "run", side_effect=fake_run), \
                patch.object(packager.subprocess, "check_output", side_effect=fake_output), \
                contextlib.redirect_stdout(io.StringIO()):
            return packager.package("desktop", "darwin", "arm64", "1.2.3", bundle, self.output, signing=signing)[0]

    def test_adhoc_package_has_truthful_metadata_and_first_launch_instructions(self):
        archive = self.package_macos("adhoc")
        with zipfile.ZipFile(archive) as contents:
            prefix = "ecaptureq-1.2.3-macos-arm64/"
            info = json.loads(contents.read(prefix + "BUILD-INFO.json"))
            self.assertEqual(info["signing"], "adhoc")
            self.assertFalse(info["notarized"])
            instructions = contents.read(prefix + "INSTALL.txt").decode()
            self.assertIn("NOT been notarized", instructions)
            self.assertIn("Privacy & Security > Open Anyway", instructions)
            self.assertEqual(contents.read(prefix + "eCaptureQ.app/Contents/MacOS/eCaptureQ"), self.binary.read_bytes())

    def test_developer_id_signature_cannot_be_mislabeled_adhoc(self):
        with self.assertRaisesRegex(ValueError, "does not have an ad-hoc signature"):
            self.package_macos("adhoc", signature="developer-id")
        self.assertFalse(self.output.exists())

    def test_adhoc_signature_cannot_be_mislabeled_notarized(self):
        with self.assertRaisesRegex(ValueError, "requires a Developer ID"):
            self.package_macos("notarized")
        self.assertFalse(self.output.exists())

    def test_damaged_source_signature_stops_packaging(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.package_macos("adhoc", broken_source=True)
        self.assertFalse(self.output.exists())

    def test_damage_during_bundle_copy_does_not_produce_an_archive(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.package_macos("adhoc", broken_copy=True)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_notarized_package_requires_valid_ticket(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.package_macos("notarized", signature="developer-id", broken_ticket=True)
        self.assertFalse(self.output.exists())

    def test_verified_notarized_package_records_true_status(self):
        archive = self.package_macos("notarized", signature="developer-id")
        with zipfile.ZipFile(archive) as contents:
            info = json.loads(contents.read("ecaptureq-1.2.3-macos-arm64/BUILD-INFO.json"))
            self.assertEqual(info["signing"], "notarized")
            self.assertTrue(info["notarized"])


if __name__ == "__main__":
    unittest.main()
