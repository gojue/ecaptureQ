#!/bin/bash
# Explicit release-only signing. Never invoke this with secrets for pull requests.
# References: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
# https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications
set +x
set -euo pipefail

app=${1:-dist/eCaptureQ.app}
required=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
configured=0
for key in "${required[@]}"; do
  if [ -n "${!key:-}" ]; then configured=$((configured + 1)); fi
done
if [ "$configured" -eq 0 ]; then
  echo 'Apple signing secrets are not configured: producing an unsigned macOS app.'
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo 'signing=unsigned' >> "$GITHUB_OUTPUT"; fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo 'macOS app: unsigned (Apple signing secrets are not configured).' >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
fi
if [ "$configured" -ne "${#required[@]}" ]; then
  echo 'Apple signing is partially configured; all six APPLE_* signing/notarization secrets are required.' >&2
  exit 1
fi
if [ "$(uname -s)" != Darwin ] || [ ! -f "$app/Contents/MacOS/eCaptureQ" ]; then
  echo 'Signing requires macOS and a built eCaptureQ.app bundle.' >&2
  exit 1
fi
case "$APPLE_SIGNING_IDENTITY" in
  'Developer ID Application:'*) ;;
  *) echo 'APPLE_SIGNING_IDENTITY must be a Developer ID Application identity.' >&2; exit 1 ;;
esac

umask 077
signing_temp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ecaptureq-sign.XXXXXX")
signing_keychain="$signing_temp/signing.keychain-db"
signing_password=$(openssl rand -hex 32)
cleanup() {
  security delete-keychain "$signing_keychain" >/dev/null 2>&1 || true
  rm -rf "$signing_temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Secrets go only into a private temporary keychain; never print decoded material.
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$signing_temp/certificate.p12"
security create-keychain -p "$signing_password" "$signing_keychain"
security set-keychain-settings -lut 21600 "$signing_keychain"
security unlock-keychain -p "$signing_password" "$signing_keychain"
security import "$signing_temp/certificate.p12" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -t cert -f pkcs12 -k "$signing_keychain" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$signing_password" "$signing_keychain" >/dev/null

# The app has one Mach-O executable and system frameworks only. Sign inside out.
codesign --force --options runtime --timestamp --keychain "$signing_keychain" \
  --sign "$APPLE_SIGNING_IDENTITY" "$app/Contents/MacOS/eCaptureQ"
codesign --force --options runtime --timestamp --keychain "$signing_keychain" \
  --sign "$APPLE_SIGNING_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

xcrun notarytool store-credentials ecaptureq-release --keychain "$signing_keychain" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" >/dev/null
ditto -c -k --sequesterRsrc --keepParent "$app" "$signing_temp/notarize.zip"
xcrun notarytool submit "$signing_temp/notarize.zip" --keychain "$signing_keychain" \
  --keychain-profile ecaptureq-release --wait --timeout 30m
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict "$app"
echo 'Signed and notarized the macOS application.'
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo 'signing=notarized' >> "$GITHUB_OUTPUT"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo 'macOS app: Developer ID signed and notarized.' >> "$GITHUB_STEP_SUMMARY"; fi
