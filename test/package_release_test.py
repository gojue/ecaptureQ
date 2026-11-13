"""Exercise release archive boundaries and distribution metadata."""
import contextlib
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
        (self.root / "frontend/ecaptureq-logo.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
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

    def package(self, target_os, kind="server"):
        with patch.object(packager, "ROOT", self.root), patch.object(packager, "check_binary"), contextlib.redirect_stdout(io.StringIO()):
            return packager.package(kind, target_os, "arm64", "1.2.3-rc.1", self.binary, self.output)[0]

    def test_tar_contains_only_selected_executable_licenses_and_metadata(self):
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

    def test_archives_contain_only_executable_licenses_and_metadata(self):
        targets = [(kind, target_os) for kind in ("desktop", "server") for target_os in ("linux", "windows")]
        targets.append(("server", "darwin"))
        for kind, target_os in targets:
            with self.subTest(kind=kind, target_os=target_os):
                archive = self.package(target_os, kind)
                executable = "ecaptureq-web" if kind == "server" else "eCaptureQ"
                if target_os == "windows":
                    executable += ".exe"
                prefix = packager.package_name(kind, target_os, "arm64", "1.2.3-rc.1") + "/"
                if target_os == "linux":
                    with tarfile.open(archive) as contents:
                        names = {entry.name for entry in contents.getmembers() if entry.isfile()}
                        binary = contents.extractfile(prefix + executable).read()
                        license_text = contents.extractfile(prefix + "LICENSE").read()
                        notice = contents.extractfile(prefix + "NOTICE").read()
                else:
                    with zipfile.ZipFile(archive) as contents:
                        names = {name for name in contents.namelist() if not name.endswith("/")}
                        binary = contents.read(prefix + executable)
                        license_text = contents.read(prefix + "LICENSE")
                        notice = contents.read(prefix + "NOTICE")
                self.assertEqual(names, {prefix + name for name in (executable, "LICENSE", "NOTICE", "BUILD-INFO.json")})
                self.assertEqual(binary, self.binary.read_bytes())
                self.assertEqual(license_text, (self.root / "LICENSE").read_bytes())
                self.assertEqual(notice, (self.root / "NOTICE").read_bytes())

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

    def package_macos(self, signing, signature="adhoc", broken_source=False, broken_copy=False, broken_ticket=False, dmg=False, prepare=True, stale_resources=False):
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
            elif command[0] == "hdiutil":
                stage = Path(command[command.index("-srcfolder") + 1])
                self.assertEqual({p.name for p in stage.iterdir()}, {"eCaptureQ.app", "Applications"})
                self.assertTrue((stage / "Applications").is_symlink())
                self.assertEqual((stage / "Applications").readlink(), Path("/Applications"))
                self.assertTrue((stage / "eCaptureQ.app/Contents/Resources/Distribution/LICENSE").is_file())
                Path(command[-1]).write_bytes(b"synthetic disk image")
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
            if prepare:
                packager.package("desktop", "darwin", "arm64", "1.2.3", bundle, self.output,
                                 signing=signing, prepare_app=True)
                self.assertFalse(self.output.exists())
            if stale_resources:
                (bundle / "Contents/Resources/Distribution/BUILD-INFO.json").write_text("{}")
            before = {p.relative_to(bundle): p.read_bytes() for p in bundle.rglob("*") if p.is_file()}
            result = packager.package("desktop", "darwin", "arm64", "1.2.3", bundle, self.output,
                                      signing=signing, dmg=dmg)[0]
            after = {p.relative_to(bundle): p.read_bytes() for p in bundle.rglob("*") if p.is_file()}
            self.assertEqual(before, after, "Packaging must not modify the source bundle")
            return result

    def test_adhoc_package_has_truthful_metadata(self):
        archive = self.package_macos("adhoc")
        with zipfile.ZipFile(archive) as contents:
            prefix = "eCaptureQ.app/Contents/Resources/Distribution/"
            info = json.loads(contents.read(prefix + "BUILD-INFO.json"))
            self.assertEqual(info["signing"], "adhoc")
            self.assertFalse(info["notarized"])
            self.assertEqual(contents.read("eCaptureQ.app/Contents/MacOS/eCaptureQ"), self.binary.read_bytes())

    def test_macos_zip_contains_only_app_and_dmg_adds_applications_shortcut(self):
        archive = self.package_macos("adhoc", dmg=True)
        with zipfile.ZipFile(archive) as contents:
            self.assertEqual({name.split("/")[0] for name in contents.namelist()}, {"eCaptureQ.app"})
            prefix = "eCaptureQ.app/Contents/Resources/Distribution/"
            self.assertEqual({name[len(prefix):] for name in contents.namelist()
                              if name.startswith(prefix) and not name.endswith("/")},
                             {"LICENSE", "NOTICE", "BUILD-INFO.json"})
        for suffix in (".zip", ".dmg"):
            output = archive.with_suffix(suffix)
            self.assertEqual(output.with_name(output.name + ".sha256").read_text(),
                             hashlib.sha256(output.read_bytes()).hexdigest() + "  " + output.name + "\n")

    def test_signed_bundle_requires_resources_prepared_before_signing(self):
        with self.assertRaisesRegex(ValueError, "run --prepare-app before signing"):
            self.package_macos("adhoc", prepare=False)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_stale_signed_metadata_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "run --prepare-app before signing"):
            self.package_macos("adhoc", stale_resources=True)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_unsigned_bundle_gets_resources_without_changing_source(self):
        archive = self.package_macos("unsigned", prepare=False)
        with zipfile.ZipFile(archive) as contents:
            info = json.loads(contents.read("eCaptureQ.app/Contents/Resources/Distribution/BUILD-INFO.json"))
            self.assertEqual(info["signing"], "unsigned")

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
            info = json.loads(contents.read("eCaptureQ.app/Contents/Resources/Distribution/BUILD-INFO.json"))
            self.assertEqual(info["signing"], "notarized")
            self.assertTrue(info["notarized"])


if __name__ == "__main__":
    unittest.main()
