"""Release gates must reject incomplete, corrupted or mismatched distributions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


version_gate = load("check-version")
release_gate = load("collect-release")


class ReleaseGateTest(unittest.TestCase):
    def test_version_and_tag_consistency(self):
        version = (ROOT / "VERSION").read_text().strip()
        self.assertEqual(version_gate.check_version(ROOT, "v" + version)[0], version)
        with self.assertRaisesRegex(ValueError, "Tag must"):
            version_gate.check_version(ROOT, "v0.0.0-wrong")

    def test_mismatched_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "build/desktop").mkdir(parents=True)
            (root / "VERSION").write_text("2.0.0")
            (root / "package.json").write_text(json.dumps({"version": "1.0.0"}))
            (root / "build/desktop/Info.plist").write_bytes(plistlib.dumps({"ECaptureQVersion": "2.0.0"}))
            with self.assertRaisesRegex(ValueError, "must match"):
                version_gate.check_version(root)
            for invalid in ("../2.0.0", "01.2.3", "1.2.3-alpha..1", "1.2.3-01"):
                (root / "VERSION").write_text(invalid)
                with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "semantic version"):
                    version_gate.check_version(root)

    def test_complete_and_corrupt_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            names = release_gate.expected_packages("1.0.0-test")
            for name in names:
                data = ("synthetic-package:" + name).encode()
                (directory / name).write_bytes(data)
                (directory / (name + ".sha256")).write_text(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
            self.assertEqual(release_gate.collect(directory, "1.0.0-test"), 15)
            self.assertEqual(len((directory / "SHA256SUMS").read_text().splitlines()), 15)
            chosen = next(iter(names))
            (directory / chosen).write_bytes(b"corrupted")
            with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
                release_gate.collect(directory, "1.0.0-test")
            (directory / chosen).unlink()
            with self.assertRaisesRegex(ValueError, "missing="):
                release_gate.collect(directory, "1.0.0-test")

    def test_public_downloads_have_one_manifest_and_detect_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            directory, public = Path(temp) / 'internal', Path(temp) / 'public'
            directory.mkdir()
            for name in release_gate.expected_packages('1.2.3'):
                data = name.encode()
                (directory / name).write_bytes(data)
                (directory / (name + '.sha256')).write_text(f'{hashlib.sha256(data).hexdigest()}  {name}\n')
            release_gate.collect(directory, '1.2.3', public)
            self.assertEqual(len(list(public.iterdir())), 16)
            self.assertFalse(list(public.glob('*.sha256')))
            self.assertEqual(release_gate.collect(public, '1.2.3'), 15)
            (public / 'SHA256SUMS').write_text('incorrect manifest\n')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                release_gate.collect(public, '1.2.3')
            (public / 'SHA256SUMS').unlink()
            with self.assertRaisesRegex(ValueError, 'missing='):
                release_gate.collect(public, '1.2.3')

    def test_download_matrix_has_universal_macos_and_native_linux_packages(self):
        names = release_gate.expected_packages('1.2.3')
        self.assertEqual(len(names), 15)
        self.assertEqual(len([name for name in names if name.endswith('.deb')]), 4)
        self.assertEqual(len([name for name in names if name.endswith('.rpm')]), 4)
        self.assertEqual(len([name for name in names if '-macos-universal.' in name]), 3)
        self.assertFalse(any('-desktop-' in name or '-server-' in name or '-darwin-' in name for name in names))


if __name__ == "__main__":
    unittest.main()
