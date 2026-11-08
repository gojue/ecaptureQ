"""Exercise the native icon pipeline without building or launching the app."""
from pathlib import Path
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class MacOSBundleMetadataTest(unittest.TestCase):
    def test_manually_managed_languages_are_declared(self):
        with (ROOT / 'build/desktop/Info.plist').open('rb') as source:
            info = plistlib.load(source)
        self.assertEqual(info['CFBundleDevelopmentRegion'], 'en')
        self.assertEqual(info['CFBundleLocalizations'], ['en', 'zh-Hans'])


@unittest.skipUnless(sys.platform == 'darwin', 'Icon rendering needs the macOS SDK')
class MacOSIconTest(unittest.TestCase):
    def test_complete_icon_and_deterministic_universal_resources(self):
        with (ROOT / 'build/desktop/Info.plist').open('rb') as source:
            icon_name = plistlib.load(source)['CFBundleIconFile']
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            first = output / icon_name
            second = output / 'second.icns'
            for target in (first, second):
                result = subprocess.run(['sh', 'scripts/build-macos-icon.sh', str(target)],
                                        cwd=ROOT, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            # The universal merge requires identical non-executable resources.
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first.read_bytes()[:4], b'icns')
            iconset = output / 'check.iconset'
            subprocess.run(['iconutil', '-c', 'iconset', str(first), '-o', str(iconset)],
                           check=True, capture_output=True, text=True)
            expected = {}
            for points in (16, 32, 128, 256, 512):
                for scale in (1, 2):
                    suffix = '@2x' if scale == 2 else ''
                    expected[f'icon_{points}x{points}{suffix}.png'] = points * scale
            self.assertEqual({path.name for path in iconset.iterdir()}, set(expected))
            for name, pixels in expected.items():
                png = (iconset / name).read_bytes()
                self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
                self.assertEqual(struct.unpack('>II', png[16:24]), (pixels, pixels))
                # PNG colour type 6 has RGBA; type 4 has grayscale + alpha.
                self.assertIn(png[25], (4, 6), f'{name} must retain transparency')

    def test_desktop_bundle_is_complete_before_replacing_previous_build(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / 'scripts').mkdir()
                (root / 'build/desktop').mkdir(parents=True)
                shutil.copy(ROOT / 'scripts/build-desktop.sh', root / 'scripts')
                shutil.copy(ROOT / 'build/desktop/Info.plist', root / 'build/desktop')
                (root / 'VERSION').write_text('1.0.0-alpha.3\n')
                # Icon rendering is tested above; isolate bundle publication here.
                (root / 'scripts/build-macos-icon.sh').write_text('printf icon > "$1"\n')
                previous = root / 'dist/eCaptureQ.app/previous-build'
                previous.parent.mkdir(parents=True)
                previous.write_text('preserve until successful replacement')
                tools = root / 'tools'
                tools.mkdir()
                go = tools / 'go'
                go.write_text('#!' + sys.executable + '\n' + r'''
import os, pathlib, sys
args = sys.argv[1:]
if args[0] == 'env':
    print('arm64' if args[1] == 'GOHOSTARCH' else 'darwin')
elif args[0] == 'build':
    assert pathlib.Path('dist/eCaptureQ.app/previous-build').is_file()
    output = pathlib.Path(args[args.index('-o') + 1])
    assert output.parts[1].startswith('.ecaptureq-build.')
    output.write_text('synthetic executable')
    if os.environ['DESKTOP_BUILD_TEST_FAIL'] == '1':
        sys.exit(9)
''')
                go.chmod(0o755)
                xcrun = tools / 'xcrun'
                xcrun.write_text('#!/bin/sh\necho /synthetic-sdk\n')
                xcrun.chmod(0o755)
                env = {**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'],
                       'DESKTOP_BUILD_TEST_FAIL': '1' if fail else '0'}
                result = subprocess.run(['sh', 'scripts/build-desktop.sh'], cwd=root,
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 9 if fail else 0,
                                 result.stdout + result.stderr)
                self.assertEqual(list((root / 'dist').glob('.ecaptureq-build.*')), [])
                if fail:
                    self.assertTrue(previous.is_file())
                else:
                    self.assertFalse(previous.exists())
                    bundle = root / 'dist/eCaptureQ.app'
                    self.assertTrue((bundle / 'Contents/MacOS/eCaptureQ').is_file())
                    self.assertTrue((bundle / 'Contents/Resources/eCaptureQ.icns').is_file())
                    info = bundle / 'Contents/Info.plist'
                    self.assertGreaterEqual(bundle.stat().st_mtime_ns, info.stat().st_mtime_ns)


if __name__ == '__main__':
    unittest.main()
