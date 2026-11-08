"""Verify Windows resources live only for the desktop build that consumes them."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class WindowsIconBuildTest(unittest.TestCase):
    def test_build_consumes_resource_and_cleans_up_on_success_or_failure(self):
        for fail in (False, True):
            for arch in ('amd64', 'arm64'):
                with self.subTest(fail=fail, arch=arch), tempfile.TemporaryDirectory() as temporary:
                    root, resource, env = self.fixture(temporary, arch)
                    env['DESKTOP_BUILD_TEST_FAIL'] = '1' if fail else '0'
                    result = subprocess.run(['sh', 'scripts/build-desktop.sh'], cwd=root,
                                            env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 9 if fail else 0,
                                     result.stdout + result.stderr)
                    self.assertFalse(resource.exists())

    def test_existing_resource_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, resource, env = self.fixture(temporary, 'amd64')
            resource.write_text('existing user resource')
            result = subprocess.run(['sh', 'scripts/build-desktop.sh'], cwd=root,
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Refusing to overwrite', result.stderr)
            self.assertEqual(resource.read_text(), 'existing user resource')

    def fixture(self, temporary, arch):
        root = Path(temporary)
        (root / 'scripts').mkdir()
        (root / 'cmd/desktop').mkdir(parents=True)
        (root / 'tools').mkdir()
        shutil.copy(ROOT / 'scripts/build-desktop.sh', root / 'scripts')
        (root / 'scripts/build-windows-icon.sh').write_text('printf "synthetic icon" > "$2"\n')
        (root / 'VERSION').write_text('1.0.0-alpha.3\n')
        go = root / 'tools/go'
        go.write_text('#!' + sys.executable + '\n' + r'''
import os, pathlib, sys
args = sys.argv[1:]
arch = os.environ['DESKTOP_BUILD_TEST_ARCH']
if args[0] == 'env':
    print(arch if args[1] in ('GOHOSTARCH', 'GOARCH') else 'windows')
elif args[0] == 'build':
    resource = pathlib.Path(f'cmd/desktop/rsrc_windows_{arch}.syso')
    assert resource.read_text() == 'synthetic icon'
    if os.environ.get('DESKTOP_BUILD_TEST_FAIL') == '1':
        sys.exit(9)
    pathlib.Path(args[args.index('-o') + 1]).write_text('synthetic executable')
''')
        go.chmod(0o755)
        env = {**os.environ, 'PATH': str(root / 'tools') + os.pathsep + os.environ['PATH'],
               'DESKTOP_BUILD_TEST_ARCH': arch}
        return root, root / f'cmd/desktop/rsrc_windows_{arch}.syso', env


if __name__ == '__main__':
    unittest.main()
