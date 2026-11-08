"""Verify signing mode isolation and failures without Apple credentials/services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FAKE_TOOL = r'''
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['SIGNING_TEST_LOG'], 'a', encoding='utf-8') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'uname':
    print('Darwin')
elif name == 'codesign':
    if os.environ.get('SIGNING_TEST_FAIL') in ('sign', 'verify'):
        option = '--force' if os.environ['SIGNING_TEST_FAIL'] == 'sign' else '--verify'
        if option in args:
            print('Synthetic codesign failure', file=sys.stderr)
            sys.exit(9)
    if '--display' in args:
        print('Signature=' + os.environ.get('SIGNING_TEST_SIGNATURE', 'adhoc'), file=sys.stderr)
elif name == 'security':
    if os.environ.get('SIGNING_TEST_FORMAL') != '1':
        print('Forbidden credential/keychain access', file=sys.stderr)
        sys.exit(91)
    if args[:3] == ['list-keychains', '-d', 'user'] and '-s' not in args:
        if os.environ.get('SIGNING_TEST_EMPTY_KEYCHAINS') != '1':
            print('    "/synthetic/keychain with spaces.keychain-db"')
            print('    "/synthetic/system.keychain-db"')
    if args and args[0] == 'find-identity':
        if os.environ.get('SIGNING_TEST_MISSING_IDENTITY') == '1':
            print('0 valid identities found')
        else:
            print('1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "' + os.environ['APPLE_SIGNING_IDENTITY'] + '"')
elif name == 'xcrun':
    if os.environ.get('SIGNING_TEST_FORMAL') != '1':
        print('Forbidden Apple service access', file=sys.stderr)
        sys.exit(92)
    if os.environ.get('SIGNING_TEST_FAIL') == 'notary' and 'submit' in args:
        print('Synthetic notarization failure', file=sys.stderr)
        sys.exit(8)
elif name == 'openssl':
    print('synthetic-random-password')
elif name == 'ditto':
    pathlib.Path(args[-1]).write_bytes(b'synthetic archive')
'''


@unittest.skipUnless(shutil.which('bash'), 'Signing script tests need Bash')
class MacOSSigningTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'eCaptureQ.app'
        executable = self.app / 'Contents/MacOS/eCaptureQ'
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b'synthetic executable')
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        for name in ('uname', 'codesign', 'security', 'xcrun', 'openssl', 'ditto'):
            tool = self.tools / name
            tool.write_text('#!' + sys.executable + '\n' + FAKE_TOOL, encoding='utf-8')
            tool.chmod(0o755)
        self.log = self.root / 'calls.jsonl'
        self.output = self.root / 'output.txt'
        self.summary = self.root / 'summary.md'
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('APPLE_')}
        self.env.update(PATH=str(self.tools) + os.pathsep + os.environ['PATH'],
                        SIGNING_TEST_LOG=str(self.log), GITHUB_OUTPUT=str(self.output),
                        GITHUB_STEP_SUMMARY=str(self.summary), RUNNER_TEMP=str(self.root))

    def run_signer(self, mode=None):
        args = ['bash', str(ROOT / 'scripts/sign-macos.sh'), str(self.app)]
        if mode is not None:
            args.append(mode)
        return subprocess.run(args, env=self.env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def formal_credentials(self):
        # Only synthetic placeholders enter this process, never inherited Apple secrets.
        self.env.update(APPLE_CERTIFICATE='c3ludGhldGlj', APPLE_CERTIFICATE_PASSWORD='synthetic-p12-password',
                        APPLE_SIGNING_IDENTITY='Developer ID Application: Synthetic Test (TEST)',
                        APPLE_ID='synthetic@example.invalid', APPLE_PASSWORD='synthetic-app-password',
                        APPLE_TEAM_ID='SYNTHETIC', SIGNING_TEST_FORMAL='1')

    def assert_no_success(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.output.exists(), 'Failed signing must not expose a successful signing output')

    def test_default_adhoc_ignores_expired_credentials(self):
        self.formal_credentials()
        self.env.pop('SIGNING_TEST_FORMAL')
        self.env['APPLE_CERTIFICATE'] = 'not even valid base64; must never be decoded'
        result = self.run_signer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'signing=adhoc\n')
        self.assertIn('not notarized', self.summary.read_text())
        self.assertEqual({call[0] for call in self.calls()}, {'uname', 'codesign'})
        signing = [call for call in self.calls() if '--force' in call]
        self.assertEqual([call[-1] for call in signing], [str(self.app / 'Contents/MacOS/eCaptureQ'), str(self.app)])
        for call in signing:
            self.assertEqual(call[call.index('--sign') + 1], '-')
            self.assertIn('--timestamp=none', call)
        self.assertNotIn('synthetic-p12-password', result.stdout + result.stderr)

    def test_explicit_adhoc_needs_no_credentials(self):
        result = self.run_signer('adhoc')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'signing=adhoc\n')
        self.assertFalse(any(call[0] in ('security', 'xcrun') for call in self.calls()))

    def test_signing_and_verification_failures_do_not_report_success(self):
        for failure in ('sign', 'verify'):
            with self.subTest(failure=failure):
                self.env['SIGNING_TEST_FAIL'] = failure
                self.assert_no_success(self.run_signer('adhoc'))

    def test_wrong_signature_class_is_rejected(self):
        self.env['SIGNING_TEST_SIGNATURE'] = 'unexpected-signature'
        result = self.run_signer('adhoc')
        self.assert_no_success(result)
        self.assertIn('required ad-hoc signature', result.stderr)

    def test_unknown_mode_is_rejected_before_signing(self):
        result = self.run_signer('automatic')
        self.assert_no_success(result)
        self.assertEqual(self.calls(), [])

    def test_developer_id_requires_credentials_without_fallback(self):
        result = self.run_signer('developer-id')
        self.assert_no_success(result)
        self.assertIn('requires all six', result.stderr)
        self.assertFalse(any(call[0] in ('security', 'codesign', 'xcrun') for call in self.calls()))

    def test_developer_id_restores_keychain_list_after_notary_failure(self):
        self.formal_credentials()
        self.env['SIGNING_TEST_FAIL'] = 'notary'
        result = self.run_signer('developer-id')
        self.assert_no_success(result)
        self.assertIn('Submitting the signed application', result.stdout)
        updates = [call for call in self.calls() if call[:4] == ['security', 'list-keychains', '-d', 'user'] and '-s' in call]
        self.assertEqual(len(updates), 2)
        original = ['/synthetic/keychain with spaces.keychain-db', '/synthetic/system.keychain-db']
        self.assertEqual(updates[0][-2:], original)
        self.assertIn('ecaptureq-sign.', updates[0][5])
        self.assertEqual(updates[1][5:], original)
        self.assertTrue(any(call[:2] == ['security', 'delete-keychain'] for call in self.calls()))
        self.assertEqual(list(self.root.glob('ecaptureq-sign.*')), [])
        self.assertNotIn('synthetic-app-password', result.stdout + result.stderr)

    def test_missing_valid_identity_stops_before_signing(self):
        self.formal_credentials()
        self.env['SIGNING_TEST_MISSING_IDENTITY'] = '1'
        result = self.run_signer('developer-id')
        self.assert_no_success(result)
        self.assertIn('No valid matching Developer ID identity', result.stderr)
        self.assertFalse(any(call[0] in ('codesign', 'xcrun') for call in self.calls()))
        self.assertEqual(list(self.root.glob('ecaptureq-sign.*')), [])

    def test_successful_formal_signing_restores_empty_search_list(self):
        self.formal_credentials()
        self.env['SIGNING_TEST_EMPTY_KEYCHAINS'] = '1'
        result = self.run_signer('developer-id')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'signing=notarized\n')
        calls = self.calls()
        updates = [call for call in calls if call[:4] == ['security', 'list-keychains', '-d', 'user'] and '-s' in call]
        self.assertEqual(updates[-1], ['security', 'list-keychains', '-d', 'user', '-s'])
        self.assertTrue(any(call[:3] == ['xcrun', 'stapler', 'validate'] for call in calls))
        self.assertEqual(list(self.root.glob('ecaptureq-sign.*')), [])


if __name__ == '__main__':
    unittest.main()
