"""Universal CPU slices, Linux package boundaries and release download choices."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import release_common


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


packager = load('package-release')
merger = load('merge-macos')
notes = load('render-release-notes')
collector = load('collect-release')


class NativePackagesTest(unittest.TestCase):
    def test_universal_requires_exactly_both_architectures(self):
        for arches in ('arm64', 'x86_64', 'arm64 arm64', 'x86_64 arm64 arm64e'):
            with self.subTest(arches=arches), patch.object(release_common.subprocess, 'check_output', return_value=arches):
                with self.assertRaisesRegex(ValueError, 'exactly x86_64 and arm64'):
                    release_common.check_binary(Path('synthetic'), 'darwin', 'universal')

    def test_universal_checks_go_metadata_in_each_slice(self):
        outputs = ['x86_64 arm64', 'build GOOS=darwin\nbuild GOARCH=amd64\n',
                   'build GOOS=darwin\nbuild GOARCH=amd64\n']
        with patch.object(release_common.subprocess, 'check_output', side_effect=outputs), \
             patch.object(release_common.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'GOARCH=arm64'):
                release_common.check_binary(Path('synthetic'), 'darwin', 'universal')
            self.assertEqual(run.call_count, 2)

    def test_universal_signature_rejects_bad_second_slice(self):
        with patch.object(packager.subprocess, 'run'), \
             patch.object(packager.subprocess, 'check_output', side_effect=['Signature=adhoc\n', 'Signature=wrong\n']):
            with self.assertRaisesRegex(ValueError, 'does not have an ad-hoc signature'):
                packager.check_macos_signature(Path('synthetic-file'), 'adhoc', 'universal')

    def test_bundle_version_difference_prevents_merge(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('amd64', 'arm64'):
                (root / name / 'Contents').mkdir(parents=True)
                (root / name / 'Contents/Info.plist').write_text(name)
            with patch.object(merger.sys, 'platform', 'darwin'), patch.object(merger.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'must match'):
                    merger.merge(root / 'amd64', root / 'arm64', root / 'universal.app')
                run.assert_not_called()

    def test_linux_web_and_app_can_coexist_without_private_config_or_hooks(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            for name in ('LICENSE', 'NOTICE', 'BUILD-INFO.json', 'ecaptureq-web'):
                (stage / name).write_text('synthetic')
            web = packager.linux_config(stage, 'server', 'arm64', '1.2.3-rc.1')
            self.assertEqual(web['name'], 'ecaptureq-web')
            self.assertNotIn('depends', web)
            self.assertNotIn('overrides', web)
            self.assertNotIn('scripts', web)
            self.assertEqual(web['contents'][0]['dst'], '/usr/bin/ecaptureq-web')
            self.assertEqual({entry['dst'] for entry in web['contents']}, {
                '/usr/bin/ecaptureq-web', '/usr/share/doc/ecaptureq-web/BUILD-INFO.json',
                '/usr/share/licenses/ecaptureq-web/LICENSE', '/usr/share/licenses/ecaptureq-web/NOTICE',
            })
            self.assertTrue(all('/etc/' not in entry['dst'] for entry in web['contents']))
            (stage / 'ecaptureq-web').unlink()
            (stage / 'eCaptureQ').write_text('synthetic')
            app = packager.linux_config(stage, 'desktop', 'arm64', '1.2.3-rc.1')
            self.assertEqual(app['name'], 'ecaptureq')
            self.assertEqual(app['contents'][0]['dst'], '/usr/bin/ecaptureq')
            self.assertEqual({entry['dst'] for entry in app['contents']}, {
                '/usr/bin/ecaptureq', '/usr/share/doc/ecaptureq/BUILD-INFO.json',
                '/usr/share/licenses/ecaptureq/LICENSE', '/usr/share/licenses/ecaptureq/NOTICE',
                '/usr/share/applications/ecaptureq.desktop', '/usr/share/icons/hicolor/scalable/apps/ecaptureq.svg',
            })
            self.assertEqual(app['contents'][0]['file_info']['mode'], 0o755)
            self.assertIn('gtk4 >= 4.14', app['overrides']['rpm']['depends'])
            self.assertIn('libgtk-4-1 (>= 4.14)', app['overrides']['deb']['depends'])
            self.assertIn('/usr/share/applications/ecaptureq.desktop', [entry['dst'] for entry in app['contents']])
            self.assertFalse({entry['dst'] for entry in web['contents']} & {entry['dst'] for entry in app['contents']})

    def test_linux_packaging_writes_both_formats_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stage = root / 'ecaptureq-web-1.2.3-linux-arm64'
            stage.mkdir()
            output = root / 'packages'
            output.mkdir()
            for name in ('LICENSE', 'NOTICE', 'BUILD-INFO.json', 'ecaptureq-web'):
                (stage / name).write_text('synthetic')
            configs = []
            def run(command, **kwargs):
                configs.append(json.loads(Path(command[command.index('--config') + 1]).read_text()))
                Path(command[-1]).write_bytes(b'synthetic package')
            with patch.object(packager.subprocess, 'run', side_effect=run):
                results = packager.linux_packages(stage, output, 'server', 'arm64', '1.2.3', ('deb', 'rpm'))
            self.assertEqual({p.suffix for p in results}, {'.deb', '.rpm'})
            self.assertEqual(len(list(output.glob('*.sha256'))), 2)
            self.assertTrue(all(config['arch'] == 'arm64' for config in configs))

    def test_download_notes_link_to_exact_public_matrix(self):
        import re
        template = (ROOT / 'docs/release-notes.md').read_text()
        rendered = notes.render('1.2.3', 'gojue/ecaptureQ', template)
        linked = re.findall(r'https://github.com/gojue/ecaptureQ/releases/download/v1.2.3/([^)]*)', rendered)
        self.assertEqual(set(linked), collector.expected_packages('1.2.3') | {'SHA256SUMS'})
        self.assertEqual(len(linked), 18)
        self.assertLess(rendered.index('### Download eCaptureQ'), rendered.index('<details>'))
        self.assertNotIn('<!-- downloads -->', rendered)

    def test_loong64_is_linux_web_only(self):
        self.assertEqual(release_common.package_name('server', 'linux', 'loong64', '1.2.3'),
                         'ecaptureq-web-1.2.3-linux-loong64')
        with self.assertRaisesRegex(ValueError, 'loong64 desktop packages are not supported'):
            release_common.package_name('desktop', 'linux', 'loong64', '1.2.3')
        with self.assertRaisesRegex(ValueError, 'only available for Linux'):
            release_common.package_name('server', 'windows', 'loong64', '1.2.3')

    def test_loong64_web_linux_config_has_no_desktop_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            for name in ('LICENSE', 'NOTICE', 'BUILD-INFO.json', 'ecaptureq-web'):
                (stage / name).write_text('synthetic')
            web = packager.linux_config(stage, 'server', 'loong64', '1.2.3')
            self.assertEqual(web['arch'], 'loong64')
            self.assertNotIn('depends', web)
            self.assertNotIn('overrides', web)


if __name__ == '__main__':
    unittest.main()
